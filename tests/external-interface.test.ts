import { confirmedDraft } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeTool, executeToolInline, inputs, runBackgroundAction } from "../src/mcp/server.ts";
import { backgroundTools } from "../src/records/execution-store.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { valueHash } from "../src/records/files.ts";
import { renderVersion } from "../src/media/render.ts";
import { adoptedDesign, fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";
import { backgroundFixture } from "./background-helpers.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { WorkRouter } from "../src/runtime/work-router.ts";
import { configuration } from "../src/config.ts";

function files(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(files(path)) : [[path, valueHash(readFileSync(path))]];
  }));
}

test("默认指南简短，工具契约覆盖当前注册表，全文与章节仍可取得", async () => {
  const root = fixtureRoot();
  try {
    const service = new WorkService(new WorkStore(root.path));
    const short = await executeToolInline("read_usage_guide", {}, service) as { content: string; coverage: string; sections: string[] };
    const full = await executeToolInline("read_usage_guide", { view: "full" }, service) as { content: string; coverage: string };
    assert.match(short.content, /^## 快速开始/); assert(short.content.length < 2200);
    assert.equal(short.coverage, "partial"); assert.equal(full.coverage, "complete");
    assert(full.content.length > short.content.length * 5); assert(short.sections.includes("工具执行契约"));
    const catalog = await executeToolInline("read_usage_guide", { section: "工具执行契约" }, service) as {
      content: string; tools: { name: string; execution: string; queryTool: string | null; modelUsage: string }[] };
    assert.deepEqual(catalog.tools.map(item => item.name).sort(), Object.keys(inputs).sort());
    assert.deepEqual(catalog.tools.filter(item => item.execution === "background").map(item => item.name).sort(), [...backgroundTools].sort());
    for (const item of catalog.tools.filter(item => item.execution === "background")) assert.equal(item.queryTool, "get_execution");
    assert.match(catalog.content, /materials_only/); assert.match(catalog.content, /reconcile_only/);
    const section = await executeToolInline("read_usage_guide", { section: "请求准备与重试" }, service) as { content: string };
    assert.match(section.content, /preflightHash/);
  } finally { root.cleanup(); }
});

test("外部摘要保留检查范围和未知项，音色配置声明可读且不泄露凭据", async () => {
  const root = fixtureRoot(), providers = configuration.providers;
  try {
    configuration.providers = { speech: { apiKey: "fixture-secret-not-for-output", speaker: "fixture-speaker", resourceId: "fixture-resource",
      timeoutMs: 1000, label: "合成复刻音色", description: "测试用户声明：这是本人声音。" } };
    const store = new WorkStore(root.path), work = store.create("检查范围摘要", "合成检查结论"), service = new WorkService(store);
    const runtime = await executeToolInline("get_runtime_info", {}, service) as any;
    assert.equal(runtime.voices[0].label, "合成复刻音色"); assert.match(runtime.voices[0].description, /用户声明/);
    assert.equal(runtime.voices[0].configured, true); assert(!JSON.stringify(runtime).includes("fixture-secret-not-for-output"));
    const version = readyVersion(store, work.id, "v001", "sample");
    version.technicalCheck = { decoded: true, checkedAt: "2026-01-01T00:00:00Z" };
    version.review = { status: "passed", source: "external_ai", notes: "仅检查指定抽帧；未连续播放、未试听。" };
    version.reviewPreparation = { status: "available", batches: [], inspections: [{ id: "fixture-inspection", inputPath: "fixture-input.json",
      inputSha256: "fixture", sendState: "acknowledged", status: "completed", result: { sufficient: true, notes: "仅画面内检。",
        quality: { status: "passed", issues: [] }, limitations: ["静帧不能证明连续运动。"],
        sound: { status: "not_checked", notes: "未听音。", ranges: [] }, additionalRanges: [] } }] };
    work.versions.push(version); store.save(work);
    const task = store.resolvePath("works/" + work.id + "/task.json"), before = readFileSync(task, "utf8");
    const summary = await executeToolInline("get_work", { workId: work.id }, service) as any;
    assert.match(summary.latestVersion.review.notes, /未试听/);
    assert.equal(summary.latestVersion.internalReview.sound.status, "not_checked");
    assert.deepEqual(summary.latestVersion.internalReview.limitations, ["静帧不能证明连续运动。"]);
    assert.equal(summary.latestVersion.technicalCheck.decoded, true); assert.match(summary.latestVersion.checkScopeNote, /未记录/);
    assert.equal(readFileSync(task, "utf8"), before);
    delete version.reviewPreparation; version.review = { status: "not_reviewed" }; store.save(work);
    const unknown = await executeToolInline("get_work", { workId: work.id }, service) as any;
    assert.equal(unknown.latestVersion.internalReview, undefined); assert.equal(unknown.latestVersion.review.status, "not_reviewed");
  } finally { configuration.providers = providers; root.cleanup(); }
});

test("作品默认摘要不倾倒历史，反馈和稿件各自分页且未展开不报为空", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("摘要与分页", "合成需求"), service = new WorkService(store);
    await adoptedDesign(store, work.id);
    const record = store.read(work.id);
    for (let number = 1; number <= 4; number++) {
      const version = readyVersion(store, work.id, "v00" + number, "sample");
      version.agentReply = "无需默认展开的历史正文".repeat(2000);
      version.directionId = "v001"; if (number > 1) version.basedOnVersionId = "v00" + (number - 1);
      record.versions.push(version);
    }
    store.save(record);
    for (const text of ["换角色", "保留声音", "增大文字"]) await store.feedback(work.id, "v004", text, "user");
    const summary = await executeTool("get_work", { workId: work.id }, service) as any;
    assert.equal(summary.view, "summary"); assert.equal(summary.coverage, "summary");
    assert.equal(summary.versions, undefined); assert.equal(summary.feedback, undefined);
    assert.equal(summary.latestVersion.id, "v004"); assert.equal(summary.counts.versions, 4);
    assert.equal(summary.pendingFeedback.count, 3); assert(JSON.stringify(summary).length < 5000);
    const first = await executeTool("get_work", { workId: work.id, section: "feedback", limit: 2 }, service) as any;
    assert.equal(first.total, 3); assert.equal(first.items.length, 2); assert.equal(first.nextOffset, 2);
    const drafts = await executeTool("get_work", { workId: work.id, section: "drafts", limit: 2 }, service) as any;
    assert.equal(drafts.total, 1); assert.equal(drafts.items.length, 1); assert.equal(drafts.nextOffset, null);
    const last = await executeTool("get_work", { workId: work.id, section: "feedback", offset: first.nextOffset, limit: 2 }, service) as any;
    assert.equal(last.items[0].text, "增大文字"); assert.equal(last.nextOffset, null); assert.equal(last.coverage, "partial");
    const detail = await executeTool("get_work", { workId: work.id, view: "detail" }, service) as any;
    assert.equal(detail.versions.length, 4); assert.equal(detail.feedback.length, 3); assert(detail.feedbackDirectory);
    assert(JSON.stringify(detail).length > JSON.stringify(summary).length * 10);
  } finally { root.cleanup(); }
});

