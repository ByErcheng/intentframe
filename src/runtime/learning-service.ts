import { z } from "zod";
import { experienceRefSchema, learningResultSchema } from "../records/contracts.ts";
import type { ExperienceRef, ExperienceSource, LearningResult } from "../records/contracts.ts";
import { immutableJson, readJson, valueHash } from "../records/files.ts";
import { KnowledgeStore, pendingLearningSources } from "../records/knowledge-store.ts";
import { ComparisonStore } from "../records/comparison-store.ts";
import { sourceFingerprint } from "../records/source-snapshot.ts";
import { WorkStore } from "../records/work-store.ts";
import type { WorkRecord, WorkVersion } from "../records/work-store.ts";

const searchSchema = z.strictObject({ query: z.string().max(2_000), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) });
const feedbackPageSchema = z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) });
const feedbackReadSchema = z.strictObject({ ids: z.array(z.string()).min(1).max(20) });
export const knowledgeToolDefinitions = [
  { type: "function", name: "intentframe_search_experience", description: "按本次任务查找可用经验索引。索引不替代正文；评价专用材料不会返回。", inputSchema: z.toJSONSchema(searchSchema) },
  { type: "function", name: "intentframe_read_experience", description: "读取搜索结果中的确切经验版本，核对适用条件、来源和限制；读取失败不能当成没有经验。", inputSchema: z.toJSONSchema(experienceRefSchema) },
  { type: "function", name: "intentframe_list_feedback", description: "分页查找本次任务的原反馈位置。摘要不替代原文，实际处理前按编号读取。", inputSchema: z.toJSONSchema(feedbackPageSchema) },
  { type: "function", name: "intentframe_read_feedback", description: "读取当前任务内指定反馈的完整原文与定位，不读取其他任务。", inputSchema: z.toJSONSchema(feedbackReadSchema) },
];

export class LearningService {
  readonly store: WorkStore;
  readonly knowledge: KnowledgeStore;
  constructor(store: WorkStore, knowledge = new KnowledgeStore(store.assetRoot)) { this.store = store; this.knowledge = knowledge; }

  tools(work: WorkRecord, runId: string) {
    const comparison = new ComparisonStore(this.store, this.knowledge).context(work);
    const reads = new Map<string, ExperienceRef>();
    const feedbackReads = new Set<string>();
    return {
      reads, feedbackReads,
      call: (name: string, input: unknown) => {
        if (name === "intentframe_list_feedback") {
          const args = feedbackPageSchema.parse(input), end = args.offset + args.limit;
          return { items: work.feedback.slice(args.offset, end).map(item => ({ id: item.id, versionId: item.versionId,
            preview: item.text.slice(0, 120), location: item.location })), nextOffset: end < work.feedback.length ? end : null,
            coverage: end < work.feedback.length ? "partial" : "complete" };
        }
        if (name === "intentframe_read_feedback") {
          const args = feedbackReadSchema.parse(input);
          const items = args.ids.map(id => {
            const item = work.feedback.find(value => value.id === id);
            if (!item) throw new Error("反馈不属于本次任务。");
            return item;
          });
          for (const item of items) feedbackReads.add(item.id);
          return { coverage: "complete", items };
        }
        if (name === "intentframe_search_experience") {
          const args = searchSchema.parse(input);
          return this.knowledge.search(args.query, args.offset, args.limit, comparison?.input.knowledgeIndex);
        }
        if (name !== "intentframe_read_experience") throw new Error("本轮没有开放该工具。");
        const ref = experienceRefSchema.parse(input);
        if (comparison && !comparison.input.knowledgeRefs.some(value => valueHash(value) === valueHash(ref))) throw new Error("该经验不在本轮共同知识范围内。");
        const record = this.knowledge.read(ref);
        immutableJson(this.store.resolvePath("works/" + work.id + "/runs/" + runId + "/knowledge/" + ref.id + "-" + ref.revision + ".json"), { ref, record });
        reads.set(valueHash(ref), ref);
        return { ref, record, note: "只按本任务条件判断是否适用；候选及测试来源不能自动成为长期偏好。" };
      },
    };
  }

  accept(work: WorkRecord, version: WorkVersion, id: string, raw: LearningResult, sourceIds: string[]): void {
    const result = learningResultSchema.parse(raw), allowed = new Set(sourceIds);
    if (new Set(result.checkedSourceIds).size !== result.checkedSourceIds.length || result.checkedSourceIds.some(key => !allowed.has(key))) throw new Error("经验整理范围包含未交接或重复的来源。");
    if (result.proposals.some(proposal => proposal.sourceIds.some(key => !result.checkedSourceIds.includes(key)))) throw new Error("候选经验必须来自本次已检查的来源。");
    if (work.learningBatches?.some(batch => batch.id === id)) return;
    if (work.learningPending && work.learningPending.id !== id) throw new Error("还有未完成的经验保存，须先接续原批次。");
    if (work.learningPending && valueHash(work.learningPending.result) !== valueHash(result)) throw new Error("同一整理批次返回了不同内容，须核对原结果。");
    work.learningPending ??= { id, result, versionId: version.id, sourceIds, createdAt: new Date().toISOString() };
    this.store.save(work);
    this.finishPending(work);
  }

