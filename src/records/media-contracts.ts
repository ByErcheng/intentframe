import { z } from "zod";
import { modelEvidenceFields } from "./model-settings.ts";
import { documentRefSchema } from "./authoring-contracts.ts";
import { assetRoleSchema, voiceInfoSchema, libraryUsageSchema } from "./asset-types.ts";

export const assetIdSchema = z.string().regex(/^asset-[a-f0-9]{24}$/);
export const assetSchema = z.object({
  id: assetIdSchema, path: z.string(), sha256: z.string(), bytes: z.number().int().positive(),
  mimeType: z.string(), role: assetRoleSchema,
  voice: voiceInfoSchema.optional(),
  usage: libraryUsageSchema.optional(),
  description: z.string(), origin: z.string(), operationId: z.string(), createdAt: z.string(),
  document: documentRefSchema.optional(), metadataPath: z.string().optional(), metadataSha256: z.string().optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const MAX_INTERNAL_REPAIRS = 2;
const coverageRangeSchema = z.strictObject({ startSeconds: z.number().finite().nonnegative(), endSeconds: z.number().finite().nonnegative() })
  .refine(value => value.endSeconds >= value.startSeconds, "检查范围结束时间不得早于开始时间。");
const inspectionScopeSchema = z.strictObject({ status: z.enum(["checked", "not_checked"]),
  ranges: z.array(coverageRangeSchema).max(50).default([]), notes: z.string().trim().min(1).max(2000) })
  .superRefine((value, ctx) => {
    if ((value.status === "checked") !== (value.ranges.length > 0)) ctx.addIssue({ code: "custom", message: "已检查须列实际范围；未检查不能填写已检查范围。" });
  });
export const reviewCoverageSchema = z.strictObject({
  frames: inspectionScopeSchema,
  temporal: inspectionScopeSchema.refine(value => value.status === "not_checked" || value.ranges.every(range => range.endSeconds > range.startSeconds),
    "时序检查须覆盖相邻时刻，不能只列一个静态时间点。"),
  playback: z.strictObject({ status: z.enum(["not_watched", "partial", "full"]),
    ranges: z.array(coverageRangeSchema.safeExtend({ rate: z.number().finite().positive().max(4) })).max(50).default([]),
    notes: z.string().trim().min(1).max(2000) }).superRefine((value, ctx) => {
      if ((value.status !== "not_watched") !== (value.ranges.length > 0) || value.ranges.some(range => range.endSeconds <= range.startSeconds)) {
        ctx.addIssue({ code: "custom", message: "实际播放须列正长度的观看范围；未观看不能填写观看范围。" });
      }
    }),
});
export type ReviewCoverage = z.infer<typeof reviewCoverageSchema>;

/** 核对声明与成片范围一致；不能据此证明声明者确实观看过。 */
export function validateReviewCoverage(raw: unknown, durationSeconds: unknown): ReviewCoverage {
  const coverage = reviewCoverageSchema.parse(raw);
  const ranges = [...coverage.frames.ranges, ...coverage.temporal.ranges, ...coverage.playback.ranges];
  if (ranges.length && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw new Error("成片时长未核实，不能登记时间范围检查。");
  }
  if (typeof durationSeconds === "number" && ranges.some(range => range.endSeconds > durationSeconds + 0.001)) throw new Error("检查范围超出实际成片时长。");
  if (coverage.playback.status === "full") {
    if (typeof durationSeconds !== "number") throw new Error("成片时长未核实，不能声明完整观看。");
    let covered = 0;
    for (const range of [...coverage.playback.ranges].sort((a, b) => a.startSeconds - b.startSeconds)) {
      if (range.startSeconds > covered + 0.001) throw new Error("完整观看声明存在未覆盖的时间段。");
      covered = Math.max(covered, range.endSeconds);
    }
    if (covered < durationSeconds - 0.001) throw new Error("完整观看声明未覆盖全片。");
  }
  return coverage;
}
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
  ...modelEvidenceFields,
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
