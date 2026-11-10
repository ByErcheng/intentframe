import assert from "node:assert/strict";
import { fileHash } from "../src/common/file-hash.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import type { WorkRecord } from "../src/records/work-store.ts";
import { KnowledgeStore, pendingLearningSources } from "../src/records/knowledge-store.ts";
import type { ExperienceInput } from "../src/records/knowledge-store.ts";
import { sourceFingerprint } from "../src/records/source-snapshot.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

function example(store: WorkStore) {
  const work = store.create("经验来源", "合成字幕布局任务，不代表真实作品。");
  work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
  const input: ExperienceInput = {
    title: "字幕避让主体", problem: "字幕与主体重叠", method: "按主体位置调整字幕区域，然后观看复查。",
    conditions: "主体与字幕位置接近", limitations: "合成数据仅验证记录与调用，不证明效果。", keywords: ["字幕", "主体"],
    status: "candidate", use: "reusable", sources: [{ purpose: store.purpose, workId: work.id, versionId: "v001",
      sourceFingerprint: sourceFingerprint(work.versions[0]!.sourceSnapshot!), feedbackIds: [] }],
  };
  return { work, input };
}

function turnCount(root: string) {
  return readFileSync(join(root, "native-fixture/calls.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(call => call.method === "turn/start").length;
}

test("无效经验撤销或版本更新不留下新目录，也不破坏已有搜索和读取", () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), { input } = example(store), knowledge = new KnowledgeStore(root.path);
    const ref = knowledge.save(input), original = knowledge.read(ref);
    for (const [id, value, expectedRevision, message] of [
      ["missing-withdrawal", { ...input, status: "withdrawn" as const }, 0, /已有经验/],
      ["missing-revision", input, 1, /版本已变化/],
      [ref.id, { ...input, method: "过期修改" }, 0, /版本已变化/],
    ] as const) {
      assert.throws(() => knowledge.save(value, { id, expectedRevision }), message);
      if (id !== ref.id) assert(!existsSync(join(knowledge.root, "items", id)));
      assert.deepEqual(knowledge.search("字幕").items.map(item => item.ref), [ref]);
      assert.deepEqual(knowledge.read(ref), original);
    }
    const updated = knowledge.save({ ...input, method: "有效更新" }, { id: ref.id, expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    knowledge.save({ ...input, status: "withdrawn" }, { id: ref.id, expectedRevision: 2 });
    assert.equal(knowledge.search("字幕").items.length, 0);
  } finally { root.cleanup(); }
});

test("正式与测试经验共享入口，证据、用途、历史版本与停止采用分别校验", async () => {
  const root = fixtureRoot();
  try {
    const production = new WorkStore(root.path, "production", root.path);
    const testing = new WorkStore(join(root.path, "testing"), "test", root.path);
    const first = example(production), second = example(testing), knowledge = new KnowledgeStore(root.path);
    const a = knowledge.save(first.input), b = knowledge.save(second.input);
    assert.equal(knowledge.search("字幕").items.length, 2);
    assert.equal(knowledge.read(b).sources[0]!.purpose, "test");
    assert.equal(production.list().length, 1); assert.equal(testing.list().length, 1);
    assert.throws(() => knowledge.save({ ...first.input, status: "verified", verification: "声称通过" }), /复查通过/);
    await production.review(first.work.id, "v001", "passed", "合成测试：验证记录前提，非作品效果。", "internal_check");
    const verified = knowledge.save({ ...first.input, status: "verified", verification: "仅核对本例，不能推广效果。" }, { id: a.id, expectedRevision: 1 });
    assert.equal(verified.revision, 2); assert.equal(knowledge.read(a).status, "candidate");
    const restricted = knowledge.save({ ...second.input, use: "evaluation_only" });
    assert(!knowledge.search("字幕").items.some(item => item.ref.id === restricted.id));
    assert.throws(() => knowledge.read(restricted), /评价专用/);
    const unavailable = testing.resolvePath(second.work.versions[0]!.sourcePath);
    rmSync(unavailable);
    assert.throws(() => knowledge.read(b), /ENOENT|不存在|缺少|变化/);
    // 原依据缺失仍可撤销，不能继续把旧版本当作有效经验返回。
    knowledge.save({ ...second.input, status: "withdrawn" }, { id: b.id, expectedRevision: 1 });
    assert.throws(() => knowledge.read(b), /停止采用/);
    assert.equal(knowledge.read(b, { evaluation: true, verifySources: false }).status, "candidate");
    assert.throws(() => knowledge.read({ ...a, sha256: "0".repeat(64) }), /指定版本/);
    const feedback = await production.feedback(first.work.id, "v001", "只调整当前画面的字幕", "user");
    feedback.versions.push(readyVersion(production, first.work.id, "v002", "sample")); production.save(feedback);
    assert.throws(() => knowledge.save({ ...first.input, sources: [{ ...first.input.sources[0]!, versionId: "v002",
      sourceFingerprint: sourceFingerprint(feedback.versions[1]!.sourceSnapshot!), feedbackIds: [feedback.feedback[0]!.id] }] }), /来源版本/);
  } finally { root.cleanup(); }
});

test("同一主 AI 实际调用经验工具，保存采用版本与必要规则的输入依据", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), source = example(store), knowledge = new KnowledgeStore(root.path);
    const ref = knowledge.save(source.input), next = store.create("相关任务", "字幕不要遮挡画面主体。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "use_experience"), render: fixtureRender });
    const work = await service.produce(next.id, "sample"), version = work.versions[0]!;
    assert.deepEqual(version.knowledgeUsed, [ref]);
    const text = readFileSync(store.resolvePath(version.sourcePath), "utf8");
    assert(text.includes(ref.sha256));
    const context = readFileSync(store.resolvePath(version.sourcePath.replace("entry.tsx", "context.md")), "utf8");
    assert(context.includes("字幕不要遮挡"));
    assert(version.inputManifestPath && version.inputManifestSha256);
    assert.equal(fileHash(store.resolvePath(version.inputManifestPath)), version.inputManifestSha256);
    const input = JSON.parse(readFileSync(store.resolvePath(version.inputManifestPath), "utf8"));
    assert(input.developerInstructions.includes("试做与方向确认"));
    assert.deepEqual(input.context, context);
    assert(input.sources.every((source: { path: string; sha256: string; text: string }) => source.path.startsWith("prompts/") && source.sha256 && source.text));
    assert(input.outputSchema.properties.status);
    assert(existsSync(store.resolvePath("works/" + work.id + "/runs/" + version.runId + "/knowledge/" + ref.id + "-1.json")));
    assert.equal(knowledge.search("完全不相关的火星地质").coverage, "not_found");
    writeFileSync(store.resolvePath(source.work.versions[0]!.sourcePath), "// 已变化");
    assert.throws(() => service.learning.tools(work, "read-check").call("intentframe_read_experience", ref), /工程或制作依赖/);
  } finally { root.cleanup(); }
});

