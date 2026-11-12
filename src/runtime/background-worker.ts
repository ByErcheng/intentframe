import { setTimeout as delay } from "node:timers/promises";
import { configuration } from "../config.ts";
import { ExecutionDispatchBusy, ExecutionStore, activeExecution, assertExecutionAccess, withExecutionDispatch } from "../records/execution-store.ts";
import type { ExecutionOutcome } from "../records/execution-store.ts";
import { OperationStore } from "../records/operation-store.ts";
import { WorkStore, workSchema } from "../records/work-store.ts";
import { runBackgroundAction } from "../mcp/server.ts";
import { WorkRouter } from "./work-router.ts";
import { WorkService } from "./work-service.ts";
import { runtimeFingerprint, systemFingerprint } from "./context.ts";
import { ExecutionBudgetExceeded, StopRequested } from "./execution-control.ts";
import { processExists } from "./process-state.ts";

async function run(id: string) {
  const executions = new ExecutionStore(configuration.assetRoot), request = executions.read(id);
  const dataRoot = configuration.workRoots[request.purpose];
  const controller = new AbortController(), runnerPids = new Set<number>();
  const router = new WorkRouter(configuration.assetRoot, store => new WorkService(
    new WorkStore(store.dataRoot, store.purpose, store.assetRoot, id), {
      signal: controller.signal,
      onProgress: phase => executions.update(request, "running", phase),
      onRunner: pid => runnerPids.add(pid),
      productionSnapshot: request.prepared?.snapshot !== undefined ? workSchema.parse(request.prepared.snapshot) : undefined,
    }));
  const service = router.forWork(request.workId);
  if (service.store.purpose !== request.purpose) throw new Error("后台请求与任务用途不一致。");
  let claimed = false;
  const claimDeadline = Date.now() + configuration.runtime.stopTimeoutMs;
  while (!claimed) {
    try {
      const proceed = await withExecutionDispatch(dataRoot, request.workId, () => {
        if (executions.outcome(request)) return false;
        assertExecutionAccess(dataRoot, request.workId, id);
        const original = new OperationStore(configuration.assetRoot).read(id);
        if (original.name !== request.name || original.inputHash !== request.inputHash || original.workId !== request.workId || original.purpose !== request.purpose ||
            !["unresolved", "accepted"].includes(original.state)) throw new Error("后台执行与原受理回执不一致。");
        if (request.configurationFingerprint !== runtimeFingerprint() || request.systemFingerprint !== systemFingerprint()) {
          executions.finish(request, { status: "failed", error: "受理后系统或运行配置已变化，尚未执行；请核对新条件。" });
          executions.clearActive(request, dataRoot); return false;
        }
        if (executions.stop(request)) {
          executions.finish(request, { status: "cancelled", error: "请求在执行开始前已取消。" });
          executions.clearActive(request, dataRoot); return false;
        }
        executions.claim(request);
        executions.update(request, "running", "工作进程已领取原请求");
        return true;
      });
      if (!proceed) return;
      claimed = true;
    } catch (error) {
      if (!(error instanceof ExecutionDispatchBusy) || Date.now() >= claimDeadline) throw error;
      await delay(50);
    }
  }
  const started = Date.now();
  const inspectControl = () => {
    if (controller.signal.aborted) return;
    try {
      const stop = executions.stop(request);
      if (stop) controller.abort(new StopRequested(stop.reason));
      else if (Date.now() - started >= configuration.runtime.jobTimeoutMs) controller.abort(new ExecutionBudgetExceeded("本次后台执行达到已配置的总等待上限，正在核对停止结果。"));
    } catch (error) { controller.abort(error); }
  };
  const timer = setInterval(inspectControl, 200);
  const terminate = () => controller.abort(new StopRequested("本机要求停止当前工作进程。"));
  process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
  let result: unknown, failure: unknown;
  try {
    inspectControl();
    controller.signal.throwIfAborted();
    result = await runBackgroundAction(request.name, request.prepared?.input ?? request.input, router);
  } catch (error) { failure = error; }
  finally { clearInterval(timer); process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate); }

  const work = service.store.read(request.workId);
  const originalUnresolved = ["running", "unknown"].includes(work.execution.status);
  const writersAlive = [...runnerPids].some(pid => processExists(pid, process.platform !== "win32"));
  const resultStatus = result && typeof result === "object" && "status" in result ? result.status : undefined;
  let status: ExecutionOutcome["status"];
  if (originalUnresolved || writersAlive || ["running", "unknown", "needs_verification"].includes(String(resultStatus))) status = "unknown";
  else if (failure) status = controller.signal.reason instanceof StopRequested ? "cancelled" : "failed";
  else if (["produce_version", "revise_draft", "review_draft", "design_video", "recover_work"].includes(request.name) && work.execution.status === "failed") status = "failed";
  else {
    // 只补材料的操作完成不等于作品已解决原有阻塞；分别返回操作终态和作品状态。
    const materialsOnly = request.name === "prepare_review_materials" && result !== null && typeof result === "object" &&
      "mode" in result && result.mode === "materials_only";
    const awaitingThisTask = !materialsOnly && ["produce_version", "recover_work", "revise_draft", "review_draft", "design_video", "prepare_review_materials"].includes(request.name);
    status = awaitingThisTask && work.execution.status === "waiting_input" ? "waiting_input" : "succeeded";
  }
  const cause = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);
  const error = cause && controller.signal.reason instanceof Error ? controller.signal.reason.message + " " + cause : cause;
  executions.finish(request, { status, result,
    error: error ?? (status === "failed" ? work.execution.error : status === "unknown" ? "执行或写入尚未得到可靠终态，保留原占用并沿原调用恢复。" : undefined) });
  await withExecutionDispatch(dataRoot, request.workId, () => {
    if (status !== "unknown" && activeExecution(dataRoot, request.workId)?.operationId === id) executions.clearActive(request, dataRoot);
  });
}

const id = process.argv[2];
if (!id) throw new Error("缺少原后台执行编号。");
await run(id).catch(error => {
  // 不猜测业务是否发生，也不在失去依据后清锁；查询会按原工作进程与回执报告未知。
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