test("制作预检只读解析实际基线和反馈，状态或参数变化拒绝，成功重放保留原结果", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("预检范围", "沿已确认 A 修改，B 保留。"),
      service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const a = readyVersion(store, work.id, "v001", "sample"), b = readyVersion(store, work.id, "v002", "sample");
    a.directionId = a.id; b.directionId = b.id; b.newDirection = true;
    work.versions.push(a, b); store.save(work);
    await store.confirm(work.id, a.id, "direction", "合成确认 A", "A");
    await store.feedback(work.id, b.id, "B 的意见不带入 A", "user");
    await store.feedback(work.id, a.id, "把小猫换成小熊", "user");
    const prepare = () => executeToolInline("prepare_operation", { name: "produce_version", arguments: { workId: work.id, kind: "complete" } }, service) as Promise<any>;
    const before = files(root.path), prepared = await prepare();
    assert.deepEqual(files(root.path), before, "准备不落盘、不创建操作或调用模型");
    assert.equal(prepared.preflight.status, "ready"); assert.equal(prepared.preflight.baseVersionId, "v001");
    assert.equal(prepared.preflight.feedback.length, 1); assert.equal(prepared.preflight.feedback[0].excerpt, "把小猫换成小熊");
    assert.equal(prepared.preflight.excludedFeedback.total, 1); assert.equal(prepared.capability.execution, "background");
    assert.equal(prepared.arguments.baseVersionId, "v001"); assert(prepared.arguments.baseReason); assert(prepared.arguments.preflightHash);
    await assert.rejects(executeToolInline("produce_version", { ...prepared.arguments, feedbackIds: [] }, service), /预检后/);
    assert(!existsSync(join(root.path, "operations", prepared.arguments.operationId)));
    await store.feedback(work.id, a.id, "同时保留原配色", "user");
    await assert.rejects(executeToolInline("produce_version", prepared.arguments, service), /预检后/);
    assert(!existsSync(join(root.path, "operations", prepared.arguments.operationId)));
    const fresh = await prepare(); assert.equal(fresh.preflight.feedback.length, 2);
    const result = await executeToolInline("produce_version", fresh.arguments, service);
    const after = store.read(work.id); assert.equal(after.versions.length, 3);
    assert.equal(after.versions.at(-1)!.basedOnVersionId, "v001");
    assert.deepEqual(after.versions.at(-1)!.feedbackIds, fresh.arguments.feedbackIds);
    assert.deepEqual(await executeToolInline("produce_version", fresh.arguments, service), result);
    assert.equal(store.read(work.id).versions.length, 3);
    assert.equal(readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"turn/start"')).length, 1);
  } finally { root.cleanup(); }
});

