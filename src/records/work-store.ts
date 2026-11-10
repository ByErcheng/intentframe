import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash, sourceSnapshotSchema, verifyLegacySource, verifySourceSnapshot } from "./source-snapshot.ts";
import { productionResultSchema } from "../runtime/production-result.ts";
import { atomicJson, immutableJson, ownedPath, readJson, valueHash } from "./files.ts";
import { experienceRefSchema, feedbackLocationSchema, learningResultSchema, purposeSchema, workInputSchema } from "./contracts.ts";
import type { FeedbackLocation, WorkPurpose } from "./contracts.ts";
import { processExists } from "../runtime/process-state.ts";
import { activeExecution, assertExecutionAccess, ExecutionStore, withExecutionDispatch } from "./execution-store.ts";
import { inspectPreviews } from "../media/previews.ts";
import { authoringSchema, documentRefSchema } from "./authoring-contracts.ts";
import { assetSchema, reviewPreparationSchema, internalReviewPassed } from "./media-contracts.ts";
import { readReviewBatch } from "../media/review-materials.ts";
import { dirname } from "node:path";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const versionIdSchema = z.string().regex(/^v\d{3,}$/);
const feedbackSchema = z.object({
  id: z.string(), versionId: versionIdSchema, text: z.string(),
  source: z.enum(["user", "external_ai", "internal_check", "system_test"]),
  changesDirection: z.boolean(), createdAt: z.string(),
  location: feedbackLocationSchema.optional(),
  operationId: z.string().optional(), receivedDuringExecutionId: z.string().optional(), receivedDuringRunId: z.string().optional(),
  invalidatesApproval: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  supersedes: z.array(z.string()).optional(),
});
const reviewSchema = z.object({
  status: z.enum(["not_reviewed", "needs_changes", "passed"]),
  notes: z.string().optional(),
  source: z.enum(["user", "external_ai", "internal_check"]).optional(),
  checkedAt: z.string().optional(),
  materialIndexes: z.array(z.string()).optional(),
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
  directionId: versionIdSchema.optional(), newDirection: z.boolean().optional(),
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
  operationId: z.string().optional(), contextSha256: z.string().optional(),
  designRef: documentRefSchema.optional(), designDecisionId: z.string().optional(),
  assets: z.array(assetSchema).optional(), reviewPreparation: reviewPreparationSchema.optional(),
  assetRequestIds: z.array(z.string()).optional(),
  mediaToolsVersion: z.literal(1).optional(),
  audioPlan: z.object({ sha256: z.string(), dataSha256: z.string(), runtimeSha256: z.string() }).optional(),
  internalRepair: z.object({ rootVersionId: versionIdSchema, attempt: z.number().int().nonnegative(),
    inspectionId: z.string().optional() }).optional(),
  inputManifestPath: z.string().optional(), inputManifestSha256: z.string().optional(),
  systemFingerprint: z.string().optional(),
  executionConditions: z.object({
    runner: z.object({ executable: z.string(), sha256: z.string(), declaredVersion: z.string().optional() }),
    node: z.object({ version: z.string(), platform: z.string(), architecture: z.string() }),
    timeoutMs: z.number().positive(), media: z.record(z.string(), z.number()), dependencyLockSha256: z.string(),
  }).optional(),
  runnerPid: z.number().int().positive().optional(),
  sendState: z.enum(["not_sent", "sending", "acknowledged"]).optional(),
  nativeResult: z.object({ threadId: z.string(), turnId: z.string(), status: z.enum(["completed", "failed", "interrupted"]), reply: z.string(), error: z.string().optional() }).optional(),
  knowledgeUsed: z.array(experienceRefSchema).optional(),
});
export type WorkVersion = z.infer<typeof versionSchema>;
const executionSchema = z.object({
  status: z.enum(["idle", "running", "waiting_input", "failed", "unknown"]),
  runId: z.string().optional(), versionId: z.string().optional(), error: z.string().optional(),
});
export const workSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: purposeSchema.optional(), scopeId: z.string().optional(),
  creationOperationId: z.string().optional(),
  comparison: z.object({ id: idSchema, side: z.enum(["before", "after"]), inputHash: z.string() }).optional(),
  id: idSchema, title: z.string(), briefPath: z.string(), createdAt: z.string(),
  authoring: authoringSchema.optional(),
  assets: z.array(assetSchema).optional(),
  execution: executionSchema,
  directionApproval: z.object({
    sampleVersionId: versionIdSchema, scope: z.string(), userConfirmation: z.string(), confirmedAt: z.string(),
    feedbackAcknowledgedIds: z.array(z.string()).optional(),
  }).nullable(),
  feedback: z.array(feedbackSchema),
  confirmations: z.array(confirmationSchema).optional(),
  versions: z.array(versionSchema),
  learningBatches: z.array(z.object({ id: idSchema, checkedSourceIds: z.array(z.string()), notes: z.string(), versionId: z.string(),
    experienceRefs: z.array(experienceRefSchema), savedAt: z.string(), staged: z.boolean(), draftSha256: z.string().optional() })).optional(),
  learningPending: z.object({ id: idSchema, result: learningResultSchema, versionId: z.string(), sourceIds: z.array(z.string()), createdAt: z.string() }).optional(),
  learningError: z.string().optional(),
  learningRun: z.object({ id: idSchema, versionId: z.string(), sourceIds: z.array(z.string()), contextSha256: z.string(),
    threadId: z.string().optional(), turnId: z.string().optional(), runnerPid: z.number().int().positive().optional(),
    sendState: z.enum(["not_sent", "sending", "acknowledged"]), previousExecution: executionSchema,
    completed: z.boolean(), createdAt: z.string() }).optional(),
});
export type WorkRecord = z.infer<typeof workSchema>;
const now = () => new Date().toISOString();

