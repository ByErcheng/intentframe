import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ToolUpdateChecker, updatePeriod } from "../src/updates/checker.ts";
import { latestVersion, newerStable, toolVersion } from "../src/updates/sources.ts";
import { readInventory, type Inventory } from "../src/updates/catalog.ts";
import { configuration, repositoryRoot } from "../src/config.ts";
import { valueHash } from "../src/records/files.ts";
import { fixtureRoot } from "./helpers.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { executeTool } from "../src/mcp/server.ts";
import { WorkRouter } from "../src/runtime/work-router.ts";

const settings = { enabled: true, dayStartHour: 6, timeoutMs: 150 };
function inventory(version = "1.0.0"): Inventory {
  return { fingerprint: valueHash(version), entries: [
    { id: "library", name: "合成依赖", packages: ["example"], source: { kind: "npm", package: "example" }, url: "https://example.com/releases" },
  ], packages: { example: version }, tools: {}, issues: [] };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("版本按数值比较，识别跨主版本和正式版，拒绝预发布候选与未知格式", () => {
  assert(newerStable("4.0.10", "4.0.9")); assert(!newerStable("4.0.9", "4.0.10"));
  assert(!newerStable("4.0.10+build.2", "v4.0.10+build.1"));
  assert(newerStable("1.0.0", "1.0.0-rc.1")); assert(!newerStable("1.0.0", "2.0.0-rc.1"));
  assert.throws(() => newerStable("1.0.1-rc.1", "1.0.0"), /预发布/);
  assert.throws(() => newerStable("latest", "1.0.0"), /版本号/);
});

test("早上六点划分本地周期，午夜和夏令时切换不提前重置", () => {
  assert.equal(updatePeriod(new Date(2026, 10, 13, 1), 6), "2026-11-12");
  assert.equal(updatePeriod(new Date(2026, 10, 13, 5, 59, 59), 6), "2026-11-12");
  assert.equal(updatePeriod(new Date(2026, 10, 13, 6), 6), "2026-11-13");
  assert.equal(updatePeriod(new Date(2026, 0, 1, 1), 6), "2025-12-31");
  const source = "import {updatePeriod} from './src/updates/checker.ts'; console.log(updatePeriod(new Date(2026,2,8,5,59),6));";
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", source],
    { cwd: repositoryRoot, env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" }).trim(), "2026-03-07");
});

test("首次检查、同日复用、回执幂等和次日重新通知；旧回执不屏蔽新一天", async () => {
  const root = fixtureRoot(); let now = new Date(2026, 10, 12, 23, 59), calls = 0;
  const options = { settings, now: () => now, inventory,
    latest: async () => { calls++; return "2.0.0"; } };
  try {
    const checker = new ToolUpdateChecker(root.path, options), first = await checker.check();
    assert(first && "notice" in first && first.notice);
    const id = first.notice.id;
    assert.equal(first.status, "updates_available"); assert(first.notice.updates[0]!.members[0]!.majorChange);
    assert.deepEqual(await new ToolUpdateChecker(root.path, options).check(), first);
    now = new Date(2026, 10, 13, 1);
    assert.deepEqual(await checker.check(), first); assert.equal(calls, 1);
    const receipt = await checker.acknowledge(id);
    assert.deepEqual(await checker.acknowledge(id), receipt);
    const received = await checker.check(); assert(received && !("notice" in received));
    now = new Date(2026, 10, 13, 6);
    const next = await checker.check(); assert(next && "notice" in next && next.notice);
    assert.notEqual(next.notice.id, id); assert.equal(calls, 2);
    await assert.rejects(checker.acknowledge(id), /过期/);
    assert("notice" in (await checker.check())!);
  } finally { root.cleanup(); }
});

test("同日升级后按新安装状态检查，旧提醒无法确认新状态", async () => {
  const root = fixtureRoot(); let current = "1.0.0";
  try {
    const checker = new ToolUpdateChecker(root.path, { settings, inventory: () => inventory(current), latest: async () => "2.0.0" });
    const first = await checker.check(); assert(first && "notice" in first && first.notice);
    current = "2.0.0";
    const next = await checker.check(); assert.equal(next?.status, "current"); assert(!("notice" in next!));
    await assert.rejects(checker.acknowledge(first.notice.id), /过期/);
  } finally { root.cleanup(); }
});

test("并发调用只查一次，结果与回执分别落盘，不把返回消息当作已收到", async () => {
  const root = fixtureRoot(); let calls = 0;
  const options = { settings: { ...settings, timeoutMs: 1000 }, inventory,
    latest: async () => { calls++; await delay(60); return "1.0.1"; } };
  try {
    const values = await Promise.all(Array.from({ length: 5 }, () => new ToolUpdateChecker(root.path, options).check()));
    assert.equal(calls, 1); assert(values.every(value => value && "notice" in value));
    values.forEach(value => assert.deepEqual(value, values[0]));
    const first = values[0]!; assert("notice" in first && first.notice);
    await Promise.all(Array.from({ length: 4 }, () => new ToolUpdateChecker(root.path, options).acknowledge(first.notice!.id)));
    assert(!("notice" in (await new ToolUpdateChecker(root.path, options).check())!));
  } finally { root.cleanup(); }
});

test("一处超时仍保留其他更新，同日不反复联网，不要求额外轮询", async () => {
  const root = fixtureRoot(); let calls = 0;
  const snapshot = inventory();
  snapshot.entries.push({ id: "slow", name: "慢来源", packages: ["slow"], source: { kind: "npm", package: "slow" }, url: "https://example.com/slow" });
  snapshot.packages.slow = "1.0.0";
  try {
    const checker = new ToolUpdateChecker(root.path, { settings, inventory: () => snapshot,
      latest: async source => { calls++; if (source.kind === "npm" && source.package === "slow") return new Promise<string>(() => {}); return "1.0.1"; } });
    const start = Date.now(), result = await checker.check();
    assert(Date.now() - start < 1000); assert.equal(result?.status, "partial");
    assert(result && "notice" in result && result.notice); assert.equal(result.notice.updates.length, 1);
    assert(result.issues.some(item => item.includes("超时")));
    assert.deepEqual(await checker.check(), result); assert.equal(calls, 2);
  } finally { root.cleanup(); }
});

test("全部查询失败、记录损坏和中断认领均明确失败，不报告已经最新", async () => {
  const root = fixtureRoot();
  try {
    const checker = new ToolUpdateChecker(root.path, { settings, inventory, latest: async () => { throw new Error("HTTP 503"); } });
    const result = await checker.check(); assert.equal(result?.status, "failed"); assert(!("notice" in result!));
    const id = updatePeriod(new Date(), 6) + "-" + inventory().fingerprint;
    const record = join(root.path, "maintenance/tool-updates", id, "result.json");
    writeFileSync(record, "{}");
    assert.equal((await checker.check())?.status, "failed");
    const changed = inventory("1.0.1"), directory = join(root.path, "maintenance/tool-updates", updatePeriod(new Date(), 6) + "-" + changed.fingerprint);
    mkdirSync(directory);
    const interrupted = await new ToolUpdateChecker(root.path, { settings, inventory: () => changed, latest: async () => { throw new Error("不应重查"); } }).check();
    assert.equal(interrupted?.status, "failed"); assert(interrupted?.issues.some(item => item.includes("中断")));
  } finally { root.cleanup(); }
});

test("来源适配核对响应、排除预发布、限制大小，不发送凭据或执行安装", async () => {
  const signal = new AbortController().signal;
  assert.equal(await latestVersion({ kind: "npm", package: "@example/pkg" }, signal, async (url, init) => {
    assert.equal(String(url), "https://registry.npmjs.org/%40example%2Fpkg/latest");
    assert.equal(init?.redirect, "error"); assert(!new Headers(init?.headers).has("authorization"));
    return json({ version: "1.2.3" });
  }), "1.2.3");
  assert.equal(await latestVersion({ kind: "node" }, signal, async () => json([
    { version: "v27.0.0-alpha.1" }, { version: "v24.10.0" }, { version: "v26.1.0" }, { version: "v26.0.0" },
  ])), "26.1.0");
  assert.equal(await latestVersion({ kind: "github", repository: "restic/restic" }, signal,
    async () => json({ tag_name: "v0.19.2", draft: false, prerelease: false })), "0.19.2");
  await assert.rejects(latestVersion({ kind: "npm", package: "example" }, signal, async () => json({ version: "1.0.1-beta" })), /正式/);
  await assert.rejects(latestVersion({ kind: "github", repository: "restic/restic" }, signal,
    async () => json({ tag_name: "v0.19.2", draft: true, prerelease: false })));
  await assert.rejects(latestVersion({ kind: "node" }, signal, async () => new Response("", { status: 503 })), /503/);
  await assert.rejects(latestVersion({ kind: "node" }, signal, async () => new Response("bad json")), /JSON/);
  await assert.rejects(latestVersion({ kind: "node" }, signal, async () => new Response("x".repeat(2_000_001))), /大小/);
});

test("工具清单完整覆盖项目直接依赖；合成新增和移除依赖、安装漂移均可见", () => {
  const actual = readInventory();
  assert(!actual.issues.some(item => /未登记|已不在项目/.test(item)));
  const root = fixtureRoot();
  try {
    mkdirSync(join(root.path, "config")); mkdirSync(join(root.path, "node_modules/example"), { recursive: true });
    writeFileSync(join(root.path, "config/tool-updates.json"), JSON.stringify(inventory().entries));
    writeFileSync(join(root.path, "package.json"), JSON.stringify({ dependencies: { example: "1.0.0", newdep: "1.0.0" } }));
    writeFileSync(join(root.path, "package-lock.json"), JSON.stringify({ packages: { "node_modules/example": { version: "1.0.0" } } }));
    writeFileSync(join(root.path, "node_modules/example/package.json"), JSON.stringify({ version: "1.0.1" }));
    const result = readInventory(root.path);
    assert(result.issues.some(item => item.includes("newdep"))); assert(result.issues.some(item => item.includes("不一致")));
    writeFileSync(join(root.path, "package.json"), "{}");
    assert(readInventory(root.path).issues.some(item => item.includes("已不在项目")));
  } finally { root.cleanup(); }
});

test("独立工具读取实际版本，未知输出不能冒用声明版本", async () => {
  const signal = new AbortController().signal, root = fixtureRoot(), oldPath = process.env.PATH;
  try {
    assert.equal(await toolVersion("node", process.execPath, signal), process.version.slice(1));
    const executable = join(root.path, "unknown");
    writeFileSync(executable, "#!" + process.execPath + "\nconsole.log('unrecognized');", { mode: 0o700 });
    await assert.rejects(toolVersion("codex", executable, signal), /实际版本/);
    writeFileSync(executable, "#!/usr/bin/env node\nconsole.log('codex-cli 0.163.0');", { mode: 0o700 });
    process.env.PATH = "/usr/bin:/bin";
    assert.equal(await toolVersion("codex", executable, signal), "0.163.0");
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; root.cleanup(); }
});

test("禁用检查无状态写入，配置保留六点与短超时边界", async () => {
  const root = fixtureRoot();
  try {
    const checker = new ToolUpdateChecker(root.path, { settings: { ...settings, enabled: false },
      inventory: () => { throw new Error("不应读取"); } });
    assert.equal(await checker.check(), undefined);
    await assert.rejects(checker.acknowledge("unused"), /未启用/);
    assert.equal(configuration.updates.dayStartHour, 6);
  } finally { root.cleanup(); }
});

test("检查记录写入失败不破坏原查询或错误，也不把失败缓存成最新", async () => {
  const root = fixtureRoot(), previous = configuration.updates.enabled;
  try {
    configuration.updates.enabled = true;
    writeFileSync(join(root.path, "maintenance"), "合成占位，阻止创建检查记录");
    const router = new WorkRouter(root.path);
    const result = await executeTool("list_works", {}, router) as { works: unknown[]; updateCheck: { status: string } };
    assert.deepEqual(result.works, []); assert.equal(result.updateCheck.status, "failed");
    await assert.rejects(executeTool("get_work", { workId: "missing-work" }, router), /找不到指定作品/);
    assert.equal(readFileSync(join(root.path, "maintenance"), "utf8"), "合成占位，阻止创建检查记录");
  } finally { configuration.updates.enabled = previous; root.cleanup(); }
});

test("真实 MCP 跨进程共享每日检查，外部 AI 直接回执，业务与重复请求保持原行为", { timeout: 20_000 }, async () => {
  const root = fixtureRoot(), clients: Client[] = [];
  try {
    const log = join(root.path, "requests.log");
    const executable = join(root.path, "tool");
    writeFileSync(executable, "#!" + process.execPath + "\nconsole.log(process.argv[2] === 'version' ? 'restic 0.19.1' : 'codex-cli 0.163.0');", { mode: 0o700 });
    const connect = async (fail = false) => {
      const client = new Client({ name: "update-check-fixture", version: "1" }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [join(repositoryRoot, "tests/fixtures/update-mcp-server.ts")],
        env: { INTENTFRAME_DATA_ROOT: fail ? join(root.path, "failed") : root.path, INTENTFRAME_NODE_BIN: process.execPath,
          INTENTFRAME_CODEX_BIN: executable, INTENTFRAME_RESTIC_BIN: executable,
          INTENTFRAME_BACKUP_ROOT: join(root.path, "backups"), INTENTFRAME_UPDATE_CHECKS: "1", UPDATE_FIXTURE_LOG: log,
          UPDATE_FIXTURE_FAIL: fail ? "1" : "0" } }));
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content.find(item => item.type === "text"); assert(content?.type === "text");
      if (result.isError) throw new Error(content.text);
      return JSON.parse(content.text);
    };
    const [a, b] = await Promise.all([connect(), connect()]);
    const [info, list] = await Promise.all([call(a, "get_runtime_info"), call(b, "list_works")]);
    assert.equal(info.assetRoot, root.path); assert.deepEqual(list.works, []);
    assert.equal(info.updateCheck.notice.id, list.updateCheck.notice.id);
    const fetched = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(fetched.length, new Set(fetched).size);
    assert(fetched.length >= 12);
    const notices = info.updateCheck.notice.updates;
    assert.equal(notices.filter((entry: { id: string }) => entry.id === "remotion").length, 1);
    const receipt = await call(a, "acknowledge_update_notice", { noticeId: info.updateCheck.notice.id, received: true });
    assert.equal(receipt.received, true);
    assert.deepEqual(await call(b, "acknowledge_update_notice", { noticeId: info.updateCheck.notice.id, received: true }), receipt);
    assert.equal((await call(b, "get_runtime_info")).updateCheck.notice, undefined);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, fetched.length);
    await assert.rejects(call(a, "acknowledge_update_notice", { noticeId: info.updateCheck.notice.id, received: false }));
    const c = await connect(); assert.equal((await call(c, "get_runtime_info")).updateCheck.notice, undefined);
    const failed = await connect(true), failure = await call(failed, "list_works");
    assert.deepEqual(failure.works, []); assert.equal(failure.updateCheck.status, "failed");
    assert.equal(failure.updateCheck.notice, undefined); assert(failure.updateCheck.issues.some((issue: string) => issue.includes("503")));
  } finally { await Promise.all(clients.map(client => client.close())); root.cleanup(); }
});
