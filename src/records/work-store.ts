import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash, sourceSnapshotSchema, verifyLegacySource, verifySourceSnapshot } from "./source-snapshot.ts";
import { productionResultSchema } from "../runtime/production-result.ts";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const versionIdSchema = z.string().regex(/^v\d{3,}$/);
const feedbackSchema = z.object({
  id: z.string(), versionId: versionIdSchema, text: z.string(),
  source: z.enum(["user", "external_ai", "internal_check", "system_test"]),
  changesDirection: z.boolean(), createdAt: z.string(),
});
const reviewSchema = z.object({
  status: z.enum(["not_reviewed", "needs_changes", "passed"]),
  notes: z.string().optional(),
  source: z.enum(["user", "external_ai", "internal_check"]).optional(),
  checkedAt: z.string().optional(),
});
const confirmationSchema = z.object({
  versionId: versionIdSchema, kind: z.enum(["direction", "acceptance"]),
  userConfirmation: z.string(), scope: z.string().optional(), confirmedAt: z.string().optional(),
});
export const versionSchema = z.object({
  id: versionIdSchema,
  kind: z.enum(["sample", "complete"]),
  production: z.enum(["creating", "source_ready", "rendering", "ready", "blocked", "failed", "unknown"]),
  sourcePath: z.string(), mediaPath: z.string(), createdAt: z.string(),
  basedOnVersionId: versionIdSchema.optional(),
  feedbackId: z.string().optional(), runId: z.string(),
  feedbackIds: z.array(z.string()).optional(), appliedFeedbackIds: z.array(z.string()).optional(),
  baseReason: z.string().optional(), agentReply: z.string().optional(), agentResult: productionResultSchema.optional(),
  threadId: z.string().optional(), turnId: z.string().optional(), model: z.string().optional(),
  sourceSha256: z.string().optional(), videoSha256: z.string().optional(),
  sourceSnapshot: sourceSnapshotSchema.optional(),
  technicalCheck: z.record(z.string(), z.unknown()).optional(),
  review: reviewSchema,
  reviews: z.array(reviewSchema).optional(),
  acceptance: z.enum(["pending", "accepted"]),
  userConfirmation: z.string().optional(), error: z.string().optional(),
});
export type WorkVersion = z.infer<typeof versionSchema>;
export const workSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema, title: z.string(), briefPath: z.string(), createdAt: z.string(),
  execution: z.object({
    status: z.enum(["idle", "running", "waiting_input", "failed", "unknown"]),
    runId: z.string().optional(), versionId: z.string().optional(), error: z.string().optional(),
  }),
  directionApproval: z.object({
    sampleVersionId: versionIdSchema, scope: z.string(), userConfirmation: z.string(), confirmedAt: z.string(),
  }).nullable(),
  feedback: z.array(feedbackSchema),
  confirmations: z.array(confirmationSchema).optional(),
  versions: z.array(versionSchema),
});
export type WorkRecord = z.infer<typeof workSchema>;
const now = () => new Date().toISOString();

function validateRecord(input: unknown): WorkRecord {
  const record = workSchema.parse(input), workPath = "works/" + record.id;
  if (record.briefPath !== workPath + "/brief.md") throw new Error("需求路径与所属作品不一致。");
  const ids = new Set<string>();
  for (const version of record.versions) {
    if (ids.has(version.id)) throw new Error("作品版本编号重复。");
    ids.add(version.id);
    if (version.sourcePath !== workPath + "/versions/" + version.id + "/source/entry.tsx" ||
        version.mediaPath !== "media/" + record.id + "/" + version.id + "/video.mp4") {
      throw new Error("源码或媒体路径与所属作品版本不一致。");
    }
  }
  return record;
}

// 在第一次更新历史时保留旧记录中的已知事实，不补造原记录没有的确认时间。
function preserveConfirmations(record: WorkRecord): NonNullable<WorkRecord["confirmations"]> {
  if (record.confirmations) return record.confirmations;
  record.confirmations = [];
  if (record.directionApproval) {
    const { sampleVersionId, ...confirmation } = record.directionApproval;
    record.confirmations.push({ kind: "direction", versionId: sampleVersionId, ...confirmation });
  }
  for (const version of record.versions) {
    if (version.acceptance === "accepted" && version.userConfirmation) {
      record.confirmations.push({ kind: "acceptance", versionId: version.id, userConfirmation: version.userConfirmation });
    }
  }
  return record.confirmations;
}