test("预检明确报告设计、素材和未知执行的阻塞，不猜测或创建操作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("预检阻塞", "合成条件"), service = new WorkService(store);
    const designRef = await adoptedDesign(store, work.id);
    const prepare = (args: Record<string, unknown>) => executeToolInline("prepare_operation", { name: "produce_version",
      arguments: { workId: work.id, kind: "sample", ...args } }, service) as Promise<any>;
    const missing = await prepare({}); assert.equal(missing.preflight.status, "blocked"); assert.match(missing.preflight.blockers[0], /designRef/);
    const asset = await prepare({ designRef, assetIds: ["missing"] }); assert.equal(asset.preflight.status, "blocked");
    const valid = await prepare({ designRef, feedbackIds: [] }); assert.equal(valid.preflight.status, "ready");
    await store.withLock(work.id, async () => {
      const locked = await prepare({ designRef }); assert.equal(locked.preflight.status, "blocked"); assert.match(locked.preflight.blockers[0], /写入占用/);
    });
    const record = store.read(work.id); record.execution = { status: "unknown", error: "原调用未核清" }; store.save(record);
    const unknown = await prepare({ designRef }); assert.equal(unknown.preflight.status, "blocked"); assert.match(unknown.preflight.blockers[0], /未取得明确结果/);
    assert(!existsSync(join(root.path, "operations"))); assert.equal(store.read(work.id).versions.length, 0);
    const version = readyVersion(store, work.id, "v001", "sample");
    version.reviewPreparation = { status: "unknown", batches: [], inspections: [] };
    record.execution = { status: "idle" }; record.versions.push(version); store.save(record);
    const before = files(root.path);
    await assert.rejects(service.prepareMaterials(work.id, version.id, [], "only-materials", "materials_only"), /尚未核清/);
    assert.deepEqual(files(root.path), before, "缺失检查身份不能用补材料解除未知状态");
  } finally { root.cleanup(); }
});

test("旧恢复回执和已受理输入保持旧语义，新默认与显式旧参数分别处理", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("恢复兼容", "合成空任务"), service = new WorkService(store);
    const operations = new OperationStore(root.path), old = { operationId: "old-receipt", workId: work.id, render: true };
    await operations.execute(old.operationId, "recover_work", old, () => ({ legacyReceipt: true }), "production");
    assert.deepEqual(await executeToolInline("recover_work", { operationId: old.operationId, workId: work.id }, service), { legacyReceipt: true });
    await assert.rejects(executeToolInline("recover_work", { ...old, render: false }, service), /不同内容/);
    const router = new WorkRouter(root.path, routed => routed.purpose === store.purpose ? service : new WorkService(routed));
    const queued = await runBackgroundAction("recover_work", { operationId: "old-queued", workId: work.id }, router) as any;
    assert.equal(queued.mode, "resume", "历史已受理请求不按新默认解释");
    const newRequest = await executeToolInline("recover_work", { operationId: "new-default", workId: work.id }, service) as any;
    assert.equal(newRequest.mode, "reconcile_only");
    const explicit = await executeToolInline("recover_work", { operationId: "old-explicit", workId: work.id, render: true }, service) as any;
    assert.equal(explicit.mode, "resume");
    await assert.rejects(executeToolInline("recover_work", { operationId: "conflict", workId: work.id, mode: "resume", render: false }, service), /冲突/);
    assert(!existsSync(join(root.path, "operations/conflict")));
  } finally { root.cleanup(); }
});

