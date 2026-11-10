import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { configuration } from "../config.ts";
import { dirname, resolve } from "node:path";
import { processMatches, processStartedAt } from "./process-state.ts";
import { describeError } from "../common/errors.ts";
export { describeError } from "../common/errors.ts";

export const codexTurnSchema = z.object({
  id: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
  error: z.object({ message: z.string() }).nullable().optional(),
});
export type CodexTurn = z.infer<typeof codexTurnSchema>;

const rpcMessageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export class UnknownExecutionOutcome extends Error {}
export class RpcRequestRejected extends Error {}

/** 只有制作可能已开始且未取得终态，才需要阻止重发；握手失败不等于制作结果未知。 */
export function executionFailureStatus(
  error: unknown, phase: "preparing" | "awaiting_result" | "checking_result" | "rendering",
): "failed" | "unknown" {
  return phase === "awaiting_result" && !(error instanceof RpcRequestRejected) ? "unknown" : "failed";
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// 复用官方 Harness 的会话与权限，仅适配项目需要的请求、终态和证据事件。
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private childStartedAt?: string;
  private responseLines: ReadlineInterface;
  private recordEvent: (event: Record<string, unknown>) => void;
  private timeoutMs: number;
  private turnTimeoutMs: number;
  private stopTimeoutMs: number;
  private abortSignal?: AbortSignal;
  stopReason?: string;
  private nextRequestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private completedTurns = new Map<string, CodexTurn>();
  private replies = new Map<string, { text: string; phase?: string | null }[]>();
  private transportError: Error | undefined;
  private onToolCall?: (tool: string, args: unknown, identity: { threadId: string; turnId: string }) => unknown | Promise<unknown>;

  constructor(options: { cwd: string; executable?: string; onEvent?: (event: Record<string, unknown>) => void; timeoutMs?: number;
    turnTimeoutMs?: number; stopTimeoutMs?: number; signal?: AbortSignal;
    onToolCall?: (tool: string, args: unknown, identity: { threadId: string; turnId: string }) => unknown | Promise<unknown> }) {
    this.recordEvent = options.onEvent ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? configuration.runtime.requestTimeoutMs;
    this.turnTimeoutMs = options.turnTimeoutMs ?? options.timeoutMs ?? configuration.runtime.requestTimeoutMs;
    this.stopTimeoutMs = options.stopTimeoutMs ?? configuration.runtime.stopTimeoutMs;
    this.abortSignal = options.signal;
    this.onToolCall = options.onToolCall;
    const executable = options.executable ?? configuration.codex;

    this.child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, PATH: dirname(configuration.node) + ":" + (process.env.PATH ?? "") },
    });
    // 原始 stderr 可能含无关配置或个人信息；这里只保存调用方选择的协议证据。
    this.child.stderr.resume();
    this.responseLines = createInterface({ input: this.child.stdout });
    this.child.on("error", error => this.handleTransportFailure(error));
    this.child.on("exit", (code, signal) => {
      this.handleTransportFailure(new UnknownExecutionOutcome("app-server 已退出：" + (signal ?? code)));
    });
    this.child.stdin.on("error", error => this.handleTransportFailure(error));
    this.responseLines.on("line", line => this.handleServerMessage(line));
    if (process.platform !== "win32" && this.child.pid) {
      try { this.childStartedAt = processStartedAt(this.child.pid); }
      catch (error) { this.handleTransportFailure(new UnknownExecutionOutcome(describeError(error))); }
    }
  }

  private handleServerMessage(line: string): void {
    try {
      const message = rpcMessageSchema.parse(JSON.parse(line));
      if (message.method && message.id !== undefined) {
        if (message.method === "item/tool/call" && this.onToolCall) {
          const call = z.object({ tool: z.string(), arguments: z.unknown(), threadId: z.string(), turnId: z.string() }).parse(message.params);
          void this.answerTool(message.id, call);
          return;
        }
        // 此接入没有人工审批界面，不代替用户批准额外权限或回答交互问题。
        this.child.stdin.write(JSON.stringify({
          id: message.id,
          error: { code: -32601, message: "本接入不支持交互请求。" },
        }) + "\n");
        return;
      }

      if (typeof message.id === "number") {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          let rejection = new RpcRequestRejected(message.error.message);
          try {
            this.recordEvent({ kind: "rpc_rejected", code: message.error.code, message: message.error.message });
          } catch (error) {
            rejection = new RpcRequestRejected(message.error.message + "；保存错误证据失败：" + describeError(error));
            this.handleTransportFailure(rejection);
          } finally {
            // 即使证据存储失败，已经移出等待表的请求也必须结束。
            pending.reject(rejection);
          }
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.method === "turn/completed") {
        const result = z.object({ threadId: z.string(), turn: codexTurnSchema }).parse(message.params);
        // 通知可能早于 turn/start 的响应，先保存，避免漏掉快速完成的任务。
        this.recordEvent({
          kind: "turn_completed",
          threadId: result.threadId,
          ...result.turn,
        });
        this.completedTurns.set(result.turn.id, result.turn);
      } else if (message.method === "item/completed") {
        const result = z.object({
          threadId: z.string(),
          turnId: z.string(),
          item: z.object({
            id: z.string(), type: z.string(), status: z.string().optional(),
            text: z.string().optional(), phase: z.string().nullable().optional(),
          }),
        }).parse(message.params);
        if (result.item.type === "agentMessage" && result.item.text !== undefined) {
          const replies = this.replies.get(result.turnId) ?? [];
          replies.push({ text: result.item.text, phase: result.item.phase });
          this.replies.set(result.turnId, replies);
          this.recordEvent({ kind: "item_completed", ...result });
        } else {
          const { id, type, status } = result.item;
          this.recordEvent({ kind: "item_completed", threadId: result.threadId, turnId: result.turnId, item: { id, type, status } });
        }
      }
    } catch (error) {
      this.handleTransportFailure(
        new UnknownExecutionOutcome("无法处理协议消息或保存对应证据：" + describeError(error)),
      );
    }
  }

  get pid(): number | undefined { return this.child.pid; }

  private async answerTool(id: string | number, call: { tool: string; arguments?: unknown; threadId: string; turnId: string }) {
    let result;
    try {
      const output = await this.onToolCall!(call.tool, call.arguments, call);
      result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(output) }] };
    } catch (error) {
      result = { success: false, contentItems: [{ type: "inputText", text: describeError(error) }] };
    }
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  private handleTransportFailure(error: Error): void {
    this.transportError ??= error;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  sendRequest(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.transportError) return Promise.reject(this.transportError);
    const id = ++this.nextRequestId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new UnknownExecutionOutcome(method + " 等待超时，须核对原任务后再决定是否继续。"));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async initializeConnection(): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: { name: "intentframe_smoke", version: "0.1.0" },
      ...(this.onToolCall ? { capabilities: { experimentalApi: true } } : {}),
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }

  async waitForTurnCompletion(turnId: string, threadId?: string): Promise<CodexTurn> {
    const deadline = Date.now() + this.turnTimeoutMs;
    let stopDeadline: number | undefined;
    while (true) {
      const completed = this.completedTurns.get(turnId);
      if (completed) return completed;
      if (this.transportError) throw new UnknownExecutionOutcome(describeError(this.transportError));
      if (stopDeadline === undefined && (this.abortSignal?.aborted || Date.now() >= deadline)) {
        this.stopReason = this.abortSignal?.aborted ? describeError(this.abortSignal.reason) : "等待模型本轮结果达到已配置上限。";
        if (!threadId) throw new UnknownExecutionOutcome(this.stopReason + " 未收到执行结束事件，结果仍未知。");
        this.recordEvent({ kind: "turn_stop_requested", threadId, turnId, reason: this.stopReason });
        stopDeadline = Date.now() + this.stopTimeoutMs;
        try { await this.sendRequest("turn/interrupt", { threadId, turnId }, this.stopTimeoutMs); }
        catch (error) {
          const ended = this.completedTurns.get(turnId);
          if (ended) return ended;
          throw new UnknownExecutionOutcome(this.stopReason + " 停止结果尚未核实：" + describeError(error));
        }
      }
      if (stopDeadline !== undefined && Date.now() >= stopDeadline) throw new UnknownExecutionOutcome(this.stopReason + " 停止后仍未取得原执行终态。");
      await delay(100);
    }
  }

  finalReply(turnId: string): string {
    const replies = this.replies.get(turnId) ?? [];
    const final = replies.filter(reply => reply.phase === "final_answer").at(-1)
      ?? replies.filter(reply => reply.phase == null).at(-1);
    if (!final) throw new Error("原生执行结束，但没有明确的最终制作结果。");
    return final.text;
  }

  /** 只读原线程；按准确轮次或已保存的执行标记定位，绝不发送新的制作输入。 */
  async readOriginalTurn(threadId: string, turnId: string | undefined, cwd: string, runId: string) {
    const metadata = z.object({ thread: z.object({ id: z.string(), cwd: z.string(), historyMode: z.enum(["legacy", "paginated"]).default("legacy") }) })
      .parse(await this.sendRequest("thread/read", { threadId }));
    if (metadata.thread.id !== threadId || resolve(metadata.thread.cwd) !== resolve(cwd)) throw new UnknownExecutionOutcome("原线程身份或工作目录与任务不一致。");
    const item = z.object({ type: z.string(), text: z.string().optional(), phase: z.string().nullable().optional(),
      status: z.string().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional() }).passthrough();
    const turn = codexTurnSchema.extend({ itemsView: z.enum(["full", "summary", "notLoaded"]).default("full"), items: z.array(item) });
    const prefix = "本次执行编号：" + runId + "\n";
    const matches = (candidate: z.infer<typeof turn>) => (!turnId || candidate.id === turnId) &&
      candidate.items.some(value => value.type === "userMessage" && value.content?.some(part => part.type === "text" && part.text?.startsWith(prefix)));
    const found: z.infer<typeof turn>[] = [];
    if (metadata.thread.historyMode === "legacy") {
      const history = z.object({ thread: z.object({ id: z.string(), turns: z.array(turn) }) })
        .parse(await this.sendRequest("thread/read", { threadId, includeTurns: true }));
      if (history.thread.id !== threadId) throw new UnknownExecutionOutcome("原线程查询返回其他线程。");
      found.push(...history.thread.turns.filter(matches));
    } else {
      let cursor: string | null = null;
      const visited = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const result: { data: z.infer<typeof turn>[]; nextCursor: string | null } = z.object({ data: z.array(turn), nextCursor: z.string().nullable() })
          .parse(await this.sendRequest("thread/turns/list", { threadId, cursor, limit: 20, itemsView: "full", sortDirection: "desc" }));
        found.push(...result.data.filter(matches));
        cursor = result.nextCursor;
        if (!cursor || (turnId && found.length)) break;
        if (visited.has(cursor) || page === 99) throw new UnknownExecutionOutcome("原轮次历史未完整核对，保留未知。");
        visited.add(cursor);
      }
    }
    if (found.length !== 1) throw new UnknownExecutionOutcome("无法唯一定位原执行轮次，未重新发起制作。");
    const original = found[0]!;
    if (original.status === "inProgress") return { turn: original, reply: "" };
    if (original.itemsView !== "full" || original.items.some(value => value.status === "inProgress")) throw new UnknownExecutionOutcome("原执行终态或完整结果仍无法核对。");
    const answers = original.items.filter(value => value.type === "agentMessage");
    const final = answers.filter(value => value.phase === "final_answer").at(-1) ?? answers.filter(value => value.phase == null).at(-1);
    return { turn: original, reply: final?.text ?? "" };
  }

  async close(): Promise<void> {
    this.handleTransportFailure(new UnknownExecutionOutcome("客户端已关闭。"));
    this.responseLines.close();
    this.child.stdin.end();
    this.signal("SIGTERM");
    for (let attempt = 0; attempt < 20 && this.child.exitCode === null && this.child.signalCode === null; attempt++) {
      await delay(50);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.signal("SIGKILL");
      for (let attempt = 0; attempt < 20 && this.child.exitCode === null && this.child.signalCode === null; attempt++) await delay(50);
    }
  }

  private signal(signal: NodeJS.Signals) {
    try {
      if (process.platform !== "win32" && this.child.pid) {
        // 渲染可能持续较久，PID 已被重用或身份未知时不能向别的进程组发送信号。
        if (processMatches(this.child.pid, this.childStartedAt) === true) process.kill(-this.child.pid, signal);
      } else this.child.kill(signal);
    }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }
}
