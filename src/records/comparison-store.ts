import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { experienceRefSchema, experienceSourceSchema, recordIdSchema, workInputLimits, workInputSchema } from "./contracts.ts";
import { atomicJson, readJson, valueHash } from "./files.ts";
import { KnowledgeStore } from "./knowledge-store.ts";
import type { ExperienceIndex } from "./knowledge-store.ts";
import { WorkStore } from "./work-store.ts";
import type { WorkRecord } from "./work-store.ts";
import { captureSourceSnapshot, sourceSnapshotSchema, verifySourceSnapshot } from "./source-snapshot.ts";

const sideSuffixes = { before: "（修改前）", after: "（修改后）" } as const;
function comparisonBrief(input: { brief: string; revisionRequest?: string }): string {
  return input.brief + (input.revisionRequest ? "\n\n本轮共同修改要求：\n" + input.revisionRequest : "");
}

const recordedInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(workInputLimits.title), brief: z.string().min(1).max(workInputLimits.brief),
  kind: z.enum(["creation", "revision", "retrieval"]),
  change: z.string().trim().min(1).max(2_000),
  revisionRequest: z.string().trim().min(1).max(10_000).optional(),
  base: experienceSourceSchema.optional(),
  knowledgeRefs: z.array(experienceRefSchema).max(100),
}).refine(value => value.kind !== "revision" || Boolean(value.base && value.revisionRequest), "反馈修改比较须提供共同工程基线和同一修改要求。");
// 新建时预留两侧名称标记，并校验拼接后的需求；历史记录仍按原格式读取。
export const comparisonInputSchema = recordedInputSchema.safeExtend({
  title: z.string().trim().min(1).max(workInputLimits.title - Math.max(...Object.values(sideSuffixes).map(suffix => suffix.length))),
  brief: workInputSchema.shape.brief.describe("原始需求；与共同修改要求及分隔文字拼接后的总长度不得超过 " + workInputLimits.brief + " 字符，不截断原文。"),
}).refine(value => comparisonBrief(value).length <= workInputLimits.brief, {
  path: ["brief"], message: "原始需求、共同修改要求及分隔文字合计不能超过 " + workInputLimits.brief + " 字符。",
});
const indexSchema = z.object({ ref: experienceRefSchema, title: z.string(), problem: z.string(), conditions: z.string(),
  keywords: z.array(z.string()), status: z.enum(["candidate", "verified", "withdrawn"]), use: z.enum(["reusable", "evaluation_only"]) });
const definitionSchema = z.object({ ...recordedInputSchema.shape, knowledgeIndex: z.array(indexSchema), baseSnapshot: sourceSnapshotSchema.optional() });
const comparisonSchema = z.object({
  schemaVersion: z.literal(1), id: recordIdSchema, state: z.enum(["open", "completed"]),
  inputHash: z.string(), input: definitionSchema, createdAt: z.string(),
  workIds: z.object({ before: recordIdSchema, after: recordIdSchema }),
  evaluation: z.object({ beforeVersionId: z.string(), afterVersionId: z.string(),
    verdict: z.enum(["improved", "regressed", "mixed", "inconclusive"]), observations: z.string(),
    source: z.enum(["user", "external_ai"]), conditions: z.unknown(), evaluatedAt: z.string() }).optional(),
});
export type Comparison = z.infer<typeof comparisonSchema>;

/** 比较只组织固定条件与证据，不启动第二套运行器，也不自动评分。 */
export class ComparisonStore {
  readonly store: WorkStore;
  readonly knowledge: KnowledgeStore;
  constructor(store: WorkStore, knowledge = new KnowledgeStore(store.assetRoot)) { this.store = store; this.knowledge = knowledge; }

  read(id: string): Comparison {
    const record = comparisonSchema.parse(readJson(this.store.resolvePath("comparisons/" + recordIdSchema.parse(id) + "/record.json")));
    const { knowledgeIndex, baseSnapshot: _snapshot, ...input } = record.input;
    recordedInputSchema.parse(input);
    if (valueHash(knowledgeIndex.map(item => item.ref)) !== valueHash(input.knowledgeRefs)) throw new Error("比较知识索引超出共同版本范围。");
    if (record.id !== id || valueHash(record.input) !== record.inputHash) throw new Error("比较记录的共同输入发生变化。");
    if (record.state === "completed" && !record.evaluation) throw new Error("比较缺少实际评价，不能当作已结束。");
    return record;
  }

