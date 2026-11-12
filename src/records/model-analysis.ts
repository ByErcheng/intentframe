import { z } from "zod";
import { modelEvidenceFields } from "./model-settings.ts";

export const analysisKindSchema = z.enum(["production_assets", "visual_understanding"]);
export const analysisResultSchema = z.strictObject({
  status: z.enum(["completed", "needs_input"]),
  markdown: z.string().trim().min(1).max(50000),
  limitations: z.array(z.string().trim().min(1).max(2000)).max(40),
});
export const analysisRunSchema = z.object({
  id: z.string(), parentRunId: z.string(), kind: analysisKindSchema, requestKey: z.string(),
  inputPath: z.string(), inputSha256: z.string(),
  ...modelEvidenceFields,
  threadId: z.string().optional(), turnId: z.string().optional(), runnerPid: z.number().int().positive().optional(),
  sendState: z.enum(["not_sent", "sending", "acknowledged"]),
  status: z.enum(["preparing", "running", "completed", "failed", "unknown"]),
  result: analysisResultSchema.optional(), error: z.string().optional(),
});
export type AnalysisRun = z.infer<typeof analysisRunSchema>;
