import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkStore } from "../src/records/work-store.ts";
import type { WorkRecord } from "../src/records/work-store.ts";
import { KnowledgeStore, pendingLearningSources, experienceInputSchema } from "../src/records/knowledge-store.ts";
import { ComparisonStore } from "../src/records/comparison-store.ts";
import { DocumentStore } from "../src/records/document-store.ts";
import { atomicJson, immutableJson, valueHash } from "../src/records/files.ts";
import { sourceFingerprint } from "../src/records/source-snapshot.ts";
import { inputs } from "../src/mcp/server.ts";
import { LearningService } from "../src/runtime/learning-service.ts";
import { learningCases } from "../src/runtime/learning-cases.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fakeCodex, fixtureRoot, readyVersion, fixtureProfile } from "./helpers.ts";

function addHistory(store: WorkStore, work: WorkRecord, sizes: number[]) {
  for (const [group, size] of sizes.entries()) {
    const feedbackId = "feedback-" + group, base = "v" + String(work.versions.length + 1).padStart(3, "0");
    work.feedback.push({ id: feedbackId, versionId: base, text: "核对第" + group + "处修改", source: "system_test",
      changesDirection: false, createdAt: new Date().toISOString() });
    for (let index = 0; index < size; index++) {
      const version = readyVersion(store, work.id, "v" + String(work.versions.length + 1).padStart(3, "0"), "sample");
      if (index) { version.basedOnVersionId = base; version.feedbackIds = [feedbackId]; }
      work.versions.push(version);
    }
  }
  store.save(work);
  const pending = pendingLearningSources(work), { caseSources } = learningCases(store, work, pending.items);
  const sourceIds = pending.items.map(source => source.id);
  const proposal = { title: "合成修改方法", problem: "多版本同类问题", method: "结合前后结果核对修改",
    conditions: "相同问题与约束", limitations: "只验证保存行为", keywords: [], sourceIds };
  const result = { checkedSourceIds: sourceIds, notes: "合成来源数量回归", proposals: [proposal] };
  return { sourceIds, caseSources, result };
}

test("九条整理来源展开为108个版本后可完整保存、读取和重复接续", () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("来源展开", "合成记录，不代表经验效果。");
    const { sourceIds, caseSources, result } = addHistory(store, work, Array(9).fill(12));
    const knowledge = new KnowledgeStore(root.path), learning = new LearningService(store, knowledge);
    learning.accept(work, work.versions.at(-1)!, "learning-expanded", result, sourceIds, caseSources);
    const saved = store.read(work.id), ref = saved.learningBatches![0]!.experienceRefs[0]!;
    const experience = knowledge.read(ref);
    assert.equal(experience.sources.length, 108);
    assert.deepEqual(new Set(experience.sources.map(source => "versionId" in source && source.versionId)),
      new Set(work.versions.map(version => version.id)));
    learning.finishPending(saved);
    learning.accept(saved, saved.versions.at(-1)!, "learning-expanded", result, sourceIds, caseSources);
    assert.equal(knowledge.latest().length, 1);
    assert.equal(saved.learningPending, undefined);
  } finally { root.cleanup(); }
});

test("后续候选来源身份冲突在写入批次或任何经验前拒绝", () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("全部候选预检", "合成记录。");
    const { sourceIds, caseSources, result } = addHistory(store, work, [2, 2]);
    const first = caseSources[sourceIds[1]!]![0]!;
    assert("versionId" in first); first.sourceFingerprint = "0".repeat(64);
    result.proposals = sourceIds.map(id => ({ ...result.proposals[0]!, sourceIds: [id] }));
    const knowledge = new KnowledgeStore(root.path), learning = new LearningService(store, knowledge);
    const taskPath = store.resolvePath("works/" + work.id + "/task.json"), before = readFileSync(taskPath);
    assert.throws(() => learning.accept(work, work.versions.at(-1)!, "learning-conflict", result, sourceIds, caseSources), /冻结|不一致/);
    assert.equal(store.read(work.id).learningPending, undefined);
    assert.equal(knowledge.latest().length, 0);
    assert(!existsSync(store.resolvePath("works/" + work.id + "/learning/learning-conflict.json")));
    assert.deepEqual(readFileSync(taskPath), before);
  } finally { root.cleanup(); }
});

