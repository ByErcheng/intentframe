import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { KnowledgeStore } from "../src/records/knowledge-store.ts";
import type { ExperienceInput } from "../src/records/knowledge-store.ts";
import { ComparisonStore } from "../src/records/comparison-store.ts";
import { valueHash } from "../src/records/files.ts";
import { sourceFingerprint } from "../src/records/source-snapshot.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { WorkRouter } from "../src/runtime/work-router.ts";
import { executeTool, inputs, prepareOperation } from "../src/mcp/server.ts";
import { fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

test("比较固定共同输入和知识版本，新经验先暂存，评价后再发布且可增量整理评价", async () => {
  const root = fixtureRoot();
  try {
    const production = new WorkStore(root.path, "production", root.path), source = production.create("基线", "合成正式作品。");
    source.versions.push(readyVersion(production, source.id, "v001", "sample")); production.save(source);
    const base = { purpose: "production" as const, workId: source.id, versionId: "v001",
      sourceFingerprint: sourceFingerprint(source.versions[0]!.sourceSnapshot!), feedbackIds: [] };
    const input: ExperienceInput = { title: "字幕布局", problem: "字幕遮挡", method: "按主体调整", conditions: "主体接近字幕", limitations: "合成记录", keywords: ["字幕"], status: "candidate", use: "reusable", sources: [base] };
    const knowledge = new KnowledgeStore(root.path), shared = knowledge.save(input);
    const store = new WorkStore(join(root.path, "testing"), "test", root.path);
    const comparison = new ComparisonStore(store, knowledge).create({ title: "反馈修改比较", brief: "相同字幕任务", kind: "revision", change: "测试制作策略", revisionRequest: "字幕避开主体", base, knowledgeRefs: [shared] }, "compare-one");
    const sourceBefore = readFileSync(production.resolvePath(source.versions[0]!.sourcePath), "utf8");
    const taskBefore = readFileSync(join(production.workDirectory(source.id), "task.json"), "utf8");
    const later = knowledge.save({ ...input, title: "后加入的字幕方法" });
    const service = new WorkService(store, { knowledge, codexExecutable: fakeCodex(root.path, "use_experience"), render: fixtureRender });
    const tools = service.learning.tools(store.read(comparison.workIds.before), "scope-check");
    const found = tools.call("intentframe_search_experience", { query: "字幕" }) as { items: { ref: unknown }[] };
    assert.deepEqual(found.items.map(item => item.ref), [shared]);
    assert.throws(() => tools.call("intentframe_read_experience", later), /共同知识范围/);
    const first = await service.produce(comparison.workIds.before, "sample");
    await store.review(first.id, "v001", "passed", "合成复查：字幕位置需后续观看验证。", "external_ai");
    const organizer = new WorkService(store, { knowledge, codexExecutable: fakeCodex(root.path, "learn_method") });
    const learned = await organizer.organize(first.id);
    assert.equal(learned.learningBatches?.[0]?.staged, true);
    assert.equal(knowledge.latest().length, 2);
    assert.throws(() => organizer.learning.publishStaged(learned), /比较尚未结束/);
    const second = await service.produce(comparison.workIds.after, "sample");
    assert.deepEqual(first.versions[0]!.knowledgeUsed, second.versions[0]!.knowledgeUsed);
    await assert.rejects(service.produce(first.id, "sample"), /首次制作/);
    const evaluated = await service.comparisons.evaluate(comparison.id, { beforeVersionId: "v001", afterVersionId: "v001", verdict: "inconclusive", observations: "合成数据只证明记录闭环，未进行作品效果比较。", source: "external_ai" });
    assert.equal(evaluated.state, "completed");
    const conditions = evaluated.evaluation!.conditions as { before: { execution: unknown }; differences: string[] };
    assert(conditions.before.execution); assert.deepEqual(conditions.differences, []);
    organizer.learning.publishStaged(store.read(first.id));
    assert.equal(knowledge.latest().length, 3);
    organizer.learning.publishStaged(store.read(first.id)); assert.equal(knowledge.latest().length, 3);
    const pending = organizer.learning.pending(store.read(first.id));
    assert.equal(pending.items.length, 1); assert.equal(pending.items[0]!.kind, "comparison");
    const summarized = await organizer.organize(first.id);
    assert.equal(organizer.learning.pending(summarized).pendingCount, 0);
    assert.equal(readFileSync(production.resolvePath(source.versions[0]!.sourcePath), "utf8"), sourceBefore);
    assert.equal(readFileSync(join(production.workDirectory(source.id), "task.json"), "utf8"), taskBefore);
    assert.equal(production.list().length, 1); assert.equal(store.list().length, 2);
  } finally { root.cleanup(); }
});

test("比较不能改共同需求、引用额外反馈或将篡改的暂存正文发布", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "testing"), "test", root.path), service = new WorkService(store, {
      codexExecutable: fakeCodex(root.path), render: fixtureRender,
    });
    assert.throws(() => new ComparisonStore(new WorkStore(root.path)).create({ title: "不能正式比较", brief: "x", kind: "creation", change: "x", knowledgeRefs: [] }, "wrong-mode"), /测试入口/);
    const comparison = service.comparisons.create({ title: "同条件", brief: "相同初始需求", kind: "creation", change: "一个改动", knowledgeRefs: [] }, "inputs");
    const before = store.read(comparison.workIds.before), briefPath = store.resolvePath(before.briefPath), original = readFileSync(briefPath, "utf8");
    writeFileSync(briefPath, "另一套需求");
    await assert.rejects(service.produce(before.id, "sample"), /原始需求已变化/);
    assert.equal(store.read(before.id).versions.length, 0);
    writeFileSync(briefPath, original);
    await service.produce(before.id, "sample"); await service.produce(comparison.workIds.after, "sample");
    const detached = store.read(before.id), binding = detached.comparison;
    detached.comparison = undefined; store.save(detached);
    await assert.rejects(service.comparisons.evaluate(comparison.id, { beforeVersionId: "v001", afterVersionId: "v001", verdict: "inconclusive", observations: "归属损坏不能作为本轮结果", source: "external_ai" }), /比较归属/);
    detached.comparison = binding; store.save(detached);
    await store.review(before.id, "v001", "needs_changes", "字幕需避让主体。", "external_ai");
    const organizer = new WorkService(store, { codexExecutable: fakeCodex(root.path, "learn_method") });
    const learned = await organizer.organize(before.id), batch = learned.learningBatches![0]!;
    const draftPath = store.resolvePath("works/" + before.id + "/learning/" + batch.id + ".json");
    const draft = JSON.parse(readFileSync(draftPath, "utf8")); draft.result.proposals[0].method = "后来改写的无依据结论";
    writeFileSync(draftPath, JSON.stringify(draft));
    await service.comparisons.evaluate(comparison.id, { beforeVersionId: "v001", afterVersionId: "v001", verdict: "inconclusive", observations: "只核对记录。", source: "user" });
    assert.throws(() => organizer.learning.publishStaged(store.read(before.id)), /暂存经验正文/);
    assert.equal(organizer.knowledge.latest().length, 0);
    const next = service.comparisons.create({ title: "禁止新增反馈", brief: "固定", kind: "creation", change: "一个改动", knowledgeRefs: [] }, "extra");
    await service.produce(next.workIds.before, "sample"); await service.produce(next.workIds.after, "sample");
    await store.feedback(next.workIds.before, "v001", "比较中临时增加的要求", "user");
    await assert.rejects(service.comparisons.evaluate(next.id, { beforeVersionId: "v001", afterVersionId: "v001", verdict: "improved", observations: "不能声称条件相同", source: "external_ai" }), /额外制作或人工反馈/);
  } finally { root.cleanup(); }
});

