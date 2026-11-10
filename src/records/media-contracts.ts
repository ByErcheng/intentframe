import { z } from "zod";
import { documentRefSchema } from "./authoring-contracts.ts";

export const assetIdSchema = z.string().regex(/^asset-[a-f0-9]{24}$/);
export const assetSchema = z.object({
  id: assetIdSchema, path: z.string(), sha256: z.string(), bytes: z.number().int().positive(),
  mimeType: z.string(), role: z.enum(["reference", "image", "narration", "music"]),
  description: z.string(), origin: z.string(), operationId: z.string(), createdAt: z.string(),
  document: documentRefSchema.optional(), metadataPath: z.string().optional(), metadataSha256: z.string().optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const MAX_INTERNAL_REPAIRS = 2;
export const soundReviewSchema = z.object({ status: z.enum(["checked", "not_checked"]), notes: z.string(),
  ranges: z.array(z.object({ startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() })).default([]) });
export const internalQualitySchema = z.object({
  status: z.enum(["passed", "needs_repair", "needs_confirmation", "not_checked"]),
  issues: z.array(z.object({
    description: z.string().trim().min(1).max(2000),
    correction: z.string().trim().min(1).max(2000),
  })).max(10),
});
export const reviewInspectionSchema = z.object({
  id: z.string(), inputPath: z.string(), inputSha256: z.string(),
  operationId: z.string().optional(),
  threadId: z.string().optional(), turnId: z.string().optional(), runnerPid: z.number().optional(),
  model: z.string().optional(),
  sendState: z.enum(["not_sent", "sending", "acknowledged"]),
  status: z.enum(["preparing", "running", "completed", "failed", "unknown"]),
  result: z.object({ sufficient: z.boolean(), notes: z.string(), limitations: z.array(z.string()),
    quality: internalQualitySchema.optional(),
    sound: soundReviewSchema.optional(),
    additionalRanges: z.array(z.object({ startSeconds: z.number(), endSeconds: z.number(), fps: z.number(), reason: z.string() })) }).optional(),
  error: z.string().optional(),
});
export type ReviewInspection = z.infer<typeof reviewInspectionSchema>;
export const reviewPreparationSchema = z.object({
  // 仅兼容已保存记录；当前自动审查不以听音结果作为通过条件。
  requiresAudioCheck: z.boolean().optional(),
  operationId: z.string().optional(),
  status: z.enum(["preparing", "available", "needs_attention", "failed", "unknown"]),
  batches: z.array(z.object({ path: z.string(), sha256: z.string() })), inspections: z.array(reviewInspectionSchema),
  error: z.string().optional(),
});

/** 旧的覆盖检查没有质量结论，不能据此补认内检通过。 */
export function internalReviewPassed(preparation?: z.infer<typeof reviewPreparationSchema>): boolean {
  const latest = preparation?.inspections.at(-1);
  return preparation?.status === "available" && latest?.status === "completed" &&
    latest.result?.sufficient === true && latest.result.quality?.status === "passed";
}
