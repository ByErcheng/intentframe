import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { executeTool, executeToolInline, inputs, prepareOperation } from "../src/mcp/server.ts";
import { RequestRejected } from "../src/mcp/request-errors.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fillPrompt } from "../src/runtime/prompts.ts";
import { fileHash } from "../src/common/file-hash.ts";
import { selectProduction } from "../src/runtime/production-selection.ts";
import { fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

test("错误参数可定位并纠正，准备回显默认值，拒绝前置条件不登记制作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), service = new WorkService(store);
    assert.throws(() => prepareOperation("create_work", { title: "合成", brief: "需求" }), error => {
      assert(error instanceof RequestRejected);
      assert.equal(error.details.issues[0]?.field, "purpose");
      assert.match(error.message, /test/); assert.match(error.message, /production/); return true;
    });
    const work = store.create("校验", "合成需求");
    const prepared = prepareOperation("produce_version", { workId: work.id, kind: "sample", feedbackIds: [] });
    assert.equal(inputs.produce_version.parse(prepared.arguments).threadMode, "fresh");
    assert.equal(inputs.produce_version.parse(prepared.arguments).newDirection, false);
    assert.throws(() => prepareOperation("produce_version", { workId: work.id, kind: "sample", feedbackId: "" }), RequestRejected);
    assert.throws(() => prepareOperation("produce_version", { workId: work.id, kind: "sample", feedbackIds: [], feedbackId: "a" }), /不能同时/);
    assert.throws(() => prepareOperation("produce_version", { workId: work.id, kind: "sample", feedbackIds: ["a", "a"] }), /重复/);
    const wrong = { operationId: "bad-baseline", workId: work.id, kind: "sample", baseVersionId: "v099", feedbackIds: [] };
    await assert.rejects(executeTool("produce_version", wrong, service), /找不到指定作品版本/);
    assert(!existsSync(join(root.path, "operations", "bad-baseline")));
    assert.equal(store.read(work.id).versions.length, 0);
    await assert.rejects(executeTool("produce_version", { ...wrong, operationId: "no-confirmation", baseVersionId: undefined, kind: "complete" }, service), /方向/);
    assert(!existsSync(join(root.path, "operations", "no-confirmation")));
    await assert.rejects(executeTool("submit_feedback", { operationId: "missing-work", workId: "work-missing", versionId: "v001", source: "user", text: "改文字" }, service), RequestRejected);
  } finally { root.cleanup(); }
});

test("创建 B 后选回确认的 A，不串方向、不重复备选要求；空集合和部分集合均可准确执行", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("双方向", "保留 A，并探索 B。");
    const a = readyVersion(store, work.id, "v001", "sample"); a.directionId = a.id;
    work.versions.push(a); store.save(work);
    await store.confirm(work.id, a.id, "direction", "沿 A 制作", "A 方向");
    const withFeedback = await store.feedback(work.id, a.id, "另做一个 B 方向，保留 A", "user");
    const alternative = withFeedback.feedback[0]!;
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const b = await service.produce(work.id, "sample", alternative.id, "fresh", a.id, undefined, undefined, { newDirection: true });
    assert.equal(b.versions.at(-1)?.directionId, "v002");
    assert.equal(store.read(work.id).directionApproval?.sampleVersionId, a.id);
    const complete = await service.produce(work.id, "complete");
    assert.equal(complete.versions.at(-1)?.basedOnVersionId, a.id);
    assert.deepEqual(complete.versions.at(-1)?.feedbackIds, []);
    assert.equal(complete.versions.at(-1)?.directionId, a.id);
    const sourceBefore = fileHash(store.resolvePath(a.sourcePath));
    for (const text of ["字幕增加两字", "开头增加留白", "结尾延长"])
      await store.feedback(work.id, a.id, text, "user");
    const feedback = store.read(work.id).feedback.filter(f => f.id !== alternative.id);
    const continuedB = await service.produce(work.id, "sample", undefined, "fresh", "v002", "继续 B；A 的新增意见不属于 B。");
    assert.deepEqual(continuedB.versions.at(-1)?.feedbackIds, []);
    const selected = feedback.slice(0, 2).map(f => f.id);
    await executeToolInline("produce_version", { operationId: "two-feedback", workId: work.id, kind: "complete",
      feedbackIds: selected, baseVersionId: complete.versions.at(-1)!.id, baseReason: "沿已确认 A 接续，B 保持独立。" }, service);
    assert.deepEqual(store.read(work.id).versions.at(-1)?.agentResult?.appliedFeedbackIds, selected);
    await service.produce(work.id, "complete", undefined, "fresh", a.id, "仅沿 A 检查排版，其他意见另行处理", undefined, { feedbackIds: [] });
    assert.deepEqual(store.read(work.id).versions.at(-1)?.feedbackIds, []);
    assert.equal(fileHash(store.resolvePath(a.sourcePath)), sourceBefore);
    assert.equal(store.read(work.id).feedback.length, 4);
  } finally { root.cleanup(); }
});