  create(raw: z.input<typeof comparisonInputSchema>, operationId: string): Comparison {
    if (this.store.purpose !== "test") throw new Error("比较任务只能在测试入口创建。");
    const input = comparisonInputSchema.parse(raw), id = "comparison-" + valueHash(operationId).slice(0, 24);
    const tasks = (["before", "after"] as const).map(side => ({ side, ...workInputSchema.parse({
      title: input.title + sideSuffixes[side], brief: comparisonBrief(input),
    }) }));
    const directory = this.store.resolvePath("comparisons/" + id);
    if (existsSync(join(directory, "record.json"))) throw new Error("比较编号已存在，请查询原操作。");
    const knowledgeIndex: ExperienceIndex[] = input.knowledgeRefs.map(ref => {
      this.knowledge.read(ref);
      return this.knowledge.index(ref);
    });
    mkdirSync(directory, { recursive: true });
    let baseSnapshot;
    if (input.base) {
      this.knowledge.validateSources([input.base]);
      const sourceStore = this.knowledge.sourceStore(input.base), work = sourceStore.read(input.base.workId);
      const version = sourceStore.version(work, input.base.versionId);
      sourceStore.verifySource(version);
      const source = sourceStore.resolvePath(version.sourcePath);
      const target = this.store.resolvePath("comparisons/" + id + "/base");
      cpSync(join(source, ".."), target, { recursive: true, errorOnExist: true, force: false });
      baseSnapshot = captureSourceSnapshot(join(target, "entry.tsx"));
      if (valueHash(baseSnapshot) !== valueHash(version.sourceSnapshot)) throw new Error("复制后的比较工程与原基线不一致。");
    }
    const definition = { ...input, knowledgeIndex, ...(baseSnapshot ? { baseSnapshot } : {}) }, inputHash = valueHash(definition);
    const record: Comparison = { schemaVersion: 1, id, state: "open", inputHash, input: definition,
      createdAt: new Date().toISOString(), workIds: { before: this.store.plannedWorkId(operationId + "-before"), after: this.store.plannedWorkId(operationId + "-after") } };
    atomicJson(join(directory, "record.json"), record);
    for (const { side, title, brief } of tasks) {
      this.store.create(title, brief, operationId + "-" + side, { id, side, inputHash });
    }
    return record;
  }

  context(work: WorkRecord): Comparison | undefined {
    if (!work.comparison) return undefined;
    if (this.store.purpose !== "test") throw new Error("比较作品不能在正式入口执行。");
    const comparison = this.read(work.comparison.id);
    if (comparison.workIds[work.comparison.side] !== work.id || comparison.inputHash !== work.comparison.inputHash) throw new Error("作品与比较输入的关联不一致。");
    if (readFileSync(this.store.resolvePath(work.briefPath), "utf8") !== "# 原始需求\n\n" + comparisonBrief(comparison.input) + "\n") throw new Error("比较任务的原始需求已变化。");
    return comparison;
  }

  prepare(work: WorkRecord, target: string): Comparison | undefined {
    const comparison = this.context(work);
    if (!comparison) return undefined;
    if (comparison.state !== "open") throw new Error("比较已结束；新的制作要求须创建新任务。");
    if (work.versions.length > 1 || work.feedback.length) throw new Error("比较使用首次制作及固定修改要求，额外反馈请另开比较。");
    if (comparison.input.baseSnapshot) {
      const base = this.store.resolvePath("comparisons/" + comparison.id + "/base/entry.tsx");
      verifySourceSnapshot(base, comparison.input.baseSnapshot);
      cpSync(join(base, ".."), target, { recursive: true });
      verifySourceSnapshot(join(target, "entry.tsx"), comparison.input.baseSnapshot);
    }
    return comparison;
  }

  async evaluate(id: string, input: { beforeVersionId: string; afterVersionId: string; verdict: "improved" | "regressed" | "mixed" | "inconclusive"; observations: string; source: "user" | "external_ai" }) {
    z.string().trim().min(1).max(20_000).parse(input.observations);
    const comparison = this.read(id);
    return this.store.withLock(comparison.workIds.before, () => this.store.withLock(comparison.workIds.after, () => {
      const current = this.read(id);
      if (current.state !== "open") throw new Error("比较已有评价，保留原结果；修订请建立新的比较。");
      const conditions: Record<string, unknown> = {};
      for (const side of ["before", "after"] as const) {
        const work = this.store.read(current.workIds[side]), membership = this.context(work);
        if (membership?.id !== current.id || work.comparison?.side !== side) throw new Error("作品的比较归属不一致，不能登记本轮评价。");
        const version = this.store.version(work, side === "before" ? input.beforeVersionId : input.afterVersionId);
        if (work.versions.length !== 1 || work.feedback.length) throw new Error("比较包含额外制作或人工反馈，不能作为同条件初稿比较。");
        if (!["ready", "failed", "blocked"].includes(version.production) || !version.systemFingerprint || !version.executionConditions) throw new Error("比较结果尚未取得可靠状态或系统版本依据。");
        if (version.production === "ready") this.store.assertAvailable(version);
        if (version.knowledgeUsed?.some(ref => !current.input.knowledgeRefs.some(allowed => valueHash(ref) === valueHash(allowed)))) throw new Error("比较使用了共同范围之外的经验。");
        conditions[side] = { systemFingerprint: version.systemFingerprint, model: version.model, kind: version.kind,
          execution: version.executionConditions,
          production: version.production, knowledgeUsed: version.knowledgeUsed ?? [],
          videoSha256: version.videoSha256, error: version.error };
      }
      const before = conditions.before as Record<string, unknown>, after = conditions.after as Record<string, unknown>;
      conditions.differences = ["systemFingerprint", "model", "kind", "execution", "knowledgeUsed"]
        .filter(key => valueHash(before[key] ?? null) !== valueHash(after[key] ?? null));
      conditions.note = "差异须结合声明的改动判断，未受控差异不能归因为单一改动；记录不代替观看评价。";
      const record: Comparison = { ...current, state: "completed", evaluation: { ...input, conditions, evaluatedAt: new Date().toISOString() } };
      atomicJson(this.store.resolvePath("comparisons/" + id + "/record.json"), record);
      return record;
    }));
  }
}
