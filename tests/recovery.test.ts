import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeToolInline as executeTool } from "../src/mcp/server.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { WorkStore } from "../src/records/work-store.ts";
import type { WorkRecord } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { productionReceiptPath } from "../src/runtime/production-receipt.ts";
import type { ProductionReceipt } from "../src/runtime/production-receipt.ts";
import { fakeCodex, fixtureRender, fixtureRoot } from "./helpers.ts";

function calls(root: string) {
  return readFileSync(join(root, "native-fixture/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).method as string);
}

test("原结果已保存但任务写回失败，只补原结果并完成渲染，不再次调用模型", async () => {
  const root = fixtureRoot();
  class FailingStore extends WorkStore {
    fail = true;
    override save(work: WorkRecord) {
      if (this.fail && work.versions.at(-1)?.agentResult) { this.fail = false; throw new Error("合成：结果写回中断"); }
      super.save(work);
    }
  }
  try {
    const store = new FailingStore(root.path), work = store.create("恢复", "仅使用模拟模型");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    await assert.rejects(executeTool("produce_version", { operationId: "produce-once", workId: work.id, kind: "sample" }, service), /写回中断/);
    const before = store.read(work.id), version = before.versions[0]!;
    assert(existsSync(productionReceiptPath(store, work.id, version.runId)));
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
    await executeTool("recover_work", { operationId: "recover-source-only", workId: work.id, render: false }, service);
    assert.equal(store.read(work.id).versions[0]!.production, "source_ready");
    assert(!existsSync(store.resolvePath(version.mediaPath)), "只补存不能生成媒体或声称已交付");
    assert.equal(new OperationStore(root.path).read("produce-once").state, "failed");
    const recovered = await executeTool("recover_work", { operationId: "recover-once", workId: work.id }, new WorkService(store, {
      codexExecutable: fakeCodex(root.path, "read_only"), render: fixtureRender,
    }));
    assert(recovered);
    assert.equal(store.read(work.id).versions[0]!.production, "ready");
    assert.equal(store.read(work.id).versions.length, 1);
    assert.equal(new OperationStore(root.path).read("produce-once").state, "succeeded");
    await executeTool("produce_version", { operationId: "produce-once", workId: work.id, kind: "sample" }, service);
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("回执身份不符时保留未知状态、原工程和禁止重发的保护", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("恢复身份保护", "合成断线与回执错绑，不调用真实模型。");
    await assert.rejects(new WorkService(store, {
      codexExecutable: fakeCodex(root.path, "disconnect_after_result"), render: fixtureRender,
    }).produce(work.id, "sample"));
    const original = store.read(work.id), version = original.versions[0]!;
    assert.equal(original.execution.status, "unknown");
    const source = readFileSync(store.resolvePath(version.sourcePath), "utf8");
    const path = productionReceiptPath(store, work.id, version.runId);
    mkdirSync(join(store.workDirectory(work.id), "runs", version.runId), { recursive: true });
    const receipt: ProductionReceipt = { workId: work.id, versionId: version.id, runId: version.runId,
      threadId: version.threadId!, turnId: version.turnId!, status: "completed", reply: "{}",
      contextSha256: version.contextSha256!, knowledgeReads: [], feedbackReads: [], learningSourceIds: [] };
    let renders = 0;
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only"),
      render: async (...args) => { renders++; return fixtureRender(...args); } });
    for (const mismatch of [{ workId: "other-work" }, { threadId: "other-thread" },
      { turnId: "other-turn" }, { contextSha256: "0".repeat(64) }]) {
      writeFileSync(path, JSON.stringify({ ...receipt, ...mismatch }));
      const savedReceipt = readFileSync(path, "utf8");
      await assert.rejects(service.recover(work.id), /原制作回执.*不一致/);
      assert.deepEqual(store.read(work.id), original, "未核实的回执不能改变原任务事实");
      assert.equal(readFileSync(path, "utf8"), savedReceipt);
      await assert.rejects(service.produce(work.id, "sample"), /不能重复发起/);
    }
    assert.equal(renders, 0);
    assert.equal(readFileSync(store.resolvePath(version.sourcePath), "utf8"), source);
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("仅补存缺失成片的已认可版本，保留完成与确认事实且不重新制作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("历史完成保护", "合成制作与确认，只验证记录规则。");
    let renders = 0;
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path),
      render: async (...args) => { renders++; return fixtureRender(...args); } });
    await service.produce(work.id, "sample");
    await store.confirm(work.id, "v001", "direction", "合成方向确认", "合成样例");
    const operations = new OperationStore(store.dataRoot);
    const request = { operationId: "complete-once", workId: work.id, kind: "complete" as const, threadMode: "fresh" as const };
    await assert.rejects(operations.execute(request.operationId, "produce_version", request, async () => {
      await service.produce(work.id, request.kind, undefined, request.threadMode, undefined, undefined, request.operationId);
      throw new Error("合成：业务已生效，返回操作结果前失败");
    }), /返回操作结果前失败/);
    await store.review(work.id, "v002", "passed", "合成复查，不代表实际作品效果。", "external_ai");
    const original = await store.confirm(work.id, "v002", "acceptance", "合成成片确认");
    const version = original.versions[1]!, output = store.resolvePath(version.mediaPath);
    rmSync(output);
    for (const operationId of ["recover-without-render", "check-again-without-render"]) {
      await executeTool("recover_work", { operationId, workId: work.id, render: false }, service);
      const recovered = store.read(work.id);
      assert.deepEqual(recovered.versions, original.versions, "媒体缺失不改变已经完成的版本及其审查认可");
      assert.deepEqual(recovered.confirmations, original.confirmations);
      assert.equal(store.availability(recovered.versions[1]!).status, "missing");
      assert(!existsSync(output));
      assert.equal(renders, 2);
      assert.equal(operations.read(request.operationId).state, "failed", "历史完成不能代替当前成片可用，提前补认成功回执");
    }
    await executeTool("recover_work", { operationId: "recover-with-render", workId: work.id }, service);
    const restored = store.read(work.id);
    assert.equal(restored.versions[1]!.production, "ready");
    assert.equal(restored.versions[1]!.acceptance, "accepted");
    assert.deepEqual(restored.confirmations, original.confirmations);
    assert.equal(store.availability(restored.versions[1]!).status, "available");
    assert.equal(operations.read(request.operationId).state, "succeeded");
    assert.equal(renders, 3);
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 2);
  } finally { root.cleanup(); }
});

