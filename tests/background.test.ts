import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { backgroundFixture } from "./background-helpers.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { readyVersion } from "./helpers.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { valueHash } from "../src/records/files.ts";

test("MCP 提供实际指南，短调用受理制作，断开后继续并由新连接取回同一结果", { timeout: 45_000 }, async () => {
  const fixture = backgroundFixture();
  try {
    const first = await fixture.connect();
    assert(first.getInstructions()?.includes("read_usage_guide"));
    const guide = await fixture.call(first, "read_usage_guide", { view: "full" });
    assert.equal(guide.content, readFileSync(join(fixture.project, "scripts/README.md"), "utf8"));
    assert.equal(guide.version, createHash("sha256").update(guide.content).digest("hex"));
    const rules = await fixture.call(first, "read_usage_guide", { document: "workflow", section: "反馈处理" });
    assert(rules.content.startsWith("## 反馈处理")); assert(rules.content.includes("原始反馈"));
    await assert.rejects(fixture.call(first, "read_usage_guide", { document: "../../config/local.json" }));
    const work = await fixture.createLegacyWork(first, { operationId: "create", title: "后台交接", brief: "合成任务，验证调用与产物。", purpose: "test" });
    const request = { operationId: "produce", workId: work.id, kind: "sample" };
    const submitted = await fixture.call(first, "produce_version", request, 500);
    assert.equal(submitted.status, "accepted"); assert.equal(submitted.executionId, request.operationId);
    assert.equal(submitted.purpose, "test");
    assert.equal(fixture.executions.read(request.operationId).name, "produce_version");
    assert.equal((await fixture.call(first, "get_operation", { operationId: request.operationId })).state, "accepted");
    await assert.rejects(fixture.call(first, "produce_version", { ...request, operationId: "duplicate" }), /已有后台执行/);
    await first.close();
    const next = await fixture.connect();
    assert.deepEqual(await fixture.call(next, "produce_version", request), submitted);
    const finished = await fixture.wait(next, submitted.executionId);
    assert.equal(finished.status, "succeeded", JSON.stringify(finished));
    const finalWork = await fixture.call(next, "get_work", { view: "detail", workId: work.id });
    assert.equal(finalWork.versions.length, 1); assert.equal(finalWork.versions[0].production, "ready");
    assert.equal(finalWork.activeExecutionId, undefined);
    assert(existsSync(join(fixture.data, "testing", finalWork.versions[0].mediaPath)));
    assert.equal(fixture.countTurns(), 1);
    assert.equal((await fixture.call(next, "get_operation", { operationId: request.operationId })).state, "accepted", "受理回执与制作结果分别保存");
    assert.deepEqual(await fixture.call(next, "produce_version", request), submitted);
  } finally { await fixture.cleanup(); }
});

test("未领取的后台请求可取消，迟到的工作进程不会开始制作；条件变化明确失败", { timeout: 15_000 }, async () => {
  const fixture = backgroundFixture();
  try {
    fixture.delayWorkerStart();
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "尚未开始", brief: "合成排队阶段。", purpose: "test" });
    await fixture.call(client, "produce_version", { operationId: "queued", workId: work.id, kind: "sample" });
    // 首次任务尚无任何版本；可以追加反馈不等于允许虚构反馈目标。
    await assert.rejects(fixture.call(client, "submit_feedback", { operationId: "during-queue", workId: work.id, versionId: "v001", text: "不能引用尚未创建的版本", source: "user" }), /版本/);
    assert.equal((await fixture.call(client, "get_work", { view: "detail", workId: work.id })).feedback.length, 0);
    const cancelled = await fixture.call(client, "cancel_execution", { operationId: "cancel", executionId: "queued" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.timing.firstReturnedStatus, "cancelled");
    assert(cancelled.timing.firstReturnedAt);
    assert.equal((await fixture.call(client, "get_work", { view: "detail", workId: work.id })).activeExecutionId, undefined);
    await fixture.call(client, "produce_version", { operationId: "changed-system", workId: work.id, kind: "sample" });
    appendFileSync(join(fixture.project, "docs/workflow.md"), "\n合成：受理后条件已变化。\n");
    const stopped = await fixture.wait(client, "changed-system");
    assert.equal(stopped.status, "failed"); assert.match(stopped.error, /系统或运行配置已变化/);
    assert.equal(fixture.countTurns(), 0);
    assert.equal((await fixture.call(client, "get_work", { view: "detail", workId: work.id })).versions.length, 0);
  } finally { await fixture.cleanup(); }
});