test("旧方向无法判定时不猜测；显式基线和空范围允许接续且保留旧记录", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("旧记录", "原始需求");
    work.versions.push(readyVersion(store, work.id, "v001", "sample"), readyVersion(store, work.id, "v002", "sample")); store.save(work);
    await store.confirm(work.id, "v001", "direction", "选第一个", "A");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "complete"), /历史版本缺少方向/);
    assert.equal(store.read(work.id).versions.length, 2);
    await service.produce(work.id, "complete", undefined, "fresh", "v001", "用户选择 A，不延续另一个方向", undefined, { feedbackIds: [] });
    assert.equal(store.read(work.id).versions[0]?.directionId, undefined);
    assert.equal(store.read(work.id).versions.at(-1)?.basedOnVersionId, "v001");
  } finally { root.cleanup(); }
});

test("旧双方向不自动选基线或重做备选，复制来源不能继承方向确认", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("旧双方向", "保留 A，另外探索 B。");
    const a = readyVersion(store, work.id, "v001", "sample"), b = readyVersion(store, work.id, "v002", "sample");
    b.basedOnVersionId = a.id;
    work.versions.push(a, b); store.save(work);
    const record = await store.feedback(work.id, a.id, "保留 A，另外制作 B", "external_ai", true);
    record.versions[1]!.appliedFeedbackIds = [record.feedback[0]!.id]; store.save(record);
    const service = new WorkService(store);
    await assert.rejects(executeTool("produce_version", { operationId: "implicit-legacy", workId: work.id, kind: "sample" }, service), /历史.*方向/);
    assert(!existsSync(join(root.path, "operations", "implicit-legacy")));
    assert.throws(() => selectProduction(store, record, "sample", undefined, "fresh", a.id, "继续 A，B 保留"), /feedbackIds/);
    assert.deepEqual(selectProduction(store, record, "sample", undefined, "fresh", a.id, "继续 A", { feedbackIds: [] }).requested, []);
    await store.confirm(work.id, a.id, "direction", "合成确认 A", "仅 A");
    const wrong = { operationId: "legacy-b-complete", workId: work.id, kind: "complete", baseVersionId: b.id, feedbackIds: [] };
    await assert.rejects(executeTool("produce_version", wrong, service), /已确认方向/);
    await assert.rejects(service.produce(work.id, "complete", undefined, "fresh", b.id, undefined, undefined, { feedbackIds: [] }), /已确认方向/);
    assert(!existsSync(join(root.path, "operations", wrong.operationId)));
    assert.equal(store.read(work.id).versions.length, 2);
    // 即使末端标了 A，中间经过未核对的旧 B 也不能跳过检查。
    const changed = store.read(work.id), c = readyVersion(store, work.id, "v003", "sample");
    c.basedOnVersionId = b.id; c.directionId = a.id; changed.versions.push(c); store.save(changed);
    assert.throws(() => selectProduction(store, store.read(work.id), "complete", undefined, "fresh", c.id, undefined, { feedbackIds: [] }), /已确认方向/);
    // 用户实际确认较新的样例后，它本身就是新起点；更早的未知关系不要求反复确认。
    await store.confirm(work.id, c.id, "direction", "合成：现确认第三个样例", "第三个样例本身");
    assert.equal(selectProduction(store, store.read(work.id), "complete", undefined, "fresh", undefined, undefined, { feedbackIds: [] }).previous?.id, c.id);
    assert.equal(store.read(work.id).versions[0]!.directionId, undefined);
    assert.equal(store.read(work.id).versions[1]!.directionId, undefined);
  } finally { root.cleanup(); }
});