test("比较派生任务超限时在准备与执行入口拒绝，不留下比较或任务记录", async () => {
  for (const changes of [
    { title: "题".repeat(196) },
    { title: "题".repeat(200) },
    { brief: "需".repeat(29_988), revisionRequest: "改" },
    { brief: "需".repeat(30_000), revisionRequest: "改" },
    { brief: " \n " },
  ]) {
    const root = fixtureRoot();
    try {
      const comparison = { title: "边界比较", brief: "共同需求", kind: "creation" as const, change: "一个改动", knowledgeRefs: [], ...changes };
      const request = { operationId: "invalid-comparison", comparison }, router = new WorkRouter(root.path);
      assert(!inputs.create_comparison.safeParse(request).success);
      assert.throws(() => prepareOperation("create_comparison", { comparison }));
      await assert.rejects(executeTool("create_comparison", request, router));
      assert(!router.operations.exists(request.operationId));
      assert.throws(() => router.service("test").comparisons.create(comparison, "direct-invalid"));
      assert(!existsSync(join(root.path, "testing")), "无效输入不能先创建比较、区域标识或作品目录");
    } finally { root.cleanup(); }
  }
});

test("比较派生任务可使用长度上限，需求原文完整保留且重试返回原结果", async () => {
  for (const fields of [
    { brief: "需".repeat(30_000) },
    // 29987 字符原始需求 + 12 字符分隔标题 + 1 字符修改要求。
    { brief: "  \n" + "需".repeat(29_981) + "\n  ", revisionRequest: "改" },
  ]) {
    const root = fixtureRoot();
    try {
      const router = new WorkRouter(root.path);
      const request = prepareOperation("create_comparison", { comparison: {
        title: "题".repeat(195), kind: "creation", change: "一个改动", knowledgeRefs: [], ...fields,
      } });
      const created = await executeTool(request.name, request.arguments, router) as { id: string; workIds: { before: string; after: string } };
      const store = router.service("test").store;
      assert.equal(store.list().length, 2);
      const expectedBrief = fields.brief + (fields.revisionRequest ? "\n\n本轮共同修改要求：\n" + fields.revisionRequest : "");
      assert.equal(expectedBrief.length, 30_000);
      for (const side of ["before", "after"] as const) {
        const work = store.read(created.workIds[side]);
        assert.equal(work.title, "题".repeat(195) + (side === "before" ? "（修改前）" : "（修改后）"));
        assert.equal(work.title.length, 200);
        assert.equal(readFileSync(store.resolvePath(work.briefPath), "utf8"), "# 原始需求\n\n" + expectedBrief + "\n");
        assert.equal(router.service("test").comparisons.context(work)!.id, created.id);
      }
      assert.deepEqual(await executeTool(request.name, request.arguments, new WorkRouter(root.path)), created);
      assert.equal(store.list().length, 2);
    } finally { root.cleanup(); }
  }
});

