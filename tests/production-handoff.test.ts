import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { ExecutionStore } from "../src/records/execution-store.ts";
import { valueHash } from "../src/records/files.ts";
import { fileHash } from "../src/common/file-hash.ts";
import { backgroundFixture } from "./background-helpers.ts";
import { fixtureRoot, readyVersion } from "./helpers.ts";

test("真实 MCP 拒绝旧方向歧义，后台允许明确沿已确认旧样例接续", { timeout: 45_000 }, async () => {
  const fixture = backgroundFixture();
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", { operationId: "legacy-create", title: "旧双方向", brief: "合成需求", purpose: "test" });
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data), record = store.read(work.id);
    const a = readyVersion(store, work.id, "v001", "sample"), b = readyVersion(store, work.id, "v002", "sample");
    b.basedOnVersionId = a.id; record.versions.push(a, b); store.save(record);
    await assert.rejects(fixture.call(client, "produce_version", { operationId: "legacy-implicit", workId: work.id, kind: "sample" }), /历史.*方向/);
    await fixture.call(client, "confirm_version", { operationId: "legacy-confirm", workId: work.id, versionId: a.id,
      kind: "direction", scope: "仅 A", userConfirmation: "合成确认 A" });
    await assert.rejects(fixture.call(client, "produce_version", { operationId: "legacy-wrong", workId: work.id, kind: "complete", baseVersionId: b.id, feedbackIds: [] }), /已确认方向/);
    for (const op of ["legacy-implicit", "legacy-wrong"]) {
      assert(!fixture.executions.exists(op)); assert(!existsSync(join(fixture.data, "operations", op)));
    }
    assert.equal(fixture.countTurns(), 0);
    const accepted = await fixture.call(client, "produce_version", { operationId: "legacy-correct", workId: work.id,
      kind: "complete", baseVersionId: a.id, baseReason: "合成：沿 A，B 保留", feedbackIds: [] });
    assert.equal((await fixture.wait(client, accepted.executionId)).status, "succeeded");
    const current = store.read(work.id), completed = current.versions.at(-1)!;
    assert.equal(completed.basedOnVersionId, a.id); assert.equal(completed.directionId, a.id);
    assert.equal(current.versions[0]!.directionId, undefined); assert.equal(current.versions[1]!.directionId, undefined);
    const again = await fixture.call(client, "produce_version", { operationId: "legacy-continue", workId: work.id,
      kind: "complete", baseVersionId: completed.id, feedbackIds: [] });
    assert.equal((await fixture.wait(client, again.executionId)).status, "succeeded");
    assert.equal(store.read(work.id).confirmations?.length, 1);
  } finally { await fixture.cleanup(); }
});

