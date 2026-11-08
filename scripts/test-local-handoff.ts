import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { configuration } from "../src/config.ts";
import { CodexAppServerClient, UnknownExecutionOutcome, RpcRequestRejected, codexTurnSchema, describeError } from "../src/runtime/codex-client.ts";

/**
 * 固定范围的接入验证：MCP 客户端 → 测试 MCP 服务 → Codex → 文本文件。
 * 默认入口验证创建、原线程恢复、新线程接续；--errors 单独验证异常路径。
 * --serve 由测试客户端启动子进程使用。测试记录保存在 .cache，不定义正式任务接口。
 *
 * 阅读顺序：任务记录 → Codex 协议连接 → 单阶段执行 → MCP 交接 → 验证入口。
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 仅作为本次测试的等待上限；超时表示未取得结果，不表示远端已经停止。
const requestTimeoutMs = 180_000;

const artifactRecordSchema = z.object({
  version: z.number().int(),
  path: z.string(),
  sha256: z.string(),
  threadId: z.string(),
  turnId: z.string(),
});
type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

const taskStateSchema = z.object({
  taskId: z.string(),
  marker: z.string(),
  status: z.enum(["ready", "running", "completed", "failed", "unknown"]),
  version: z.number().int().min(0).max(3),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  artifacts: z.array(artifactRecordSchema),
  error: z.string().optional(),
});
type ProbeTaskState = z.infer<typeof taskStateSchema>;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readTaskState(taskDirectory: string): ProbeTaskState {
  return taskStateSchema.parse(JSON.parse(readFileSync(join(taskDirectory, "task.json"), "utf8")));
}

function saveTaskState(taskDirectory: string, state: ProbeTaskState): void {
  const target = join(taskDirectory, "task.json");
  // 先写完整记录再替换，避免进程退出留下半份 JSON。
  writeFileSync(target + ".tmp", JSON.stringify(taskStateSchema.parse(state), null, 2) + "\n");
  renameSync(target + ".tmp", target);
}

function appendExecutionEvent(taskDirectory: string, data: Record<string, unknown>): void {
  appendFileSync(
    join(taskDirectory, "events.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n",
  );
}

type ProbeStage = "create" | "resume" | "fresh";
type ExecutionPhase = "preparing" | "awaiting_result" | "checking_result";

/**
 * 只在捕获异常时调用，执行阶段说明此时已经取得哪些事实：
 * 请求被明确拒绝，或已取得终态后校验失败，都有失败依据；
 * 已发出请求却未取得终态时，不能根据通信错误推断远端执行结果。
 */
function determineFailureStatus(error: unknown, phase: ExecutionPhase): "failed" | "unknown" {
  if (error instanceof RpcRequestRejected) return "failed";
  if (error instanceof UnknownExecutionOutcome || phase === "awaiting_result") return "unknown";
  return "failed";
}

function buildProbePrompt(stage: ProbeStage, version: number, marker: string): string {
  // 提示词属于被测行为，不能当作普通说明注释翻译。
  const filename = "artifact-v" + version + ".txt";
  if (stage === "create") {
    return "Create " + filename + " containing exactly " + JSON.stringify(marker + ":v1\n") + ".";
  }
  return "Read task.json and its latest recorded artifact. Create " + filename +
    " with the same marker, replacing only the final :v" + (version - 1) + " with :v" + version +
    ". Preserve every earlier artifact and do not edit task.json. This request is complete; act now.";
}

function verifyArtifactVersion(
  taskDirectory: string,
  state: ProbeTaskState,
  version: number,
  threadId: string,
  turnId: string,
): ArtifactRecord {
  const filename = "artifact-v" + version + ".txt";
  const actual = readFileSync(join(taskDirectory, filename), "utf8");
  assert.equal(actual, state.marker + ":v" + version + "\n", "新文件内容与本次要求不符。");
  for (const artifact of state.artifacts) {
    assert.equal(
      sha256(readFileSync(join(taskDirectory, artifact.path), "utf8")),
      artifact.sha256,
      "旧版本被修改：" + artifact.path,
    );
  }
  return { version, path: filename, sha256: sha256(actual), threadId, turnId };
}