test("新建比较的长度校验不阻断旧版已保存的比较记录", () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "testing"), "test", root.path), comparisons = new ComparisonStore(store);
    const original = comparisons.create({ title: "历史比较", brief: "共同需求", kind: "creation", change: "一个改动", knowledgeRefs: [] }, "legacy");
    // 旧版任务创建以 trim 后长度校验，可能已经保存包含更多前导空白的完整原文。
    const brief = " ".repeat(20) + "需".repeat(29_980);
    const input = { ...original.input, brief, revisionRequest: "改" };
    const legacy = { ...original, input, inputHash: valueHash(input) };
    const path = store.resolvePath("comparisons/" + original.id + "/record.json");
    writeFileSync(path, JSON.stringify(legacy));
    for (const id of Object.values(original.workIds)) {
      const work = store.read(id); work.comparison!.inputHash = legacy.inputHash; store.save(work);
      const briefPath = store.resolvePath(work.briefPath), text = "# 原始需求\n\n" + brief + "\n\n本轮共同修改要求：\n改\n";
      writeFileSync(briefPath, text);
      assert.deepEqual(comparisons.context(work), legacy);
      assert.equal(readFileSync(briefPath, "utf8"), text);
    }
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(legacy), "兼容读取不迁移或改写历史比较");
    assert.throws(() => comparisons.create(input, "new-over-limit"), /合计不能超过/);
  } finally { root.cleanup(); }
});
