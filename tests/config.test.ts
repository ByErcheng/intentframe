import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadConfiguration, repositoryRoot } from "../src/config.ts";
import { fakeCodex, fixtureRoot } from "./helpers.ts";

const example = readFileSync(join(repositoryRoot, "config/example.json"), "utf8");
const cleanEnvironment = { ...process.env };
for (const key of Object.keys(cleanEnvironment)) {
  if (key.startsWith("INTENTFRAME_")) delete cleanEnvironment[key];
}

function configurationFixture() {
  const root = fixtureRoot(), project = join(root.path, "project with spaces");
  const path = join(project, "config/local.json");
  mkdirSync(join(project, "config"), { recursive: true });
  const settings = JSON.parse(example);
  settings.dataRoot = "../isolated data";
  settings.backupRoot = "../isolated backup";
  const save = () => writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  save();
  return { ...root, project, configPath: path, settings, save };
}

test("完整配置以仓库为路径基准，临时覆盖可追溯且不改文件", () => {
  const fixture = configurationFixture();
  try {
    fixture.settings.runtime.requestTimeoutMs = 800;
    fixture.settings.runtime.productionTimeoutMs = 1_200;
    fixture.settings.media.concurrency = 3;
    fixture.settings.assetLibraries = [{ id: "music", path: "../music", role: "music" }];
    fixture.save();
    const before = readFileSync(fixture.configPath, "utf8");
    const config = loadConfiguration(fixture.project, { INTENTFRAME_DATA_ROOT: "../temporary data",
      INTENTFRAME_NODE_BIN: process.execPath, INTENTFRAME_CODEX_BIN: "../fake codex",
      INTENTFRAME_RESTIC_BIN: "../fake restic", INTENTFRAME_BACKUP_ROOT: "../temporary backup" });
    assert.equal(config.configPath, fixture.configPath);
    assert.equal(config.assetRoot, join(fixture.path, "temporary data"));
    assert.deepEqual(config.workRoots, { production: config.assetRoot, test: join(config.assetRoot, "testing") });
    assert.equal(config.backupRoot, join(fixture.path, "temporary backup"));
    assert.equal(config.node, process.execPath);
    assert.equal(config.codex, join(fixture.path, "fake codex"));
    assert.equal(config.restic, join(fixture.path, "fake restic"));
    assert.equal(config.environmentOverrides.length, 5);
    assert.equal(config.runtime.requestTimeoutMs, 800);
    assert.equal(config.runtime.productionTimeoutMs, 1_200);
    assert.equal(config.media.concurrency, 3);
    assert.equal(config.assetLibraries[0]!.path, resolve(fixture.project, "../music"));
    const fromFile = loadConfiguration(fixture.project, {});
    assert.equal(fromFile.assetRoot, join(fixture.path, "isolated data"));
    assert.equal(fromFile.node, resolve(fixture.project, fixture.settings.tools.node.path));
    assert.deepEqual(fromFile.environmentOverrides, []);
    assert.equal(readFileSync(fixture.configPath, "utf8"), before);
    for (const key of config.environmentOverrides) {
      for (const value of ["", "   ", "bad\npath", "bad\0path"]) {
        assert.throws(() => loadConfiguration(fixture.project, { [key]: value }), /必须为非空路径/);
      }
    }
  } finally { fixture.cleanup(); }
});

test("错误配置不回退、不吞未知字段，也不在错误中输出填写内容", () => {
  const fixture = configurationFixture();
  const privateValue = "synthetic-private-value-must-not-appear";
  try {
    const invalid = [
      { ...fixture.settings, dataRoot: "" },
      { ...fixture.settings, dataRoot: privateValue + "\n" },
      { ...fixture.settings, [privateValue]: "unknown" },
      { ...fixture.settings, tools: { ...fixture.settings.tools, node: { ...fixture.settings.tools.node, [privateValue]: true } } },
      { ...fixture.settings, runtime: null },
      { ...fixture.settings, audioInspection: "pretend-heard" },
      { ...fixture.settings, assetLibraries: [{ id: "music", path: "../music", role: "music" }, { id: "music", path: "../other", role: "music" }] },
      { ...fixture.settings, assetLibraries: [{ id: "music", path: " ", role: "music" }] },
      { ...fixture.settings, media: { ...fixture.settings.media, concurrency: 0 } },
      { ...fixture.settings, media: { ...fixture.settings.media, concurrency: 1.5 } },
      ...[0, -1, 1.5, 2_147_483_648, "3000"].map(commandTimeoutMs =>
        ({ ...fixture.settings, backup: { commandTimeoutMs } })),
    ];
    for (const value of invalid) {
      writeFileSync(fixture.configPath, JSON.stringify(value));
      assert.throws(() => loadConfiguration(fixture.project, {}), error => {
        assert(error instanceof Error);
        assert.match(error.message, /字段无效、缺失或含未知项/);
        assert(!error.message.includes(privateValue));
        return true;
      });
    }
    writeFileSync(fixture.configPath, '{"token":"' + privateValue);
    assert.throws(() => loadConfiguration(fixture.project, {}), error =>
      error instanceof Error && /不是有效 JSON/.test(error.message) && !error.message.includes(privateValue));
    // 示例及旧文件即使存在，也不能代替缺失的本机配置。
    writeFileSync(join(fixture.project, "config/example.json"), example);
    writeFileSync(join(fixture.project, "toolchain.json"), example);
    rmSync(fixture.configPath);
    assert.throws(() => loadConfiguration(fixture.project, {}), /首次运行/);
  } finally { fixture.cleanup(); }
});

