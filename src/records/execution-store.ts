import { existsSync, mkdirSync, rmSync } from "node:fs";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, immutableJson, ownedPath, readJson, valueHash } from "./files.ts";
import { operationIdSchema } from "./operation-store.ts";
import { purposeSchema, recordIdSchema } from "./contracts.ts";
import { processMatches, processStartedAt } from "../runtime/process-state.ts";

export const backgroundTools = ["produce_version", "render_version", "organize_experience", "recover_work"] as const;
export const backgroundToolSchema = z.enum(backgroundTools);
export type BackgroundTool = z.infer<typeof backgroundToolSchema>;
const requestSchema = z.object({
  operationId: operationIdSchema, name: backgroundToolSchema, input: z.record(z.string(), z.unknown()),
  inputHash: z.string(), workId: recordIdSchema, purpose: purposeSchema, createdAt: z.string(),
  systemFingerprint: z.string(), configurationFingerprint: z.string(),
  receivedAt: z.iso.datetime().optional(),
  prepared: z.object({ input: z.record(z.string(), z.unknown()), snapshot: z.unknown() }).optional(),
  preparedHash: z.string().optional(),
});
export type ExecutionRequest = z.infer<typeof requestSchema>;
const identity = { operationId: operationIdSchema, inputHash: z.string() };
const stateSchema = z.object({ ...identity, status: z.enum(["queued", "running"]), phase: z.string(), updatedAt: z.string() });
const claimSchema = z.object({ ...identity, pid: z.number().int().positive(), startedAt: z.string(), processStartedAt: z.string().optional() });
const outcomeSchema = z.object({ ...identity,
  status: z.enum(["succeeded", "waiting_input", "failed", "cancelled", "unknown"]),
  result: z.unknown().optional(), error: z.string().optional(), finishedAt: z.string(),
});
export type ExecutionOutcome = z.infer<typeof outcomeSchema>;
const activeSchema = z.object({ operationId: operationIdSchema, workId: recordIdSchema });
export class ExecutionDispatchBusy extends Error {}

export function activeExecution(dataRoot: string, workId: string) {
  const path = ownedPath(dataRoot, "works/" + recordIdSchema.parse(workId) + "/active-execution.json");
  if (!existsSync(path)) return undefined;
  const active = activeSchema.parse(readJson(path));
  if (active.workId !== workId) throw new Error("后台执行占用与作品不一致。");
  return active;
}

/** 后台占用覆盖受理到确认结束；普通工具不能趁工作进程尚未取得写锁时插入修改。 */
export function assertExecutionAccess(dataRoot: string, workId: string, operationId?: string) {
  const active = activeExecution(dataRoot, workId);
  if (active?.operationId !== operationId) throw new Error("作品有后台执行或原占用已变化；请查询原执行，不能重复修改。");
}

/** 调度交接仅持短锁，不承担模型运行循环；残留交接锁保留现场供核对。 */
export async function withExecutionDispatch<T>(dataRoot: string, workId: string, action: () => T | Promise<T>): Promise<T> {
  const path = ownedPath(dataRoot, "works/" + recordIdSchema.parse(workId) + "/.dispatch-lock");
  const deadline = Date.now() + 1_000;
  while (true) {
    try { mkdirSync(path); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new ExecutionDispatchBusy("已有执行交接或未结束的交接，请先核对原记录。");
      await delay(25);
    }
  }
  try {
    immutableJson(ownedPath(dataRoot, "works/" + workId + "/.dispatch-lock/owner.json"), { pid: process.pid, startedAt: new Date().toISOString() });
    return await action();
  } finally { rmSync(path, { recursive: true }); }
}

export class ExecutionStore {
  readonly assetRoot: string;
  constructor(assetRoot: string) { this.assetRoot = assetRoot; }

  path(id: string, file: string): string {
    return ownedPath(this.assetRoot, "operations/" + operationIdSchema.parse(id) + "/execution/" + file);
  }

  exists(id: string): boolean { return existsSync(this.path(id, "request.json")); }

  create(input: ExecutionRequest): ExecutionRequest {
    const request = requestSchema.parse(input);
    if (request.prepared && valueHash(request.prepared) !== request.preparedHash) throw new Error("受理时的制作输入摘要不一致。");
    if (valueHash(request.input) !== request.inputHash || request.input.operationId !== request.operationId || request.input.workId !== request.workId) throw new Error("后台请求与原操作不一致。");
    immutableJson(this.path(request.operationId, "request.json"), request);
    this.update(request, "queued", "已受理，等待本机工作进程领取");
    return request;
  }

