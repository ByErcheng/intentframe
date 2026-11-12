import { z } from "zod";

const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
export const modelSettingsSchema = z.strictObject({ model: identifier, effort: identifier });
export const modelStageSchema = z.enum(["draft_review", "draft_revision", "design", "production_assets",
  "sample", "production", "feedback_revision", "internal_review", "learning", "visual_understanding"]);
export type ModelStage = z.infer<typeof modelStageSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export const modelsSchema = z.strictObject({
  default: modelSettingsSchema,
  stages: z.partialRecord(modelStageSchema, modelSettingsSchema.partial()).default({}),
});
export type ModelsConfiguration = z.infer<typeof modelsSchema>;
export const modelSelectionSchema = modelSettingsSchema.extend({ stage: modelStageSchema });
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export function selectModel(models: ModelsConfiguration, stage: ModelStage): ModelSelection {
  return modelSelectionSchema.parse({ ...models.default, ...models.stages[stage], stage });
}

/** 请求与运行器返回值分开保存；旧记录没有这些字段时不补猜。 */
export const modelEvidenceFields = {
  modelSelection: modelSelectionSchema.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
};
