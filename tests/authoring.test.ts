import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeToolInline as call } from "../src/mcp/server.ts";
import { WorkStore, workSchema } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { DocumentStore } from "../src/records/document-store.ts";
import { KnowledgeStore, pendingLearningSources } from "../src/records/knowledge-store.ts";
import { fakeCodex, fixtureRoot, fixtureRender } from "./helpers.ts";
import { backgroundFixture } from "./background-helpers.ts";

function setup() {
  const root = fixtureRoot(), store = new WorkStore(root.path);
  const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender, prepareReview: async () => undefined });
  return { root, store, service };
}

test("外部原稿逐字保存；保存和修改不启动设计，旧基线不能覆盖新稿", async () => {
  const { root, store, service } = setup();
  try {
    const original = "  # 我的想法\n\n保留原有空白。\n";
    const work = workSchema.parse(await call("create_work", { operationId: "draft-create", title: "入口草稿", brief: original, purpose: "production" }, service));
    const first = work.authoring!.drafts[0]!;
    assert.equal(service.documents.read(work, first).markdown, original);
    assert.equal(work.authoring!.handoffs.length, 0); assert.equal(work.authoring!.runs.length, 0); assert.equal(work.versions.length, 0);
    await assert.rejects(call("design_video", { operationId: "too-early", workId: work.id, base: first, instruction: "设计" }, service), /交.*设计/);
    assert.equal(store.read(work.id).authoring!.runs.length, 0);
    const second = await service.documents.submit(work.id, "# 新想法\n改为表达感谢。", "draft-edit", "用户修改表达。", first);
    assert.equal(second.id, "d002"); assert.equal(readFileSync(store.resolvePath(first.path), "utf8"), original);
    await assert.rejects(service.documents.submit(work.id, "覆盖", "stale", "旧基线", first), /草稿已变化/);
    assert.equal(store.read(work.id).authoring!.drafts.length, 2);
    assert(!existsSync(join(store.workDirectory(work.id), "versions")));
  } finally { root.cleanup(); }
});

test("草稿生成与设计生成只返回稿件；采用确切设计后才能生成代码", async () => {
  const { root, store, service } = setup();
  try {
    const work = workSchema.parse(await call("create_work", { operationId: "create", title: "设计交接", brief: "合成小熊递花案例。", purpose: "production" }, service));
    const first = work.authoring!.drafts[0]!;
    const revised = await service.authoring.generate(work.id, "revise_draft", first, "按我的意思补充动作。", "revise");
    assert.equal(revised.status, "completed"); assert(revised.document);
    assert.equal(store.read(work.id).authoring!.handoffs.length, 0);
    await service.documents.handoff(work.id, revised.document, "合成用户指令：用这版开始设计。", "handoff");
    const designed = await service.authoring.generate(work.id, "design", revised.document, "设计完整画面、动作和声音。", "design");
    assert.equal(designed.status, "completed"); assert(designed.document);
    assert.equal(store.read(work.id).versions.length, 0);
    assert(!existsSync(join(store.workDirectory(work.id), "versions")));
    const ref = { id: designed.document.id, sha256: designed.document.sha256 };
    await assert.rejects(service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "early-code", { designRef: ref }), /采用/);
    await service.documents.decide(work.id, { operationId: "review", design: ref, status: "adopted", source: "external_ai", notes: "合成审查通过，覆盖动作设计。" });
    const made = await service.produce(work.id, "complete", undefined, "fresh", undefined, undefined, "produce", { designRef: ref });
    const version = made.versions[0]!;
    assert.deepEqual(version.designRef, ref); assert.equal(version.acceptance, "pending");
    assert.equal(made.directionApproval, null, "AI 采用不能补造用户样例确认");
    const input = JSON.parse(readFileSync(store.resolvePath(version.inputManifestPath!), "utf8"));
    assert(input.context.includes(designed.document.markdown));
    assert(input.context.includes(revised.document.markdown));
    const current = store.read(work.id);
    const third = await service.documents.submit(work.id, "新的未交接想法。", "later-draft", "先讨论，不改变在途依据。", current.authoring!.drafts.at(-1));
    assert.equal(service.documents.adopted(store.read(work.id), ref)!.document.id, ref.id);
    await service.documents.handoff(work.id, third, "采用新稿重新设计。", "new-handoff");
    assert.throws(() => service.documents.adopted(store.read(work.id), ref), /交接已被更新/);
    assert.equal(readFileSync(store.resolvePath(version.inputManifestPath!), "utf8"), JSON.stringify(input, null, 2) + "\n");
  } finally { root.cleanup(); }
});

