import { z } from "zod";
import { valueHash } from "./files.ts";

export const profileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const profileRefSchema = z.object({ id: profileIdSchema, revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const profileInputSchema = z.strictObject({
  name: text(200).refine(value => !/[\r\n]/.test(value), "档案名称须为单行。"), summary: text(2_000),
  markdown: z.string().min(1).max(30_000).refine(value => Boolean(value.trim()), "档案正文不能为空白。"),
  status: z.enum(["active", "inactive"]).default("active"), instruction: text(10_000),
});
export const profileRecordSchema = profileInputSchema.extend({ id: profileIdSchema, revision: z.number().int().positive(),
  createdAt: z.string(), operationId: z.string(), requestHash: z.string() });
export const profileSnapshotSchema = z.object({ ref: profileRefSchema, profile: profileRecordSchema }).superRefine((value, ctx) => {
  if (value.ref.id !== value.profile.id || value.ref.revision !== value.profile.revision || value.ref.sha256 !== valueHash(value.profile)) {
    ctx.addIssue({ code: "custom", message: "创作档案快照与版本引用不一致。" });
  }
});
export const profileAssignmentSchema = z.object({ profileId: profileIdSchema, previousProfileId: profileIdSchema.nullable(),
  operationId: z.string(), reason: text(10_000), assignedAt: z.string() });
export const creativeBriefSchema = z.object({ directionSummary: text(4_000), positioning: text(4_000) });
export type ProfileRef = z.infer<typeof profileRefSchema>;
export type ProfileInput = z.input<typeof profileInputSchema>;
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;

/** 标识、摘要和本条定位直接出现在用户查看的原稿中；程序只核对展示一致性，不判断语义。 */
export function profileHeading(snapshot: ProfileSnapshot): string {
  return `所属创作档案：${snapshot.profile.name}（${snapshot.ref.id}，第 ${snapshot.ref.revision} 版）`;
}

export function readCreativeBrief(markdown: string, snapshot: ProfileSnapshot) {
  profileSnapshotSchema.parse(snapshot);
  const lines = markdown.split(/\r?\n/).map(line => line.trim());
  if (lines.filter(line => line.startsWith("所属创作档案：")).length !== 1 || !lines.includes(profileHeading(snapshot))) {
    throw new Error("草稿须明确展示所选创作档案名称、编号和版本；请按创作档案草稿模板核对原文。");
  }
  const field = (label: string) => {
    const matches = lines.filter(line => line.startsWith(label));
    if (matches.length !== 1) throw new Error("草稿须有且仅有一项：" + label);
    return matches[0]!.slice(label.length).trim();
  };
  return creativeBriefSchema.parse({ directionSummary: field("档案方向摘要："), positioning: field("本条视频定位：") });
}