  read(id: string): ExecutionRequest {
    const request = requestSchema.parse(readJson(this.path(id, "request.json")));
    if (request.prepared && valueHash(request.prepared) !== request.preparedHash) throw new Error("受理时的制作输入已经变化。");
    if (request.operationId !== id || valueHash(request.input) !== request.inputHash ||
        request.input.operationId !== id || request.input.workId !== request.workId) throw new Error("后台请求身份或内容已变化。");
    return request;
  }

  private check<T extends { operationId: string; inputHash: string }>(request: ExecutionRequest, value: T): T {
    if (value.operationId !== request.operationId || value.inputHash !== request.inputHash) throw new Error("后台执行记录与原请求不一致。");
    return value;
  }

  setActive(request: ExecutionRequest, dataRoot: string): void {
    atomicJson(ownedPath(dataRoot, "works/" + request.workId + "/active-execution.json"), { operationId: request.operationId, workId: request.workId });
  }

  clearActive(request: ExecutionRequest, dataRoot: string): void {
    const active = activeExecution(dataRoot, request.workId);
    if (active?.operationId !== request.operationId) throw new Error("后台占用已变化，不能清除其他执行。");
    rmSync(ownedPath(dataRoot, "works/" + request.workId + "/active-execution.json"));
  }

  launched(request: ExecutionRequest, pid: number) {
    const birth = processStartedAt(pid);
    if (!birth) throw new Error("工作进程在取得启动身份前已退出。");
    immutableJson(this.path(request.operationId, "launch.json"), { operationId: request.operationId, inputHash: request.inputHash, pid, processStartedAt: birth, launchedAt: new Date().toISOString() });
  }

  claim(request: ExecutionRequest): void {
    const path = this.path(request.operationId, "claimed/owner.json");
    // 调用方持交接锁；完整身份原子发布后才允许进入业务，查询不会读到半份 owner。
    if (existsSync(path) || this.hasStarted(request)) throw new Error("原执行已被领取，不能再次执行。");
    immutableJson(path, { operationId: request.operationId, inputHash: request.inputHash, pid: process.pid,
      processStartedAt: processStartedAt(process.pid), startedAt: new Date().toISOString() });
  }

  claimant(request: ExecutionRequest) {
    if (!existsSync(this.path(request.operationId, "claimed/owner.json"))) return undefined;
    return this.check(request, claimSchema.parse(readJson(this.path(request.operationId, "claimed/owner.json"))));
  }

  hasStarted(request: ExecutionRequest): boolean {
    return this.check(request, stateSchema.parse(readJson(this.path(request.operationId, "state.json")))).status === "running";
  }

  update(request: ExecutionRequest, status: "queued" | "running", phase: string) {
    atomicJson(this.path(request.operationId, "state.json"), { operationId: request.operationId, inputHash: request.inputHash, status, phase, updatedAt: new Date().toISOString() });
  }

  finish(request: ExecutionRequest, value: Pick<ExecutionOutcome, "status" | "result" | "error">) {
    const outcome = outcomeSchema.parse({ operationId: request.operationId, inputHash: request.inputHash, ...value, finishedAt: new Date().toISOString() });
    immutableJson(this.path(request.operationId, "outcome.json"), outcome);
    return outcome;
  }

  outcome(request: ExecutionRequest) {
    const recovered = this.path(request.operationId, "recovered.json"), original = this.path(request.operationId, "outcome.json");
    const path = existsSync(recovered) ? recovered : original;
    return existsSync(path) ? this.check(request, outcomeSchema.parse(readJson(path))) : undefined;
  }

  recordRecovery(id: string, workId: string, result: unknown) {
    if (!this.exists(id)) return;
    const request = this.read(id);
    if (request.name !== "produce_version" || request.workId !== workId) throw new Error("恢复结果不属于原后台制作。");
    const path = this.path(id, "recovered.json");
    if (existsSync(path)) { this.check(request, outcomeSchema.parse(readJson(path))); return; }
    immutableJson(path, { operationId: id, inputHash: request.inputHash, status: "succeeded", result, finishedAt: new Date().toISOString() });
  }

  requestStop(request: ExecutionRequest, reason: string) {
    const path = this.path(request.operationId, "stop.json");
    if (!existsSync(path)) immutableJson(path, { operationId: request.operationId, inputHash: request.inputHash, reason, requestedAt: new Date().toISOString() });
    return this.stop(request);
  }

  stop(request: ExecutionRequest) {
    const path = this.path(request.operationId, "stop.json");
    return existsSync(path) ? this.check(request, z.object({ ...identity, reason: z.string(), requestedAt: z.string() }).parse(readJson(path))) : undefined;
  }

  handoff(request: ExecutionRequest, recoveryOperationId: string) {
    const path = this.path(request.operationId, "recovery.json");
    if (!existsSync(path)) immutableJson(path, { operationId: request.operationId, inputHash: request.inputHash, recoveryOperationId });
  }

