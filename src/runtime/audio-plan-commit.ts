import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicText, immutableJson, ownedPath, readJson, valueHash } from "../records/files.ts";
import { operationIdSchema } from "../records/operation-store.ts";
import { versionSchema } from "../records/work-store.ts";
import type { WorkStore, WorkRecord, WorkVersion } from "../records/work-store.ts";
import { AssetStore } from "../records/asset-store.ts";

export const audioPlanFiles = ["public/intentframe/audio-plan.json", "intentframe-audio-data.ts", "intentframe-audio.tsx"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pendingSchema = z.object({ operationId: operationIdSchema, sha256: digest });
const fileChange = z.object({ before: z.string().nullable(), after: z.string() });
const transactionSchema = z.object({ workId: z.string(), versionId: z.string(), runId: z.string(), operationId: operationIdSchema,
  inputHash: digest, before: versionSchema.shape.audioPlan, after: versionSchema.shape.audioPlan.unwrap(),
  files: z.tuple([fileChange, fileChange, fileChange]), assetIds: z.array(z.string()), result: z.unknown() });
type Transaction = z.infer<typeof transactionSchema>;
const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
const directory = (store: WorkStore, workId: string, runId: string) => store.resolvePath(join("works", workId, "runs", runId, "audio-plans"));

export function assertAudioPlanSettled(store: WorkStore, version: WorkVersion) {
  const workId = version.sourcePath.split("/")[1]!;
  if (existsSync(ownedPath(directory(store, workId, version.runId), "pending.json"))) {
    throw new Error("声音编排尚未提交完整；请沿原 operationKey 和参数重试，不能以当前文件冒充完成。");
  }
}

/** 固定路径的三份声音文件及作品指针共同提交；业务调用方始终持有作品写锁。 */
export class AudioPlanCommit {
  private store: WorkStore;
  private work: WorkRecord;
  private version: WorkVersion;
  private inputHash: string;
  private operationId: string;
  private pendingPath: string;
  private transactionPath: string;
  private completedPath: string;
  constructor(store: WorkStore, work: WorkRecord, version: WorkVersion, input: unknown, operationId?: string) {
    this.store = store; this.work = work; this.version = version; this.inputHash = valueHash(input);
    const root = directory(store, work.id, version.runId);
    this.pendingPath = ownedPath(root, "pending.json");
    const pending = existsSync(this.pendingPath) ? pendingSchema.parse(readJson(this.pendingPath)) : undefined;
    this.operationId = operationIdSchema.parse(operationId ?? pending?.operationId ?? randomUUID());
    this.transactionPath = ownedPath(root, "operations/" + this.operationId + ".json");
    this.completedPath = ownedPath(root, "operations/" + this.operationId + "-committed.json");
  }

  resume(): { result: unknown } | undefined {
    const pending = existsSync(this.pendingPath) ? pendingSchema.parse(readJson(this.pendingPath)) : undefined;
    if (!existsSync(this.transactionPath)) {
      if (pending) throw new Error("尚有未完成的声音编排，须先沿原请求核对接续。");
      return undefined;
    }
    const transaction = transactionSchema.parse(readJson(this.transactionPath)), sha256 = valueHash(transaction);
    if (transaction.workId !== this.work.id || transaction.versionId !== this.version.id || transaction.runId !== this.version.runId ||
        transaction.operationId !== this.operationId || transaction.inputHash !== this.inputHash) throw new Error("声音编排提交记录与原请求不一致。");
    if (existsSync(this.completedPath)) {
      if (valueHash(pendingSchema.parse(readJson(this.completedPath))) !== valueHash({ operationId: this.operationId, sha256 })) throw new Error("声音编排提交回执不一致。");
      if (pending?.operationId === this.operationId) this.clearPending(sha256);
      // 即使后续已有其他编排，也只返回本次历史结果，不重写当前文件或指针。
      return { result: transaction.result };
    }
    if (pending && (pending.operationId !== this.operationId || pending.sha256 !== sha256)) throw new Error("尚有其他未完成或不一致的声音编排，未覆盖。");
    immutableJson(this.pendingPath, { operationId: this.operationId, sha256 });
    return { result: this.apply(transaction) };
  }

  commit(contents: [string, string, string], assetIds: string[], result: unknown) {
    const base = dirname(this.store.resolvePath(this.version.sourcePath));
    const transaction = transactionSchema.parse({ workId: this.work.id, versionId: this.version.id, runId: this.version.runId,
      operationId: this.operationId, inputHash: this.inputHash, before: this.version.audioPlan,
      after: { sha256: textHash(contents[0]), dataSha256: textHash(contents[1]), runtimeSha256: textHash(contents[2]) },
      files: audioPlanFiles.map((name, index) => { const path = ownedPath(base, name);
        return { before: existsSync(path) ? readFileSync(path, "utf8") : null, after: contents[index] }; }),
      assetIds: [...new Set(assetIds)], result: JSON.parse(JSON.stringify(result)) });
    immutableJson(this.transactionPath, transaction);
    immutableJson(this.pendingPath, { operationId: this.operationId, sha256: valueHash(transaction) });
    return this.apply(transaction);
  }

  private clearPending(sha256: string) {
    const pending = pendingSchema.parse(readJson(this.pendingPath));
    if (pending.operationId !== this.operationId || pending.sha256 !== sha256) throw new Error("声音编排待提交身份已变化，未解除保护。");
    rmSync(this.pendingPath);
  }

  private apply(transaction: Transaction) {
    const base = dirname(this.store.resolvePath(this.version.sourcePath));
    const paths = audioPlanFiles.map(name => ownedPath(base, name));
    // 直接准备合成/新版本时允许尚未首次登记；已有编排仍必须匹配实际持久指针。
    const current = () => this.store.read(this.work.id).versions.find(item => item.id === this.version.id);
    const persisted = current(), matches = (value: WorkVersion["audioPlan"], expected: WorkVersion["audioPlan"]) => valueHash(value ?? null) === valueHash(expected ?? null);
    if (persisted && persisted.runId !== transaction.runId) throw new Error("声音编排所属执行已变化，不能覆盖其他执行。");
    if (!matches(persisted?.audioPlan, transaction.before) && !matches(persisted?.audioPlan, transaction.after)) throw new Error("当前声音编排已变化，不能覆盖后续提交。");
    const actual = paths.map(path => existsSync(path) ? readFileSync(path, "utf8") : null);
    if (actual.some((text, index) => text !== transaction.files[index]!.before && text !== transaction.files[index]!.after)) {
      throw new Error("声音文件不属于原提交的前后内容，不能覆盖工具外改动。");
    }
    const after = transaction.files.map(file => file.after);
    if (textHash(after[0]!) !== transaction.after.sha256 || textHash(after[1]!) !== transaction.after.dataSha256 ||
        textHash(after[2]!) !== transaction.after.runtimeSha256) throw new Error("声音编排内容与待提交摘要不符。");
    const assets = new AssetStore(this.store).select(this.work, transaction.assetIds);
    try {
      for (const [index, path] of paths.entries()) if (actual[index] !== after[index]) atomicText(path, after[index]!);
      this.version.audioPlan = transaction.after;
      this.version.assets = [...persisted?.assets ?? this.version.assets ?? []];
      for (const asset of assets) if (!this.version.assets.some(item => item.id === asset.id)) this.version.assets.push(asset);
      this.store.save(this.work);
      if (!matches(current()?.audioPlan, transaction.after)) throw new Error("声音编排尚未写入原版本记录，未标记提交完成。");
      const sha256 = valueHash(transaction);
      immutableJson(this.completedPath, { operationId: this.operationId, sha256 });
      this.clearPending(sha256);
      return transaction.result;
    } catch (error) {
      // save 可能在成功写入后才报错；先读实际指针，已提交内容不能回滚为旧文件。
      try {
        const saved = current();
        if (matches(saved?.audioPlan, transaction.before) && !matches(saved?.audioPlan, transaction.after)) {
          for (const [index, path] of paths.entries()) {
            const before = transaction.files[index]!.before;
            if (before === null) rmSync(path, { force: true }); else atomicText(path, before);
          }
        }
        this.version.audioPlan = saved?.audioPlan; this.version.assets = saved?.assets;
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "声音编排提交和回退未完成；保留原请求与待提交记录，请沿原操作接续。");
      }
      throw error;
    }
  }
}