async function runProbeStage(taskDirectory: string, stage: ProbeStage): Promise<ProbeTaskState> {
  const state = readTaskState(taskDirectory);
  const version = { create: 1, resume: 2, fresh: 3 }[stage];
  if (!["ready", "completed"].includes(state.status) || state.version !== version - 1) {
    throw new Error("执行顺序或当前状态不允许继续，请先核对 task.json；本次未发起模型请求。");
  }

  const codex = new CodexAppServerClient({ cwd: taskDirectory, onEvent: event => appendExecutionEvent(taskDirectory, event) });
  let phase: ExecutionPhase = "preparing";
  try {
    await codex.initializeConnection();
    const response = await codex.sendRequest(stage === "resume" ? "thread/resume" : "thread/start", {
      ...(stage === "resume" ? { threadId: state.threadId, excludeTurns: true } : {}),
      cwd: taskDirectory,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      developerInstructions: "This is a tiny file-I/O connectivity test. Only read task.json and artifact-v*.txt in the working directory, and create the requested artifact file. Do not delegate, browse, install, or change any other file. Use apply_patch if shell access is unavailable.",
    });
    const { thread } = z.object({ thread: z.object({ id: z.string() }) }).parse(response);
    state.threadId = thread.id;
    state.turnId = undefined;
    state.status = "running";
    state.error = undefined;
    saveTaskState(taskDirectory, state);
    appendExecutionEvent(taskDirectory, { kind: "stage_started", stage, threadId: thread.id });

    // 发送前进入等待阶段，即使响应丢失，也不会把可能已开始的执行当作明确失败。
    phase = "awaiting_result";
    const started = z.object({ turn: codexTurnSchema }).parse(await codex.sendRequest("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: buildProbePrompt(stage, version, state.marker) }],
    }));
    state.turnId = started.turn.id;
    saveTaskState(taskDirectory, state);

    const completed = await codex.waitForTurnCompletion(started.turn.id);
    phase = "checking_result";
    if (completed.status !== "completed") {
      throw new Error(completed.error?.message ?? ("Codex 执行结束，状态为 " + completed.status));
    }

    // Codex 报告完成后，还需核对真实文件及旧版本，才能记录测试成功。
    const artifact = verifyArtifactVersion(taskDirectory, state, version, thread.id, started.turn.id);
    state.artifacts.push(artifact);
    state.version = version;
    state.status = "completed";
    saveTaskState(taskDirectory, state);
    appendExecutionEvent(taskDirectory, {
      kind: "artifact_verified",
      version,
      path: artifact.path,
      sha256: artifact.sha256,
    });
    return state;
  } catch (error) {
    state.status = determineFailureStatus(error, phase);
    state.error = describeError(error);
    saveTaskState(taskDirectory, state);
    appendExecutionEvent(taskDirectory, {
      kind: "stage_error",
      stage,
      phase,
      status: state.status,
      message: state.error,
    });
    return state;
  } finally {
    await codex.close();
  }
}

function startProbeMcpServer(taskDirectory: string): void {
  const initial = readTaskState(taskDirectory);
  if (initial.status === "running") {
    // 上次进程没有留下终态，只能标为未知；本测试不自动重发或假装已恢复。
    initial.status = "unknown";
    initial.error = "上次进程未留下最终结果，须核对原生作业后再决定是否继续。";
    saveTaskState(taskDirectory, initial);
    appendExecutionEvent(taskDirectory, { kind: "orphaned_execution", status: "unknown" });
  }

  let stageRunning = false;
  serveStdio(() => {
    const server = new McpServer({ name: "intentframe-local-probe", version: "0.1.0" });
    server.registerTool("sample_status", {
      description: "读取当前固定测试任务的状态。",
      inputSchema: z.object({}),
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify(readTaskState(taskDirectory)) }],
    }));
    server.registerTool("run_sample", {
      description: "执行本机接入测试的一个固定文件生成阶段。",
      inputSchema: z.object({ stage: z.enum(["create", "resume", "fresh"]) }),
    }, async ({ stage }) => {
      if (stageRunning) {
        return { isError: true, content: [{ type: "text", text: "已有测试阶段正在执行。" }] };
      }
      stageRunning = true;
      try {
        const state = await runProbeStage(taskDirectory, stage);
        return {
          isError: state.status !== "completed",
          content: [{ type: "text", text: JSON.stringify(state) }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: describeError(error) }] };
      } finally {
        stageRunning = false;
      }
    });
    return server;
  }, { onerror: error => console.error(error.message) });
}

