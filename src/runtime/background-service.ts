import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configuration, projectEnvironment, repositoryRoot } from "../config.ts";
import { valueHash } from "../records/files.ts";
import { ExecutionStore, activeExecution, withExecutionDispatch } from "../records/execution-store.ts";
import type { BackgroundTool, ExecutionRequest } from "../records/execution-store.ts";
import { WorkStore } from "../records/work-store.ts";
import { WorkRouter } from "./work-router.ts";
import { processExists, processMatches } from "./process-state.ts";
import { runtimeFingerprint, systemFingerprint } from "./context.ts";
import { selectProduction } from "./production-selection.ts";
import { z } from "zod";

/** 只交接一次本机执行，不建立常驻调度器或第二套 Agent 运行循环。 */
export class BackgroundService {
  readonly router: WorkRouter;
  readonly executions: ExecutionStore;
  constructor(router: WorkRouter) { this.router = router; this.executions = new ExecutionStore(router.assetRoot); }

  async submit(name: BackgroundTool, input: Record<string, unknown> & { operationId: string; workId: string }, receivedAt?: string) {
    const service = this.router.forWork(input.workId), store = service.store;
    if (store.assetRoot !== configuration.assetRoot) throw new Error("后台进程须使用当前入口已配置的资产目录；隔离调用请先设置独立配置。");
    return withExecutionDispatch(store.dataRoot, input.workId, async () => {
      let previous = activeExecution(store.dataRoot, input.workId);
      if (previous) {
        const finishedRequest = this.executions.read(previous.operationId), outcome = this.executions.outcome(finishedRequest);
        if (finishedRequest.workId !== input.workId || finishedRequest.purpose !== store.purpose) throw new Error("后台占用与任务归属不一致，停止交接。");
        if (outcome && outcome.status !== "unknown") {
          // 独立终态先于释放占用保存；此时原业务已收尾，可以在短锁内接续清理。
          this.executions.clearActive(finishedRequest, store.dataRoot);
          previous = undefined;
        }
      }
      if (previous && name !== "recover_work") throw new Error("作品已有后台执行，须先查询或核对原任务，不能重复提交。");
      const priorRequest = previous ? this.executions.read(previous.operationId) : undefined;
      if (priorRequest) {
        const owner = this.executions.claimant(priorRequest);
        if (!owner && this.executions.hasStarted(priorRequest)) throw new Error("原执行已开始但工作进程身份缺失，不能自动接管；请核对原记录。");
        if (owner && processMatches(owner.pid, owner.processStartedAt) !== false) throw new Error("原后台工作进程仍在运行或身份尚未核实，请先查询或请求停止。");
      }
      const lockingStore = new WorkStore(store.dataRoot, store.purpose, store.assetRoot, previous?.operationId);
      const accept = async () => {
        store.read(input.workId);
        if (name === "recover_work") {
          const owner = lockingStore.lockOwner(input.workId);
          if (owner && processExists(owner.pid)) throw new Error("原任务写入进程仍在运行，暂不另行恢复。");
        } else service.assertCanProduce(store.read(input.workId), name === "produce_version" && input.kind === "complete" ? "complete" : "sample");
        let prepared;
        if (name === "produce_version") {
          const args = z.object({ kind: z.enum(["sample", "complete"]), feedbackId: z.string().optional(),
            feedbackIds: z.array(z.string()).optional(), newDirection: z.boolean().optional(), threadMode: z.enum(["fresh", "resume"]),
            baseVersionId: z.string().optional(), baseReason: z.string().optional(),
            designRef: z.object({ id: z.string(), sha256: z.string() }).optional(), assetIds: z.array(z.string()).optional() }).parse(input);
          const snapshot = store.read(input.workId);
          const chosen = selectProduction(store, snapshot, args.kind, args.feedbackId, args.threadMode, args.baseVersionId, args.baseReason, args);
          const { feedbackId: _feedbackId, ...original } = input;
          prepared = { snapshot, input: { ...original, feedbackIds: chosen.requested,
            baseVersionId: chosen.previous?.id, baseReason: chosen.baseReason, newDirection: chosen.newDirection } };
        }
        const request = this.executions.create({ operationId: input.operationId, name, input, inputHash: valueHash(input),
          workId: input.workId, purpose: store.purpose, createdAt: new Date().toISOString(),
          receivedAt, prepared, preparedHash: prepared ? valueHash(prepared) : undefined,
          systemFingerprint: systemFingerprint(), configurationFingerprint: runtimeFingerprint() });
        if (priorRequest) {
          if (!this.executions.claimant(priorRequest) && !this.executions.outcome(priorRequest)) {
            this.executions.finish(priorRequest, { status: "cancelled", error: "原请求尚未开始执行，后续已按任务发起恢复核对。" });
          }
          this.executions.handoff(priorRequest, input.operationId);
        }
        this.executions.setActive(request, store.dataRoot);
        try { await this.launch(request); }
        catch (error) {
          // 领取也必须持交接锁，因此此处失败时尚未进入业务执行。
          this.executions.finish(request, { status: "failed", error: error instanceof Error ? error.message : String(error) });
          this.executions.clearActive(request, store.dataRoot);
          throw error;
        }
        return { executionId: request.operationId, workId: request.workId, purpose: request.purpose,
          status: "accepted", queryTool: "get_execution", pollAfterMs: 1_000,
          selection: this.executions.selection(request),
          message: "请求已保存并交给本机工作进程；已受理不表示制作完成。" };
      };
      // 恢复交接允许保留旧写锁，由工作进程沿原调用核对后决定是否解除。
      return name === "recover_work" ? lockingStore.withRecoveryGuard(input.workId, accept) : lockingStore.withLock(input.workId, accept);
    });
  }

  private async launch(request: ExecutionRequest) {
    const worker = fileURLToPath(new URL("./background-worker.ts", import.meta.url));
    const child = spawn(configuration.node, [worker, request.operationId], { cwd: repositoryRoot,
      env: { ...process.env, ...projectEnvironment() }, detached: process.platform !== "win32", stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (!child.pid) throw new Error("未取得本机工作进程身份。");
    this.executions.launched(request, child.pid);
    child.unref();
  }

  view(id: string) {
    if (!this.executions.exists(id)) throw new Error("未找到完整后台执行记录，请核对原操作；旧同步操作通过 get_operation 和 get_work 查阅。");
    return this.executions.view(id);
  }

  async stop(id: string, reason: string) {
    const request = this.executions.read(id), store = this.router.forWork(request.workId).store;
    if (store.purpose !== request.purpose) throw new Error("原执行与任务用途不一致。");
    return withExecutionDispatch(store.dataRoot, request.workId, () => {
      const outcome = this.executions.outcome(request);
      if (outcome && outcome.status !== "unknown") return this.view(id);
      this.executions.requestStop(request, reason);
      if (!this.executions.claimant(request) && !this.executions.hasStarted(request) && !outcome) {
        this.executions.finish(request, { status: "cancelled", error: "已取消尚未开始的执行。" });
        if (activeExecution(store.dataRoot, request.workId)?.operationId === id) this.executions.clearActive(request, store.dataRoot);
      }
      return this.view(id);
    });
  }
}
