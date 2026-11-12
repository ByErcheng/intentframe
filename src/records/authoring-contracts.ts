import { z } from "zod";
import { modelEvidenceFields } from "./model-settings.ts";
import { experienceRefSchema } from "./experience-ref.ts";
import { profileSnapshotSchema, creativeBriefSchema } from "./creative-profile.ts";

const explanation = z.string().trim().min(1).max(10_000);
// 路径是外部 AI 所展示文件的来源声明；程序校验提交正文摘要，不任意读取客户端文件。
export const draftSubmissionSchema = z.strictObject({
  sourcePath: z.string().min(1).max(4_000).regex(/^\/.*\.md$/i, "须提供用户可打开的 Markdown 文件绝对路径。"),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  authorization: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), userInstruction: z.string().min(1).max(30_000).refine(value => value.trim().length > 0, "用户交接原话不能为空白。") }),
    z.strictObject({ kind: z.literal("external_correction"), reviewRunId: explanation, notes: explanation }),
  ]),
});
export type DraftSubmission = z.infer<typeof draftSubmissionSchema>;
export const draftReviewResultSchema = z.strictObject({
  status: z.enum(["passed", "needs_changes", "needs_confirmation"]), summary: explanation,
  issues: z.array(z.strictObject({ location: explanation, problem: explanation, reason: explanation,
    suggestion: explanation, resolver: z.enum(["external_ai", "user"]) })).max(50),
  usedExperienceRefs: z.array(experienceRefSchema).max(100), limitations: z.array(explanation).max(50),
}).superRefine((result, ctx) => {
  const expected = result.issues.some(issue => issue.resolver === "user") ? "needs_confirmation" : result.issues.length ? "needs_changes" : "passed";
  if (result.status !== expected) ctx.addIssue({ code: "custom", message: "草稿检查结论与待处理问题或处理人不一致。" });
});
export type DraftReviewResult = z.infer<typeof draftReviewResultSchema>;

export const documentIdSchema = z.string().regex(/^[ds][0-9]{3,}$/);
export const documentRefSchema = z.object({ id: documentIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type DocumentRef = z.infer<typeof documentRefSchema>;
// 测试基线只携带已核验的前置事实及来源摘要，不复制原模型的评价正文。
export const baselineDraftReviewEvidenceSchema = z.strictObject({
  kind: z.literal("verified_baseline_draft_review"), draft: documentRefSchema,
  sourceWorkId: z.string().min(1), sourceRunId: z.string().min(1), sourceInputSha256: z.string().min(1),
  sourceResultSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const markdownSchema = z.string().min(1).max(100_000).refine(value => value.trim().length > 0, "正文不能仅为空白。");
export const documentSchema = documentRefSchema.extend({
  kind: z.enum(["draft", "design"]), path: z.string(), createdAt: z.string(), operationId: z.string(),
  contentSha256: z.string(), assetRefs: z.array(z.object({ id: z.string(), sha256: z.string(), metadataSha256: z.string().optional() })).default([]),
  source: z.enum(["user", "external_ai", "project_ai"]), instruction: z.string(),
  basedOn: documentRefSchema.optional(), draft: documentRefSchema.optional(),
  assetIds: z.array(z.string()).default([]),
  submission: draftSubmissionSchema.optional(),
  reviewRequired: z.boolean().optional(),
  creativeProfile: profileSnapshotSchema.optional(), creativeBrief: creativeBriefSchema.optional(),
});
export type AuthoringDocument = z.infer<typeof documentSchema>;
export const designDecisionSchema = z.object({
  operationId: z.string(), design: documentRefSchema,
  status: z.enum(["adopted", "needs_changes"]), source: z.enum(["user", "external_ai"]),
  notes: z.string().trim().min(1), createdAt: z.string(),
  feedbackAcknowledgedIds: z.array(z.string()).default([]),
});
export type DesignDecision = z.infer<typeof designDecisionSchema>;
export const authoringRunSchema = z.object({
  id: z.string(), operationId: z.string(), kind: z.enum(["revise_draft", "review_draft", "design"]),
  base: documentRefSchema, instruction: z.string(), assetIds: z.array(z.string()),
  threadId: z.string().optional(), turnId: z.string().optional(),
  ...modelEvidenceFields,
  runnerPid: z.number().int().positive().optional(), sendState: z.enum(["not_sent", "sending", "acknowledged"]),
  status: z.enum(["preparing", "running", "completed", "needs_input", "failed", "unknown"]),
  inputPath: z.string(), inputSha256: z.string(), outputDocument: documentRefSchema.optional(),
  blockers: z.array(z.string()).default([]), error: z.string().optional(),
  draftReview: draftReviewResultSchema.optional(),
});
export type AuthoringRun = z.infer<typeof authoringRunSchema>;
export const authoringSchema = z.object({
  drafts: z.array(documentSchema).default([]), designs: z.array(documentSchema).default([]),
  handoffs: z.array(z.object({ operationId: z.string(), draft: documentRefSchema,
    userInstruction: z.string().min(1).refine(value => value.trim().length > 0), createdAt: z.string(),
    correctionOf: z.object({ operationId: z.string(), reviewRunId: z.string(), notes: explanation }).optional() })).default([]),
  decisions: z.array(designDecisionSchema).default([]), runs: z.array(authoringRunSchema).default([]),
  baselineDraftReviews: z.array(z.object({ draft: documentRefSchema, path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
});
export const authoringResultSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed"]), markdown: z.string(),
  summary: z.string(), blockers: z.array(z.string()),
});