test("制作中保存反馈不污染冻结输入，旧任务快照不丢新意见，方向撤销不会被后台复活", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("并发意见", "合成任务");
    const version = readyVersion(store, work.id, "v001", "sample"); version.directionId = version.id;
    work.versions.push(version); store.save(work);
    await store.confirm(work.id, version.id, "direction", "沿用", "原方向");
    const original = store.read(work.id);
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "slow_completed", 500), render: fixtureRender });
    const producing = service.produce(work.id, "complete");
    // withLock 在第一次异步运行器请求前已保存本轮上下文。
    await delay(20);
    const received = await store.feedback(work.id, version.id, "  新方向\n保留原话", "user", true, undefined, "feedback-during-run");
    const newFeedback = received.feedback[0]!;
    assert.equal(received.directionApproval, null);
    const completed = await producing;
    const latest = completed.versions.at(-1)!;
    const context = readFileSync(join(dirname(store.resolvePath(latest.sourcePath)), "context.md"), "utf8");
    assert(!context.includes(newFeedback.text));
    assert.deepEqual(latest.feedbackIds, []);
    const current = new WorkStore(root.path).read(work.id);
    assert.equal(current.feedback[0]?.text, newFeedback.text);
    assert.equal(current.directionApproval, null);
    assert(current.confirmations?.some(c => c.versionId === original.directionApproval?.sampleVersionId));
    await store.feedback(work.id, version.id, newFeedback.text, "user", true, undefined, "feedback-during-run");
    assert.equal(store.read(work.id).feedback.length, 1);
    await assert.rejects(service.produce(work.id, "complete"), /方向/);
    assert(latest.inputManifestPath && latest.inputManifestSha256);
    const manifest = JSON.parse(readFileSync(store.resolvePath(latest.inputManifestPath), "utf8"));
    assert.equal(manifest.context, context);
    assert(!context.includes("延续最新已有工程"));
    assert(!context.includes("Restic"));
    writeFileSync(store.resolvePath(latest.inputManifestPath), "{}\n");
    await assert.rejects(service.recover(work.id), /输入依据|执行/);
  } finally { root.cleanup(); }
});

test("模板替换不解释用户正文，缺少必要占位时明确拒绝", () => {
  assert.equal(fillPrompt("需求：{{brief}}", { brief: "保留 {{brief}} 原文" }), "需求：保留 {{brief}} 原文");
  assert.throws(() => fillPrompt("{{brief}}", {}), /缺少输入/);
  assert.throws(() => fillPrompt("没有占位", { brief: "必要需求" }), /必要占位/);
});

test("确认的旧读取快照不能越过同时追加的方向变更；重新确认须包含已收到意见", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("确认与反馈并发", "合成场景");
    work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
    await store.confirm(work.id, "v001", "direction", "采用这个样例", "原方向");
    const stale = store.read(work.id);
    const received = await store.feedback(work.id, "v001", "现在改变核心方向", "user", true);
    // 模拟确认先读取、反馈随后追加、确认最后写回；新的时间戳不能掩盖未读的新意见。
    stale.directionApproval!.confirmedAt = "2026-11-10T23:59:59.000Z";
    store.save(stale);
    assert.equal(store.read(work.id).directionApproval, null);
    assert.equal(store.read(work.id).feedback.length, 1);
    await store.confirm(work.id, "v001", "direction", "核对意见后仍决定沿原样例", "原方向");
    assert.deepEqual(store.read(work.id).directionApproval?.feedbackAcknowledgedIds, [received.feedback[0]!.id]);
  } finally { root.cleanup(); }
});

test("替代或取消的意见保留原文但不再自动执行，无法用失效编号强行续作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("反馈替代", "合成需求");
    work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
    const first = (await store.feedback(work.id, "v001", "背景改为红色", "user")).feedback[0]!;
    await assert.rejects(store.feedback(work.id, "v001", "新要求", "user", false, undefined, "invalid-reference", ["missing"]), /supersedes/);
    const changed = await store.feedback(work.id, "v001", "取消红色要求，保持原背景", "user", false, undefined, "replacement", [first.id]);
    const replacement = changed.feedback.find(f => f.id !== first.id)!;
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample", first.id), /已被后续意见替代/);
    const result = await service.produce(work.id, "sample");
    assert.deepEqual(result.versions.at(-1)?.feedbackIds, [replacement.id]);
    assert.equal(store.read(work.id).feedback[0]?.text, first.text);
    const view = await executeTool("get_work", { workId: work.id }, service) as { feedback: { id: string; supersededByFeedbackIds: string[] }[] };
    assert.deepEqual(view.feedback.find(f => f.id === first.id)?.supersededByFeedbackIds, [replacement.id]);
  } finally { root.cleanup(); }
});
