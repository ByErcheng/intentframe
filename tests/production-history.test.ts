import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { productionHistory } from "../src/runtime/production-history.ts";
import { fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

test("历史查询固定本轮基线，分页保留原文和替代关系，拒绝跨任务或路径输入", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("历史材料", "合成需求");
    const base = readyVersion(store, work.id, "v001", "sample");
    base.agentReply = "原始历史回复";
    work.versions.push(base); store.save(work);
    await store.feedback(work.id, base.id, "  保留绿色背景\n", "user");
    const record = await store.feedback(work.id, base.id, "改成蓝色背景", "user");
    const [first, second] = record.feedback;
    second!.supersedes = [first!.id];
    const reads = new Set<string>();
    const history = productionHistory(record, base, record.feedback.map(f => f.id), reads);
    record.feedback[0]!.text = "制作中变化"; base.agentReply = "后来的回复";
    assert.equal(history.read({ section: "baseline_result" }).result?.agentReply, "原始历史回复");
    const page = history.read({ section: "inherited_feedback", limit: 1 });
    assert.equal(page.coverage, "partial"); assert.equal(page.nextOffset, 1);
    assert.equal(page.items?.[0]?.text, "  保留绿色背景\n");
    assert.deepEqual(page.items?.[0]?.supersededByFeedbackIds, [second!.id]);
    assert.deepEqual([...reads], [first!.id]);
    assert.equal(history.read({ section: "inherited_feedback", offset: 1, limit: 1 }).coverage, "complete");
    assert.throws(() => history.read({ section: "baseline_result", workId: "other" }));
    assert.throws(() => history.read({ section: "baseline_result", path: "../../other" }));
    assert.throws(() => history.read({ section: "baseline_result", offset: 1 }), /offset/);
    const empty = productionHistory(work, undefined, [], new Set());
    assert.equal(empty.read({ section: "baseline_result" }).coverage, "not_found");
    assert.deepEqual(empty.read({ section: "inherited_feedback" }).items, []);
  } finally { root.cleanup(); }
});

test("制作会话可实际取得历史材料，完成状态与旧声明分开，历史工程不被改写", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("交接", "原始目标与未定备选");
    const base = readyVersion(store, work.id, "v001", "sample");
    base.agentReply = "历史：仅源码完成，尚未渲染";
    work.versions.push(base); store.save(work);
    const record = await store.feedback(work.id, base.id, "已处理的历史要求", "user");
    record.versions[0]!.appliedFeedbackIds = [record.feedback[0]!.id]; store.save(record);
    const oldSource = readFileSync(store.resolvePath(base.sourcePath));
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_history"), render: fixtureRender,
      models: { default: { model: "fixture-a", effort: "medium" }, stages: {} } });
    const result = await service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, undefined, { feedbackIds: [] });
    const version = result.versions.at(-1)!;
    assert.equal(version.production, "ready");
    assert.equal(version.model, "fixture-a", "记录配置请求及运行器返回的模型，不写死生产模型名");
    assert.equal(version.reasoningEffort, "medium");
    const directory = dirname(store.resolvePath(version.sourcePath));
    const context = readFileSync(join(directory, "context.md"), "utf8");
    assert(!context.includes(base.agentReply!)); assert(!context.includes("已处理的历史要求"));
    assert(context.includes('"currentProduction": "ready"'));
    assert(context.includes("原始目标与未定备选"));
    const observed = JSON.parse(readFileSync(join(directory, "history-read.json"), "utf8"));
    assert.equal(observed.baseline.result.agentReply, base.agentReply);
    assert.equal(observed.inherited.items[0].text, "已处理的历史要求");
    assert.deepEqual(readFileSync(store.resolvePath(base.sourcePath)), oldSource);
    const receipt = JSON.parse(readFileSync(join(store.workDirectory(work.id), "runs", version.runId, "production-result.json"), "utf8"));
    assert.deepEqual(receipt.feedbackReads, [record.feedback[0]!.id]);
  } finally { root.cleanup(); }
});

test("长反馈仅提供读取入口时不能冒充已经取得原文，首次需求仍在任务区完整展示", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("边界", "  完整原话与备选\n第二行  ");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const first = await service.produce(work.id, "sample");
    const context = readFileSync(join(dirname(store.resolvePath(first.versions[0]!.sourcePath)), "context.md"), "utf8");
    assert(context.includes("  完整原话与备选\n第二行  "));
    assert(context.indexOf("完整原话与备选") < context.indexOf("## 必要依据"));
    // 每条都在合法上限内，合计超过正文内联阈值。
    for (let index = 0; index < 3; index++) await store.feedback(work.id, "v001", index + "长反馈".repeat(3_000), "user");
    await assert.rejects(service.produce(work.id, "sample"), /未取得原文/);
    const version = store.read(work.id).versions.at(-1)!;
    const nextContext = readFileSync(join(dirname(store.resolvePath(version.sourcePath)), "context.md"), "utf8");
    assert(!nextContext.includes("长反馈"));
    assert(nextContext.includes("intentframe_read_feedback"));
    const receipt = JSON.parse(readFileSync(join(store.workDirectory(work.id), "runs", version.runId, "production-result.json"), "utf8"));
    assert.deepEqual(receipt.feedbackReads, []);
  } finally { root.cleanup(); }
});
