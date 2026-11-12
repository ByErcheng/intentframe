import { z } from "zod";

export const assetRoleSchema = z.enum(["reference", "image", "narration", "music", "sound_effect"]);
export type AssetRole = z.infer<typeof assetRoleSchema>;
/** 人声身份和文字是有来源的声明，不由文件名或模型猜测。 */
export const voiceInfoSchema = z.strictObject({
  kind: z.enum(["recording", "synthesized", "unknown"]),
  speaker: z.string().trim().min(1).max(300).optional(),
  source: z.string().trim().min(1).max(2000).optional(),
  transcript: z.object({ text: z.string().min(1).max(30000), source: z.string().trim().min(1).max(2000) }).optional(),
});
export type VoiceInfo = z.infer<typeof voiceInfoSchema>;
/** 本机配置提供的使用声明随新素材保存，不代表程序逐首核验了许可。 */
export const libraryUsageSchema = z.object({ source: z.literal("local_library"), libraryId: z.string(), path: z.string(),
  notes: z.string().optional(), attributionRequired: z.boolean().optional(), attributionReminder: z.string().optional() });
export type LibraryUsage = z.infer<typeof libraryUsageSchema>;
/** 复用时补充身份必须说明依据；旧记录缺失来源时仍按原样继承。 */
export const voiceDeclarationSchema = voiceInfoSchema.required({ source: true });
export const assetMimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac" };
export function isAudioRole(role: AssetRole): boolean { return ["music", "narration", "sound_effect"].includes(role); }
