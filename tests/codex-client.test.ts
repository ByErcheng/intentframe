import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient, RpcRequestRejected } from "../src/runtime/codex-client.ts";
import { fakeCodex, fixtureRoot } from "./helpers.ts";
import { processMatches, processStartedAt } from "../src/runtime/process-state.ts";

test("RPC 拒绝期间日志失败，原请求仍明确结束", { timeout: 10_000 }, async () => {
  const root = fixtureRoot();
  const client = new CodexAppServerClient({ cwd: root.path, executable: fakeCodex(root.path), timeoutMs: 1_000,
    onEvent: () => { throw new Error("测试磁盘写入失败"); } });
  try {
    await client.initializeConnection();
    const result = await Promise.race([
      client.sendRequest("reject").then(() => null, error => error),
      delay(2_000).then(() => "timeout"),
    ]);
    assert(result instanceof RpcRequestRejected);
    assert.match(result.message, /请求被明确拒绝.*保存错误证据失败/);
  } finally { await client.close(); root.cleanup(); }
});

test("只从最终消息取得交付结果，保留原始回复而不混入进度说明", async () => {
  const root = fixtureRoot(), events: Record<string, unknown>[] = [];
  const client = new CodexAppServerClient({ cwd: root.path, executable: fakeCodex(root.path, "needs_input"), onEvent: e => events.push(e) });
  try {
    await client.initializeConnection();
    await client.sendRequest("turn/start", {});
    assert.equal((await client.waitForTurnCompletion("fixture-turn")).status, "completed");
    assert.equal(JSON.parse(client.finalReply("fixture-turn")).status, "needs_input");
    assert(JSON.stringify(events).includes("缺少参考素材"));
    assert(!client.finalReply("fixture-turn").includes("测试进度"));
  } finally { await client.close(); root.cleanup(); }
});

test("已保存终态后连接结束，不把已知结果改成未知", async () => {
  const root = fixtureRoot();
  const client = new CodexAppServerClient({ cwd: root.path, executable: fakeCodex(root.path, "completed_exit") });
  try {
    await client.initializeConnection();
    await client.sendRequest("turn/start", {});
    await delay(150);
    assert.equal((await client.waitForTurnCompletion("fixture-turn")).status, "completed");
  } finally { await client.close(); root.cleanup(); }
});

test("协议响应与模型整轮等待分别计时，整轮到期后核对中断终态", async () => {
  const root = fixtureRoot();
  const client = new CodexAppServerClient({ cwd: root.path, executable: fakeCodex(root.path, "slow_completed", 2_500), timeoutMs: 1_500, turnTimeoutMs: 5_000 });
  try {
    await client.initializeConnection();
    await client.sendRequest("turn/start", {});
    assert.equal((await client.waitForTurnCompletion("fixture-turn", "fixture-thread")).status, "completed", "模型等待超过单次 RPC 时限仍可完成");
  } finally { await client.close(); root.cleanup(); }
  const stoppedRoot = fixtureRoot();
  const stopped = new CodexAppServerClient({ cwd: stoppedRoot.path, executable: fakeCodex(stoppedRoot.path, "interruptible"), timeoutMs: 2_000, turnTimeoutMs: 150, stopTimeoutMs: 1_000 });
  try {
    await stopped.initializeConnection(); await stopped.sendRequest("turn/start", {});
    assert.equal((await stopped.waitForTurnCompletion("fixture-turn", "fixture-thread")).status, "interrupted");
    assert.match(stopped.stopReason!, /上限/);
  } finally { await stopped.close(); stoppedRoot.cleanup(); }
});

test("进程启动身份不随客户端时区变化，PID 相同但身份不同不能当作原进程", () => {
  const original = process.env.TZ;
  try {
    const birth = processStartedAt(process.pid);
    assert(birth);
    process.env.TZ = "America/New_York";
    assert.equal(processMatches(process.pid, birth), true);
    assert.equal(processMatches(process.pid, "not-the-original-process"), false);
    assert.equal(processMatches(process.pid), undefined);
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});