for (const count of [100, 101, 601]) test("来源容量边界完整贯通保存、读取及外部契约：" + count, () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("来源边界", "合成数量检查。");
    const expanded = Math.min(count, 600), sizes = Array(Math.floor(expanded / 12)).fill(12);
    if (expanded % 12) sizes.push(expanded % 12);
    const { sourceIds, caseSources, result } = addHistory(store, work, sizes);
    if (count === 601) {
      // 第601个版本没有参与这50条反馈，仍是本轮必须计入的关联版本。
      work.versions.push(readyVersion(store, work.id, "v601", "sample")); store.save(work);
      assert.equal(sourceIds.length, 50);
    }
    const knowledge = new KnowledgeStore(root.path), learning = new LearningService(store, knowledge);
    learning.accept(work, work.versions.at(-1)!, "learning-boundary", result, sourceIds, caseSources);
    const experience = knowledge.read(work.learningBatches![0]!.experienceRefs[0]!);
    assert.equal(experience.sources.length, count);
    const { id: _id, revision: _revision, createdAt: _createdAt, ...input } = experience;
    assert(inputs.save_experience.safeParse({ operationId: "external-boundary", experience: input }).success);
    if (count === 601) {
      const extra = readyVersion(store, work.id, "v602", "sample"); work.versions.push(extra); store.save(work);
      const current = work.versions.find(version => version.id === "v601")!;
      caseSources[sourceIds[0]!]!.push({ purpose: store.purpose, workId: work.id, versionId: current.id,
        sourceFingerprint: sourceFingerprint(current.sourceSnapshot!), feedbackIds: [] });
      const invalid = { ...result, proposals: [{ ...result.proposals[0]!, sourceIds: [sourceIds[1]!] }, result.proposals[0]!] };
      assert.throws(() => learning.accept(work, extra, "learning-over-capacity", invalid, sourceIds, caseSources), /601/);
      assert.equal(store.read(work.id).learningPending, undefined);
      assert.equal(knowledge.latest().length, 1, "后面的候选超限时，不先保存前面的合法候选");
      assert(!existsSync(store.resolvePath("works/" + work.id + "/learning/learning-over-capacity.json")));
      assert(!experienceInputSchema.safeParse({ ...input, sources: [...input.sources, { purpose: store.purpose,
        workId: work.id, versionId: extra.id, sourceFingerprint: sourceFingerprint(extra.sourceSnapshot!), feedbackIds: [] }] }).success);
    }
  } finally { root.cleanup(); }
});

test("旧超限待保存批次原样补存，不重发模型或改写原批次", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("旧批次恢复", "合成旧数量错误。");
    const { sourceIds, caseSources, result } = addHistory(store, work, Array(9).fill(12));
    work.learningPending = { id: "learning-old-overflow", versionId: work.versions.at(-1)!.id,
      sourceIds, caseSources, result, createdAt: new Date().toISOString() };
    work.learningError = "Too big: expected array to have <=100 items"; store.save(work);
    const path = store.resolvePath("works/" + work.id + "/learning/learning-old-overflow.json");
    // 与旧 accept/finishPending 一样，使用持久契约的字段顺序生成不可变批次。
    immutableJson(path, { workId: work.id, ...store.read(work.id).learningPending });
    const before = readFileSync(path), codex = fakeCodex(root.path, "read_only");
    const service = new WorkService(store, { codexExecutable: codex });
    const recovered = await service.organize(work.id);
    assert.equal(recovered.learningPending, undefined); assert.equal(recovered.learningError, undefined);
    assert.equal(service.knowledge.read(recovered.learningBatches![0]!.experienceRefs[0]!).sources.length, 108);
    await service.organize(work.id);
    assert.equal(service.knowledge.latest().length, 1);
    assert(!existsSync(join(root.path, "native-fixture/calls.jsonl")), "补存不启动原生模型调用");
    assert.deepEqual(readFileSync(path), before);
  } finally { root.cleanup(); }
});

test("多个大候选中途保存失败后保持原引用与批次，重复接续不重复创建", () => {
  const root = fixtureRoot();
  class Interrupted extends KnowledgeStore {
    calls = 0;
    override save(...args: Parameters<KnowledgeStore["save"]>) {
      const ref = super.save(...args);
      if (++this.calls === 2) throw new Error("合成：第二条保存后中断");
      return ref;
    }
  }
  try {
    const store = new WorkStore(root.path), work = store.create("部分保存", "合成中断。");
    const { sourceIds, caseSources, result } = addHistory(store, work, Array(9).fill(12));
    result.proposals.push({ ...result.proposals[0]!, title: "另一条合成方法" });
    const knowledge = new Interrupted(root.path), learning = new LearningService(store, knowledge);
    assert.throws(() => learning.accept(work, work.versions.at(-1)!, "learning-interrupted", result, sourceIds, caseSources), /第二条保存后中断/);
    const saved = store.read(work.id), refs = knowledge.latest().map(item => item.ref);
    assert(saved.learningPending); assert.equal(refs.length, 2);
    const path = store.resolvePath("works/" + work.id + "/learning/learning-interrupted.json"), before = readFileSync(path);
    learning.finishPending(saved); learning.finishPending(store.read(work.id));
    assert.deepEqual(knowledge.latest().map(item => item.ref), refs);
    assert.equal(store.read(work.id).learningBatches!.length, 1);
    assert.deepEqual(readFileSync(path), before);
  } finally { root.cleanup(); }
});