test("后台预览修复返回实际文件，保留视频且不再次调用模型", { timeout: 45_000 }, async () => {
  const fixture = backgroundFixture();
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", { operationId: "preview-create", title: "预览修复", brief: "合成一秒视频", purpose: "test" });
    const started = await fixture.call(client, "produce_version", { operationId: "preview-produce", workId: work.id, kind: "sample" });
    assert.equal((await fixture.wait(client, started.executionId)).status, "succeeded");
    const before = await fixture.call(client, "get_work", { workId: work.id }), version = before.versions[0];
    const previews = version.technicalCheck.previews as string[];
    rmSync(previews[1]!);
    const missing = await fixture.call(client, "get_work", { workId: work.id });
    assert.equal(missing.versions[0].previewAvailability.status, "incomplete");
    assert(!missing.versions[0].technicalCheck.previews.includes(previews[1]));
    const repair = await fixture.call(client, "render_version", { operationId: "preview-repair", workId: work.id, versionId: version.id });
    assert.equal((await fixture.wait(client, repair.executionId)).status, "succeeded");
    const after = await fixture.call(client, "get_work", { workId: work.id });
    assert.equal(after.versions[0].previewAvailability.status, "available");
    assert(after.versions[0].technicalCheck.previews.every((path: string) => existsSync(path)));
    assert.equal(fileHash(version.videoLocation), version.videoSha256);
    assert.equal(after.versions.length, 1); assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("真实 MCP 在受理时冻结反馈，排队收到的新意见留待下一轮；首次最终返回耗时稳定", async () => {
  const fixture = backgroundFixture();
  try {
    fixture.delayWorkerStart();
    const client = await fixture.connect();
    const invalid = await client.callTool({ name: "create_work", arguments: { operationId: "unknown-field", title: "非法字段", brief: "合成", purpose: "test", clientSentAt: "2026-01-01T00:00:00Z" } });
    assert.equal(invalid.isError, true);
    assert(!existsSync(join(fixture.data, "operations", "unknown-field")));
    const work = await fixture.call(client, "create_work", { operationId: "create", title: "排队反馈", brief: "合成案例", purpose: "test" });
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data);
    const record = store.read(work.id), version = readyVersion(store, work.id, "v001", "sample");
    version.directionId = version.id; record.versions.push(version); store.save(record);
    await assert.rejects(fixture.call(client, "produce_version", { operationId: "invalid", workId: work.id, kind: "sample", feedbackIds: ["missing"] }), /反馈标识/);
    assert(!fixture.executions.exists("invalid"));
    const start = await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample", baseVersionId: "v001" });
    const request = fixture.executions.read(start.executionId);
    assert.equal(start.selection.baseVersionId, "v001");
    assert.deepEqual(start.selection.feedbackIds, []);
    assert(request.receivedAt && request.receivedAt <= request.createdAt);
    const feedback = await fixture.call(client, "submit_feedback", { operationId: "new-feedback", workId: work.id, versionId: "v001", source: "user", text: "稍后改成蓝色" });
    assert.equal(feedback.feedback[0].receivedDuringExecutionId, start.executionId);
    const done = await fixture.wait(client, start.executionId);
    assert.equal(done.status, "succeeded");
    assert(!done.message.includes("正在"));
    assert(done.timing.elapsedMs >= 0);
    assert.equal(done.timing.receivedAt, request.receivedAt);
    assert.equal(done.timing.firstReturnedStatus, "succeeded");
    assert.deepEqual((await fixture.call(client, "get_execution", { executionId: start.executionId })).timing, done.timing);
    const current = await fixture.call(client, "get_work", { workId: work.id });
    assert.equal(current.feedback.length, 1);
    assert.deepEqual(current.versions.at(-1).feedbackIds, []);
    assert.deepEqual(current.feedback[0].appliedInVersionIds, []);
    assert.deepEqual(await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample", baseVersionId: "v001" }), start);
    assert.equal(fixture.countTurns(), 1);
  } finally { await fixture.cleanup(); }
});

test("未知与历史缺值不伪造耗时，失败返回与恢复后的查询保留原终点", () => {
  const root = fixtureRoot();
  try {
    const store = new ExecutionStore(root.path), input = { operationId: "timing", workId: "work-test" };
    const request = store.create({ operationId: "timing", name: "produce_version", input, inputHash: valueHash(input),
      workId: "work-test", purpose: "test", createdAt: new Date().toISOString(), systemFingerprint: "test", configurationFingerprint: "test" });
    assert.equal(store.recordReturn("timing", { status: "unknown" }), undefined);
    assert(!existsSync(store.path("timing", "first-return.json")));
    store.finish(request, { status: "failed", error: "合成失败" });
    const returned = store.recordReturn("timing", store.view("timing"));
    assert.equal(returned?.elapsedMs, null);
    assert.equal(returned?.receivedAt, undefined);
    assert.match(returned?.limitation ?? "", /缺少接收时间/);
    assert.equal(returned?.firstReturnedAt, undefined);
    assert(!existsSync(store.path("timing", "first-return.json")));
    store.recordRecovery("timing", "work-test", { saved: true });
    assert.deepEqual(store.recordReturn("timing", store.view("timing")), returned);
    assert.equal(store.view("timing").status, "succeeded");
    const modernInput = { operationId: "modern", workId: "work-test" };
    const modern = store.create({ ...request, operationId: "modern", input: modernInput, inputHash: valueHash(modernInput), receivedAt: new Date().toISOString() });
    store.finish(modern, { status: "failed", error: "可核对失败" });
    const first = store.recordReturn("modern", store.view("modern"));
    assert(first?.firstReturnedAt);
    store.recordRecovery("modern", "work-test", { saved: true });
    assert.deepEqual(store.recordReturn("modern", store.view("modern")), first);
  } finally { root.cleanup(); }
});
