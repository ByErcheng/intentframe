import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeToolInline } from "../src/mcp/server.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { selectProduction } from "../src/runtime/production-selection.ts";
import { fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

async function feedbackApplications(service: WorkService, workId: string) {
  const view = await executeToolInline("get_work", { view: "detail", workId }, service) as {
    feedback: { id: string; appliedInVersionIds: string[] }[];
  };
  return view.feedback.map(item => item.appliedInVersionIds);
}

function baseline(root: string) {
  const store = new WorkStore(root), work = store.create("反馈证据", "合成任务，仅验证反馈记录与交接。");
  const version = readyVersion(store, work.id, "v001", "sample");
  version.directionId = version.id;
  work.versions.push(version); store.save(work);
  return { store, work };
}

test("未读取长反馈的应用声明被拒绝后，查询和备选范围仍保留未完成事实", async () => {
  const root = fixtureRoot();
  try {
    const { store, work } = baseline(root.path);
    for (let n = 0; n < 3; n++) await store.feedback(work.id, "v001", n + "长反馈".repeat(3_000), "user");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, undefined,
      { newDirection: true }), /未取得原文/);
    const failed = store.read(work.id), version = failed.versions.at(-1)!, ids = failed.feedback.map(item => item.id);
    assert.equal(version.production, "failed");
    assert.deepEqual(version.agentResult?.appliedFeedbackIds, ids, "原始声明仍保留供追溯");
    assert.equal(version.appliedFeedbackIds, undefined);
    assert.deepEqual(await feedbackApplications(service, work.id), [[], [], []]);
    assert.deepEqual(selectProduction(store, failed, "sample", undefined, "fresh", "v001").requested, ids,
      "失败的备选创建不能排除原方向仍未完成的要求");
    await assert.rejects(service.recover(work.id), /未取得原文/);
    assert.deepEqual(await feedbackApplications(service, work.id), [[], [], []]);
  } finally { root.cleanup(); }
});

test("已读取反馈但缺少工程入口时，完成声明不会成为查询中的应用事实", async () => {
  const root = fixtureRoot();
  try {
    const { store, work } = baseline(root.path);
    const record = await store.feedback(work.id, "v001", "字幕放大", "user");
    const source = readFileSync(store.resolvePath(record.versions[0]!.sourcePath));
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "missing_source"), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample"), /没有可核对的工程入口/);
    const version = store.read(work.id).versions.at(-1)!;
    assert.equal(version.production, "failed"); assert.equal(version.sourceSnapshot, undefined);
    assert.deepEqual(version.agentResult?.appliedFeedbackIds, [record.feedback[0]!.id]);
    assert.deepEqual(await feedbackApplications(service, work.id), [[]]);
    assert.deepEqual(readFileSync(store.resolvePath(record.versions[0]!.sourcePath)), source);
  } finally { root.cleanup(); }
});

test("查询保留已核验的部分修改，并区分本轮应用与后续继承", async t => {
  for (const mode of ["completed", "partial_input", "partial_failed"]) await t.test(mode, async () => {
    const root = fixtureRoot();
    try {
      const { store, work } = baseline(root.path);
      await store.feedback(work.id, "v001", "字幕放大", "user");
      await store.feedback(work.id, "v001", "结尾延长", "user");
      const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, mode), render: fixtureRender });
      if (mode === "partial_failed") await assert.rejects(service.produce(work.id, "sample"), /完成测试源码/);
      else await service.produce(work.id, "sample");
      const expected = [["v002"], mode === "partial_input" ? [] : ["v002"]];
      assert.deepEqual(await feedbackApplications(service, work.id), expected);
      if (mode !== "partial_failed") {
        const checked = store.read(work.id);
        assert.equal(checked.learningError, undefined);
        assert.deepEqual(checked.learningBatches?.at(-1)?.checkedSourceIds, checked.feedback.map(item => "feedback:" + item.id),
          "已内联反馈无需再次调用读取工具即可整理");
      }
      const next = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
      const continued = await next.produce(work.id, "sample", undefined, "fresh", undefined, undefined, undefined, { feedbackIds: [] });
      assert(continued.versions.at(-1)!.appliedFeedbackIds?.includes(continued.feedback[0]!.id));
      assert.deepEqual(continued.versions.at(-1)!.agentResult?.appliedFeedbackIds, []);
      assert.deepEqual(await feedbackApplications(next, work.id), expected, "继承成果不能重复记为本轮处理");
    } finally { root.cleanup(); }
  });
});