test("脚本内容变化和跨作品引用被拒绝，未完成设计不能采用", async () => {
  const { root, store, service } = setup();
  try {
    const work = store.create("稿件保护", "原始需求"); service.documents.initialize(work, "原稿", "initialize");
    const draft = work.authoring!.drafts[0]!;
    await service.documents.handoff(work.id, draft, "开始设计", "handoff");
    const designed = await service.authoring.generate(work.id, "design", draft, "合成设计", "design");
    assert(designed.document);
    const other = store.create("另一作品", "不能引用别人的稿"); service.documents.initialize(other, "另一稿", "other");
    assert.throws(() => service.documents.read(other, designed.document!), /不存在|不符/);
    const record = store.read(work.id); record.authoring!.runs[0]!.status = "needs_input"; store.save(record);
    await assert.rejects(service.documents.decide(work.id, { operationId: "invalid-approval", design: designed.document, status: "adopted", source: "external_ai", notes: "错误模拟" }), /尚未完成/);
    writeFileSync(designed.document.location, "外部改坏正文");
    assert.throws(() => service.documents.read(store.read(work.id), designed.document!), /不一致/);
  } finally { root.cleanup(); }
});

test("稿件原回复已产生但终态通知失联时，恢复只核原线程并补存，不再生成", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), documents = new DocumentStore(store), work = store.create("稿件恢复", "合成恢复场景");
    documents.initialize(work, "原稿", "initial"); const draft = work.authoring!.drafts[0]!;
    await documents.handoff(work.id, draft, "合成用户指令：设计", "handoff");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result"), timeoutMs: 2000 });
    await assert.rejects(service.authoring.generate(work.id, "design", draft, "合成设计", "design-op"));
    assert.equal(store.read(work.id).execution.status, "unknown");
    const recovered = await new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only"), timeoutMs: 2000 }).recover(work.id);
    assert.equal(recovered.status, "recovered");
    const current = store.read(work.id); assert.equal(current.authoring!.designs.length, 1); assert.equal(current.authoring!.designs[0]!.operationId, "design-op");
    assert.equal(current.execution.status, "idle"); assert.equal(current.versions.length, 0);
    assert.equal(readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"turn/start"')).length, 1);
  } finally { root.cleanup(); }
});

test("未登记的稿件文件保留原样，不被后续新稿覆盖", async () => {
  const { root, store, service } = setup();
  try {
    const work = store.create("残留保护", "合成未登记正文"); service.documents.initialize(work, "第一稿", "initial");
    const path = join(store.workDirectory(work.id), "documents/d002.md"); writeFileSync(path, "未知来源但必须保留");
    const next = await service.documents.submit(work.id, "新的合法草稿", "new-draft", "按原稿修改", work.authoring!.drafts[0]);
    assert.equal(next.id, "d003"); assert.equal(readFileSync(path, "utf8"), "未知来源但必须保留");
  } finally { root.cleanup(); }
});

