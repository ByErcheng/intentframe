import { existsSync } from "node:fs";
import { z } from "zod";
import { experienceRefSchema } from "../records/contracts.ts";
import { immutableJson, readJson, valueHash } from "../records/files.ts";
import { captureSourceSnapshot, fileHash, sourceSnapshotSchema, verifySourceSnapshot } from "../records/source-snapshot.ts";
import { WorkStore } from "../records/work-store.ts";
import type { WorkRecord, WorkVersion } from "../records/work-store.ts";

export const productionReceiptSchema = z.object({
  workId: z.string(), versionId: z.string(), runId: z.string(), threadId: z.string(), turnId: z.string(),
  status: z.enum(["completed", "failed", "interrupted"]), reply: z.string(), error: z.string().optional(),
  contextSha256: z.string(), sourceSnapshot: sourceSnapshotSchema.optional(),
  knowledgeReads: z.array(experienceRefSchema), feedbackReads: z.array(z.string()), learningSourceIds: z.array(z.string()),
});
export type ProductionReceipt = z.infer<typeof productionReceiptSchema>;
export function productionReceiptPath(store: WorkStore, workId: string, runId: string): string {
  return store.resolvePath("works/" + workId + "/runs/" + runId + "/production-result.json");
}

export function saveProductionReceipt(store: WorkStore, work: WorkRecord, version: WorkVersion,
  result: Pick<ProductionReceipt, "threadId" | "turnId" | "status" | "reply" | "error" | "knowledgeReads" | "feedbackReads" | "learningSourceIds">): ProductionReceipt {
  const path = productionReceiptPath(store, work.id, version.runId);
  if (existsSync(path)) return readProductionReceipt(store, work, version);
  const entry = store.resolvePath(version.sourcePath), context = store.resolvePath(version.sourcePath.replace(/entry\.tsx$/, "context.md"));
  if (!version.contextSha256 || fileHash(context) !== version.contextSha256) throw new Error("制作上下文已变化，不能保存为原执行的可信结果。");
  if (version.inputManifestPath && fileHash(store.resolvePath(version.inputManifestPath)) !== version.inputManifestSha256) throw new Error("本次实际输入依据已变化，不能确认原执行结果。");
  const receipt = productionReceiptSchema.parse({ ...result, workId: work.id, versionId: version.id, runId: version.runId,
    contextSha256: version.contextSha256, ...(existsSync(entry) ? { sourceSnapshot: captureSourceSnapshot(entry) } : {}) });
  immutableJson(path, receipt);
  return receipt;
}

export function readProductionReceipt(store: WorkStore, work: WorkRecord, version: WorkVersion): ProductionReceipt {
  const receipt = productionReceiptSchema.parse(readJson(productionReceiptPath(store, work.id, version.runId)));
  if (receipt.workId !== work.id || receipt.versionId !== version.id || receipt.runId !== version.runId ||
      receipt.threadId !== version.threadId || (version.turnId && receipt.turnId !== version.turnId) ||
      receipt.contextSha256 !== version.contextSha256) throw new Error("原制作回执与任务、调用或上下文不一致。");
  const context = store.resolvePath(version.sourcePath.replace(/entry\.tsx$/, "context.md"));
  if (fileHash(context) !== receipt.contextSha256) throw new Error("原制作上下文已经改变。");
  if (version.inputManifestPath && fileHash(store.resolvePath(version.inputManifestPath)) !== version.inputManifestSha256) throw new Error("原制作输入依据已经改变。");
  if (version.sourceSnapshot && valueHash(version.sourceSnapshot) !== valueHash(receipt.sourceSnapshot ?? null)) throw new Error("原工程回执与已保存的版本依据不一致。");
  if (version.nativeResult && valueHash(version.nativeResult) !== valueHash({ threadId: receipt.threadId, turnId: receipt.turnId,
    status: receipt.status, reply: receipt.reply, ...(receipt.error ? { error: receipt.error } : {}) })) throw new Error("原制作回执与已保存的原生结果不一致。");
  if (receipt.sourceSnapshot) verifySourceSnapshot(store.resolvePath(version.sourcePath), receipt.sourceSnapshot);
  return receipt;
}
