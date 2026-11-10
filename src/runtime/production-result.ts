import { z } from "zod";
import { experienceRefSchema, learningResultSchema } from "../records/contracts.ts";

// 这是主 AI 的交付声明，不替代媒体检查、内容审查或用户认可。
export const productionResultSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed"]),
  summary: z.string().trim().min(1).max(20_000),
  appliedFeedbackIds: z.array(z.string()),
  unresolvedFeedbackIds: z.array(z.string()),
  blockers: z.array(z.string().trim().min(1)),
  usedExperienceRefs: z.array(experienceRefSchema).max(100).optional(),
  learning: learningResultSchema.optional(),
}).strict();
export type ProductionResult = z.infer<typeof productionResultSchema>;
export const productionOutputSchema = z.toJSONSchema(productionResultSchema.extend({
  usedExperienceRefs: z.array(experienceRefSchema).max(100), learning: learningResultSchema,
}));

export function parseProductionResult(text: string, requestedIds: string[]): ProductionResult {
  const result = productionResultSchema.parse(JSON.parse(text));
  const requested = new Set(requestedIds);
  for (const id of [...result.appliedFeedbackIds, ...result.unresolvedFeedbackIds]) {
    if (!requested.has(id)) throw new Error("主 AI 结果包含本次未要求处理的反馈：" + id);
  }
  if (result.appliedFeedbackIds.some(id => result.unresolvedFeedbackIds.includes(id))) {
    throw new Error("同一反馈不能同时标为完成和未解决。");
  }
  if (result.status === "completed" && (result.blockers.length || result.unresolvedFeedbackIds.length ||
      requestedIds.some(id => !result.appliedFeedbackIds.includes(id)))) {
    throw new Error("主 AI 声称完成，但仍有阻塞或未完成的反馈。");
  }
  if (result.status === "needs_input" && !result.blockers.length) throw new Error("等待输入须说明具体缺口。");
  return result;
}