test("稿件恢复补齐原后台结果，保留完成、待输入和失败的真实状态", { timeout: 30_000 }, async t => {
  for (const [tool, mode, expected, resultStatus] of [
    ["revise_draft", "disconnect_after_result", "succeeded", "completed"],
    ["design_video", "disconnect_needs_input", "waiting_input", "needs_input"],
    ["design_video", "disconnect_failed", "failed", "failed"],
  ] as const) await t.test(expected, async () => {
    const fixture = backgroundFixture(mode);
    try {
      const client = await fixture.connect();
      const work = await fixture.call(client, "create_work", { operationId: "create", title: "稿件恢复回执", brief: "合成稿件，不调用真实模型。", purpose: "test" });
      const draft = work.authoring.drafts[0], base = { id: draft.id, sha256: draft.sha256 };
      if (tool === "design_video") await fixture.call(client, "handoff_draft", { operationId: "handoff", workId: work.id, draft: base, userInstruction: "合成指令：开始设计。" });
      const input = { operationId: "authoring", workId: work.id, base, instruction: "检查恢复后的实际结果。" };
      const accepted = await fixture.call(client, tool, input);
      assert.equal((await fixture.wait(client, "authoring")).status, "unknown");
      const originalBytes = readFileSync(fixture.executions.path("authoring", "outcome.json"));
      await fixture.call(client, "recover_work", { operationId: "recover", workId: work.id });
      assert.equal((await fixture.wait(client, "recover")).status, expected);
      const original = await fixture.call(client, "get_execution", { executionId: "authoring" });
      assert.equal(original.status, expected); assert.equal(original.result.status, resultStatus);
      assert(original.timing.elapsedMs >= 0); assert.equal(original.timing.firstReturnedStatus, expected);
      if (expected === "succeeded") assert.equal(original.result.document.id, "d002");
      if (expected === "waiting_input") assert(original.result.blockers.length);
      if (expected === "failed") assert(original.error);
      assert.deepEqual(readFileSync(fixture.executions.path("authoring", "outcome.json")), originalBytes, "保留原失联记录");
      assert.deepEqual(await fixture.call(client, tool, input), accepted, "同编号重试沿用受理回执");
      await fixture.call(client, "recover_work", { operationId: "recover-again", workId: work.id });
      await fixture.wait(client, "recover-again");
      assert.deepEqual((await fixture.call(client, "get_execution", { executionId: "authoring" })).timing, original.timing);
      assert.equal(fixture.countTurns(), 1, "恢复与重试不再生成稿件");
    } finally { await fixture.cleanup(); }
  });
});

