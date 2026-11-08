import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { readyVersion } from "./helpers.ts";

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
