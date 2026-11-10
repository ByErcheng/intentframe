import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeToolInline as executeTool, prepareOperation } from "../src/mcp/server.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { WorkStore, workSchema } from "../src/records/work-store.ts";
import type { WorkRecord } from "../src/records/work-store.ts";
import { WorkRouter } from "../src/runtime/work-router.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { adoptedDesign, fakeCodex, fixtureRender, fixtureRoot } from "./helpers.ts";

function fixtureRouter(root: string) {
  const executable = fakeCodex(root);
  return new WorkRouter(root, store => new WorkService(store, { codexExecutable: executable, render: fixtureRender, prepareReview: async () => undefined }));
}

test("一个入口按新任务选择用途，交错制作、修改和新会话接续保持原区域", async () => {
  const root = fixtureRoot();
  try {
    const router = fixtureRouter(root.path), brief = "只测试任务路由，字幕缓慢出现。";
    assert.throws(() => prepareOperation("create_work", { title: "缺少用途", brief }), /purpose/);
    await assert.rejects(executeTool("create_work", { operationId: "invalid", title: "未知用途", brief, purpose: "auto" }, router));
    assert(!router.operations.exists("invalid"));
    const testing = workSchema.parse(await executeTool("create_work", { operationId: "create-test", title: "做一次测试", brief, purpose: "test" }, router));
    assert(!existsSync(join(root.path, "works")), "测试创建不写正式作品区域");
    const formal = workSchema.parse(await executeTool("create_work", { operationId: "create-formal", title: "正式制作", brief, purpose: "production" }, router));
    const testingDesign = await adoptedDesign(router.forWork(testing.id).store, testing.id);
    const formalDesign = await adoptedDesign(router.forWork(formal.id).store, formal.id);
    const before = readFileSync(join(root.path, "works", formal.id, "task.json"), "utf8");
    const made = workSchema.parse(await executeTool("produce_version", { operationId: "make-test", workId: testing.id, kind: "sample", designRef: testingDesign }, router));
    assert.equal(made.purpose, "test"); assert.equal(made.versions[0]!.production, "ready");
    assert.equal(router.operations.read("make-test").purpose, "test");
    assert.equal(readFileSync(join(root.path, "works", formal.id, "task.json"), "utf8"), before);
    await executeTool("submit_feedback", { operationId: "feedback-test", workId: testing.id, versionId: "v001", text: "标题放大一些", source: "user" }, fixtureRouter(root.path));
    await executeTool("produce_version", { operationId: "make-formal", workId: formal.id, kind: "sample", designRef: formalDesign }, router);
    const continued = workSchema.parse(await executeTool("produce_version", { operationId: "continue-test", workId: testing.id, kind: "sample", designRef: testingDesign }, fixtureRouter(root.path)));
    assert.equal(continued.purpose, "test"); assert.equal(continued.versions.length, 2);
    assert.equal(continued.versions[1]!.basedOnVersionId, "v001");
    assert.deepEqual(continued.versions[1]!.appliedFeedbackIds, [continued.feedback[0]!.id]);
    assert(existsSync(join(root.path, "testing", continued.versions[1]!.mediaPath)));
    assert(!existsSync(join(root.path, continued.versions[1]!.mediaPath)));
    await assert.rejects(executeTool("produce_version", { operationId: "illicit-switch", workId: testing.id, kind: "sample", purpose: "production" }, router), /purpose/);
    await assert.rejects(executeTool("produce_version", { operationId: "complete-without-design", workId: formal.id, kind: "complete" }, router), /designRef/);
    const listing = await executeTool("list_works", { purpose: "all", limit: 1 }, router) as { works: unknown[]; nextOffset: number };
    assert.equal(listing.works.length, 1); assert.equal(listing.nextOffset, 1);
    assert.equal(router.service("production").store.list().length, 1);
    assert.equal(router.service("test").store.list().length, 1);
  } finally { root.cleanup(); }
});