test("拒绝权限宽松、符号链接和非普通配置文件，FIFO 不阻塞启动", { timeout: 15_000 }, () => {
  const fixture = configurationFixture();
  try {
    chmodSync(fixture.configPath, 0o644);
    assert.throws(() => loadConfiguration(fixture.project, {}), /0600/);
    chmodSync(fixture.configPath, 0o600);
    const external = join(fixture.path, "saved.json");
    renameSync(fixture.configPath, external);
    symlinkSync(external, fixture.configPath);
    assert.throws(() => loadConfiguration(fixture.project, {}), /符号链接/);
    rmSync(fixture.configPath);
    execFileSync("/usr/bin/mkfifo", [fixture.configPath]);
    chmodSync(fixture.configPath, 0o600);
    const blocked = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import {loadConfiguration} from " + JSON.stringify(pathToFileURL(join(repositoryRoot, "src/config.ts")).href) +
      ";loadConfiguration(" + JSON.stringify(fixture.project) + ",{});"],
    { env: cleanEnvironment, encoding: "utf8", timeout: 5_000 });
    assert.equal(blocked.error, undefined);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /普通 JSON 文件/);
    rmSync(fixture.configPath);
    renameSync(external, fixture.configPath);
    const directory = join(fixture.project, "config");
    renameSync(directory, join(fixture.path, "redirected-config"));
    symlinkSync(join(fixture.path, "redirected-config"), directory);
    assert.throws(() => loadConfiguration(fixture.project, {}), /符号链接/);
  } finally { fixture.cleanup(); }
});

