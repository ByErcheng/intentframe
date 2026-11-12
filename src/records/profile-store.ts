import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson, immutableJson, immutableText, ownedPath, readJson, valueHash } from "./files.ts";
import { profileIdSchema, profileInputSchema, profileRefSchema, profileSnapshotSchema } from "./creative-profile.ts";
import type { ProfileInput, ProfileRef, ProfileSnapshot } from "./creative-profile.ts";
import { operationIdSchema } from "./operation-store.ts";

export const profileSaveSchema = z.strictObject({ profile: profileInputSchema, id: profileIdSchema.optional(),
  expectedRevision: z.number().int().nonnegative().default(0), operationId: operationIdSchema });
type ProfileListItem = { id: string; state: string; error?: string; ref?: ProfileRef; name?: string; summary?: string;
  status?: "active" | "inactive"; updatedAt?: string; location?: string };

/** 本机跨作品档案。pending 保存确切写入内容，正文与版本先落盘，当前指针最后发布。 */
export class ProfileStore {
  readonly root: string;
  private now: () => string;
  constructor(assetRoot: string, now = () => new Date().toISOString()) { this.root = ownedPath(assetRoot, "profiles"); this.now = now; }
  private path(id: string, suffix: string) { return ownedPath(this.root, profileIdSchema.parse(id) + "/" + suffix); }
  private head(id: string): ProfileRef | undefined {
    const path = this.path(id, "head.json");
    if (!existsSync(path)) return undefined;
    const ref = profileRefSchema.parse(readJson(path));
    if (ref.id !== id) throw new Error("创作档案当前版本与目录不一致。");
    return ref;
  }
  read(ref: ProfileRef): ProfileSnapshot & { location: string } {
    profileRefSchema.parse(ref);
    const published = this.head(ref.id);
    if (!published || ref.revision > published.revision) throw new Error("创作档案版本尚未提交完整，请沿原保存请求接续。");
    const snapshot = profileSnapshotSchema.parse(readJson(this.path(ref.id, `v${ref.revision}.json`)));
    const location = this.path(ref.id, `v${ref.revision}.md`);
    if (valueHash(snapshot.ref) !== valueHash(ref) || readFileSync(location, "utf8") !== snapshot.profile.markdown) {
      throw new Error("创作档案正文与指定版本不一致，不能采用。");
    }
    return { ...snapshot, location };
  }
  current(id: string) {
    const head = this.head(id);
    if (!head) throw new Error("创作档案尚无已提交版本；请查询或接续原保存请求。");
    return this.read(head);
  }
  select(ref: ProfileRef): ProfileSnapshot {
    const current = this.current(ref.id);
    if (current.profile.status !== "active") throw new Error("创作档案已停用，不能用于新的选择；已固定的任务仍沿原依据接续。");
    const { location: _location, ...snapshot } = this.read(ref);
    if (snapshot.profile.status !== "active") throw new Error("不能选择停用状态的档案版本。");
    return snapshot;
  }
  list(includeInactive = false) {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))
      .flatMap<ProfileListItem>(entry => {
        const pending = existsSync(this.path(entry.name, "pending.json"));
        const ref = this.head(entry.name);
        if (!ref) return [{ id: entry.name, state: "needs_recovery", error: "档案尚未提交完整版本；请沿原保存请求接续。" }];
        const value = this.read(ref);
        if (!includeInactive && value.profile.status === "inactive" && !pending) return [];
        return [{ id: ref.id, ref, name: value.profile.name, summary: value.profile.summary, status: value.profile.status,
          updatedAt: value.profile.createdAt, location: value.location, state: pending ? "needs_recovery" : "ready" }];
      });
  }

  save(raw: { profile: ProfileInput; id?: string; expectedRevision?: number; operationId: string }): ProfileSnapshot {
    const input = profileSaveSchema.parse(raw), requestHash = valueHash(input);
    const id = input.id ?? "profile-" + valueHash(input.operationId).slice(0, 24);
    // 校验不存在的更新，避免失败请求留下空档案目录。
    if (!existsSync(this.path(id, "head.json")) && input.expectedRevision !== 0 && !existsSync(this.path(id, "pending.json"))) {
      throw new Error("创作档案版本已变化或不存在，请先读取当前版本。");
    }
    mkdirSync(this.path(id, "operations"), { recursive: true });
    const lock = this.path(id, ".write-lock"), pendingPath = this.path(id, "pending.json");
    try { mkdirSync(lock); } catch { throw new Error("创作档案正在写入或前次进程未收尾，请核对原操作。"); }
    try {
      const journal = this.path(id, "operations/" + input.operationId + ".json"), head = this.head(id);
      const pending = existsSync(pendingPath) ? profileSnapshotSchema.parse(readJson(pendingPath)) : undefined;
      let snapshot = existsSync(journal) ? profileSnapshotSchema.parse(readJson(journal)) : undefined;
      if (snapshot && snapshot.profile.requestHash !== requestHash) throw new Error("同一档案操作编号已用于不同内容。");
      if (snapshot && (snapshot.ref.id !== id || snapshot.profile.operationId !== input.operationId)) throw new Error("档案保存记录与原请求身份不一致。");
      if (snapshot && head && head.revision >= snapshot.ref.revision) {
        this.read(snapshot.ref);
        if (pending?.profile.operationId === input.operationId) rmSync(pendingPath);
        return snapshot;
      }
      if (pending) {
        if (pending.profile.operationId !== input.operationId || pending.profile.requestHash !== requestHash) throw new Error("档案有未完成保存，须先沿原请求接续。");
        snapshot = pending;
      }
      if ((head?.revision ?? 0) !== input.expectedRevision) throw new Error("创作档案版本已变化，请读取新版本后合并修改。");
      if (!snapshot) {
        const profile = { ...input.profile, id, revision: input.expectedRevision + 1, createdAt: this.now(), operationId: input.operationId, requestHash };
        snapshot = profileSnapshotSchema.parse({ ref: { id, revision: profile.revision, sha256: valueHash(profile) }, profile });
      }
      if (snapshot.ref.id !== id || snapshot.ref.revision !== input.expectedRevision + 1) throw new Error("档案待保存身份与原请求不一致。");
      atomicJson(pendingPath, snapshot);
      immutableJson(journal, snapshot);
      immutableText(this.path(id, `v${snapshot.ref.revision}.md`), snapshot.profile.markdown);
      immutableJson(this.path(id, `v${snapshot.ref.revision}.json`), snapshot);
      this.commitHead(this.path(id, "head.json"), snapshot.ref);
      rmSync(pendingPath);
      return snapshot;
    } finally { rmSync(lock, { recursive: true }); }
  }
  /** 独立提交边界，便于在故障回归中验证正文已写而当前指针失败。 */
  protected commitHead(path: string, ref: ProfileRef) { atomicJson(path, ref); }
}
