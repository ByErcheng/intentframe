import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { modelsSchema, selectModel } from "../src/records/model-settings.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { ModelAnalysisService } from "../src/runtime/model-analysis-service.ts";
import { adoptedDesign, fakeCodex, fixtureRender, fixtureRoot } from "./helpers.ts";
import { backgroundFixture } from "./background-helpers.ts";
import { assertAnalysesSettled } from "../src/runtime/model-analysis-service.ts";
import { rgbPng } from "../src/media/review-materials.ts";

const models = modelsSchema.parse({ default: { model: "fixture-a", effort: "high" }, stages: {
  production: { model: "fixture-b", effort: "medium" }, internal_review: { model: "fixture-b" }, visual_understanding: { model: "fixture-b" },
} });
function calls(path: string) {
  return readFileSync(join(path, "native-fixture/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("配置支持替换任意模型标识与单项覆盖，未知环节、空模型和强度明确拒绝", () => {
  const value = modelsSchema.parse({ default: { model: "future-model-v9", effort: "future-effort" }, stages: {
    design: { model: "another-model" }, learning: { effort: "medium" },
  } });
  assert.deepEqual(selectModel(value, "design"), { stage: "design", model: "another-model", effort: "future-effort" });
  assert.deepEqual(selectModel(value, "learning"), { stage: "learning", model: "future-model-v9", effort: "medium" });
  for (const invalid of [{ ...value, stages: { desgin: { model: "typo" } } },
    { ...value, default: { model: "", effort: "high" } }, { ...value, stages: { design: { effort: " " } } },
    { ...value, stages: { production: { strength: "high" } } }]) assert.equal(modelsSchema.safeParse(invalid).success, false);
});

test("真实制作入口按配置分配素材、完整制作、视觉理解、独立内检；反馈修改回到默认模型", { timeout: 35_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("配置交接", "合成一秒色块，不判断创作质量。"), design = await adoptedDesign(store, work.id);
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), models });
    const first = await service.produce(work.id, "complete", undefined, "fresh", undefined, undefined, "first", { designRef: design });
    assert.equal(first.execution.status, "idle");
    const version = first.versions[0]!;
    assert.deepEqual(version.modelSelection, { stage: "production", model: "fixture-b", effort: "medium" });
    assert.equal(version.model, "fixture-b"); assert.equal(version.reasoningEffort, "medium");
    assert.equal(version.reviewPreparation!.inspections[0]!.modelSelection!.stage, "internal_review");
    assert.deepEqual(first.analysisRuns!.map(run => [run.kind, run.model, run.reasoningEffort]), [
      ["production_assets", "fixture-a", "high"], ["visual_understanding", "fixture-b", "high"],
    ]);
    const input = JSON.parse(readFileSync(store.resolvePath(version.inputManifestPath!), "utf8"));
    const history = JSON.parse(readFileSync(join(root.path, "native-fixture/history.json"), "utf8"));
    assert.equal(history.threads[version.threadId!].turns[0].items[0].content[0].text, input.turnInput, "保存实际发送的素材交接原文");
    assert(input.assetPlan.runId); assert(input.turnInput.includes(input.assetPlan.markdown));
    const feedback = await store.feedback(work.id, version.id, "保持设计，只修正测试色块。", "user", false);
    const second = await service.produce(work.id, "complete", feedback.feedback.at(-1)!.id, "resume", version.id, undefined, "revise", { designRef: design });
    assert.equal(second.versions.at(-1)!.modelSelection!.stage, "feedback_revision");
    assert.equal(second.versions.at(-1)!.model, "fixture-a");
    const resume = calls(root.path).filter(call => call.method === "thread/resume").at(-1)!;
    assert.equal(resume.params.model, "fixture-a"); assert.equal(resume.params.config.model_reasoning_effort, "high");
    assert(calls(root.path).filter(call => call.method === "turn/start").every(call => call.params.model && call.params.effort));
    await store.feedback(work.id, second.versions.at(-1)!.id, "新的合成经验整理来源。", "user");
    await service.organize(work.id);
    const learning = store.read(work.id).learningRun!;
    assert.equal(learning.modelSelection!.stage, "learning"); assert.equal(learning.model, "fixture-a"); assert.equal(learning.reasoningEffort, "high");
  } finally { root.cleanup(); }
});

test("模型不可用、强度不支持、返回值不匹配均在生成轮次前失败，不回退到其他模型", async t => {
  for (const [mode, selection, pattern] of [
    ["completed", { model: "not-available", effort: "high" }, /不在当前运行器/],
    ["completed", { model: "fixture-a", effort: "max" }, /不支持/],
    ["model_mismatch", { model: "fixture-a", effort: "high" }, /不符/],
    ["missing_effort", { model: "fixture-a", effort: "high" }, /不符/],
  ] as const) await t.test(mode + selection.model + selection.effort, async () => {
    const root = fixtureRoot();
    try {
      const store = new WorkStore(root.path), work = store.create("拒绝错误配置", "合成调用");
      const service = new WorkService(store, { models: { default: selection, stages: {} }, codexExecutable: fakeCodex(root.path, mode), render: fixtureRender });
      await assert.rejects(service.produce(work.id, "sample"), pattern);
      assert.equal(store.read(work.id).execution.status, "failed");
      assert.equal(calls(root.path).filter(call => call.method === "turn/start").length, 0);
    } finally { root.cleanup(); }
  });
});

