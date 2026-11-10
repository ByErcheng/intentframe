import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicJson, immutableJson, ownedPath, readJson, valueHash } from "./files.ts";
import { experienceRefSchema, experienceSourceSchema, learningProposalSchema, recordIdSchema } from "./contracts.ts";
import type { ExperienceRef, ExperienceSource } from "./contracts.ts";
import { WorkStore } from "./work-store.ts";
import type { WorkRecord } from "./work-store.ts";
import { sourceFingerprint } from "./source-snapshot.ts";
import { DocumentStore } from "./document-store.ts";
import type { DocumentRef } from "./authoring-contracts.ts";

export const experienceInputSchema = learningProposalSchema.omit({ sourceIds: true }).extend({
  status: z.enum(["candidate", "verified", "withdrawn"]),
  sources: z.array(experienceSourceSchema).min(1).max(100),
  verification: z.string().trim().min(1).max(5_000).optional(),
  use: z.enum(["reusable", "evaluation_only"]).default("reusable"),
});
export type ExperienceInput = z.infer<typeof experienceInputSchema>;
const experienceSchema = experienceInputSchema.extend({ id: recordIdSchema, revision: z.number().int().positive(), createdAt: z.string() });
export type Experience = z.infer<typeof experienceSchema>;
const indexSchema = z.object({
  ref: experienceRefSchema, title: z.string(), problem: z.string(), conditions: z.string(),
  keywords: z.array(z.string()), status: z.enum(["candidate", "verified", "withdrawn"]),
  use: z.enum(["reusable", "evaluation_only"]),
});
export type ExperienceIndex = z.infer<typeof indexSchema>;

/** 正式与测试共用的轻量经验记录。索引与正文分开，正文按明确版本读取。 */
export class KnowledgeStore {
  readonly root: string;
  readonly assetRoot: string;
  constructor(assetRoot: string) {
    this.assetRoot = assetRoot;
    this.root = ownedPath(assetRoot, "experience/library");
  }

  sourceStore(source: Pick<ExperienceSource, "purpose">): WorkStore {
    return new WorkStore(source.purpose === "test" ? ownedPath(this.assetRoot, "testing") : this.assetRoot,
      source.purpose, this.assetRoot);
  }

  validateSources(sources: ExperienceSource[], status = "candidate"): void {
    if (status === "verified" && sources.every(source => "documentRef" in source)) throw new Error("仅有草稿或脚本依据的经验保持候选；画面效果验证须关联实际作品。");
    for (const source of sources) {
      const store = this.sourceStore(source), work = store.read(source.workId);
      if ("documentRef" in source) new DocumentStore(store).document(work, source.documentRef);
      else {
        const version = store.version(work, source.versionId);
        if (!version.sourceSnapshot || sourceFingerprint(version.sourceSnapshot) !== source.sourceFingerprint) throw new Error("经验来源版本与工程依据不一致。");
        store.verifySource(version);
        if (source.feedbackIds.some(id => !work.feedback.some(feedback => feedback.id === id && feedback.versionId === source.versionId))) throw new Error("经验包含不属于来源版本的反馈。");
        if (status === "verified" && (version.review.status !== "passed" || store.availability(version).status !== "available")) {
          throw new Error("已验证经验须关联实际可用并已复查通过的作品版本。");
        }
      }
      if (work.comparison) {
        const comparison = z.object({ state: z.enum(["open", "completed"])}).parse(readJson(store.resolvePath("comparisons/" + work.comparison.id + "/record.json")));
        if (comparison.state !== "completed") throw new Error("比较尚未结束，新发现须先留在本轮记录中。");
      }
    }
  }

