import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeTool, prepareOperation } from "../src/mcp/server.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fixtureRoot, readyVersion } from "./helpers.ts";

test("回复丢失后跨服务重试返回同一结果；同文新操作仍可另建任务", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), request = prepareOperation("create_work", { title: "相同标题", brief: "原始需求", purpose: "production" });
    const first = await executeTool(request.name, request.arguments, new WorkService(store));
    const replay = await executeTool(request.name, request.arguments, new WorkService(new WorkStore(root.path)));
    assert.deepEqual(replay, first);
    assert.equal(store.list().length, 1);
    await assert.rejects(executeTool(request.name, { ...request.arguments, brief: "不同需求" }, new WorkService(store)), /同一操作编号/);
    assert.equal(store.list().length, 1);
    const next = prepareOperation("create_work", { title: "相同标题", brief: "原始需求", purpose: "production" });
    await executeTool(next.name, next.arguments, new WorkService(store));
    assert.equal(store.list().length, 2);
  } finally { root.cleanup(); }
});

test("并发和未完成回执不重新调用动作，损坏回执保持可识别失败", async () => {
  const root = fixtureRoot();
  try {
    const operations = new OperationStore(root.path); let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = operations.execute("one", "synthetic", { value: 1 }, async () => { calls++; await barrier; return { value: "original" }; });
    await assert.rejects(operations.execute("one", "synthetic", { value: 1 }, () => { calls++; }), /尚无确定回执/);
    assert.equal(calls, 1); release(); await first;
    assert.deepEqual(await operations.execute("one", "synthetic", { value: 1 }, () => { calls++; }), { value: "original" });
    mkdirSync(join(root.path, "operations", "crashed"));
    await assert.rejects(operations.execute("crashed", "synthetic", {}, () => { calls++; }), /无法核对原操作回执/);
    writeFileSync(join(root.path, "operations", "one", "request.json"), "{broken");
    await assert.rejects(operations.execute("one", "synthetic", { value: 1 }, () => { calls++; }), /无法核对/);
    assert.equal(calls, 1);
  } finally { root.cleanup(); }
});

test("反馈重试只保存一次，位置校验不改原话，也不伪造精确时间", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("定位", "合成任务"), version = readyVersion(store, work.id, "v001", "sample");
    version.technicalCheck = { durationSeconds: 5 }; work.versions.push(version); store.save(work);
    const service = new WorkService(store), original = "  两秒左右那行字幕放大。\n";
    const request = { operationId: "location-feedback", workId: work.id, versionId: version.id, source: "user", text: original,
      location: { description: "下方标题", precision: "approximate", startSeconds: 2, endSeconds: 3, requestedChange: "放大标题" } };
    await executeTool("submit_feedback", request, service);
    await executeTool("submit_feedback", request, new WorkService(store));
    const updated = store.read(work.id);
    assert.equal(updated.feedback.length, 1); assert.equal(updated.feedback[0]!.text, original);
    assert.equal(updated.feedback[0]!.location?.precision, "approximate");
    await assert.rejects(executeTool("submit_feedback", { ...request, operationId: "outside", location: { ...request.location, endSeconds: 6 } }, service), /超出/);
    await assert.rejects(executeTool("submit_feedback", { ...request, operationId: "reverse", location: { ...request.location, endSeconds: 1 } }, service), /结束时间/);
    const plain = { operationId: "whole", workId: work.id, versionId: version.id, source: "user", text: "全片节奏需要调整。" };
    await executeTool("submit_feedback", plain, service);
    assert.equal(store.read(work.id).feedback.length, 2);
    assert.equal(readFileSync(store.resolvePath(work.briefPath), "utf8"), "# 原始需求\n\n合成任务\n");
  } finally { root.cleanup(); }
});