test("稿件原线程仍在执行时，恢复不补造原执行终态", { timeout: 15_000 }, async () => {
  const fixture = backgroundFixture("disconnect");
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", { operationId: "create", title: "未核清稿件", brief: "合成未结束线程。", purpose: "test" });
    const draft = work.authoring.drafts[0];
    await fixture.call(client, "revise_draft", { operationId: "authoring", workId: work.id,
      base: { id: draft.id, sha256: draft.sha256 }, instruction: "合成修改" });
    assert.equal((await fixture.wait(client, "authoring")).status, "unknown");
    await fixture.call(client, "recover_work", { operationId: "recover", workId: work.id });
    assert.equal((await fixture.wait(client, "recover")).status, "unknown");
    assert.equal((await fixture.call(client, "get_execution", { executionId: "authoring" })).status, "unknown");
    assert(!existsSync(fixture.executions.path("authoring", "recovered.json")));
    assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("后台稿件明确失败不返回 succeeded", { timeout: 20_000 }, async () => {
  const fixture = backgroundFixture("failed");
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", { operationId: "create", title: "设计失败", brief: "合成失败", purpose: "test" });
    const base = { id: work.authoring.drafts[0].id, sha256: work.authoring.drafts[0].sha256 };
    await fixture.call(client, "revise_draft", { operationId: "revise", workId: work.id, base, instruction: "模拟修改失败" });
    const state = await fixture.wait(client, "revise");
    assert.equal(state.status, "failed"); assert.equal(state.result.status, "failed");
    assert.equal((await fixture.call(client, "get_work", { workId: work.id })).authoring.drafts.length, 1);
  } finally { await fixture.cleanup(); }
});

test("草稿修改和设计审查可以整理成有稿件来源的候选经验，不能冒充成片验证", async () => {
  const { root, store, service } = setup();
  try {
    const work = store.create("脚本经验", "合成需求"); service.documents.initialize(work, "第一稿", "initial");
    const first = work.authoring!.drafts[0]!;
    const second = await service.documents.submit(work.id, "第二稿，明确动作与情绪。", "changed", "表达太笼统，增加关键动作。", first);
    assert.equal(pendingLearningSources(store.read(work.id)).pendingCount, 1);
    const learning = new WorkService(store, { codexExecutable: fakeCodex(root.path, "learn_method") });
    const organized = await learning.organize(work.id);
    const ref = organized.learningBatches![0]!.experienceRefs[0]!;
    const knowledge = new KnowledgeStore(root.path), saved = knowledge.read(ref);
    assert.equal(saved.status, "candidate");
    assert(saved.sources.some(source => "documentRef" in source && source.documentRef.id === second.id));
    assert(saved.sources.some(source => "documentRef" in source && source.documentRef.id === first.id));
    const { id: _id, revision: _revision, createdAt: _createdAt, ...body } = saved;
    assert.throws(() => knowledge.save({ ...body, status: "verified", verification: "只有脚本，没有视频" }), /实际作品/);
  } finally { root.cleanup(); }
});

test("真实 MCP 新流程依次交接草稿、设计、制作与审查材料，不能跳过采用", { timeout: 60_000 }, async () => {
  const fixture = backgroundFixture("completed");
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", { operationId: "create", title: "新流程合成案例", brief: "合成一秒色块，用来验证系统流程，不代表视频效果。", purpose: "test" });
    const draft = { id: work.authoring.drafts[0].id, sha256: work.authoring.drafts[0].sha256 };
    await assert.rejects(fixture.call(client, "produce_version", { operationId: "no-design", workId: work.id, kind: "complete" }), /designRef/);
    await fixture.call(client, "handoff_draft", { operationId: "handoff", workId: work.id, draft, userInstruction: "合成用户指令：按此稿设计。" });
    const submitted = await fixture.call(client, "design_video", { operationId: "design", workId: work.id, base: draft, instruction: "设计合成示例。" });
    const designed = await fixture.wait(client, submitted.executionId);
    assert.equal(designed.status, "succeeded", JSON.stringify(designed));
    const design = { id: designed.result.document.id, sha256: designed.result.document.sha256 };
    assert.equal((await fixture.call(client, "get_work", { workId: work.id })).versions.length, 0);
    await fixture.call(client, "review_design", { operationId: "adopt", workId: work.id, design, status: "adopted", source: "external_ai", notes: "合成审查：可以进行系统流程测试。" });
    const production = await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "complete", designRef: design, assetIds: [] });
    const finished = await fixture.wait(client, production.executionId);
    assert.equal(finished.status, "succeeded", JSON.stringify(finished));
    const material = await fixture.call(client, "get_review_materials", { workId: work.id, versionId: "v001" });
    assert.equal(material.status, "available"); assert.equal(material.review.status, "not_reviewed");
    assert(material.batches[0].frames.length >= 3); assert(existsSync(material.batches[0].sheets[0].location));
    const imageResult = await client.callTool({ name: "read_media_image", arguments: { workId: work.id,
      source: { kind: "review", versionId: "v001", indexRef: material.batches[0].indexRef, imagePath: material.batches[0].sheets[0].path } } });
    assert.equal(imageResult.isError, undefined);
    const image = imageResult.content.find(item => item.type === "image"); assert(image?.type === "image");
    assert.deepEqual(Buffer.from(image.data, "base64"), readFileSync(material.batches[0].sheets[0].location));
    const invalidImage = await client.callTool({ name: "read_media_image", arguments: { workId: work.id,
      source: { kind: "review", versionId: "v001", indexRef: material.batches[0].indexRef, imagePath: "../../../../config/local.json" } } });
    assert.equal(invalidImage.isError, true, "只能读取本批登记图片，不提供任意文件读取");
    const indexBytes = readFileSync(material.batches[0].indexLocation);
    await fixture.call(client, "record_review", { operationId: "review", workId: work.id, versionId: "v001", status: "passed", source: "external_ai",
      notes: "合成审查仅验证记录交接，没有真实审美评价。", materialIndexes: [material.batches[0].indexRef] });
    const end = await fixture.call(client, "get_work", { workId: work.id });
    assert.equal(end.versions[0].review.status, "passed"); assert.equal(end.versions[0].acceptance, "pending");
    assert.deepEqual(readFileSync(material.batches[0].indexLocation), indexBytes);
    assert.equal(fixture.countTurns(), 3, "设计、代码制作、项目材料核对各一轮");
  } finally { await fixture.cleanup(); }
});