/** 同一作品的记录是一处事实来源；媒体与源码路径相对数据根目录保存。 */
export class WorkStore {
  readonly dataRoot: string;

  constructor(dataRoot = configuration.dataRoot) {
    this.dataRoot = resolve(dataRoot);
  }

  resolvePath(path: string): string {
    const target = resolve(this.dataRoot, path);
    const child = relative(this.dataRoot, target);
    if (isAbsolute(path) || child === ".." || child.startsWith(".." + sep)) {
      throw new Error("记录路径必须位于数据根目录内。");
    }
    // 数据根目录可以由用户显式指定；内部链接不能重定向任务、源码或媒体写入。
    let current = this.dataRoot;
    for (const part of child.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("数据目录内的记录路径不能经过符号链接：" + path);
      }
    }
    return target;
  }

  workDirectory(id: string): string {
    return this.resolvePath(join("works", idSchema.parse(id)));
  }

  read(id: string): WorkRecord {
    const path = this.resolvePath(join("works", idSchema.parse(id), "task.json"));
    const record = validateRecord(JSON.parse(readFileSync(path, "utf8")));
    if (record.id !== id) throw new Error("任务记录的标识与目录不一致。");
    return record;
  }

  list() {
    const directory = this.resolvePath("works");
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, "task.json")))
      .map(entry => {
        const record = this.read(entry.name);
        const latest = record.versions.at(-1);
        return { id: record.id, title: record.title, execution: record.execution.status,
          latestVersion: latest?.id, acceptance: latest?.acceptance,
          availability: latest ? this.availability(latest) : undefined };
      });
  }

  save(record: WorkRecord): void {
    const valid = validateRecord(record);
    const target = this.resolvePath(join("works", valid.id, "task.json"));
    const temporary = target + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(valid, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, target);
  }

  create(title: string, brief: string): WorkRecord {
    z.string().trim().min(1).max(200).parse(title);
    z.string().trim().min(1).max(30_000).parse(brief);
    const id = "work-" + randomUUID();
    mkdirSync(this.workDirectory(id), { recursive: true });
    const record: WorkRecord = {
      schemaVersion: 1, id, title, briefPath: "works/" + id + "/brief.md", createdAt: now(),
      execution: { status: "idle" }, directionApproval: null, feedback: [], versions: [],
    };
    writeFileSync(this.resolvePath(record.briefPath), "# 原始需求\n\n" + brief + "\n", { flag: "wx" });
    this.save(record);
    return record;
  }

  version(record: WorkRecord, id: string): WorkVersion {
    const version = record.versions.find(item => item.id === versionIdSchema.parse(id));
    if (!version) throw new Error("找不到指定作品版本。");
    return version;
  }

  // 写锁覆盖完整操作；并发读者只读取原子替换后的快照。
  async withLock<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
    const lock = join(this.workDirectory(id), ".write-lock");
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("作品正在被操作，或前次操作未正常退出；须核对记录和进程后再继续。");
      }
      throw error;
    }
    try {
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: now() }));
      return await operation();
    }
    finally { rmSync(lock, { recursive: true }); }
  }

  async feedback(
    id: string, versionId: string, text: string,
    source: z.infer<typeof feedbackSchema>["source"], changesDirection = false,
  ): Promise<WorkRecord> {
    z.string().trim().min(1).max(10_000).parse(text);
    return this.withLock(id, () => {
      const record = this.read(id);
      this.version(record, versionId);
      record.feedback.push({ id: randomUUID(), versionId, text, source, changesDirection, createdAt: now() });
      if (changesDirection) {
        preserveConfirmations(record);
        record.directionApproval = null;
      }
      this.save(record);
      return record;
    });
  }

  async confirm(
    id: string, versionId: string, kind: "direction" | "acceptance",
    userConfirmation: string, scope?: string,
  ): Promise<WorkRecord> {
    z.string().trim().min(1).max(10_000).parse(userConfirmation);
    return this.withLock(id, () => {
      const record = this.read(id);
      const version = this.version(record, versionId);
      if (version.production !== "ready") throw new Error("只能确认已实际生成的作品版本。");
      this.assertAvailable(version);
      const confirmations = preserveConfirmations(record), confirmedAt = now();
      if (kind === "direction") {
        if (version.kind !== "sample") throw new Error("方向确认须关联样例版本。");
        record.directionApproval = {
          sampleVersionId: versionId, scope: z.string().trim().min(1).parse(scope),
          userConfirmation, confirmedAt,
        };
      } else {
        if (version.kind !== "complete") throw new Error("成片认可须关联完整作品版本。");
        version.acceptance = "accepted";
        version.userConfirmation = userConfirmation;
      }
      confirmations.push({ kind, versionId, userConfirmation, confirmedAt,
        ...(kind === "direction" ? { scope: record.directionApproval!.scope } : {}) });
      this.save(record);
      return record;
    });
  }

  async review(
    id: string, versionId: string, status: "needs_changes" | "passed",
    notes: string, source: "user" | "external_ai" | "internal_check",
  ): Promise<WorkRecord> {
    z.string().trim().min(1).parse(notes);
    return this.withLock(id, () => {
      const record = this.read(id);
      const version = this.version(record, versionId);
      if (version.production !== "ready") throw new Error("须先取得实际作品再记录审查。");
      this.assertAvailable(version);
      version.reviews ??= version.review.status === "not_reviewed" ? [] : [{ ...version.review }];
      version.review = { status, notes, source, checkedAt: now() };
      version.reviews.push(version.review);
      this.save(record);
      return record;
    });
  }

  appendEvent(id: string, runId: string, event: Record<string, unknown>): void {
    const path = this.resolvePath(join("works", idSchema.parse(id), "runs", idSchema.parse(runId) + ".jsonl"));
    const directory = join(this.workDirectory(id), "runs");
    mkdirSync(directory, { recursive: true });
    appendFileSync(path, JSON.stringify({ at: now(), ...event }) + "\n");
  }

  verifySource(version: WorkVersion): void {
    const entry = this.resolvePath(version.sourcePath);
    if (version.sourceSnapshot) verifySourceSnapshot(entry, version.sourceSnapshot);
    else if (version.sourceSha256) verifyLegacySource(entry, version.sourceSha256);
    else throw new Error("没有可核对的源码记录。");
  }

  availability(version: WorkVersion) {
    const sourceCoverage = version.sourceSnapshot ? "full_snapshot" : "legacy_entry_only";
    try {
      if (!version.videoSha256 || !version.sourceSha256) {
        return { status: "unverified", reason: "尚无完整的产物校验记录。", sourceCoverage };
      }
      if (!existsSync(this.resolvePath(version.mediaPath)) || !existsSync(this.resolvePath(version.sourcePath))) {
        return { status: "missing", reason: "源码或成片文件缺失。", sourceCoverage };
      }
      this.verifySource(version);
      if (fileHash(this.resolvePath(version.mediaPath)) !== version.videoSha256) {
        return { status: "changed", reason: "成片与记录的校验值不一致。", sourceCoverage };
      }
      return { status: "available", sourceCoverage };
    } catch (error) {
      return { status: "changed", reason: error instanceof Error ? error.message : String(error), sourceCoverage };
    }
  }

  assertAvailable(version: WorkVersion): void {
    const result = this.availability(version);
    if (result.status !== "available") throw new Error(result.reason ?? "版本当前不可用。");
  }

  summary(record: WorkRecord) {
    return {
      ...record,
      taskPath: join(this.workDirectory(record.id), "task.json"),
      briefLocation: this.resolvePath(record.briefPath),
      versions: record.versions.map(version => {
        const availability = this.availability(version);
        return { ...version, availability, sourceLocation: this.resolvePath(version.sourcePath),
          videoLocation: availability.status === "available" ? this.resolvePath(version.mediaPath) : null };
      }),
    };
  }
}