test("工作进程崩溃不伪装成完成或安全失败，原执行身份与重复保护保留", { timeout: 15_000 }, async () => {
  const fixture = backgroundFixture("interruptible");
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "进程崩溃", brief: "合成模型已经开始。", purpose: "test" });
    const original = await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" });
    await fixture.wait(client, "produce", () => fixture.countTurns() === 1);
    const owner = fixture.executions.claimant(fixture.executions.read("produce"))!;
    process.kill(-owner.pid, "SIGKILL");
    const state = await fixture.wait(client, "produce");
    assert.equal(state.status, "unknown"); assert.match(state.message, /进程已退出/);
    assert.deepEqual(await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" }), original);
    await assert.rejects(fixture.call(client, "produce_version", { operationId: "second-produce", workId: work.id, kind: "sample" }), /已有后台执行/);
    assert.equal((await fixture.call(client, "get_work", { view: "detail", workId: work.id })).activeExecutionId, "produce");
    assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("后台总执行预算独立生效，超时不会被报告为用户取消或制作完成", { timeout: 15_000 }, async () => {
  const fixture = backgroundFixture("interruptible", { jobTimeoutMs: 800, stopTimeoutMs: 1_000 });
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "总预算", brief: "合成慢任务。", purpose: "test" });
    await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" });
    const state = await fixture.wait(client, "produce");
    assert.equal(state.status, "failed", JSON.stringify(state)); assert.match(state.error, /总等待上限/);
    assert.equal(state.stopRequested, false);
    assert(fixture.countTurns() <= 1);
    assert.equal((await fixture.call(client, "get_work", { view: "detail", workId: work.id })).activeExecutionId, undefined);
  } finally { await fixture.cleanup(); }
});

test("渲染停止后保留完成工程，后台恢复只继续渲染并补齐原执行结果", { timeout: 45_000 }, async () => {
  const fixture = backgroundFixture("slow_render");
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "渲染停止与恢复", brief: "合成已完成源码。", purpose: "test" });
    await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" });
    await fixture.wait(client, "produce", state => state.status === "running" && state.message.includes("渲染"));
    await fixture.call(client, "cancel_execution", { operationId: "cancel", executionId: "produce" });
    const stopped = await fixture.wait(client, "produce");
    assert.equal(stopped.status, "cancelled", JSON.stringify(stopped));
    const before = await fixture.call(client, "get_work", { view: "detail", workId: work.id });
    assert.equal(before.versions[0].agentResult.status, "completed"); assert(before.versions[0].sourceSnapshot);
    await fixture.call(client, "recover_work", { mode: "resume", operationId: "recover", workId: work.id });
    const restored = await fixture.wait(client, "recover");
    assert.equal(restored.status, "succeeded", JSON.stringify(restored));
    const previous = await fixture.call(client, "get_execution", { executionId: "produce" });
    assert.equal(previous.status, "succeeded");
    const after = await fixture.call(client, "get_work", { view: "detail", workId: work.id });
    assert.equal(after.versions.length, 1); assert.equal(after.versions[0].production, "ready");
    assert.equal(after.activeExecutionId, undefined); assert.equal(fixture.countTurns(), 1);
    assert.equal(JSON.parse(readFileSync(fixture.executions.path("produce", "outcome.json"), "utf8")).status, "cancelled", "原停止事实仍保留");
  } finally { await fixture.cleanup(); }
});