  private sources(work: WorkRecord, version: WorkVersion, sourceIds: string[]): ExperienceSource[] {
    const feedbackIds = sourceIds.filter(id => id.startsWith("feedback:")).map(id => id.slice("feedback:".length));
    const versions = new Set([version.id, ...work.feedback.filter(feedback => feedbackIds.includes(feedback.id)).map(feedback => feedback.versionId)]);
    for (const key of sourceIds) if (key.startsWith("review:")) versions.add(key.split(":")[1]!);
    for (const target of work.versions) if (sourceIds.some(key => key.startsWith("failure:" + target.runId + ":"))) versions.add(target.id);
    return [...versions].map(id => {
      const target = this.store.version(work, id);
      if (!target.sourceSnapshot) throw new Error("来源工程缺少完整快照，候选经验保留待核实。");
      this.store.verifySource(target);
      return { purpose: this.store.purpose, workId: work.id, versionId: id,
        sourceFingerprint: sourceFingerprint(target.sourceSnapshot),
        feedbackIds: work.feedback.filter(feedback => feedback.versionId === id && feedbackIds.includes(feedback.id)).map(feedback => feedback.id) };
    });
  }

  finishPending(work: WorkRecord): void {
    const pending = work.learningPending;
    if (!pending) return;
    const version = this.store.version(work, pending.versionId);
    const draft = { workId: work.id, ...pending };
    immutableJson(this.store.resolvePath("works/" + work.id + "/learning/" + pending.id + ".json"), draft);
    const comparison = work.comparison ? new ComparisonStore(this.store, this.knowledge).context(work) : undefined;
    const staged = comparison?.state === "open";
    const refs = staged ? [] : pending.result.proposals.map((proposal, index) => {
      const { sourceIds, ...body } = proposal;
      return this.knowledge.save({ ...body, sources: this.sources(work, version, sourceIds), status: "candidate", use: "reusable" },
        { id: "experience-" + valueHash({ scope: work.scopeId, workId: work.id, batch: pending.id, index }).slice(0, 24), replay: true, createdAt: pending.createdAt });
    });
    work.learningBatches ??= [];
    if (!work.learningBatches.some(batch => batch.id === pending.id)) work.learningBatches.push({ id: pending.id,
      checkedSourceIds: pending.result.checkedSourceIds, notes: pending.result.notes, versionId: pending.versionId,
      experienceRefs: refs, savedAt: pending.createdAt, staged, draftSha256: valueHash(draft) });
    work.learningPending = undefined; work.learningError = undefined;
    this.store.save(work);
  }

  publishStaged(work: WorkRecord): void {
    if (work.comparison && new ComparisonStore(this.store, this.knowledge).context(work)?.state !== "completed") throw new Error("本轮比较尚未结束，不能把新发现加入共享经验。");
    for (const batch of work.learningBatches ?? []) {
      if (!batch.staged) continue;
      const saved = readJson(this.store.resolvePath("works/" + work.id + "/learning/" + batch.id + ".json"));
      if (!batch.draftSha256 || valueHash(saved) !== batch.draftSha256) throw new Error("暂存经验正文与原批次不一致，保留待核对。");
      const draft = z.object({ workId: z.string(), id: z.string(), versionId: z.string(), createdAt: z.string(), result: learningResultSchema })
        .parse(saved);
      if (draft.workId !== work.id || draft.id !== batch.id || draft.versionId !== batch.versionId ||
          valueHash(draft.result.checkedSourceIds) !== valueHash(batch.checkedSourceIds)) throw new Error("暂存经验与原整理批次不一致。");
      const version = this.store.version(work, batch.versionId);
      batch.experienceRefs = draft.result.proposals.map((proposal, index) => {
        const { sourceIds, ...body } = proposal;
        return this.knowledge.save({ ...body, sources: this.sources(work, version, sourceIds), status: "candidate", use: "reusable" },
          { id: "experience-" + valueHash({ scope: work.scopeId, workId: work.id, batch: batch.id, index }).slice(0, 24), replay: true, createdAt: draft.createdAt });
      });
      batch.staged = false;
      this.store.save(work);
    }
  }

  pending(work: WorkRecord) {
    const comparison = new ComparisonStore(this.store, this.knowledge).context(work);
    return pendingLearningSources(work, 50, comparison?.evaluation ? { id: comparison.id, content: comparison.evaluation } : undefined);
  }
}
