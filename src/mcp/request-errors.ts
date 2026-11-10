import { z } from "zod";
import { describeError } from "../common/errors.ts";

export class RequestRejected extends Error {
  readonly details: { tool: string; issues: { field: string; message: string }[]; effect: string; nextStep: string };
  constructor(tool: string, issues: { field: string; message: string }[], effect = "本次请求尚未进入业务执行；原有请求和作品状态仍须按编号核对。") {
    const details = { tool, issues, effect,
      nextStep: "按提示核对工具定义与 get_work；纠正参数后准备新请求。原请求已受理、超时或结果未知时，先查询 get_operation/get_execution，不换编号重做。" };
    super(JSON.stringify(details)); this.name = "RequestRejected"; this.details = details;
  }
}

export function validateInput<T extends z.ZodType>(tool: string, schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new RequestRejected(tool, result.error.issues.map(issue => ({
    field: issue.path.map(String).join(".") || "请求",
    message: issue.code === "invalid_type" ? "字段缺失或类型错误，应为 " + issue.expected :
      issue.code === "invalid_value" ? "允许值为：" + issue.values.map(String).join("、") :
      issue.code === "unrecognized_keys" ? "不支持这些字段：" + issue.keys.join("、") : issue.message,
  })));
}

export function rejectPreflight(tool: string, error: unknown): never {
  if (error instanceof RequestRejected) throw error;
  throw new RequestRejected(tool, [{ field: "作品、版本或制作前置条件", message: describeError(error) }]);
}