test("混合稿件与视频来源去重，稿件文件暂缺仍可沿原批次接续", () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), initial = store.create("混合来源", "合成稿件与视频。");
    const documents = new DocumentStore(store); documents.initialize(initial, "原稿", "draft-initial");
    const work = store.read(initial.id), old = work.authoring!.drafts[0]!;
    const next = documents.append(work, "draft", "修订稿", { operationId: "draft-next", source: "external_ai",
      instruction: "合成修改", assetIds: [], basedOn: old });
    const { sourceIds, caseSources, result } = addHistory(store, work, [2]);
    caseSources[sourceIds[0]!]!.push({ kind: "document", purpose: store.purpose, workId: work.id,
      documentRef: { id: next.id, sha256: next.sha256 } });
    const oldPath = store.resolvePath(old.path), bytes = readFileSync(oldPath); rmSync(oldPath);
    const knowledge = new KnowledgeStore(root.path), learning = new LearningService(store, knowledge);
    assert.throws(() => learning.accept(work, work.versions.at(-1)!, "learning-mixed", result, sourceIds, caseSources), /ENOENT/);
    assert(store.read(work.id).learningPending); assert.equal(knowledge.latest().length, 0);
    writeFileSync(oldPath, bytes); learning.finishPending(store.read(work.id));
    const experience = knowledge.read(store.read(work.id).learningBatches![0]!.experienceRefs[0]!);
    assert.equal(experience.sources.length, 4);
    assert.deepEqual(experience.sources.filter(source => "documentRef" in source).map(source => source.documentRef.id).sort(), [old.id, next.id]);
    writeFileSync(oldPath, "被篡改的稿件");
    assert.throws(() => knowledge.read(knowledge.latest()[0]!.ref), /稿件内容/);
  } finally { root.cleanup(); }
});

for (const missing of ["snapshot", "file"] as const) test("来源暂缺保留待保存状态，恢复真实依据后可补存：" + missing, () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("来源暂缺", "合成文件恢复。");
    const { sourceIds, result } = addHistory(store, work, [2]);
    const version = work.versions[0]!, snapshot = version.sourceSnapshot!, path = store.resolvePath(version.sourcePath), bytes = readFileSync(path);
    if (missing === "snapshot") { version.sourceSnapshot = undefined; store.save(work); }
    else rmSync(path);
    const knowledge = new KnowledgeStore(root.path), learning = new LearningService(store, knowledge);
    // 旧批次没有 caseSources；缺值必须保持未知，不能以默认指纹通过预检后的保存。
    assert.throws(() => learning.accept(work, work.versions.at(-1)!, "learning-missing", result, sourceIds), /完整快照|工程缺少 entry\.tsx/);
    const pending = store.read(work.id); assert(pending.learningPending); assert.equal(knowledge.latest().length, 0);
    if (missing === "snapshot") { pending.versions[0]!.sourceSnapshot = snapshot; store.save(pending); }
    else writeFileSync(path, bytes);
    learning.finishPending(store.read(work.id));
    assert.equal(knowledge.latest().length, 1); assert.equal(store.read(work.id).learningPending, undefined);
  } finally { root.cleanup(); }
});

test("比较暂存也先校验全部候选；完成后沿冻结大批次发布并保留原文", () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "testing"), "test", root.path), knowledge = new KnowledgeStore(root.path);
    const comparisons = new ComparisonStore(store, knowledge), comparison = comparisons.create({ title: "合成暂存", brief: "只验证暂存发布",
      kind: "creation", change: "保存容量", knowledgeRefs: [], profileRef: fixtureProfile.ref }, "staged-capacity");
    const work = store.read(comparison.workIds.before), { sourceIds, caseSources, result } = addHistory(store, work, Array(9).fill(12));
    const learning = new LearningService(store, knowledge), invalid = structuredClone(caseSources);
    const altered = invalid[sourceIds[1]!]![1]!; assert("versionId" in altered); altered.sourceFingerprint = "0".repeat(64);
    assert.throws(() => learning.accept(work, work.versions.at(-1)!, "learning-invalid-stage", result, sourceIds, invalid), /冻结/);
    assert.equal(store.read(work.id).learningPending, undefined); assert.equal(store.read(work.id).learningBatches, undefined);
    learning.accept(work, work.versions.at(-1)!, "learning-staged-capacity", result, sourceIds, caseSources);
    assert(work.learningBatches![0]!.staged); assert.equal(knowledge.latest().length, 0);
    assert.throws(() => learning.publishStaged(work), /比较尚未结束/);
    const path = store.resolvePath("works/" + work.id + "/learning/learning-staged-capacity.json"), before = readFileSync(path);
    // 隔离夹具模拟比较已完成，只验证容量、发布门槛与冻结内容，不代表合法初稿比较的制作过程。
    atomicJson(store.resolvePath("comparisons/" + comparison.id + "/record.json"), { ...comparison, state: "completed",
      evaluation: { beforeVersionId: "v108", afterVersionId: "v001", verdict: "inconclusive", observations: "合成发布边界",
        source: "external_ai", conditions: {}, evaluatedAt: new Date().toISOString() } });
    learning.publishStaged(store.read(work.id)); learning.publishStaged(store.read(work.id));
    const batch = store.read(work.id).learningBatches![0]!;
    assert.equal(knowledge.read(batch.experienceRefs[0]!).sources.length, 108);
    assert.equal(knowledge.latest().length, 1); assert.equal(batch.staged, false);
    assert.equal(batch.draftSha256, valueHash(JSON.parse(before.toString())));
    assert.deepEqual(readFileSync(path), before);
  } finally { root.cleanup(); }
});
