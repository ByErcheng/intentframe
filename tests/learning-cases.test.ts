import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkStore } from "../src/records/work-store.ts";
import { KnowledgeStore, pendingLearningSources } from "../src/records/knowledge-store.ts";
import { learningCases } from "../src/runtime/learning-cases.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fakeCodex, fixtureRoot, readyVersion } from "./helpers.ts";

async function example() {
  const root = fixtureRoot(), store = new WorkStore(root.path), initial = store.create("局部修复案例", "合成需求，保留原文和声音。");
  initial.versions.push(readyVersion(store, initial.id, "v001", "sample")); store.save(initial);
  const work = await store.feedback(initial.id, "v001", "把字幕移开主体，保留原音频。", "user");
  const id = work.feedback[0]!.id;
  const failed = readyVersion(store, work.id, "v002", "sample");
  failed.basedOnVersionId = "v001"; failed.feedbackIds = [id]; failed.production = "failed";
  failed.agentResult = { status: "completed", summary: "未经核实的完成声明", appliedFeedbackIds: [id], unresolvedFeedbackIds: [],
    blockers: [], usedExperienceRefs: [], learning: { checkedSourceIds: [], notes: "合成", proposals: [] } };
  const fixed = readyVersion(store, work.id, "v003", "sample");
  fixed.basedOnVersionId = "v001"; fixed.feedbackIds = [id]; fixed.appliedFeedbackIds = [id];
  fixed.agentResult = { ...failed.agentResult, summary: "实际局部修改，待外部复查" };
  fixed.review = { status: "passed", notes: "只检查合成帧，不表示连续观看" };
  work.versions.push(failed, fixed); store.save(work);
  return { root, store, work, id };
}

test("案例串起原反馈、失败尝试和实际修改，声明与已核验应用分开", async () => {
  const { root, store, work, id } = await example();
  try {
    const source = pendingLearningSources(work).items.find(item => item.id === "feedback:" + id)!;
    const result = learningCases(store, work, [source]);
    assert.deepEqual(result.history.cases[0]!.versionIds, ["v001", "v002", "v003"]);
    assert.deepEqual(result.history.versions[1]!.appliedThisVersion, []);
    assert.deepEqual(result.history.versions[2]!.appliedThisVersion, [id]);
    assert.equal(result.history.versions[2]!.acceptance, "pending");
    assert.deepEqual(result.caseSources[source.id]!.map(ref => "versionId" in ref && ref.versionId), ["v001", "v002", "v003"]);
    work.feedback[0]!.text = "后来变更";
    assert.match(result.history.feedback[0]!.text, /保留原音频/);
    assert.throws(() => learningCases(store, work, [{ ...source, versionId: "v999" }]), /不存在/);
  } finally { root.cleanup(); }
});

test("已整理过的反馈仍作为新复查的案例依据，冻结并随保存失败接续", async () => {
  const { root, store, work, id } = await example();
  class Interrupted extends KnowledgeStore {
    fail = true;
    override save(...args: Parameters<KnowledgeStore["save"]>) {
      const ref = super.save(...args);
      if (this.fail) { this.fail = false; throw new Error("合成：保存后中断"); }
      return ref;
    }
  }
  try {
    work.learningBatches = [{ id: "old-learning", checkedSourceIds: ["feedback:" + id], notes: "已读原反馈", versionId: "v001",
      experienceRefs: [], savedAt: new Date().toISOString(), staged: false }]; store.save(work);
    const knowledge = new Interrupted(root.path), service = new WorkService(store, { knowledge, codexExecutable: fakeCodex(root.path, "learn_method") });
    await assert.rejects(service.organize(work.id), /保存后中断/);
    const interrupted = store.read(work.id), pending = structuredClone(interrupted.learningPending!);
    assert(pending.caseSources); assert.equal(pending.sourceIds.length, 1);
    const input = JSON.parse(readFileSync(store.resolvePath("works/" + work.id + "/learning/" + interrupted.learningRun!.id + "/context.json"), "utf8"));
    assert.match(input.originalBrief, /保留原文和声音/);
    assert.deepEqual(input.caseHistory.cases[0].versionIds, ["v003", "v001"]);
    assert.match(input.caseHistory.feedback[0].text, /保留原音频/);
    assert.deepEqual(input.caseSources, pending.caseSources);
    const before = JSON.stringify(input);
    await service.organize(work.id);
    const result = store.read(work.id), ref = result.learningBatches!.at(-1)!.experienceRefs[0]!;
    const experience = knowledge.read(ref);
    assert.equal(experience.status, "candidate");
    assert.deepEqual(experience.sources.filter(s => "versionId" in s).map(s => s.versionId).sort(), ["v001", "v003"]);
    assert(experience.sources.some(s => "feedbackIds" in s && s.feedbackIds.includes(id)));
    assert.equal(result.learningPending, undefined); assert.equal(knowledge.latest().length, 1);
    assert.equal(JSON.stringify(JSON.parse(readFileSync(store.resolvePath("works/" + work.id + "/learning/" + interrupted.learningRun!.id + "/context.json"), "utf8"))), before);
    const calls = readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
    // 原工程变化不能被案例摘要掩盖。
    writeFileSync(store.resolvePath(work.versions[0]!.sourcePath), "改变的工程");
    assert.throws(() => knowledge.read(ref), /变化|工程/);
  } finally { root.cleanup(); }
});