async function connectProbeClient(taskDirectory: string): Promise<Client> {
  const executable = process.env.INTENTFRAME_CODEX_BIN ?? configuration.codex;
  if (!executable) throw new Error("运行测试前请设置 INTENTFRAME_CODEX_BIN。");
  const client = new Client({ name: "intentframe-test-client", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), "--serve", taskDirectory],
    cwd: repositoryRoot,
    env: { INTENTFRAME_CODEX_BIN: executable },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function queryProbeStatus(client: Client): Promise<ProbeTaskState> {
  const result = await client.callTool({ name: "sample_status", arguments: {} });
  const text = result.content.find(item => item.type === "text");
  if (!text || text.type !== "text") throw new Error("MCP 未返回任务状态文本。");
  return taskStateSchema.parse(JSON.parse(text.text));
}

function createTestDirectory(): string {
  const directory = join(repositoryRoot, ".cache", "local-handoff", "runs", randomUUID());
  mkdirSync(directory, { recursive: true });
  return directory;
}

function verifyOutcomeRules(): void {
  // 按事实区分结果：同样的本地错误，在取得执行终态前后具有不同含义。
  const localError = new Error("本地文件无法读取");
  assert.equal(determineFailureStatus(localError, "preparing"), "failed");
  assert.equal(determineFailureStatus(localError, "awaiting_result"), "unknown");
  assert.equal(determineFailureStatus(localError, "checking_result"), "failed");
  assert.equal(determineFailureStatus(new RpcRequestRejected("请求被拒绝"), "awaiting_result"), "failed");
  assert.equal(determineFailureStatus(new UnknownExecutionOutcome("响应丢失"), "preparing"), "unknown");
}

function verifyArtifactChecks(testDirectory: string): void {
  const directory = join(testDirectory, "artifact-checks");
  mkdirSync(directory);
  const state: ProbeTaskState = {
    taskId: randomUUID(), marker: "fixture", status: "ready", version: 0, artifacts: [],
  };
  assert.throws(
    () => verifyArtifactVersion(directory, state, 1, "test-thread", "test-turn-1"),
    { code: "ENOENT" },
  );
  writeFileSync(join(directory, "artifact-v1.txt"), "错误内容\n");
  assert.throws(
    () => verifyArtifactVersion(directory, state, 1, "test-thread", "test-turn-1"),
    /新文件内容与本次要求不符/,
  );

  writeFileSync(join(directory, "artifact-v1.txt"), "fixture:v1\n");
  state.artifacts.push(verifyArtifactVersion(directory, state, 1, "test-thread", "test-turn-1"));
  writeFileSync(join(directory, "artifact-v2.txt"), "fixture:v2\n");
  assert.equal(verifyArtifactVersion(directory, state, 2, "test-thread", "test-turn-2").version, 2);
  writeFileSync(join(directory, "artifact-v1.txt"), "被修改的旧版本\n");
  assert.throws(
    () => verifyArtifactVersion(directory, state, 2, "test-thread", "test-turn-2"),
    /旧版本被修改/,
  );
}

async function verifyFailureHandling(testDirectory: string): Promise<void> {
  verifyOutcomeRules();
  verifyArtifactChecks(testDirectory);

  // 注入遗留状态，验证保守处理；不通过中断或重发真实付费请求制造故障。
  const orphanedDirectory = join(testDirectory, "orphaned");
  mkdirSync(orphanedDirectory);
  saveTaskState(orphanedDirectory, {
    taskId: randomUUID(), marker: "fault-injection", status: "running", version: 0, artifacts: [],
  });
  const orphanedClient = await connectProbeClient(orphanedDirectory);
  try {
    assert.equal((await queryProbeStatus(orphanedClient)).status, "unknown");
    const retry = await orphanedClient.callTool({ name: "run_sample", arguments: { stage: "create" } });
    assert.equal(retry.isError, true);
    assert.equal((await queryProbeStatus(orphanedClient)).status, "unknown");
  } finally {
    await orphanedClient.close();
  }

  const rejectedDirectory = join(testDirectory, "invalid-thread");
  mkdirSync(rejectedDirectory);
  saveTaskState(rejectedDirectory, {
    taskId: randomUUID(), marker: "fault-injection", status: "completed",
    version: 1, threadId: "not-a-valid-codex-thread-id", artifacts: [],
  });
  const rejectedClient = await connectProbeClient(rejectedDirectory);
  try {
    const result = await rejectedClient.callTool(
      { name: "run_sample", arguments: { stage: "resume" } },
      { timeout: requestTimeoutMs + 10_000 },
    );
    const state = await queryProbeStatus(rejectedClient);
    assert.equal(result.isError, true);
    assert.equal(state.status, "failed");
    // 这里检查的是 Codex 原始错误，保留上游语言，不改写成项目自己的成功或失败提示。
    assert.match(state.error ?? "", /invalid|not found|thread/i);
  } finally {
    await rejectedClient.close();
  }
}

const failureChecks = [
  "依据执行阶段区分失败与未知",
  "文件缺失、内容错误或旧版本被改动时校验失败",
  "遗留运行状态转为未知并阻止重发",
  "无效线程的原生错误返回明确失败",
];

function saveVerificationReport(testDirectory: string, report: Record<string, unknown>): void {
  writeFileSync(join(testDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}

async function verifyLocalHandoff(testDirectory: string): Promise<void> {
  saveTaskState(testDirectory, {
    taskId: randomUUID(), marker: "intentframe-" + randomUUID(),
    status: "ready", version: 0, artifacts: [],
  });
  const snapshots: ProbeTaskState[] = [];
  for (const stage of ["create", "resume", "fresh"] as const) {
    // 每个阶段重建客户端与服务进程，确保接续依赖落盘记录，而非本进程内存。
    const client = await connectProbeClient(testDirectory);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["run_sample", "sample_status"]);
      if (stage === "create") {
        const invalid = await client.callTool({ name: "run_sample", arguments: { stage: "resume" } });
        assert.equal(invalid.isError, true);
        assert.equal((await queryProbeStatus(client)).status, "ready");
      }
      const result = await client.callTool(
        { name: "run_sample", arguments: { stage } },
        { timeout: requestTimeoutMs + 10_000 },
      );
      const state = await queryProbeStatus(client);
      console.log(JSON.stringify({
        stage,
        status: state.status,
        threadId: state.threadId,
        turnId: state.turnId,
        artifact: state.artifacts.at(-1)?.path,
        error: state.error,
      }));
      assert.equal(result.isError, false, state.error);
      assert.equal(state.status, "completed");
      snapshots.push(state);
    } finally {
      await client.close();
    }
  }
  assert.equal(snapshots[0]?.threadId, snapshots[1]?.threadId, "恢复阶段没有接续原线程。");
  assert.notEqual(snapshots[1]?.threadId, snapshots[2]?.threadId, "新上下文阶段复用了旧线程。");
  await verifyFailureHandling(testDirectory);
  saveVerificationReport(testDirectory, {
    at: new Date().toISOString(),
    result: "passed",
    runDirectory: testDirectory,
    verified: [
      "MCP 工具发现",
      "Codex 实际创建文件",
      "进程重启后恢复原生线程",
      "新 Codex 线程依据已保存任务接续",
      "旧版本保持不变",
      "错误执行顺序被拒绝",
      ...failureChecks,
    ],
    notVerified: ["ChatGPT 客户端直接注册此 MCP", "真实云端断线后的恢复", "视频制作"],
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--serve") {
    const directory = process.argv[3];
    if (!directory) throw new Error("缺少测试任务目录。");
    startProbeMcpServer(resolve(directory));
    return;
  }
  // 未知参数直接报错，避免命令拼写错误意外触发模型调用。
  if (mode !== undefined && mode !== "--errors") throw new Error("未知参数：" + mode);

  const testDirectory = createTestDirectory();
  console.log(JSON.stringify({ runDirectory: testDirectory }));
  if (mode === "--errors") {
    await verifyFailureHandling(testDirectory);
    saveVerificationReport(testDirectory, {
      at: new Date().toISOString(),
      result: "passed",
      runDirectory: testDirectory,
      verified: failureChecks,
      modelGeneration: false,
    });
    return;
  }
  await verifyLocalHandoff(testDirectory);
}

await main().catch(error => {
  console.error(describeError(error));
  process.exitCode = 1;
});