test("经验保存中断保留原批次，接续不再调用模型且不重复累积", async () => {
  const root = fixtureRoot();
  class FlakyKnowledge extends KnowledgeStore {
    fail = true;
    override save(...args: Parameters<KnowledgeStore["save"]>) {
      const ref = super.save(...args);
      if (this.fail) { this.fail = false; throw new Error("合成：已保存候选但未推进进度"); }
      return ref;
    }
  }
  try {
    const store = new WorkStore(root.path), { work } = example(store), knowledge = new FlakyKnowledge(root.path);
    await store.feedback(work.id, "v001", "字幕移开主体", "user");
    const service = new WorkService(store, { knowledge, codexExecutable: fakeCodex(root.path, "learn_method") });
    await assert.rejects(service.organize(work.id), /未推进进度/);
    const interrupted = store.read(work.id);
    assert(interrupted.learningPending); assert.equal(interrupted.learningBatches?.length ?? 0, 0);
    assert.equal(pendingLearningSources(interrupted).pendingCount, 1);
    assert.equal(knowledge.latest().length, 1);
    const recovered = await service.organize(work.id);
    assert.equal(recovered.learningPending, undefined); assert.equal(recovered.learningBatches?.length, 1);
    assert.equal(knowledge.latest().length, 1); assert.equal(turnCount(root.path), 1);
    assert.equal(service.learning.pending(recovered).pendingCount, 0);
    await service.organize(work.id); assert.equal(turnCount(root.path), 1);
    const record = knowledge.read(recovered.learningBatches![0]!.experienceRefs[0]!);
    assert.equal(record.status, "candidate"); assert.equal(record.sources[0]!.feedbackIds.length, 1);
    await store.feedback(work.id, "v001", "这次试验使用蓝色，不是长期偏好", "system_test");
    const unchanged = await new WorkService(store, { knowledge, codexExecutable: fakeCodex(root.path) }).organize(work.id);
    assert.equal(knowledge.latest().length, 1, "允许检查后没有可复用发现");
    assert.equal(unchanged.learningBatches?.length, 2);
  } finally { root.cleanup(); }
});

