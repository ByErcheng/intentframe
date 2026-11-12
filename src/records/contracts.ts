import { z } from "zod";
import { documentRefSchema } from "./authoring-contracts.ts";
export { experienceRefSchema, type ExperienceRef } from "./experience-ref.ts";

export const recordIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const workInputLimits = { title: 200, brief: 30_000 } as const;
const workTextSchema = z.string().min(1).refine(value => value.trim().length > 0, "内容不能仅为空白。");
// 校验原文而不裁剪空白，供工具入口、普通任务和比较派生任务共同使用。
export const workInputSchema = z.strictObject({
  title: workTextSchema.max(workInputLimits.title), brief: workTextSchema.max(workInputLimits.brief),
});
export const purposeSchema = z.enum(["production", "test"]);
export type WorkPurpose = z.infer<typeof purposeSchema>;
export const feedbackLocationSchema = z.strictObject({
  description: z.string().trim().min(1).max(2_000),
  precision: z.enum(["verified", "approximate", "unresolved"]),
  startSeconds: z.number().finite().nonnegative().optional(),
  endSeconds: z.number().finite().positive().optional(),
  quote: z.string().min(1).max(5_000).optional(),
  requestedChange: z.string().trim().min(1).max(5_000).optional(),
}).refine(value => value.endSeconds === undefined || (value.startSeconds !== undefined && value.endSeconds > value.startSeconds), "结束时间须晚于开始时间。");
export type FeedbackLocation = z.infer<typeof feedbackLocationSchema>;

export const videoExperienceSourceSchema = z.strictObject({
  purpose: purposeSchema, workId: recordIdSchema, versionId: z.string().regex(/^v\d{3,}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  feedbackIds: z.array(z.string()).max(100),
});
export const experienceSourceSchema = z.union([videoExperienceSourceSchema,
  z.strictObject({ kind: z.literal("document"), purpose: purposeSchema, workId: recordIdSchema, documentRef: documentRefSchema })]);
export type ExperienceSource = z.infer<typeof experienceSourceSchema>;

export const learningProposalSchema = z.strictObject({
  title: z.string().trim().min(1).max(200), problem: z.string().trim().min(1).max(2_000),
  method: z.string().trim().min(1).max(5_000), conditions: z.string().trim().min(1).max(2_000),
  limitations: z.string().trim().min(1).max(2_000), keywords: z.array(z.string().trim().min(1).max(100)).max(20),
  sourceIds: z.array(z.string()).min(1).max(100),
});
export const learningResultSchema = z.strictObject({
  checkedSourceIds: z.array(z.string()).max(100),
  notes: z.string().trim().min(1).max(5_000),
  proposals: z.array(learningProposalSchema).max(10),
});
export type LearningResult = z.infer<typeof learningResultSchema>;
