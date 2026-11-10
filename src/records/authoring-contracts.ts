import { z } from "zod";

export const documentIdSchema = z.string().regex(/^[ds][0-9]{3,}$/);
export const documentRefSchema = z.object({ id: documentIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type DocumentRef = z.infer<typeof documentRefSchema>;
export const markdownSchema = z.string().min(1).max(100_000).refine(value => value.trim().length > 0, "正文不能仅为空白。");
export const documentSchema = documentRefSchema.extend({
  kind: z.enum(["draft", "design"]), path: z.string(), createdAt: z.string(), operationId: z.string(),
  contentSha256: z.string(), assetRefs: z.array(z.object({ id: z.string(), sha256: z.string(), metadataSha256: z.string().optional() })).default([]),
  source: z.enum(["user", "external_ai", "project_ai"]), instruction: z.string(),
  basedOn: documentRefSchema.optional(), draft: documentRefSchema.optional(),
  assetIds: z.array(z.string()).default([]),
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
  id: z.string(), operationId: z.string(), kind: z.enum(["revise_draft", "design"]),
  base: documentRefSchema, instruction: z.string(), assetIds: z.array(z.string()),
  threadId: z.string().optional(), turnId: z.string().optional(),
  model: z.string().optional(),
  runnerPid: z.number().int().positive().optional(), sendState: z.enum(["not_sent", "sending", "acknowledged"]),
  status: z.enum(["preparing", "running", "completed", "needs_input", "failed", "unknown"]),
  inputPath: z.string(), inputSha256: z.string(), outputDocument: documentRefSchema.optional(),
  blockers: z.array(z.string()).default([]), error: z.string().optional(),
});
export type AuthoringRun = z.infer<typeof authoringRunSchema>;
export const authoringSchema = z.object({
  drafts: z.array(documentSchema).default([]), designs: z.array(documentSchema).default([]),
  handoffs: z.array(z.object({ operationId: z.string(), draft: documentRefSchema,
    userInstruction: z.string().trim().min(1), createdAt: z.string() })).default([]),
  decisions: z.array(designDecisionSchema).default([]), runs: z.array(authoringRunSchema).default([]),
});
export const authoringResultSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed"]), markdown: z.string(),
  summary: z.string(), blockers: z.array(z.string()),
});