test("停止请求经原生中断取得终态后才报告取消，随后可继续同一任务", { timeout: 20_000 }, async () => {
  const fixture = backgroundFixture("interruptible");
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "停止核对", brief: "合成慢任务。", purpose: "test" });
    await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" });
    await fixture.wait(client, "produce", () => fixture.countTurns() === 1);
    await fixture.call(client, "cancel_execution", { operationId: "cancel", executionId: "produce", reason: "合成用户要求停止" });
    const finished = await fixture.wait(client, "produce");
    assert.equal(finished.status, "cancelled", JSON.stringify(finished)); assert.equal(finished.stopRequested, true);
    const record = await fixture.call(client, "get_work", { view: "detail", workId: work.id });
    assert.equal(record.activeExecutionId, undefined); assert.equal(record.execution.status, "failed");
    assert.equal(record.versions[0].nativeResult.status, "interrupted");
    assert.equal(record.versions[0].production, "failed");
    assert.equal(fixture.countTurns(), 1);
    await fixture.call(client, "submit_feedback", { operationId: "feedback", workId: work.id, versionId: "v001", text: "保留这条原始意见供之后接续", source: "user" });
  } finally { await fixture.cleanup(); }
});

test("未取得停止终态时保留未知与占用，不能用新操作再次制作", { timeout: 20_000 }, async () => {
  const fixture = backgroundFixture("ignore_interrupt");
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "停止未核实", brief: "合成中断未响应。", purpose: "production" });
    await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" });
    await fixture.wait(client, "produce", () => fixture.countTurns() === 1);
    await fixture.call(client, "cancel_execution", { operationId: "cancel", executionId: "produce" });
    const finished = await fixture.wait(client, "produce");
    assert.equal(finished.status, "unknown", JSON.stringify(finished));
    const record = await fixture.call(client, "get_work", { view: "detail", workId: work.id });
    assert.equal(record.execution.status, "unknown"); assert.equal(record.activeExecutionId, "produce");
    await assert.rejects(fixture.call(client, "produce_version", { operationId: "retry", workId: work.id, kind: "sample" }), /已有后台执行/);
    assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("未知后台执行可交给恢复核对，原工程依据缺失时仍不重做模型请求", { timeout: 20_000 }, async () => {
  const fixture = backgroundFixture("disconnect_after_result");
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "未知后核对", brief: "合成原调用断线。", purpose: "test" });
    await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample" });
    assert.equal((await fixture.wait(client, "produce")).status, "unknown");
    await fixture.call(client, "recover_work", { mode: "resume", operationId: "recover", workId: work.id });
    const checked = await fixture.wait(client, "recover");
    assert.equal(checked.status, "unknown"); assert.equal(checked.result.status, "needs_verification");
    const previous = await fixture.call(client, "get_execution", { executionId: "produce" });
    assert.equal(previous.recoveryOperationId, "recover");
    const current = await fixture.call(client, "get_work", { view: "detail", workId: work.id });
    assert.equal(current.activeExecutionId, "recover"); assert.equal(current.execution.status, "unknown");
    assert.equal(current.versions[0].sourceSnapshot, undefined); assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("渲染复用和经验整理各自完成，不混同作品原有的待补充状态", { timeout: 20_000 }, async () => {
  const fixture = backgroundFixture("learn_method");
  try {
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data), work = store.create("待补充的作品", "合成字幕布局。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample"));
    work.execution = { status: "waiting_input", error: "原作品另有待补充素材。" }; store.save(work);
    const client = await fixture.connect();
    await fixture.call(client, "render_version", { operationId: "reuse", workId: work.id, versionId: "v001" });
    assert.equal((await fixture.wait(client, "reuse")).status, "succeeded");
    await fixture.call(client, "submit_feedback", { operationId: "feedback", workId: work.id, versionId: "v001", text: "字幕遮挡主体，请调整并复查", source: "user" });
    await fixture.call(client, "organize_experience", { operationId: "organize", workId: work.id });
    const organized = await fixture.wait(client, "organize");
    assert.equal(organized.status, "succeeded");
    const current = await fixture.call(client, "get_work", { view: "detail", workId: work.id });
    assert.equal(current.execution.status, "waiting_input"); assert.equal(current.learningBatches.length, 1);
    assert.equal(current.learningBatches[0].experienceRefs.length, 1); assert.equal(current.activeExecutionId, undefined);
  } finally { await fixture.cleanup(); }
});