test("真实 MCP 的预检参数原样进入后台，受理后的新增反馈留待下一轮", { timeout: 40_000 }, async () => {
  const fixture = backgroundFixture();
  try {
    fixture.delayWorkerStart();
    const client = await fixture.connect(), work = await fixture.createLegacyWork(client,
      { operationId: "create", title: "预检交接", brief: "合成反馈冻结", purpose: "test" });
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data), record = store.read(work.id);
    const version = readyVersion(store, work.id, "v001", "sample"); version.directionId = version.id;
    record.versions.push(version); store.save(record);
    await store.feedback(work.id, version.id, "本轮换成蓝色", "user");
    const prepared = await fixture.call(client, "prepare_operation", { name: "produce_version", arguments: { workId: work.id, kind: "sample" } });
    assert.equal(prepared.preflight.status, "ready");
    const accepted = await fixture.call(client, "produce_version", prepared.arguments);
    assert.equal(accepted.status, "accepted"); assert.deepEqual(accepted.selection.feedbackIds, prepared.arguments.feedbackIds);
    await fixture.call(client, "submit_feedback", { operationId: "later", workId: work.id, versionId: version.id, text: "下一轮再调整文字", source: "user" });
    const result = await fixture.wait(client, accepted.executionId);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const after = store.read(work.id); assert.equal(after.feedback.length, 2);
    assert.deepEqual(after.versions.at(-1)!.feedbackIds, prepared.arguments.feedbackIds);
    assert.deepEqual(await fixture.call(client, "produce_version", prepared.arguments), accepted);
    assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("实际 MCP 默认仅补材料和核对补存，明确继续才调用模型修复；原请求重复不再执行", { timeout: 60_000 }, async () => {
  const fixture = backgroundFixture("quality_repair");
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", confirmedDraft({ operationId: "create", title: "模式边界", brief: "合成视频用于检查副作用。", purpose: "test" }));
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data);
    const designRef = await adoptedDesign(store, work.id), record = store.read(work.id);
    const version = readyVersion(store, work.id, "v001", "sample");
    rmSync(store.resolvePath(version.mediaPath)); // 替换尚未登记的合成占位字节，再生成真实测试媒体。
    const rendered = await renderVersion(store.resolvePath(version.sourcePath), store.resolvePath(version.mediaPath), join(fixture.path, "cache"));
    Object.assign(version, { designRef, sourceSha256: rendered.sourceSha256, videoSha256: rendered.videoSha256, technicalCheck: rendered });
    record.versions.push(version); record.execution = { status: "waiting_input", error: "合成：等待检查结果" }; store.save(record);
    const original = readFileSync(store.resolvePath(version.sourcePath));
    const request = { operationId: "materials", workId: work.id, versionId: version.id };
    const accepted = await fixture.call(client, "prepare_review_materials", request);
    assert.equal(accepted.status, "accepted");
    const materials = await fixture.wait(client, accepted.executionId);
    assert.equal(materials.status, "succeeded", JSON.stringify(materials));
    assert.equal(materials.result.mode, "materials_only"); assert.equal(materials.result.inspectionPerformed, false);
    assert.equal(materials.result.readyForExternalReview, false); assert(materials.result.batches.length > 0);
    assert.equal(fixture.countTurns(), 0); assert.equal(store.read(work.id).versions.length, 1);
    assert.equal(store.read(work.id).execution.status, "waiting_input", "补材料完成不清除作品原有阻塞");
    const missingPreview = rendered.previews[0]!; rmSync(missingPreview);
    await fixture.call(client, "recover_work", { operationId: "reconcile", workId: work.id });
    const reconciled = await fixture.wait(client, "reconcile");
    assert.equal(reconciled.result.mode, "reconcile_only"); assert.equal(fixture.countTurns(), 0);
    assert.equal(existsSync(missingPreview), false); assert.equal(store.read(work.id).versions.length, 1);
    await fixture.call(client, "recover_work", { operationId: "resume", workId: work.id, mode: "resume" });
    const repaired = await fixture.wait(client, "resume");
    assert.equal(repaired.status, "succeeded", JSON.stringify(repaired));
    assert.equal(store.read(work.id).versions.length, 2); assert(fixture.countTurns() > 0);
    assert.equal(store.summary(store.read(work.id)).delivery.status, "ready_for_external_review");
    const count = fixture.countTurns();
    await fixture.call(client, "prepare_review_materials", { operationId: "inspect", workId: work.id, versionId: "v002", mode: "inspect_and_repair" });
    const inspected = await fixture.wait(client, "inspect");
    assert.equal(inspected.status, "succeeded"); assert.equal(inspected.result.mode, "inspect_and_repair");
    assert.equal(fixture.countTurns(), count + 2, "新检查包含视觉理解与独立内检"); assert.equal(store.read(work.id).versions.length, 2);
    assert.deepEqual(await fixture.call(client, "prepare_review_materials", request), accepted);
    assert.equal(fixture.countTurns(), count + 2); assert.deepEqual(readFileSync(store.resolvePath(version.sourcePath)), original);
    const tools = await client.listTools();
    for (const name of backgroundTools) assert.match(tools.tools.find(tool => tool.name === name)!.description!, /accepted\/executionId/);
  } finally { await fixture.cleanup(); }
});

