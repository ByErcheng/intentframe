import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { readyVersion } from "./helpers.ts";
import { executeTool } from "../src/mcp/server.ts";

test("未确认样例不能完整制作；AI 审查不等于用户确认", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-gate-"));
  try {
    const store = new WorkStore(root);
    const service = new WorkService(store);
    const work = store.create("测试", "只测试状态规则，不调用模型。");
    assert.equal(new WorkStore(root).list()[0]?.id, work.id);
    work.versions.push(readyVersion(store, work.id, "v001", "sample"));
    store.save(work);
    await store.review(work.id, "v001", "passed", "测试样例的模拟审查。", "internal_check");
    assert.throws(() => service.assertCanProduce(store.read(work.id), "complete"), /方向/);
    await assert.rejects(store.confirm(work.id, "v001", "acceptance", "测试确认"), /完整作品/);
    await store.confirm(work.id, "v001", "direction", "测试中的用户确认", "保留文字风格");
    assert.doesNotThrow(() => service.assertCanProduce(store.read(work.id), "complete"));
  } finally { rmSync(root, { recursive: true }); }
});

test("认可只属于具体版本；常规反馈与方向变更分别处理", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-versions-"));
  try {
    const store = new WorkStore(root);
    const work = store.create("测试", "版本与反馈约定。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample"), readyVersion(store, work.id, "v002", "complete"));
    store.save(work);
    await store.confirm(work.id, "v001", "direction", "模拟确认", "当前方向");
    await store.confirm(work.id, "v002", "acceptance", "模拟成片认可");
    const next = store.read(work.id);
    next.versions.push(readyVersion(store, work.id, "v003", "complete"));
    store.save(next);
    assert.equal(store.read(work.id).versions[2]?.acceptance, "pending");
    const revised = await store.feedback(work.id, "v003", "修改一个错字", "system_test", false);
    assert(revised.directionApproval);
    assert.equal(revised.feedback.at(-1)?.text, "修改一个错字");
    const changed = await store.feedback(work.id, "v003", "更换核心主题", "system_test", true);
    assert.equal(changed.directionApproval, null);
    await assert.rejects(store.feedback(work.id, "v999", "错误目标", "system_test"), /找不到/);
  } finally { rmSync(root, { recursive: true }); }
});

test("未知执行不得重发；非法路径和并发写入被拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-safety-"));
  try {
    const store = new WorkStore(root);
    const service = new WorkService(store);
    const work = store.create("测试", "失败和接续边界。");
    work.execution = { status: "unknown" };
    store.save(work);
    await assert.rejects(service.produce(work.id, "sample"), /重复发起/);
    assert.equal(store.read(work.id).versions.length, 0);
    assert.throws(() => store.workDirectory("../escape"));
    assert.throws(() => store.resolvePath("../escape"));
    await store.withLock(work.id, async () => {
      await assert.rejects(store.withLock(work.id, () => undefined), /正在被操作/);
    });
    assert.equal(store.read(work.id).execution.status, "unknown");
  } finally { rmSync(root, { recursive: true }); }
});

test("多来源审查和重复确认保留原始历史，方向失效不删除确认事实", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-history-"));
  try {
    const store = new WorkStore(root), work = store.create("历史记录", "审查与认可分别保留。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample"), readyVersion(store, work.id, "v002", "complete"));
    store.save(work);
    await store.review(work.id, "v002", "passed", "内部检查范围", "internal_check");
    await store.review(work.id, "v002", "needs_changes", "外部发现问题", "external_ai");
    await store.review(work.id, "v002", "passed", "外部复查结论", "external_ai");
    await store.confirm(work.id, "v001", "direction", "原始方向确认", "第一个方向");
    await store.feedback(work.id, "v002", "改变核心主题", "user", true);
    await store.confirm(work.id, "v002", "acceptance", "第一次认可原话");
    await store.confirm(work.id, "v002", "acceptance", "再次认可原话");
    const result = store.read(work.id);
    assert.equal(result.directionApproval, null);
    assert.deepEqual(result.versions[1]?.reviews?.map(review => review.notes), ["内部检查范围", "外部发现问题", "外部复查结论"]);
    assert.deepEqual(result.confirmations?.map(item => item.userConfirmation), ["原始方向确认", "第一次认可原话", "再次认可原话"]);
    assert.equal(result.versions[1]?.review.notes, "外部复查结论");
  } finally { rmSync(root, { recursive: true }); }
});