test("素材方案待澄清时不启动制作，不把分析完成当作制作完成", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("缺素材", "合成缺口"), design = await adoptedDesign(store, work.id);
    const service = new WorkService(store, { models, codexExecutable: fakeCodex(root.path, "analysis_needs_input"), render: fixtureRender });
    const result = await service.produce(work.id, "complete", undefined, "fresh", undefined, undefined, "make", { designRef: design });
    assert.equal(result.execution.status, "waiting_input"); assert.equal(result.versions[0]!.production, "blocked");
    assert.equal(result.versions[0]!.sendState, "not_sent"); assert.equal(calls(root.path).filter(call => call.method === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("分析失联后新请求受保护，改配置恢复只核原结果且不重发", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("分析恢复", "合成失联"), design = await adoptedDesign(store, work.id);
    const service = new WorkService(store, { models, codexExecutable: fakeCodex(root.path, "disconnect_analysis"), render: fixtureRender, timeoutMs: 2000 });
    await assert.rejects(service.produce(work.id, "complete", undefined, "fresh", undefined, undefined, "make", { designRef: design }));
    assert.equal(store.read(work.id).execution.status, "unknown");
    await assert.rejects(service.produce(work.id, "complete", undefined, "fresh", undefined, undefined, "new", { designRef: design }), /原|已有/);
    const changed = { default: { model: "unavailable-new-choice", effort: "max" }, stages: {} };
    const recovered = await new WorkService(store, { models: changed, codexExecutable: fakeCodex(root.path, "read_only") }).recover(work.id, false);
    assert.equal(recovered.status, "not_sent");
    const record = store.read(work.id); assert.equal(record.analysisRuns![0]!.status, "completed");
    assert.equal(record.analysisRuns![0]!.modelSelection!.model, "fixture-a");
    assert.equal(record.versions[0]!.production, "failed");
    assert.equal(calls(root.path).filter(call => call.method === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("相同父轮次与材料的分析恢复复用原回执，不因配置更换再次推理", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("只读分析", "合成材料");
    await store.withLock(work.id, async () => {
      const analysis = new ModelAnalysisService(store, { models, codexExecutable: fakeCodex(root.path) });
      const first = await analysis.run(work, "parent", "visual_understanding", { question: "合成协议" });
      const again = await new ModelAnalysisService(store, { models: { default: { model: "absent", effort: "max" }, stages: {} },
        codexExecutable: fakeCodex(root.path, "read_only") }).run(work, "parent", "visual_understanding", { question: "合成协议" });
      assert.deepEqual(first, again); assert.equal(work.analysisRuns!.length, 1);
    });
    assert.equal(calls(root.path).filter(call => call.method === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("排队后更换模型配置不会悄悄改变已受理任务", { timeout: 15_000 }, async () => {
  const f = backgroundFixture();
  try {
    f.delayWorkerStart();
    const client = await f.connect();
    const work = await f.createLegacyWork(client, { operationId: "create", title: "配置变化", brief: "合成排队请求", purpose: "test" });
    await f.call(client, "produce_version", { operationId: "make", workId: work.id, kind: "sample" });
    f.settings.models.default.effort = "medium";
    writeFileSync(f.configPath, JSON.stringify(f.settings));
    const outcome = await f.wait(client, "make");
    assert.equal(outcome.status, "failed"); assert.match(outcome.error, /系统或运行配置已变化/);
    assert.equal(f.countTurns(), 0);
  } finally { await f.cleanup(); }
});

test("已完成的主回复不能解除未知视觉调用保护；图像被换不能补认旧观察", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("证据保护", "合成协议"), image = join(root.path, "image.png");
    writeFileSync(image, "synthetic-image-v1");
    const analysis = new ModelAnalysisService(store, { models, codexExecutable: fakeCodex(root.path) });
    await store.withLock(work.id, () => analysis.run(work, "parent", "visual_understanding", {}, [image]));
    const run = work.analysisRuns![0]!;
    run.status = "unknown"; store.save(work);
    assert.throws(() => assertAnalysesSettled(work), /主轮次回复不能解除保护/);
    writeFileSync(image, "synthetic-image-v2");
    await assert.rejects(analysis.reconcile(work, run), /原视觉材料已经变化/);
    assert.equal(store.read(work.id).analysisRuns![0]!.status, "unknown");
    assert.equal(calls(root.path).filter(call => call.method === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("设计模型忽略视觉工具失联仍回复完成时保持未知；恢复两份原回复后才能保存设计", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("子调用未知保护", "合成视觉工具失联");
    writeFileSync(join(root.path, "image.png"), rgbPng(16, 16, Buffer.alloc(16 * 16 * 3, 50)));
    const options = { models, assetLibraries: [{ id: "test-images", path: root.path, role: "image" as const }], timeoutMs: 2000 };
    const service = new WorkService(store, { ...options, codexExecutable: fakeCodex(root.path, "visual_child_disconnect") });
    service.documents.initialize(work, "合成原稿", "draft");
    const draft = store.read(work.id).authoring!.drafts[0]!;
    await service.documents.handoff(work.id, draft, "按合成草稿设计", "handoff");
    await assert.rejects(service.authoring.generate(work.id, "design", draft, "查看素材后设计", "design"), /分析调用/);
    const interrupted = store.read(work.id);
    assert.equal(interrupted.execution.status, "unknown"); assert.equal(interrupted.authoring!.designs.length, 0);
    assert.equal(interrupted.analysisRuns![0]!.status, "unknown");
    const recovered = await new WorkService(store, { ...options, codexExecutable: fakeCodex(root.path, "read_only") }).recover(work.id, false);
    assert.equal(recovered.status, "recovered");
    const record = store.read(work.id);
    assert.equal(record.authoring!.designs.length, 1); assert.equal(record.analysisRuns![0]!.status, "completed");
    assert.equal(calls(root.path).filter(call => call.method === "turn/start").length, 2, "视觉与设计都只核原回复");
  } finally { root.cleanup(); }
});
