import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryRoot } from "../src/config.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { fixtureRoot } from "./helpers.ts";

test("真实 MCP 子进程继承隔离目录，写入前核对服务实际目标", { timeout: 30_000 }, () => {
  const root = fixtureRoot();
  try {
    const data = join(root.path, "isolated-data"); mkdirSync(data);
    const input = join(root.path, "create.json");
    writeFileSync(input, JSON.stringify({ title: "合成测试任务", brief: "只测试目标隔离，不调用模型。" }));
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