function validateRecord(input: unknown): WorkRecord {
  const record = workSchema.parse(input), workPath = "works/" + record.id;
  if (record.briefPath !== workPath + "/brief.md") throw new Error("需求路径与所属作品不一致。");
  const ids = new Set<string>();
  for (const document of [...record.authoring?.drafts ?? [], ...record.authoring?.designs ?? []]) {
    if (ids.has(document.id) || document.path !== join(workPath, "documents", document.id + ".md") ||
      !document.id.startsWith(document.kind === "draft" ? "d" : "s")) throw new Error("稿件身份、种类或位置不一致。");
    ids.add(document.id);
  }
  for (const version of record.versions) {
    if (ids.has(version.id)) throw new Error("作品版本编号重复。");
    ids.add(version.id);
    if (version.inputManifestPath && version.inputManifestPath !== workPath + "/runs/" + idSchema.parse(version.runId) + "/input.json") throw new Error("制作输入依据路径与版本执行不一致。");
    for (const ref of version.reviewPreparation?.batches ?? []) {
      if (!ref.path.startsWith("media/" + record.id + "/" + version.id + "/review/") || !ref.path.endsWith("/index.json")) throw new Error("审查材料路径与版本不符。");
    }
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
  readonly purpose: WorkPurpose;
  readonly assetRoot: string;

  readonly backgroundOperationId?: string;
  constructor(dataRoot = configuration.assetRoot, purpose: WorkPurpose = "production", assetRoot = dataRoot, backgroundOperationId?: string) {
    this.dataRoot = resolve(dataRoot);
    this.purpose = purpose;
    this.assetRoot = resolve(assetRoot);
    this.backgroundOperationId = backgroundOperationId;
  }

  resolvePath(path: string): string {
    return ownedPath(this.dataRoot, path);
  }

  scope(create = false): { id: string; purpose: WorkPurpose } | undefined {
    const path = this.resolvePath(".intentframe-scope.json");
    if (!existsSync(path)) {
      if (!create) return undefined;
      mkdirSync(this.dataRoot, { recursive: true });
      try { writeFileSync(path, JSON.stringify({ id: randomUUID(), purpose: this.purpose }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const scope = z.object({ id: z.string().uuid(), purpose: purposeSchema }).parse(readJson(path));
    if (scope.purpose !== this.purpose) throw new Error("数据目录的制作用途与本次入口不一致。");
    return scope;
  }

  workDirectory(id: string): string {
    return this.resolvePath(join("works", idSchema.parse(id)));
  }

  read(id: string): WorkRecord {
    const path = this.resolvePath(join("works", idSchema.parse(id), "task.json"));
    const record = validateRecord(readJson(path));
    if (record.id !== id) throw new Error("任务记录的标识与目录不一致。");
    const scope = this.scope();
    if ((record.purpose && record.purpose !== this.purpose) || (record.scopeId && record.scopeId !== scope?.id)) {
      throw new Error("任务的制作用途或数据区域与当前入口不一致。");
    }
    // 新反馈独立追加；后台保存旧 task 快照不会覆盖这些已收到的原始意见。
    const feedbackDirectory = this.resolvePath(join("works", id, "feedback"));
    const originalOrder = new Map(record.feedback.map((item, index) => [item.id, index]));
    if (existsSync(feedbackDirectory)) {
      for (const name of readdirSync(feedbackDirectory).filter(name => name.endsWith(".json")).sort()) {
        const item = feedbackSchema.parse(readJson(this.resolvePath(join("works", id, "feedback", name))));
        if (name !== item.id + ".json") throw new Error("反馈记录与文件标识不一致。");
        this.version(record, item.versionId);
        const existing = record.feedback.find(f => f.id === item.id);
        if (existing && valueHash(existing) !== valueHash(item)) throw new Error("反馈快照与原始追加记录不一致。");
        if (!existing) record.feedback.push(item);
      }
      record.feedback.sort((a, b) => (a.sequence ?? originalOrder.get(a.id) ?? 0) - (b.sequence ?? originalOrder.get(b.id) ?? 0));
    }
    const approval = record.directionApproval;
    if (approval && record.feedback.some(f => f.changesDirection && (approval.feedbackAcknowledgedIds ?
      !approval.feedbackAcknowledgedIds.includes(f.id) : f.invalidatesApproval === valueHash(approval)))) {
      preserveConfirmations(record);
      record.directionApproval = null;
    }
    return record;
  }

  list() {
    this.scope();
    const directory = this.resolvePath("works");
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, "task.json")))
      .map(entry => {
        const record = this.read(entry.name);
        const latest = record.versions.at(-1);
        return { id: record.id, title: record.title, purpose: record.purpose ?? "unspecified", execution: record.execution.status,
          latestVersion: latest?.id, acceptance: latest?.acceptance,
          availability: latest ? this.availability(latest) : undefined };
      });
  }

  save(record: WorkRecord): void {
    const valid = validateRecord(record);
    const scope = this.scope(true)!;
    if ((valid.purpose && valid.purpose !== this.purpose) || (valid.scopeId && valid.scopeId !== scope.id)) throw new Error("不能把任务保存到其他用途的数据区域。");
    const target = this.resolvePath(join("works", valid.id, "task.json"));
    atomicJson(target, valid);
  }

  plannedWorkId(operationId: string): string {
    return "work-" + valueHash({ scopeId: this.scope(true)!.id, operationId }).slice(0, 32);
  }

  create(title: string, brief: string, operationId?: string, comparison?: WorkRecord["comparison"], designFirst = false): WorkRecord {
    workInputSchema.parse({ title, brief });
    const scope = this.scope(true)!;
    const id = operationId ? this.plannedWorkId(operationId) : "work-" + randomUUID();
    if (existsSync(this.resolvePath(join("works", id, "task.json")))) {
      const previous = this.read(id);
      if (previous.creationOperationId !== operationId || previous.title !== title || valueHash(previous.comparison ?? null) !== valueHash(comparison ?? null) ||
          readFileSync(this.resolvePath(previous.briefPath), "utf8") !== "# 原始需求\n\n" + brief + "\n") throw new Error("原操作的任务内容不一致。");
      return previous;
    }
    mkdirSync(this.workDirectory(id), { recursive: true });
    const record: WorkRecord = {
      schemaVersion: 1, purpose: this.purpose, scopeId: scope.id, creationOperationId: operationId,
      comparison,
      id, title, briefPath: "works/" + id + "/brief.md", createdAt: now(),
      execution: { status: "idle" }, directionApproval: null, feedback: [], versions: [],
      // 新入口在首次写入就声明设计前置，避免后续草稿落盘失败时意外退回旧流程。
      authoring: designFirst ? authoringSchema.parse({}) : undefined,
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
  async withLock<T>(id: string, operation: () => Promise<T> | T, recovery = false): Promise<T> {
    assertExecutionAccess(this.dataRoot, id, this.backgroundOperationId);
    const lock = this.resolvePath(join("works", idSchema.parse(id), ".write-lock"));
    const recovering = this.resolvePath(join("works", id, ".recovery-lock"));
    if (!recovery && existsSync(recovering)) throw new Error("作品正在核对恢复，暂不接受新的写操作。");
    try {
      assertExecutionAccess(this.dataRoot, id, this.backgroundOperationId);
      mkdirSync(lock);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("作品正在被操作，或前次操作未正常退出；须核对记录和进程后再继续。");
      }
      throw error;
    }
    try {
      assertExecutionAccess(this.dataRoot, id, this.backgroundOperationId);
      if (!recovery && existsSync(recovering)) throw new Error("作品正在核对恢复，暂不接受新的写操作。");
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: now() }));
      return await operation();
    }
    finally { rmSync(lock, { recursive: true }); }
  }

  async withRecoveryGuard<T>(id: string, operation: () => Promise<T>): Promise<T> {
    assertExecutionAccess(this.dataRoot, id, this.backgroundOperationId);
    const guard = this.resolvePath(join("works", idSchema.parse(id), ".recovery-lock"));
    try { mkdirSync(guard); } catch { throw new Error("已有恢复核对或未正常结束的恢复，请保留现场。"); }
    try {
      assertExecutionAccess(this.dataRoot, id, this.backgroundOperationId);
      writeFileSync(join(guard, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: now() }), { flag: "wx" });
      return await operation();
    } finally { rmSync(guard, { recursive: true }); }
  }

  lockOwner(id: string): { pid: number; startedAt: string } | undefined {
    const directory = this.resolvePath(join("works", idSchema.parse(id), ".write-lock"));
    if (!existsSync(directory)) return undefined;
    return z.object({ pid: z.number().int().positive(), startedAt: z.string() })
      .parse(readJson(this.resolvePath(join("works", id, ".write-lock", "owner.json"))));
  }

  /** 调用方必须持恢复围栏并核对原进程、运行器与结果，不能以锁年龄判断。 */
  releaseStaleLock(id: string, expected: { pid: number; startedAt: string }): void {
    const guard = readJson(this.resolvePath(join("works", idSchema.parse(id), ".recovery-lock", "owner.json")));
    if (z.object({ pid: z.number() }).parse(guard).pid !== process.pid) throw new Error("未持有本次恢复围栏。");
    const actual = this.lockOwner(id);
    if (!actual || valueHash(actual) !== valueHash(expected) || processExists(actual.pid)) throw new Error("作品占用已变化或原进程仍在运行，停止恢复。");
    rmSync(this.resolvePath(join("works", id, ".write-lock")), { recursive: true });
  }

  validateFeedbackLocation(record: WorkRecord, versionId: string, location?: FeedbackLocation) {
    const version = this.version(record, versionId), target = location ? feedbackLocationSchema.parse(location) : undefined;
    if (target?.startSeconds !== undefined) {
      const duration = version.technicalCheck?.durationSeconds;
      if (typeof duration === "number" && (target.startSeconds >= duration || (target.endSeconds ?? 0) > duration)) throw new Error("反馈时间超出已核实的视频范围。");
      if (target.precision === "verified" && typeof duration !== "number") throw new Error("媒体时长尚未核实，不能登记已核准的时间定位。");
    }
    return target;
  }

  validateFeedbackReferences(record: WorkRecord, supersedes?: string[]) {
    if (!supersedes) return;
    if (new Set(supersedes).size !== supersedes.length || supersedes.some(id => !record.feedback.some(f => f.id === id))) {
      throw new Error("supersedes 须引用本作品已存在且不重复的反馈编号；不能猜测或引用其他作品。");
    }
  }

  async feedback(
    id: string, versionId: string, text: string,
    source: z.infer<typeof feedbackSchema>["source"], changesDirection = false, location?: FeedbackLocation,
    operationId?: string, supersedes?: string[],
  ): Promise<WorkRecord> {
    z.string().trim().min(1).max(10_000).parse(text);
    return withExecutionDispatch(this.dataRoot, id, () => {
      const record = this.read(id);
      if (existsSync(this.resolvePath(join("works", id, ".recovery-lock")))) throw new Error("作品正在核对恢复，暂不接受新的写操作。");
      const active = activeExecution(this.dataRoot, id);
      if (active) {
        const state = new ExecutionStore(this.assetRoot).view(active.operationId);
        if (state.workId !== id || !["queued", "running"].includes(state.status)) throw new Error("原执行状态须先核对，不能绕过未知占用保存反馈。");
      } else if (record.execution.status === "unknown" || existsSync(this.resolvePath(join("works", id, ".write-lock")))) {
        const owner = this.lockOwner(id);
        if (record.execution.status !== "running" || !owner || owner.pid !== process.pid) throw new Error("作品正在被操作，或前次操作未正常退出；须核对记录和进程后再继续。");
      }
      const target = this.validateFeedbackLocation(record, versionId, location);
      this.validateFeedbackReferences(record, supersedes);
      this.appendFeedback(record, { versionId, text, source, changesDirection, location: target, operationId, supersedes }, active?.operationId);
      return this.read(id);
    });
  }

  private appendFeedback(record: WorkRecord, input: Pick<WorkRecord["feedback"][number], "versionId" | "text" | "source" | "changesDirection" | "location" | "operationId" | "supersedes">, executionId?: string) {
    const feedbackId = input.operationId ? "feedback-" + valueHash({ operationId: input.operationId }).slice(0, 32) : randomUUID();
    const previous = record.feedback.find(f => f.id === feedbackId);
    if (previous) {
      const { versionId, text, source, changesDirection, location, operationId, supersedes } = previous;
      if (valueHash({ versionId, text, source, changesDirection, location, operationId, supersedes }) !== valueHash(input)) throw new Error("同一操作的反馈内容不一致。");
      return previous;
    }
    const item = { id: feedbackId, ...input, createdAt: now(), receivedDuringExecutionId: executionId,
      sequence: record.feedback.length, receivedDuringRunId: record.execution.status === "running" ? record.execution.runId : undefined,
      invalidatesApproval: input.changesDirection && record.directionApproval ? valueHash(record.directionApproval) : undefined };
    immutableJson(this.resolvePath(join("works", record.id, "feedback", feedbackId + ".json")), item);
    return item;
  }

  /** 只供持有制作写锁的内检修复使用；不把执行途中外部新意见并入已固定的制作输入。 */
  async internalFeedback(record: WorkRecord, versionId: string, text: string, inspectionId: string): Promise<string> {
    if (this.lockOwner(record.id)?.pid !== process.pid) throw new Error("保存内检反馈须持有作品写锁。");
    return withExecutionDispatch(this.dataRoot, record.id, () => {
      const latest = this.read(record.id);
      this.version(latest, versionId);
      const item = this.appendFeedback(latest, { versionId, text, source: "internal_check", changesDirection: false,
        operationId: "internal-" + inspectionId }, activeExecution(this.dataRoot, record.id)?.operationId);
      if (!record.feedback.some(f => f.id === item.id)) record.feedback.push(item);
      this.save(record);
      return item.id;
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
          feedbackAcknowledgedIds: record.feedback.map(f => f.id),
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
    notes: string, source: "user" | "external_ai" | "internal_check", materialIndexes?: string[],
  ): Promise<WorkRecord> {
    z.string().trim().min(1).parse(notes);
    return this.withLock(id, () => {
      const record = this.read(id);
      const version = this.version(record, versionId);
      if (version.production !== "ready") throw new Error("须先取得实际作品再记录审查。");
      this.assertAvailable(version);
      if (version.designRef && source === "external_ai" && !materialIndexes?.length) throw new Error("外部 AI 审查须关联实际读取的项目审查索引。");
      for (const path of materialIndexes ?? []) {
        const ref = version.reviewPreparation?.batches.find(item => item.path === path);
        if (!ref || fileHash(this.resolvePath(path)) !== ref.sha256) throw new Error("审查索引不存在、已变化或属于其他视频版本。");
        readReviewBatch(dirname(this.resolvePath(path)), version.videoSha256!);
      }
      version.reviews ??= version.review.status === "not_reviewed" ? [] : [{ ...version.review }];
      version.review = { status, notes, source, materialIndexes, checkedAt: now() };
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

  previewAvailability(version: WorkVersion) {
    return inspectPreviews(this.resolvePath(version.mediaPath), version.technicalCheck?.previews);
  }

  delivery(record: WorkRecord) {
    const version = record.versions.at(-1);
    if (!version) return { status: "not_produced" as const, versionId: null, videoLocation: null };
    const available = this.availability(version).status === "available";
    const ready = available && (!version.designRef || internalReviewPassed(version.reviewPreparation));
    return { status: ready ? version.designRef ? "ready_for_external_review" as const : "legacy_unchecked" as const : "not_ready" as const,
      versionId: version.id, videoLocation: ready ? this.resolvePath(version.mediaPath) : null,
      reason: ready ? undefined : version.error ?? version.reviewPreparation?.error ?? "制作或项目内检尚未通过。" };
  }

  summary(record: WorkRecord) {
    return {
      ...record,
      delivery: this.delivery(record),
      taskPath: join(this.workDirectory(record.id), "task.json"),
      briefLocation: this.resolvePath(record.briefPath),
      versions: record.versions.map(version => {
        const availability = this.availability(version);
        const previewAvailability = availability.status === "available" ? this.previewAvailability(version) :
          { status: "unverified", paths: [], issues: ["工程与成片尚未核对通过，不能交付对应预览。"] };
        return { ...version, availability, previewAvailability,
          technicalCheck: version.technicalCheck ? { ...version.technicalCheck, previews: previewAvailability.paths } : undefined,
          sourceLocation: this.resolvePath(version.sourcePath),
          readyForExternalReview: version.designRef ? internalReviewPassed(version.reviewPreparation) && availability.status === "available" : false,
          videoLocation: availability.status === "available" && (!version.designRef || internalReviewPassed(version.reviewPreparation)) ? this.resolvePath(version.mediaPath) : null,
          diagnosticVideoLocation: availability.status === "available" ? this.resolvePath(version.mediaPath) : null };
      }),
    };
  }
}