test("整理中断可查回原只读结果；部分整理与长反馈仍有明确待办", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), { work } = example(store);
    await store.feedback(work.id, "v001", "第一次修改字幕", "user");
    await store.feedback(work.id, "v001", "第二次核对主体", "user");
    await assert.rejects(new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result") }).organize(work.id));
    assert.equal(store.read(work.id).execution.status, "unknown");
    const recovery = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only") });
    assert.equal((await recovery.recover(work.id)).status, "recovered");
    assert.equal(store.read(work.id).execution.status, "idle"); assert.equal(turnCount(root.path), 1);
    assert.equal(recovery.learning.pending(store.read(work.id)).pendingCount, 0);
    const before = store.read(work.id);
    for (let n = 0; n < 3; n++) before.feedback.push({ id: "long-" + n, versionId: "v001", text: "字幕".repeat(4_900), source: "system_test", changesDirection: false, createdAt: new Date().toISOString() });
    store.save(before);
    const pending = recovery.learning.pending(before);
    assert(pending.remaining > 0); assert.equal(pending.pendingCount, 3);
    const tools = recovery.learning.tools(before, "paging");
    const page = tools.call("intentframe_list_feedback", { offset: 0, limit: 1 }) as { nextOffset: number };
    assert.equal(page.nextOffset, 1); assert.equal(tools.feedbackReads.size, 0);
    tools.call("intentframe_read_feedback", { ids: ["long-2"] }); assert(tools.feedbackReads.has("long-2"));
    assert.throws(() => tools.call("intentframe_read_feedback", { ids: ["other-work"] }), /不属于/);
    const partial = await new WorkService(store, { codexExecutable: fakeCodex(root.path, "partial_learning") }).organize(work.id);
    assert.equal(recovery.learning.pending(partial).pendingCount, 2);
    assert.equal(partial.learningBatches?.at(-1)?.checkedSourceIds.length, 1);
  } finally { root.cleanup(); }
});

test("整理请求被明确拒绝时保留待办和原执行状态，允许后续整理与制作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), { work } = example(store);
    await new WorkService(store, { codexExecutable: fakeCodex(root.path, "needs_input") }).produce(work.id, "sample");
    await store.feedback(work.id, "v001", "补充字幕布局参考", "user");
    const original = store.read(work.id);
    assert.equal(original.execution.status, "waiting_input");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only") });
    const pending = service.learning.pending(original);
    await assert.rejects(service.organize(work.id), /恢复测试禁止新制作/);
    const rejected = store.read(work.id), run = rejected.learningRun!;
    assert.deepEqual(rejected.execution, original.execution, "明确未执行的整理不能覆盖此前的制作状态");
    assert.equal(run.completed, true);
    assert.equal(run.turnId, undefined);
    assert.match(rejected.learningError!, /恢复测试禁止新制作/);
    assert.deepEqual(service.learning.pending(rejected), pending);
    assert.equal(rejected.learningBatches?.length ?? 0, original.learningBatches?.length ?? 0);
    const history = JSON.parse(readFileSync(join(root.path, "native-fixture/history.json"), "utf8"));
    assert.equal(history.threads[run.threadId!].turns.length, 0, "被拒绝的请求没有可恢复的原执行轮次");

    const continuation = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const organized = await continuation.organize(work.id);
    assert.deepEqual(organized.execution, original.execution);
    assert.equal(continuation.learning.pending(organized).pendingCount, 0);
    const produced = await continuation.produce(work.id, "sample");
    assert.equal(produced.versions.length, original.versions.length + 1);
    assert.equal(produced.versions.at(-1)!.production, "ready");
  } finally { root.cleanup(); }
});