test("中断后只查原线程，缺少当时工程回执时不按现有文件补造", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("原调用", "不重发制作");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result"), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample"));
    const original = store.read(work.id), version = original.versions[0]!;
    assert.equal(original.execution.status, "unknown");
    assert(!existsSync(productionReceiptPath(store, work.id, version.runId)));
    const recovery = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only"), render: fixtureRender });
    const result = await recovery.recover(work.id);
    assert.equal(result.status, "needs_verification");
    assert.equal(store.read(work.id).versions[0]!.nativeResult?.status, "completed");
    assert.equal(store.read(work.id).versions[0]!.sourceSnapshot, undefined);
    assert.equal(store.read(work.id).execution.status, "unknown");
    assert(calls(root.path).includes("thread/turns/list"));
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
    await assert.rejects(recovery.produce(work.id, "sample"), /不能重复发起/);
  } finally { root.cleanup(); }
});

test("仍在运行或返回错误线程时不解除旧占用，已核原终态才可收尾", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("占用", "核对原进程和执行");
    await assert.rejects(new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect"), render: fixtureRender }).produce(work.id, "sample"));
    const lock = join(store.workDirectory(work.id), ".write-lock"); mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: "active" }));
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only"), render: fixtureRender });
    assert.equal((await service.recover(work.id)).status, "running");
    assert(existsSync(lock));
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2_000_000_000, startedAt: "dead fixture" }));
    assert.equal((await service.recover(work.id)).status, "running");
    assert(existsSync(lock), "原线程尚无终态，不能仅凭进程退出解除占用");
    await assert.rejects(new WorkService(store, { codexExecutable: fakeCodex(root.path, "wrong_thread") }).recover(work.id), /线程身份/);
    assert(existsSync(lock));
    const path = join(root.path, "native-fixture/history.json"), history = JSON.parse(readFileSync(path, "utf8"));
    const thread = history.threads[store.read(work.id).versions[0]!.threadId!];
    thread.turns[0].status = "failed"; thread.turns[0].error = { message: "合成：原任务已停止" };
    writeFileSync(path, JSON.stringify(history));
    assert.equal((await service.recover(work.id)).status, "needs_verification");
    assert(!existsSync(lock));
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
  } finally { root.cleanup(); }
});

test("记录后的工程被改动，恢复不生成新快照或重做原制作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("来源", "防止当前文件冒充原结果");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const ready = await service.produce(work.id, "sample"), version = ready.versions[0]!;
    const original = version.sourceSnapshot;
    rmSync(store.resolvePath(version.mediaPath));
    writeFileSync(store.resolvePath(version.sourcePath), "// 后来的其他内容");
    await assert.rejects(service.recover(work.id), /工程或制作依赖/);
    assert.deepEqual(store.read(work.id).versions[0]!.sourceSnapshot, original);
    assert.equal(store.read(work.id).versions[0]!.production, "ready", "恢复失败不抹掉历史完成事实");
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
    assert(!existsSync(store.resolvePath(version.mediaPath)));
  } finally { root.cleanup(); }
});

test("旧历史协议和丢失轮次回执按原执行标记核对，重复标记不能猜选最新轮次", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("原执行定位", "仅测试协议历史，不调用模型。");
    await assert.rejects(new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result"), render: fixtureRender }).produce(work.id, "sample"));
    const record = store.read(work.id), version = record.versions[0]!;
    version.turnId = undefined; store.save(record);
    const path = join(root.path, "native-fixture/history.json"), history = JSON.parse(readFileSync(path, "utf8"));
    const thread = history.threads[version.threadId!];
    delete thread.historyMode; // 官方协议默认是 legacy，不能假定支持分页。
    const extra = structuredClone(thread.turns[0]); extra.id = "ambiguous-turn"; thread.turns.push(extra);
    writeFileSync(path, JSON.stringify(history));
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only") });
    await assert.rejects(service.recover(work.id), /无法唯一定位/);
    assert.equal(store.read(work.id).execution.status, "unknown");
    thread.turns.pop(); writeFileSync(path, JSON.stringify(history));
    assert.equal((await service.recover(work.id)).status, "needs_verification");
    assert.equal(store.read(work.id).versions[0]!.turnId, "fixture-turn");
    assert(!calls(root.path).includes("thread/turns/list"));
    assert.equal(calls(root.path).filter(name => name === "turn/start").length, 1);
  } finally { root.cleanup(); }
});