test("同一操作编号跨用途冲突只执行一次，成功回执独立于之后的任务可用性", async () => {
  const root = fixtureRoot();
  try {
    const router = fixtureRouter(root.path), common = { operationId: "one-request", title: "用途不能随重试改变", brief: "合成任务。" };
    const result = await Promise.allSettled([
      executeTool("create_work", { ...common, purpose: "test" }, router),
      executeTool("create_work", { ...common, purpose: "production" }, fixtureRouter(root.path)),
    ]);
    assert.equal(result[0]!.status, "fulfilled"); assert.equal(result[1]!.status, "rejected");
    assert.equal(router.service("production").store.list().length, 0);
    const original = await executeTool("create_work", { ...common, purpose: "test" }, fixtureRouter(root.path));
    assert.deepEqual(original, (result[0] as PromiseFulfilledResult<unknown>).value);
    const work = workSchema.parse(original), path = router.service("test").store.resolvePath("works/" + work.id + "/task.json");
    rmSync(path);
    assert.deepEqual(await executeTool("create_work", { ...common, purpose: "test" }, router), original);
    await assert.rejects(executeTool("get_work", { workId: work.id }, router), /ENOENT/);
    assert(!existsSync(path), "读取回执不能重新执行创建任务");
  } finally { root.cleanup(); }
});

test("历史未标用途的任务保持原文；重复编号或错绑用途不能自动选另一区域", async () => {
  const root = fixtureRoot();
  try {
    const router = fixtureRouter(root.path), store = router.service("test").store;
    const work = store.create("旧任务", "只有原有记录。");
    work.purpose = undefined; work.scopeId = undefined; store.save(work);
    const path = store.resolvePath("works/" + work.id + "/task.json"), original = readFileSync(path, "utf8");
    const found = await executeTool("get_work", { workId: work.id }, router) as { purpose?: string; storagePurpose: string };
    assert.equal(found.purpose, undefined); assert.equal(found.storagePurpose, "test");
    assert.equal(readFileSync(path, "utf8"), original);
    const formal = router.service("production").store;
    cpSync(store.workDirectory(work.id), formal.workDirectory(work.id), { recursive: true });
    await assert.rejects(executeTool("get_work", { workId: work.id }, router), /多个区域重复/);
    await assert.rejects(executeTool("submit_feedback", { operationId: "ambiguous", workId: work.id, versionId: "v001", text: "不要猜目标", source: "user" }, router), /多个区域重复/);
    assert(!router.operations.exists("ambiguous"));
    rmSync(formal.workDirectory(work.id), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...work, purpose: "production" }));
    await assert.rejects(executeTool("get_work", { workId: work.id }, router), /制作用途或数据区域/);
    assert.equal(formal.list().length, 0);
  } finally { root.cleanup(); }
});

test("旧区域回执原位读取与重试，新增用途不能绕过旧回执保护", async () => {
  const root = fixtureRoot();
  try {
    const router = fixtureRouter(root.path), store = router.service("test").store, legacy = new OperationStore(store.dataRoot);
    const request = { operationId: "legacy-create", title: "旧测试任务", brief: "旧接口不含用途字段。" };
    const created = await legacy.execute(request.operationId, "create_work", request,
      () => store.summary(store.create(request.title, request.brief, request.operationId)));
    const receiptPath = join(store.dataRoot, "operations", request.operationId, "request.json"), original = readFileSync(receiptPath, "utf8");
    assert.deepEqual(await executeTool("create_work", { ...request, purpose: "test" }, router), created);
    await assert.rejects(executeTool("create_work", { ...request, purpose: "production" }, router), /同一操作编号/);
    assert.equal(readFileSync(receiptPath, "utf8"), original); assert(!router.operations.exists(request.operationId));
    assert.deepEqual(await executeTool("get_operation", { operationId: request.operationId }, router), legacy.read(request.operationId));
    await router.operations.execute("old-duplicate", "historical", {}, () => ({ original: "production" }));
    await legacy.execute("old-duplicate", "historical", {}, () => ({ original: "test" }));
    await assert.rejects(executeTool("get_operation", { operationId: "old-duplicate" }, router), /历史区域重复/);
    const selected = await executeTool("get_operation", { operationId: "old-duplicate", purpose: "test" }, router) as { result: unknown };
    assert.deepEqual(selected.result, { original: "test" });
    await assert.rejects(executeTool("create_work", { ...request, operationId: "old-duplicate", purpose: "test" }, router), /历史区域重复/);
    writeFileSync(receiptPath, "{broken");
    await assert.rejects(executeTool("create_work", { ...request, purpose: "production" }, router), /无法核对原操作回执/);
    assert.equal(store.list().length, 1); assert.equal(router.service("production").store.list().length, 0);
  } finally { root.cleanup(); }
});