test("原整理终态明确但内容无效时保留待办，不永久停在未知执行", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), { work } = example(store);
    await store.feedback(work.id, "v001", "字幕与主体需要分开", "user");
    await assert.rejects(new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result") }).organize(work.id));
    const historyPath = join(root.path, "native-fixture/history.json"), history = JSON.parse(readFileSync(historyPath, "utf8"));
    const run = store.read(work.id).learningRun!;
    const native = history.threads[run.threadId!].turns.find((turn: { id: string }) => turn.id === run.turnId);
    native.items.find((item: { phase?: string }) => item.phase === "final_answer").text = "合成：不是有效的结构化整理结果";
    writeFileSync(historyPath, JSON.stringify(history));
    const recovery = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only") });
    await assert.rejects(recovery.recover(work.id));
    const result = store.read(work.id);
    assert.equal(result.execution.status, "idle"); assert.equal(result.learningRun!.completed, true);
    assert(result.learningError); assert.equal(recovery.learning.pending(result).pendingCount, 1);
    assert.equal(result.learningBatches?.length ?? 0, 0); assert.equal(turnCount(root.path), 1);
  } finally { root.cleanup(); }
});

test("作品已完成后经验记录连续写入失败，恢复只补经验且保留作品完成事实", async () => {
  const root = fixtureRoot();
  class FlakyStore extends WorkStore {
    remainingFailures = 2;
    override save(work: WorkRecord) {
      if (work.learningPending && this.remainingFailures-- > 0) throw new Error("合成：经验记录保存失败");
      super.save(work);
    }
  }
  try {
    const store = new FlakyStore(root.path), { work } = example(store);
    await store.feedback(work.id, "v001", "字幕移开主体", "user");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "learn_method"), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample"), /经验记录保存失败/);
    const interrupted = store.read(work.id);
    assert.equal(interrupted.versions.at(-1)!.production, "ready"); assert(interrupted.learningPending);
    assert.equal(store.availability(interrupted.versions.at(-1)!).status, "available");
    assert.equal(interrupted.execution.status, "failed");
    assert.match(interrupted.versions.at(-1)!.error!, /经验记录保存失败/);
    const eventsPath = store.resolvePath("works/" + work.id + "/runs/" + interrupted.versions.at(-1)!.runId + ".jsonl");
    const events = readFileSync(eventsPath, "utf8");
    assert(events.includes('"kind":"execution_error"'));
    class UnavailableKnowledge extends KnowledgeStore {
      override save(..._args: Parameters<KnowledgeStore["save"]>): never { throw new Error("合成：经验仍无法保存"); }
    }
    await assert.rejects(new WorkService(store, { knowledge: new UnavailableKnowledge(root.path) }).recover(work.id), /经验仍无法保存/);
    const stillPending = store.read(work.id);
    assert(stillPending.learningPending);
    assert.deepEqual(stillPending.execution, interrupted.execution, "剩余保存仍失败时不能清除当前执行错误");
    assert.equal(stillPending.versions.at(-1)!.error, interrupted.versions.at(-1)!.error);
    assert.equal((await service.recover(work.id)).status, "recovered");
    const restored = store.read(work.id);
    assert.equal(restored.learningPending, undefined); assert.equal(restored.learningError, undefined);
    assert.deepEqual(restored.execution, { status: "idle" });
    assert.equal(restored.versions.at(-1)!.error, undefined);
    assert.equal(store.list()[0]!.execution, "idle");
    assert.equal(restored.learningBatches?.length, 1); assert.equal(service.knowledge.latest().length, 1);
    assert.equal(restored.versions.length, 2); assert.equal(turnCount(root.path), 1);
    assert.equal(readFileSync(eventsPath, "utf8"), events, "恢复当前状态不能删除历史失败证据");
    await service.recover(work.id);
    assert.deepEqual(store.read(work.id), restored, "重复恢复不重新制作或重复保存经验");
    assert.equal(turnCount(root.path), 1);
  } finally { root.cleanup(); }
});