  read(ref: ExperienceRef, options: { evaluation?: boolean; verifySources?: boolean } = {}): Experience {
    const requested = experienceRefSchema.parse(ref);
    const path = ownedPath(this.root, "items/" + requested.id + "/v" + requested.revision + ".json");
    const record = experienceSchema.parse(readJson(path));
    if (record.id !== requested.id || record.revision !== requested.revision || valueHash(record) !== requested.sha256) throw new Error("经验正文与指定版本不一致。");
    if (!options.evaluation && record.use === "evaluation_only") throw new Error("评价专用材料不能作为普通制作输入。");
    if (!options.evaluation && record.status === "withdrawn") throw new Error("该经验已停止采用。");
    if (!options.evaluation) {
      const head = indexSchema.parse(readJson(ownedPath(this.root, "items/" + requested.id + "/head.json")));
      if (head.ref.id !== requested.id) throw new Error("经验当前指针与目录不一致。");
      if (head.status === "withdrawn") throw new Error("该经验已停止采用；历史版本仍保留。");
    }
    if (options.verifySources !== false) this.validateSources(record.sources, record.status);
    return record;
  }

  index(ref: ExperienceRef): ExperienceIndex {
    const expected = experienceRefSchema.parse(ref);
    const item = indexSchema.parse(readJson(ownedPath(this.root, "items/" + expected.id + "/index-" + expected.revision + ".json")));
    if (valueHash(item.ref) !== valueHash(expected)) throw new Error("经验索引与指定版本不一致。");
    return item;
  }

  latest(): ExperienceIndex[] {
    const directory = ownedPath(this.root, "items");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).sort().map(id => {
      recordIdSchema.parse(id);
      const item = indexSchema.parse(readJson(ownedPath(this.root, "items/" + id + "/head.json")));
      if (item.ref.id !== id) throw new Error("经验索引与目录不一致。");
      return item;
    });
  }

  search(query: string, offset = 0, limit = 20, scope?: ExperienceIndex[]) {
    z.string().max(2_000).parse(query); z.number().int().nonnegative().parse(offset); z.number().int().min(1).max(50).parse(limit);
    const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
    const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(normalize(query))]
      .filter(part => part.isWordLike).map(part => part.segment);
    const matches = (scope ?? this.latest()).filter(item => item.use === "reusable" && item.status !== "withdrawn")
      .map(item => ({ item, score: terms.reduce((n, term) => n + Number(normalize([item.title, item.problem, item.conditions, ...item.keywords].join(" ")).includes(term)), 0) }))
      .filter(value => !terms.length || value.score > 0).sort((a, b) => b.score - a.score || a.item.ref.id.localeCompare(b.item.ref.id));
    const nextOffset = offset + limit < matches.length ? offset + limit : null;
    return { coverage: !matches.length ? "not_found" : nextOffset === null ? "complete" : "partial",
      items: matches.slice(offset, offset + limit).map(value => value.item), nextOffset,
      note: "索引只帮助定位；未命中不证明历史不存在，采用前须读取正文与核对来源。" };
  }

  save(input: ExperienceInput, options: { id?: string; expectedRevision?: number; replay?: boolean; createdAt?: string } = {}): ExperienceRef {
    const value = experienceInputSchema.parse(input);
    if (value.status === "verified" && !value.verification) throw new Error("已验证经验须说明实际复查范围与结论。");
    if (value.status !== "withdrawn") this.validateSources(value.sources, value.status);
    const id = recordIdSchema.parse(options.id ?? "experience-" + randomUUID());
    const directory = ownedPath(this.root, "items/" + id);
    const headPath = ownedPath(this.root, "items/" + id + "/head.json");
    // 明确不存在的更新先拒绝，避免留下会使索引读取失败的空目录；锁内仍须复核并发变化。
    if (!existsSync(headPath)) {
      if (value.status === "withdrawn") throw new Error("只能停止采用已有经验。");
      if ((options.expectedRevision ?? 0) !== 0) throw new Error("经验版本已变化，请先读取当前版本。");
    }
    mkdirSync(directory, { recursive: true });
    const lock = ownedPath(this.root, "items/" + id + "/.write-lock");
    try { mkdirSync(lock); } catch { throw new Error("经验正在更新或前次写入未结束，请核对原记录。"); }
    try {
      const head = existsSync(headPath) ? indexSchema.parse(readJson(headPath)) : undefined;
      if (head && head.ref.id !== id) throw new Error("经验当前指针与目录不一致。");
      if (value.status === "withdrawn" && !head) throw new Error("只能停止采用已有经验。");
      if (head && options.replay) {
        const previous = this.read(head.ref, { evaluation: true, verifySources: false });
        const { id: _id, revision: _revision, createdAt: _createdAt, ...body } = previous;
        if (valueHash(body) === valueHash(value)) return head.ref;
        throw new Error("同一经验保存操作已用于其他内容。");
      }
      if ((options.expectedRevision ?? 0) !== (head?.ref.revision ?? 0)) throw new Error("经验版本已变化，请先读取当前版本。");
      const record = experienceSchema.parse({ ...value, id, revision: (head?.ref.revision ?? 0) + 1,
        createdAt: options.createdAt ?? new Date().toISOString() });
      const ref = { id, revision: record.revision, sha256: valueHash(record) };
      const index = { ref, title: record.title, problem: record.problem, conditions: record.conditions,
        keywords: record.keywords, status: record.status, use: record.use };
      immutableJson(ownedPath(this.root, "items/" + id + "/v" + record.revision + ".json"), record);
      immutableJson(ownedPath(this.root, "items/" + id + "/index-" + record.revision + ".json"), index);
      atomicJson(headPath, index);
      return ref;
    } finally { rmSync(lock, { recursive: true }); }
  }
}