test("仅补材料失败保留已通过内检与交付，失败可查询且有效重试不再次检查", { timeout: 40_000 }, async () => {
  const fixture = backgroundFixture("completed");
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", confirmedDraft({ operationId: "create", title: "补材料失败隔离", brief: "合成一秒视频。", purpose: "test" }));
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data);
    const designRef = await adoptedDesign(store, work.id);
    await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample", designRef });
    const produced = await fixture.wait(client, "produce");
    assert.equal(produced.status, "succeeded", JSON.stringify(produced));
    assert.equal(produced.result.delivery.status, "ready_for_external_review");
    const before = store.read(work.id), version = before.versions[0]!, preparation = version.reviewPreparation!;
    const turns = fixture.countTurns();
    const originalFiles = { ...files(store.workDirectory(work.id)), ...files(join(store.dataRoot, "media", work.id)) };
    const request = { operationId: "invalid-range", workId: work.id, versionId: version.id,
      ranges: [{ startSeconds: 0, endSeconds: 10, fps: 1, reason: "合成越界补帧" }] };
    const accepted = await fixture.call(client, "prepare_review_materials", request);
    const failed = await fixture.wait(client, accepted.executionId);
    assert.equal(failed.status, "failed"); assert.match(failed.error, /超过实际成片时长/);
    assert.equal(store.read(work.id).versions[0]!.reviewPreparation!.status, "available", "补材料失败不能撤销原内检通过");
    assert.deepEqual(store.read(work.id), before);
    assert.deepEqual((await fixture.call(client, "get_work", { workId: work.id })).delivery, produced.result.delivery);
    assert.deepEqual(await fixture.call(client, "prepare_review_materials", request), accepted);
    assert.equal((await fixture.call(client, "get_execution", { executionId: accepted.executionId })).status, "failed");

    await fixture.call(client, "prepare_review_materials", { operationId: "reuse-materials", workId: work.id, versionId: version.id });
    const reused = await fixture.wait(client, "reuse-materials");
    assert.equal(reused.status, "succeeded"); assert.equal(reused.result.inspectionPerformed, false);
    assert.deepEqual(store.read(work.id), before, "有效重试复用原批次，不需要重新内检");

    await fixture.call(client, "prepare_review_materials", { operationId: "valid-range", workId: work.id, versionId: version.id,
      ranges: [{ startSeconds: 0.2, endSeconds: 0.8, fps: 10, reason: "合成有效补帧" }] });
    const supplemented = await fixture.wait(client, "valid-range");
    assert.equal(supplemented.status, "succeeded"); assert.equal(supplemented.result.inspectionPerformed, false);
    assert.equal(supplemented.result.batches.length, preparation.batches.length + 1);
    assert.deepEqual(supplemented.result.delivery, produced.result.delivery);
    const after = store.read(work.id), current = after.versions[0]!.reviewPreparation!;
    assert.deepEqual(current.inspections, preparation.inspections);
    const expected = structuredClone(before);
    expected.versions[0]!.reviewPreparation!.batches.push(current.batches.at(-1)!);
    assert.deepEqual(after, expected, "只追加材料批次，制作、内检、外部审查和认可记录不变");
    for (const [path, hash] of Object.entries(originalFiles)) {
      if (path === store.resolvePath("works/" + work.id + "/task.json")) continue;
      assert.equal(valueHash(readFileSync(path)), hash, "已有工程、成片和检查材料不能被补帧改写");
    }
    assert.equal(fixture.countTurns(), turns);
    assert.equal((await fixture.call(client, "get_execution", { executionId: accepted.executionId })).status, "failed", "后续成功不改写原失败记录");
  } finally { await fixture.cleanup(); }
});
