import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot } from "../src/config.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fakeCodex, fixtureRoot } from "./helpers.ts";

test("真实 MCP 子进程继承隔离目录，写入前核对服务实际目标", { timeout: 30_000 }, () => {
  const root = fixtureRoot();
  try {
    const data = join(root.path, "isolated-data"); mkdirSync(data);
    const input = join(root.path, "create.json");
    writeFileSync(input, JSON.stringify({ operationId: "create-isolated-work", title: "合成测试任务", brief: "只测试目标隔离，不调用模型。", purpose: "production" }));
    const result = JSON.parse(execFileSync(process.execPath, [join(repositoryRoot, "scripts/mcp-call.ts"), "create_work", input], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, INTENTFRAME_NODE_BIN: process.execPath, INTENTFRAME_DATA_ROOT: data,
        INTENTFRAME_CODEX_BIN: join(root.path, "must-not-run-codex"), INTENTFRAME_BACKUP_ROOT: join(root.path, "backup") },
    }));
    assert.equal(result.taskPath, join(data, "works", result.id, "task.json"));
    assert(existsSync(result.taskPath));
    assert.equal(new WorkStore(data).list()[0]?.id, result.id);
  } finally { root.cleanup(); }
});

test("同一个真实 MCP 连接交错处理两种用途，换连接后仅凭任务编号继续", { timeout: 30_000 }, async () => {
  const root = fixtureRoot(), clients: Client[] = [];
  try {
    const executable = fakeCodex(root.path, "needs_input");
    const connect = async () => {
      const client = new Client({ name: "task-purpose-fixture", version: "1" }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: "/bin/sh", args: [join(repositoryRoot, "scripts/intentframe"), "mcp"], cwd: repositoryRoot,
        env: { INTENTFRAME_DATA_ROOT: root.path, INTENTFRAME_NODE_BIN: process.execPath, INTENTFRAME_CODEX_BIN: executable, INTENTFRAME_BACKUP_ROOT: join(root.path, "backup") } }));
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, { timeout: 10_000 });
      const content = result.content.find(item => item.type === "text");
      assert(content?.type === "text");
      if (result.isError) throw new Error(content.text);
      return JSON.parse(content.text);
    };
    const first = await connect(), info = await call(first, "get_runtime_info", {});
    assert.deepEqual(info.workRoots, { production: root.path, test: join(root.path, "testing") });
    assert.equal(info.purpose, undefined);
    const tools = await first.listTools(), creation = tools.tools.find(tool => tool.name === "create_work")!;
    assert(creation.inputSchema.required?.includes("purpose"));
    await assert.rejects(call(first, "create_work", { operationId: "without-purpose", title: "不要猜用途", brief: "合成" }), /purpose/);
    const testArgs = { title: "测试字幕", brief: "需要补充参考的合成任务。", purpose: "test" };
    const prepared = await call(first, "prepare_operation", { name: "create_work", arguments: testArgs });
    const testing = await call(first, prepared.name, prepared.arguments);
    const formal = await call(first, "create_work", { operationId: "formal-create", title: "正式字幕", brief: "正式用途也可以做样例。", purpose: "production" });
    const savedFormal = readFileSync(formal.taskPath, "utf8");
    const accepted = await call(first, "produce_version", { operationId: "test-produce", workId: testing.id, kind: "sample" });
    assert.equal(accepted.purpose, "test"); assert.equal(accepted.status, "accepted");
    let execution;
    for (let attempt = 0; attempt < 50; attempt++) {
      execution = await call(first, "get_execution", { executionId: accepted.executionId });
      if (execution.status === "waiting_input" && !execution.workerAlive) break;
      await delay(80);
    }
    assert.equal(execution.status, "waiting_input");
    assert.equal(execution.result.versions[0].production, "blocked");
    assert.equal(readFileSync(formal.taskPath, "utf8"), savedFormal);
    assert.equal((await call(first, "list_works", {})).works[0].id, formal.id);
    assert.equal((await call(first, "list_works", { purpose: "test" })).works[0].id, testing.id);
    await first.close();
    const next = await connect();
    assert.equal((await call(next, "get_work", { workId: testing.id })).purpose, "test");
    assert.deepEqual(await call(next, prepared.name, prepared.arguments), testing);
    const updated = await call(next, "submit_feedback", { operationId: "test-feedback", workId: testing.id, versionId: "v001", source: "user", text: "后续修改仍属于这次测试。" });
    assert.equal(updated.feedback.length, 1); assert.equal(updated.storagePurpose, "test");
    assert.equal((await call(next, "get_operation", { operationId: "test-produce" })).purpose, "test");
    assert.equal((await call(next, "get_work", { workId: formal.id })).purpose, "production");
    assert.equal(readFileSync(formal.taskPath, "utf8"), savedFormal);
  } finally { for (const client of clients) await client.close(); root.cleanup(); }
});
