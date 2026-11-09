import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { configuration } from "../config.ts";

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

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// 复用官方 Harness 的会话与权限，仅适配项目需要的请求、终态和证据事件。
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private responseLines: ReadlineInterface;
  private recordEvent: (event: Record<string, unknown>) => void;
  private timeoutMs: number;
  private nextRequestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private completedTurns = new Map<string, CodexTurn>();
  private replies = new Map<string, { text: string; phase?: string | null }[]>();
  private transportError: Error | undefined;

  constructor(options: { cwd: string; executable?: string; onEvent?: (event: Record<string, unknown>) => void; timeoutMs?: number }) {
    this.recordEvent = options.onEvent ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 180_000;
    const executable = options.executable ?? configuration.codex;
    if (!executable) throw new Error("请通过 INTENTFRAME_CODEX_BIN 指定已安装的 Codex 可执行文件。");

    this.child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
  }

  private handleServerMessage(line: string): void {
    try {
      const message = rpcMessageSchema.parse(JSON.parse(line));
      if (message.method && message.id !== undefined) {
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

  private handleTransportFailure(error: Error): void {
    this.transportError ??= error;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  sendRequest(method: string, params: unknown = {}): Promise<unknown> {
    if (this.transportError) return Promise.reject(this.transportError);
    const id = ++this.nextRequestId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new UnknownExecutionOutcome(method + " 等待超时，须核对原任务后再决定是否继续。"));
      }, this.timeoutMs);
      this.pendingRequests.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async initializeConnection(): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: { name: "intentframe_smoke", version: "0.1.0" },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }

  async waitForTurnCompletion(turnId: string): Promise<CodexTurn> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const completed = this.completedTurns.get(turnId);
      if (completed) return completed;
      if (this.transportError) throw new UnknownExecutionOutcome(describeError(this.transportError));
      await delay(100);
    }
    throw new UnknownExecutionOutcome("未收到执行结束事件，结果仍未知。");
  }

  finalReply(turnId: string): string {
    const replies = this.replies.get(turnId) ?? [];
    const final = replies.filter(reply => reply.phase === "final_answer").at(-1)
      ?? replies.filter(reply => reply.phase == null).at(-1);
    if (!final) throw new Error("原生执行结束，但没有明确的最终制作结果。");
    return final.text;
  }

  async close(): Promise<void> {
    this.handleTransportFailure(new UnknownExecutionOutcome("客户端已关闭。"));
    this.responseLines.close();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    for (let attempt = 0; attempt < 20 && this.child.exitCode === null && this.child.signalCode === null; attempt++) {
      await delay(50);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}