function runnableFixture() {
  const fixture = configurationFixture();
  for (const directory of ["src", "scripts", "docs", "prompts"]) {
    cpSync(join(repositoryRoot, directory), join(fixture.project, directory), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json", "AGENTS.md", "tsconfig.json"]) cpSync(join(repositoryRoot, file), join(fixture.project, file));
  symlinkSync(join(repositoryRoot, "node_modules"), join(fixture.project, "node_modules"));
  fixture.settings.tools.node.path = process.execPath;
  fixture.settings.tools.codex.path = fakeCodex(fixture.path, "initialize_wait");
  fixture.settings.runtime.productionTimeoutMs = 12_000;
  fixture.settings.runtime.requestTimeoutMs = 250;
  fixture.settings.mcp.toolTimeoutMs = 5_000;
  fixture.save();
  return fixture;
}

test("启动脚本与后台进程使用本机配置，协议请求时限确实生效", { timeout: 20_000 }, async () => {
  const fixture = runnableFixture();
  try {
    const marker = join(fixture.path, "node-used.txt");
    const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
    const wrapper = join(fixture.path, "configured node");
    writeFileSync(wrapper, "#!/bin/sh\nprintf 'started\\n' >> " + quote(marker) + "\nexec " + quote(process.execPath) + ' "$@"\n', { mode: 0o700 });
    fixture.settings.tools.node.path = "../configured node";
    fixture.save();
    const input = join(fixture.path, "input.json");
    const options = { cwd: fixture.path, env: cleanEnvironment, encoding: "utf8" as const, timeout: 7_000 };
    writeFileSync(input, "{}");
    const info = JSON.parse(execFileSync("/bin/sh", [join(fixture.project, "scripts/intentframe"), "call", "get_runtime_info", input], options));
    assert.equal(info.assetRoot, join(fixture.path, "isolated data"));
    writeFileSync(input, JSON.stringify({ operationId: "configured-create", title: "配置隔离测试", brief: "合成需求，不调用真实模型。", purpose: "production" }));
    const work = JSON.parse(execFileSync(process.execPath, [join(fixture.project, "scripts/mcp-call.ts"), "create_work", input], options));
    assert.equal(work.taskPath, join(info.workRoots.production, "works", work.id, "task.json"));
    assert(existsSync(work.taskPath));
    assert.equal(readFileSync(marker, "utf8"), "started\nstarted\n");
    const draft = work.authoring.drafts[0];
    writeFileSync(input, JSON.stringify({ operationId: "configured-produce", workId: work.id,
      base: { id: draft.id, sha256: draft.sha256 }, instruction: "仅测试稿件模型连接超时。" }));
    const production = spawnSync(process.execPath, [join(fixture.project, "scripts/mcp-call.ts"), "revise_draft", input], options);
    assert.equal(production.error, undefined);
    assert.equal(production.status, 0);
    const accepted = JSON.parse(production.stdout);
    assert.equal(accepted.status, "accepted");
    writeFileSync(input, JSON.stringify({ executionId: accepted.executionId }));
    let execution;
    for (let attempt = 0; attempt < 30; attempt++) {
      execution = JSON.parse(execFileSync(process.execPath, [join(fixture.project, "scripts/mcp-call.ts"), "get_execution", input], options));
      if (execution.status === "failed" && !execution.workerAlive) break;
      await delay(50);
    }
    assert.equal(execution.status, "failed");
    assert.match(execution.error, /initialize 等待超时/);
    const record = JSON.parse(readFileSync(work.taskPath, "utf8"));
    assert.equal(record.execution.status, "failed");
    assert.equal(record.authoring.runs[0].status, "failed"); assert.equal(record.versions.length, 0);
    assert.equal(existsSync(join(fixture.project, "intentframe-data")), false);
  } finally { fixture.cleanup(); }
});

test("通用 Codex 客户端从配置取得时限，启动前拒绝不安全配置", { timeout: 15_000 }, () => {
  const fixture = runnableFixture();
  try {
    fixture.settings.runtime.requestTimeoutMs = 250;
    fixture.settings.runtime.productionTimeoutMs = 12_000;
    fixture.save();
    const script = join(fixture.project, "request.ts");
    writeFileSync(script, 'import {CodexAppServerClient} from "./src/runtime/codex-client.ts";\n' +
      'const client=new CodexAppServerClient({cwd:process.cwd()});\n' +
      'try { await client.initializeConnection(); } finally { await client.close(); }\n');
    const request = spawnSync(process.execPath, [script], { cwd: fixture.path, env: cleanEnvironment, encoding: "utf8", timeout: 5_000 });
    assert.equal(request.error, undefined);
    assert.equal(request.status, 1);
    assert.match(request.stderr, /initialize 等待超时/);
    chmodSync(fixture.configPath, 0o644);
    const launcher = spawnSync("/bin/sh", [join(fixture.project, "scripts/intentframe"), "--help"],
      { cwd: fixture.path, env: cleanEnvironment, encoding: "utf8", timeout: 5_000 });
    assert.equal(launcher.status, 1);
    assert.match(launcher.stderr, /权限不正确/);
  } finally { fixture.cleanup(); }
});

test("同一启动配置跨 MCP 进程按任务接续，旧用途变量明确停用", { timeout: 20_000 }, () => {
  const fixture = runnableFixture();
  try {
    const testConfig = loadConfiguration(fixture.project, {});
    assert.equal(testConfig.workRoots.test, join(fixture.path, "isolated data/testing"));
    assert.equal(testConfig.assetRoot, join(fixture.path, "isolated data"));
    for (const value of ["", "test", "production"]) assert.throws(() => loadConfiguration(fixture.project, { INTENTFRAME_PURPOSE: value }), /INTENTFRAME_PURPOSE 已停用/);
    const input = join(fixture.path, "input.json"), command = join(fixture.project, "scripts/mcp-call.ts");
    const call = (name: string, args: unknown) => {
      writeFileSync(input, JSON.stringify(args));
      return JSON.parse(execFileSync(process.execPath, [command, name, input], {
        env: cleanEnvironment, encoding: "utf8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"],
      }));
    };
    const request = { operationId: "production-request", title: "合成用途检查", brief: "不调用模型或写真实数据。", purpose: "production" };
    const production = call("create_work", request);
    const before = readFileSync(production.taskPath, "utf8");
    const testRequest = { ...request, operationId: "test-request", purpose: "test" };
    const testing = call("create_work", testRequest);
    assert.equal(testing.purpose, "test"); assert.notEqual(testing.id, production.id);
    assert.equal(testing.taskPath, join(testConfig.workRoots.test, "works", testing.id, "task.json"));
    assert.equal(call("create_work", testRequest).id, testing.id);
    assert.throws(() => call("create_work", { ...testRequest, purpose: "production" }), /同一操作编号/);
    assert.equal(call("get_work", { workId: testing.id }).purpose, "test");
    assert.equal(call("get_work", { workId: production.id }).purpose, "production");
    assert.equal(call("list_works", {}).works.length, 1);
    assert.equal(call("list_works", { purpose: "test" }).works.length, 1);
    assert.equal(call("list_works", { purpose: "all" }).works.length, 2);
    assert.equal(call("get_runtime_info", {}).assetRoot, testConfig.assetRoot);
    assert.equal(readFileSync(production.taskPath, "utf8"), before);
    const scopePath = join(testConfig.workRoots.test, ".intentframe-scope.json"), scope = JSON.parse(readFileSync(scopePath, "utf8"));
    writeFileSync(scopePath, JSON.stringify({ ...scope, purpose: "production" }));
    assert.throws(() => call("get_runtime_info", {}), /制作用途/);
    assert.equal(readFileSync(production.taskPath, "utf8"), before);
  } finally { fixture.cleanup(); }
});
