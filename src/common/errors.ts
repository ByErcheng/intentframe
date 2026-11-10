/** 保留原错误含义；格式化不改变失败或未知状态的判定。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
