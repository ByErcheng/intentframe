import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { repositoryRoot } from "../src/config.ts";
import { ExecutionStore } from "../src/records/execution-store.ts";
import { fakeCodex, fixtureRoot, confirmedDraft, seedProfile } from "./helpers.ts";
import { WorkStore } from "../src/records/work-store.ts";

export function backgroundFixture(mode = "slow_completed", runtime: Record<string, number> = {}) {
  const root = fixtureRoot(), project = join(root.path, "project"), data = join(root.path, "data");
  mkdirSync(project); mkdirSync(data);
  seedProfile(data);
  for (const directory of ["src", "scripts", "docs", "prompts"]) cpSync(join(repositoryRoot, directory), join(project, directory), { recursive: true });
  for (const file of ["AGENTS.md", "package-lock.json"]) cpSync(join(repositoryRoot, file), join(project, file));
  // 复用真实依赖时也保留其配置文件真实位置，避免测试夹具让 Webpack 从另一个项目读取配置。
  for (const file of ["package.json", "tsconfig.json"]) symlinkSync(join(repositoryRoot, file), join(project, file));
  symlinkSync(join(repositoryRoot, "node_modules"), join(project, "node_modules"));
  mkdirSync(join(project, "config"));
  const settings = JSON.parse(readFileSync(join(repositoryRoot, "config/example.json"), "utf8"));
  settings.dataRoot = data; settings.backupRoot = join(root.path, "backup");
  settings.tools.node.path = process.execPath;
  settings.tools.codex.path = fakeCodex(root.path, mode);
  settings.runtime = { requestTimeoutMs: 3_000, productionTimeoutMs: 15_000, jobTimeoutMs: 30_000, stopTimeoutMs: 500, ...runtime };
  settings.media.renderTimeoutMs = 20_000;
  const configPath = join(project, "config/local.json");
  writeFileSync(configPath, JSON.stringify(settings), { mode: 0o600 });
  const clients: Client[] = [];
  const executions = new ExecutionStore(data);
  const connect = async () => {
    const client = new Client({ name: "background-fixture", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: "/bin/sh", args: [join(project, "scripts/intentframe"), "mcp"], cwd: project,
      env: { INTENTFRAME_DATA_ROOT: data, INTENTFRAME_NODE_BIN: settings.tools.node.path, INTENTFRAME_CODEX_BIN: settings.tools.codex.path } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}, timeoutMs = 2_000) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
    const item = result.content.find(value => value.type === "text");
    if (!item || item.type !== "text") throw new Error("测试调用未返回文本。");
    if (result.isError) throw new Error(item.text);
    return JSON.parse(item.text);
  };
  const wait = async (client: Client, id: string, predicate = (state: { status: string; message: string; workerAlive?: boolean }) =>
    !["queued", "running"].includes(state.status) && !state.workerAlive, timeoutMs = 35_000) => {
    const deadline = Date.now() + timeoutMs;
    let state;
    do { state = await call(client, "get_execution", { executionId: id }); if (predicate(state)) return state; await delay(80); } while (Date.now() < deadline);
    throw new Error("后台测试等待未结束：" + JSON.stringify(state));
  };
  // 明确构造升级前的记录；旧后台故障回归继续覆盖历史任务，新流程使用原始 call(create_work)。
  const createLegacyWork = async (client: Client, args: Record<string, unknown>) => {
    const work = await call(client, "create_work", confirmedDraft({ ...args, brief: String(args.brief) }));
    const store = new WorkStore(args.purpose === "test" ? join(data, "testing") : data,
      args.purpose === "test" ? "test" : "production", data);
    const record = store.read(work.id); delete record.authoring; delete record.creationProfile; delete record.profileAssignments; store.save(record);
    return store.summary(record);
  };
  const countTurns = () => {
    const path = join(root.path, "native-fixture/calls.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line.includes('"method":"turn/start"')).length : 0;
  };
  const delayWorkerStart = () => {
    const wrapper = join(root.path, "delayed-node"), quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(wrapper, '#!/bin/sh\ncase "$1" in */background-worker.ts) /bin/sleep 1 ;; esac\nexec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o700 });
    settings.tools.node.path = wrapper;
    writeFileSync(configPath, JSON.stringify(settings));
  };
  const cleanup = async () => {
    const processes = new Set<number>();
    const collect = (path: string, key: string) => {
      try { const value = JSON.parse(readFileSync(path, "utf8"))[key]; if (Number.isSafeInteger(value) && value > 0) processes.add(value); } catch { /* 未建立该合成记录。 */ }
    };
    const operations = join(data, "operations");
    for (const id of existsSync(operations) ? readdirSync(operations) : []) {
      if (!executions.exists(id)) continue;
      try { const request = executions.read(id); if (!executions.outcome(request)) executions.requestStop(request, "合成测试收尾"); } catch { /* 损坏记录的故障用例不能按正文接续。 */ }
      collect(executions.path(id, "claimed/owner.json"), "pid"); collect(executions.path(id, "launch.json"), "pid");
    }
    for (const area of [data, join(data, "testing")]) {
      const directory = join(area, "works");
      for (const id of existsSync(directory) ? readdirSync(directory) : []) {
        try {
          const work = JSON.parse(readFileSync(join(directory, id, "task.json"), "utf8"));
          for (const run of [...work.versions, work.learningRun, ...(work.authoring?.runs ?? []), ...(work.analysisRuns ?? []),
            ...work.versions.flatMap((version: { reviewPreparation?: { inspections: unknown[] } }) => version.reviewPreparation?.inspections ?? [])].filter(Boolean)) if (run.runnerPid) processes.add(run.runnerPid);
        } catch { /* 只清理本用例已登记的进程。 */ }
      }
    }
    for (const client of clients) await client.close();
    // 全部身份来自本临时夹具的启动记录；生产停止逻辑不使用此测试收尾方式。
    for (const pid of processes) { try { process.kill(-pid, "SIGTERM"); } catch { /* 已退出。 */ } }
    await delay(100);
    for (const pid of processes) { try { process.kill(-pid, "SIGKILL"); } catch { /* 已退出。 */ } }
    root.cleanup();
  };
  return { path: root.path, project, data, settings, configPath, executions, connect, call, createLegacyWork, wait, countTurns, delayWorkerStart, cleanup };
}