test("未读取的继承反馈不能推进整理或保存候选，恢复也不能补认读取", async t => {
  for (const mode of ["completed", "learn_method"]) await t.test(mode, async () => {
    const root = fixtureRoot();
    try {
      const { store, work } = baseline(root.path);
      const record = await store.feedback(work.id, "v001", "字幕避开主体", "user"), id = record.feedback[0]!.id;
      // 模拟基线已处理、但尚未整理的反馈；本轮只继承，不重新选入。
      record.versions[0]!.appliedFeedbackIds = [id]; store.save(record);
      const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, mode), render: fixtureRender });
      const produced = await service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, undefined, { feedbackIds: [] });
      const version = produced.versions.at(-1)!;
      assert.equal(version.production, "ready", "经验检查失败不抹掉制作完成事实");
      assert.deepEqual(version.agentResult?.learning?.checkedSourceIds, ["feedback:" + id]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = store.read(work.id);
        assert.match(current.learningError ?? "", /未取得原文/);
        assert.equal(current.learningPending, undefined); assert.equal(current.learningBatches?.length ?? 0, 0);
        assert.deepEqual(service.learning.pending(current).items.map(item => item.id), ["feedback:" + id]);
        assert.equal(service.knowledge.latest().length, 0);
        assert.equal((await service.recover(work.id)).status, "recovered");
      }
      const calls = readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
      const reader = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_history"), render: fixtureRender });
      const checked = await reader.produce(work.id, "sample", undefined, "fresh", undefined, undefined, undefined, { feedbackIds: [] });
      assert.equal(checked.learningError, undefined);
      assert.deepEqual(checked.learningBatches?.at(-1)?.checkedSourceIds, ["feedback:" + id]);
      assert.equal(reader.learning.pending(checked).pendingCount, 0);
    } finally { root.cleanup(); }
  });
});

test("长反馈仅列编号时保留整理待办，取得原文后按本批范围推进", async () => {
  const root = fixtureRoot();
  try {
    const { store, work } = baseline(root.path);
    for (let n = 0; n < 3; n++) await store.feedback(work.id, "v001", n + "长反馈".repeat(3_000), "user");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "needs_input"), render: fixtureRender });
    const waiting = await service.produce(work.id, "sample");
    assert.equal(waiting.versions.at(-1)!.production, "blocked");
    assert.match(waiting.learningError ?? "", /未取得原文/);
    assert.equal(waiting.learningBatches?.length ?? 0, 0);
    assert.equal(service.learning.pending(waiting).pendingCount, 4, "三条反馈及本轮阻塞原因仍待整理");
    const reader = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_feedback"), render: fixtureRender });
    const completed = await reader.produce(work.id, "sample");
    assert.equal(completed.versions.at(-1)!.production, "ready"); assert.equal(completed.learningError, undefined);
    assert.deepEqual(completed.learningBatches?.at(-1)?.checkedSourceIds,
      completed.feedback.slice(0, 2).map(item => "feedback:" + item.id));
    const pending = reader.learning.pending(completed);
    assert.equal(pending.pendingCount, 2, "超出本批交接预算的第三条反馈和阻塞原因仍须保留");
    assert.deepEqual(pending.items.map(item => item.kind), ["feedback", "failure"]);
    assert.deepEqual(await feedbackApplications(reader, work.id), [["v003"], ["v003"], ["v003"]]);
  } finally { root.cleanup(); }
});