export type LearningSource = { id: string; kind: "feedback" | "review" | "failure" | "comparison" | "document"; versionId?: string; documentRef?: DocumentRef; content: unknown };
/** 按原记录身份增量核对；后续复查/错误变化会产生新来源，不能被旧进度掩盖。 */
export function pendingLearningSources(work: WorkRecord, limit = 50, comparisonReview?: { id: string; content: unknown }) {
  const checked = new Set(work.learningBatches?.flatMap(batch => batch.checkedSourceIds) ?? []);
  const all: LearningSource[] = work.feedback.map(feedback => ({ id: "feedback:" + feedback.id, kind: "feedback", versionId: feedback.versionId, content: feedback }));
  for (const document of [...work.authoring?.drafts ?? [], ...work.authoring?.designs ?? []]) {
    if (document.basedOn) all.push({ id: "document:" + document.id + ":" + document.sha256, kind: "document",
      documentRef: { id: document.id, sha256: document.sha256 }, content: document });
  }
  for (const decision of work.authoring?.decisions ?? []) all.push({ id: "design-review:" + decision.design.id + ":" + valueHash(decision), kind: "document", documentRef: decision.design, content: decision });
  for (const version of work.versions) {
    for (const review of version.reviews ?? (version.review.status === "not_reviewed" ? [] : [version.review])) {
      all.push({ id: "review:" + version.id + ":" + valueHash(review), kind: "review", versionId: version.id, content: review });
    }
    if (version.error) all.push({ id: "failure:" + version.runId + ":" + valueHash(version.error), kind: "failure", versionId: version.id, content: version.error });
  }
  if (comparisonReview) all.push({ id: "comparison:" + comparisonReview.id + ":" + valueHash(comparisonReview.content),
    kind: "comparison", versionId: work.versions.at(-1)?.id, content: comparisonReview.content });
  const pending = all.filter(source => !checked.has(source.id));
  const items: LearningSource[] = []; let size = 0;
  for (const item of pending) {
    const length = JSON.stringify(item).length;
    if (items.length >= limit || (items.length && size + length > 24_000)) break;
    items.push(item); size += length;
  }
  return { items, remaining: pending.length - items.length, pendingCount: pending.length };
}