  selection(request: ExecutionRequest) {
    const input = request.prepared?.input;
    return input ? { baseVersionId: input.baseVersionId, feedbackIds: input.feedbackIds,
      newDirection: input.newDirection, baseReason: input.baseReason } : undefined;
  }

  view(id: string) {
    const request = this.read(id), outcome = this.outcome(request), owner = this.claimant(request), stop = this.stop(request);
    const state = this.check(request, stateSchema.parse(readJson(this.path(id, "state.json"))));
    const messages = { succeeded: "执行已完成，请查看本次结果和对应版本。", waiting_input: "需要补充信息，请查看本次结果中的缺口。",
      failed: "执行失败，请核对错误及已有成果。", cancelled: "执行已取消或停止；此前成果继续保留。", unknown: "执行结果尚未核清，保留原占用并查询恢复。" };
    let status: string = outcome?.status ?? state.status, message = outcome ? outcome.error ?? messages[outcome.status] : state.phase;
    const workerAlive = owner ? processMatches(owner.pid, owner.processStartedAt) : undefined;
    if (!outcome && !owner && state.status === "running") { status = "unknown"; message = "执行已开始但工作进程身份记录缺失，保留原占用。"; }
    if (!outcome && owner && workerAlive !== true) {
      status = "unknown"; message = workerAlive === false ? "原工作进程已退出，结果须沿原调用核对，不能重发制作。" : "无法核对原工作进程身份，保留原占用。";
    }
    const launchPath = this.path(id, "launch.json");
    if (!outcome && !owner && state.status === "queued" && existsSync(launchPath)) {
      const launch = this.check(request, z.object({ ...identity, pid: z.number().int().positive(), processStartedAt: z.string().optional() }).parse(readJson(launchPath)));
      if (processMatches(launch.pid, launch.processStartedAt) === false) { status = "not_started"; message = "工作进程未领取执行便退出，请核对启动环境并恢复原任务。"; }
    }
    const recoveryPath = this.path(id, "recovery.json");
    const recovery = existsSync(recoveryPath) ? this.check(request, z.object({ ...identity, recoveryOperationId: operationIdSchema }).parse(readJson(recoveryPath))) : undefined;
    if (stop && !outcome) message = "已保存停止请求，实际结果仍须核对。 " + message;
    return { executionId: id, workId: request.workId, purpose: request.purpose, tool: request.name,
      status, message, createdAt: request.createdAt, updatedAt: outcome?.finishedAt ?? state.updatedAt,
      selection: this.selection(request),
      ...(outcome ? { result: outcome.result, error: outcome.error } : {}), workerAlive,
      stopRequested: Boolean(stop), stopReason: stop?.reason, recoveryOperationId: recovery?.recoveryOperationId,
      pollAfterMs: outcome && workerAlive !== true ? null : 1_000 };
  }

  /** 由对外查询边界调用；旧请求缺接收时间时保持缺值，不改写原结果快照。 */
  recordReturn(id: string, returned: { status?: unknown; updatedAt?: unknown }) {
    const request = this.read(id);
    if (!["succeeded", "failed", "cancelled", "waiting_input"].includes(String(returned.status))) return undefined;
    if (!request.receivedAt) return { receivedAt: undefined, firstReturnedAt: undefined, elapsedMs: null,
      limitation: "历史请求缺少接收时间及首次最终返回依据，当前查询不补造历史起止时间。" };
    const path = this.path(id, "first-return.json");
    const value = { operationId: id, inputHash: request.inputHash, receivedAt: request.receivedAt,
      firstReturnedAt: new Date().toISOString(), firstReturnedStatus: returned.status, resultFinishedAt: returned.updatedAt };
    if (!existsSync(path)) {
      try { immutableJson(path, value); }
      catch (error) {
        // 多个查询同时完成时，保留最先发布的事件；其他写入错误不能吞掉。
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST" && existsSync(path))) throw error;
      }
    }
    const saved = this.check(request, z.object({ ...identity, receivedAt: z.iso.datetime().optional(), firstReturnedAt: z.iso.datetime(),
      firstReturnedStatus: z.enum(["succeeded", "failed", "cancelled", "waiting_input"]), resultFinishedAt: z.string() }).parse(readJson(path)));
    const elapsed = saved.receivedAt ? Date.parse(saved.firstReturnedAt) - Date.parse(saved.receivedAt) : undefined;
    return { ...saved, elapsedMs: elapsed !== undefined && elapsed >= 0 ? elapsed : null,
      scope: "项目首次接收至首次最终结果返回，包含等待查询；不表示客户端已收到。",
      limitation: elapsed === undefined ? "历史请求缺少接收时间。" : elapsed < 0 ? "本机时钟顺序异常，无法可靠计算耗时。" : undefined };
  }
}