test("已开始的执行丢失领取身份时，不补认未开始、取消成功或安全接管", async () => {
  const fixture = backgroundFixture();
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "身份缺失", brief: "合成损坏记录。", purpose: "test" });
    const input = { operationId: "lost-owner", workId: work.id, kind: "sample", threadMode: "fresh" };
    const request = { operationId: input.operationId, workId: work.id, purpose: "test" as const, name: "produce_version" as const,
      input, inputHash: valueHash(input), createdAt: new Date().toISOString(), systemFingerprint: "synthetic", configurationFingerprint: "synthetic" };
    await new OperationStore(fixture.data).execute(input.operationId, request.name, input, () => {
      fixture.executions.create(request); fixture.executions.update(request, "running", "合成：已开始但身份文件丢失");
      fixture.executions.setActive(request, join(fixture.data, "testing")); return { executionId: input.operationId, status: "accepted" };
    }, "test", "accepted");
    assert.equal((await fixture.call(client, "get_execution", { executionId: input.operationId })).status, "unknown");
    const stop = await fixture.call(client, "cancel_execution", { operationId: "cancel", executionId: input.operationId });
    assert.equal(stop.status, "unknown"); assert.equal(stop.stopRequested, true);
    assert.equal(fixture.executions.outcome(request), undefined);
    assert.throws(() => fixture.executions.claim(request), /已被领取/);
    await assert.rejects(fixture.call(client, "recover_work", { mode: "resume", operationId: "recover", workId: work.id }), /身份缺失/);
    assert.equal((await fixture.call(client, "get_work", { view: "detail", workId: work.id })).activeExecutionId, input.operationId);
    assert.equal(fixture.countTurns(), 0);
  } finally { await fixture.cleanup(); }
});

test("后台占用错绑其他作品时，不清除另一条作品的占用", async () => {
  const fixture = backgroundFixture();
  try {
    const client = await fixture.connect(), store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data);
    const first = store.create("原作品", "合成结束记录。"), second = store.create("错绑作品", "不能修改其他作品。");
    const input = { operationId: "finished", workId: first.id, kind: "sample" };
    const request = fixture.executions.create({ operationId: input.operationId, workId: first.id, purpose: "test", name: "produce_version",
      input, inputHash: valueHash(input), createdAt: new Date().toISOString(), systemFingerprint: "synthetic", configurationFingerprint: "synthetic" });
    fixture.executions.setActive(request, store.dataRoot); fixture.executions.finish(request, { status: "succeeded", result: { synthetic: true } });
    const otherPath = join(store.workDirectory(second.id), "active-execution.json");
    writeFileSync(otherPath, JSON.stringify({ operationId: request.operationId, workId: second.id }));
    const originalPath = join(store.workDirectory(first.id), "active-execution.json"), original = readFileSync(originalPath, "utf8");
    await assert.rejects(fixture.call(client, "get_work", { view: "detail", workId: second.id }), /归属不一致/);
    await assert.rejects(fixture.call(client, "recover_work", { mode: "resume", operationId: "recover", workId: second.id }), /归属不一致/);
    assert.equal(readFileSync(originalPath, "utf8"), original);
    assert.equal(fixture.countTurns(), 0);
  } finally { await fixture.cleanup(); }
});