for (const legacy of [false, true]) test("测试任务恢复自动补齐" + (legacy ? "旧区域" : "共享") + "原制作回执", async () => {
  const root = fixtureRoot();
  class FailingStore extends WorkStore {
    fail = true;
    override save(work: WorkRecord) {
      if (this.fail && work.versions.at(-1)?.agentResult) { this.fail = false; throw new Error("合成：写回失败"); }
      super.save(work);
    }
  }
  try {
    const testing = new FailingStore(join(root.path, "testing"), "test", root.path), executable = fakeCodex(root.path);
    const router = new WorkRouter(root.path, store => new WorkService(store.purpose === "test" ? testing : store, { codexExecutable: executable, render: fixtureRender }));
    const work = testing.create("恢复用途", "仅用合成原结果。");
    const request = { operationId: "produce-once", workId: work.id, kind: "sample" as const, threadMode: "fresh" as const };
    const operations = legacy ? new OperationStore(testing.dataRoot) : router.operations;
    if (legacy) await assert.rejects(operations.execute(request.operationId, "produce_version", request,
      () => router.service("test").produce(work.id, "sample", undefined, "fresh", undefined, undefined, request.operationId)), /写回失败/);
    else await assert.rejects(executeTool("produce_version", request, router), /写回失败/);
    const fresh = fixtureRouter(root.path);
    await executeTool("recover_work", { operationId: "recover-once", workId: work.id }, fresh);
    assert.equal(testing.read(work.id).versions[0]!.production, "ready");
    assert.equal(operations.read(request.operationId).state, "succeeded");
    await executeTool("produce_version", request, fresh);
    assert.equal(testing.read(work.id).versions.length, 1);
    assert.equal(readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"turn/start"')).length, 1);
  } finally { root.cleanup(); }
});

test("效果比较通过同一入口创建并定位测试任务，不改变正式任务用途", async () => {
  const root = fixtureRoot();
  try {
    const router = fixtureRouter(root.path);
    const formal = router.service("production").store.create("正式作品", "原任务保持不变。");
    const comparison = await executeTool("create_comparison", { operationId: "comparison", comparison: {
      title: "比较", brief: "共同输入", kind: "creation", change: "一处改动", knowledgeRefs: [],
    } }, router) as { id: string; workIds: { before: string; after: string } };
    for (const id of Object.values(comparison.workIds)) {
      const work = workSchema.parse(await executeTool("get_work", { workId: id }, fixtureRouter(root.path)));
      assert.equal(work.purpose, "test"); assert.equal(work.comparison!.id, comparison.id);
    }
    assert.deepEqual(await executeTool("get_comparison", { comparisonId: comparison.id }, fixtureRouter(root.path)), comparison);
    assert.equal(workSchema.parse(await executeTool("get_work", { workId: formal.id }, router)).purpose, "production");
    assert.equal(router.service("test").store.list().length, 2);
    assert.equal(router.service("production").store.list().length, 1);
  } finally { root.cleanup(); }
});
