export class StopRequested extends Error {}
export class ExecutionBudgetExceeded extends Error {}

export function checkExecution(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new StopRequested("本次执行已请求停止。");
}