test("数据目录内符号链接和错绑版本的记录不能越过作品边界", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-boundary-"));
  try {
    const store = new WorkStore(join(root, "data")), work = store.create("路径边界", "只使用隔离测试文件。");
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(store.dataRoot, "redirect"));
    assert.throws(() => store.resolvePath("redirect/target.txt"), /符号链接/);
    symlinkSync(outside, join(store.dataRoot, "works", "linked-work"));
    await assert.rejects(store.withLock("linked-work", () => writeFileSync(join(outside, "changed.txt"), "不应写入")), /符号链接/);
    work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
    const taskPath = join(store.workDirectory(work.id), "task.json");
    const corrupted = JSON.parse(readFileSync(taskPath, "utf8"));
    corrupted.versions[0].mediaPath = corrupted.versions[0].mediaPath.replace("v001", "v002");
    writeFileSync(taskPath, JSON.stringify(corrupted));
    assert.throws(() => store.read(work.id), /路径.*版本|版本.*路径/);
  } finally { rmSync(root, { recursive: true }); }
});

test("MCP 校验保留需求、反馈和确认原文，拒绝纯空白输入", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-verbatim-"));
  try {
    const store = new WorkStore(root), service = new WorkService(store);
    const brief = "    缩进的原始需求\n\n";
    await executeTool("create_work", { operationId: "create-verbatim", title: "原文", brief, purpose: "production" }, service);
    const work = store.read(store.list()[0]!.id);
    assert.equal(readFileSync(store.resolvePath(work.briefPath), "utf8"), "# 原始需求\n\n" + brief + "\n");
    work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
    const original = "    原话中的缩进\n\n";
    await executeTool("submit_feedback", { operationId: "feedback-verbatim", workId: work.id, versionId: "v001", text: original, source: "user" }, service);
    await executeTool("confirm_version", { operationId: "confirm-verbatim", workId: work.id, versionId: "v001", kind: "direction", userConfirmation: original, scope: "样例方向" }, service);
    assert.equal(store.read(work.id).feedback[0]?.text, original);
    assert.equal(store.read(work.id).directionApproval?.userConfirmation, original);
    await assert.rejects(executeTool("create_work", { operationId: "reject-whitespace", title: "空白", brief: " \n ", purpose: "production" }, service));
  } finally { rmSync(root, { recursive: true }); }
});

test("首次更新旧记录时保留已知审查与确认，不编造历史确认时间", async () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-legacy-history-"));
  try {
    const store = new WorkStore(root), work = store.create("旧历史", "兼容已有记录。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample"), readyVersion(store, work.id, "v002", "complete"));
    work.directionApproval = { sampleVersionId: "v001", scope: "旧范围", userConfirmation: "旧方向原话", confirmedAt: "2026-01-01T00:00:00.000Z" };
    work.versions[1]!.acceptance = "accepted";
    work.versions[1]!.userConfirmation = "旧成片认可原话";
    work.versions[1]!.review = { status: "needs_changes", source: "external_ai", notes: "原有问题", checkedAt: "2026-01-02T00:00:00.000Z" };
    store.save(work);
    await store.review(work.id, "v002", "passed", "复查通过", "external_ai");
    const result = await store.feedback(work.id, "v002", "修改方向", "user", true);
    assert.deepEqual(result.versions[1]?.reviews?.map(item => item.notes), ["原有问题", "复查通过"]);
    assert.equal(result.confirmations?.[0]?.confirmedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(result.confirmations?.[1]?.userConfirmation, "旧成片认可原话");
    assert.equal(result.confirmations?.[1]?.confirmedAt, undefined);
  } finally { rmSync(root, { recursive: true }); }
});
