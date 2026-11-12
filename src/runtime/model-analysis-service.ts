import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { immutableJson, readJson, valueHash } from "../records/files.ts";
import { analysisResultSchema } from "../records/model-analysis.ts";
import type { AnalysisRun } from "../records/model-analysis.ts";
import { selectModel } from "../records/model-settings.ts";
import type { WorkRecord, WorkStore } from "../records/work-store.ts";
import type { AuthoringOptions } from "./authoring-service.ts";
import { CodexAppServerClient, codexTurnSchema, describeError, executionFailureStatus, UnknownExecutionOutcome } from "./codex-client.ts";
import { checkModel, modelThreadParameters, modelThreadSchema, modelTurnParameters, verifyModelThread } from "./model-call.ts";
import { checkExecution } from "./execution-control.ts";
import { processExists } from "./process-state.ts";
import { readPrompt } from "./prompts.ts";

type AnalysisTools = { definitions: unknown[]; call: (name: string, args: unknown) => unknown | Promise<unknown> };
const receiptSchema = z.object({ threadId: z.string(), turnId: z.string(), inputSha256: z.string(), reply: z.string() });

export function assertAnalysesSettled(record: WorkRecord) {
  if (record.analysisRuns?.some(run => ["preparing", "running", "unknown"].includes(run.status))) {
    throw new UnknownExecutionOutcome("分析调用尚未取得可靠终态，须先恢复原结果；主轮次回复不能解除保护。");
  }
}

/** 两个只读制作环节，沿父任务的锁和取消信号串行运行；不调度写素材或独立后台任务。 */
export class ModelAnalysisService {
  readonly store: WorkStore;
  readonly options: AuthoringOptions;
  constructor(store: WorkStore, options: AuthoringOptions = {}) { this.store = store; this.options = options; }

  async run(record: WorkRecord, parentRunId: string, kind: AnalysisRun["kind"], context: unknown,
    images: string[] = [], tools?: AnalysisTools) {
    checkExecution(this.options.signal);
    const imageInputs = images.map(path => ({ path, sha256: fileHash(path) }));
    const requestKey = valueHash({ parentRunId, kind, context, images: imageInputs });
    const previous = record.analysisRuns?.find(item => item.requestKey === requestKey);
    if (previous) {
      if (["preparing", "running", "unknown"].includes(previous.status) && await this.reconcile(record, previous) === "running") throw new UnknownExecutionOutcome("原分析尚未结束，未重发。");
      if (previous.status !== "completed") throw new Error(previous.error ?? "原分析失败，须核对父任务。");
      this.apply(record, previous);
      return { runId: previous.id, ...previous.result! };
    }
    if (record.analysisRuns?.some(item => item.status === "unknown")) throw new UnknownExecutionOutcome("原分析调用尚未核清，不能重发。");
    const id = "analysis-" + randomUUID(), inputPath = join("works", record.id, "analysis", id, "input.json");
    const directory = dirname(this.store.resolvePath(inputPath)); mkdirSync(directory, { recursive: true });
    const modelSelection = selectModel(this.options.models ?? configuration.models, kind);
    const prompt = readPrompt("model-analysis", kind === "production_assets" ? "制作素材方案" : "视觉材料理解");
    const input = { runId: id, parentRunId, kind, context, images: imageInputs, modelSelection, prompt,
      outputSchema: z.toJSONSchema(analysisResultSchema) };
    immutableJson(this.store.resolvePath(inputPath), input);
    const run: AnalysisRun = { id, parentRunId, kind, requestKey, inputPath, inputSha256: fileHash(this.store.resolvePath(inputPath)),
      modelSelection, sendState: "not_sent", status: "preparing" };
    record.analysisRuns ??= []; record.analysisRuns.push(run); this.store.save(record);
    let client: CodexAppServerClient | undefined;
    let phase: "preparing" | "awaiting_result" | "checking_result" = "preparing";
    try {
      this.options.onProgress?.(kind === "production_assets" ? "项目正在形成制作素材方案" : "项目正在理解实际视觉材料");
      client = new CodexAppServerClient({ cwd: directory, executable: this.options.codexExecutable,
        timeoutMs: this.options.timeoutMs, turnTimeoutMs: this.options.timeoutMs ?? configuration.runtime.productionTimeoutMs,
        signal: this.options.signal, onEvent: event => this.store.appendEvent(record.id, id, event),
        ...(tools ? { onToolCall: (name, args, identity) => {
          if (identity.threadId !== run.threadId || (run.turnId && identity.turnId !== run.turnId)) throw new Error("工具调用不属于当前分析。");
          return tools.call(name, args);
        } } : {}) });
      run.runnerPid = client.pid;
      const parent = record.versions.find(item => item.runId === parentRunId) ?? record.authoring?.runs.find(item => item.id === parentRunId);
      // 父轮次尚未启动时，崩溃恢复仍需要最初运行器的身份；已启动的父运行器不能被覆盖。
      if (parent && !parent.runnerPid && parent.sendState === "not_sent") parent.runnerPid = client.pid;
      this.store.save(record); if (client.pid) this.options.onRunner?.(client.pid);
      await client.initializeConnection(); await checkModel(client, modelSelection); checkExecution(this.options.signal);
      const response = modelThreadSchema.parse(await client.sendRequest("thread/start", {
        cwd: directory, sandbox: "read-only", approvalPolicy: "never", developerInstructions: prompt.text,
        ...modelThreadParameters(modelSelection, kind === "production_assets" ? { web_search: "live" } : {}),
        ...(tools ? { dynamicTools: tools.definitions } : {}),
      }));
      run.threadId = response.thread.id; run.model = response.model; run.reasoningEffort = response.reasoningEffort; this.store.save(record);
      verifyModelThread(modelSelection, response);
      for (const image of imageInputs) if (fileHash(image.path) !== image.sha256) throw new Error("视觉输入在发送前已变化。");
      checkExecution(this.options.signal); run.sendState = "sending"; run.status = "running"; this.store.save(record); phase = "awaiting_result";
      const started = z.object({ turn: codexTurnSchema }).parse(await client.sendRequest("turn/start", {
        threadId: run.threadId, ...modelTurnParameters(modelSelection), outputSchema: input.outputSchema,
        input: [{ type: "text", text: "本次执行编号：" + id + "\n读取 input.json，完成指定只读分析，保存依据与未检查范围。" },
          ...images.map(path => ({ type: "localImage", path }))],
      }));
      run.turnId = started.turn.id; run.sendState = "acknowledged"; this.store.save(record);
      const completed = await client.waitForTurnCompletion(run.turnId, run.threadId);
      if (completed.status === "inProgress") throw new UnknownExecutionOutcome("分析尚未结束。");
      phase = "checking_result";
      if (completed.status !== "completed") throw new Error("分析未完成：" + (completed.error?.message ?? completed.status));
      immutableJson(join(directory, "result.json"), { threadId: run.threadId, turnId: run.turnId,
        inputSha256: run.inputSha256, reply: client.finalReply(run.turnId) });
      this.apply(record, run);
      return { runId: id, ...run.result! };
    } catch (error) {
      run.status = executionFailureStatus(error, phase); run.error = describeError(error); this.store.save(record);
      if (run.status === "unknown") {
        record.execution = { ...record.execution, status: "unknown", error: run.error }; this.store.save(record);
        throw new UnknownExecutionOutcome(run.error);
      }
      throw error;
    } finally { await client?.close(); }
  }

  private apply(record: WorkRecord, run: AnalysisRun) {
    if (fileHash(this.store.resolvePath(run.inputPath)) !== run.inputSha256) throw new Error("原分析输入已经变化。");
    const input = z.object({ images: z.array(z.object({ path: z.string(), sha256: z.string() })) }).parse(readJson(this.store.resolvePath(run.inputPath)));
    for (const image of input.images) if (fileHash(image.path) !== image.sha256) throw new Error("原视觉材料已经变化，不能补存为原结果。");
    const receipt = receiptSchema.parse(readJson(join(dirname(this.store.resolvePath(run.inputPath)), "result.json")));
    if (receipt.threadId !== run.threadId || receipt.turnId !== run.turnId || receipt.inputSha256 !== run.inputSha256) throw new Error("分析回执身份不符。");
    run.result = analysisResultSchema.parse(JSON.parse(receipt.reply)); run.status = "completed"; run.error = undefined; this.store.save(record);
  }

  /** 只读取原执行。即使本机配置已换模型，也不重新推理或覆盖旧选择。调用方决定剩余制作。 */
  async reconcile(record: WorkRecord, run: AnalysisRun) {
    if (run.runnerPid && processExists(run.runnerPid, process.platform !== "win32")) return "running" as const;
    const directory = dirname(this.store.resolvePath(run.inputPath)), receiptPath = join(directory, "result.json");
    if (existsSync(receiptPath)) { this.apply(record, run); return "recovered" as const; }
    if (run.sendState === "not_sent") { run.status = "failed"; run.error = "原分析尚未发送。"; this.store.save(record); return "recovered" as const; }
    if (!run.threadId) throw new UnknownExecutionOutcome("原分析缺少线程身份，未重发。");
    const client = new CodexAppServerClient({ cwd: directory, executable: this.options.codexExecutable, timeoutMs: this.options.timeoutMs });
    if (client.pid) this.options.onRunner?.(client.pid);
    try {
      await client.initializeConnection();
      const original = await client.readOriginalTurn(run.threadId, run.turnId, directory, run.id);
      if (original.turn.status === "inProgress") return "running" as const;
      run.turnId = original.turn.id;
      if (original.turn.status !== "completed") { run.status = "failed"; run.error = "原分析未完成，未重发。"; this.store.save(record); return "recovered" as const; }
      immutableJson(receiptPath, { threadId: run.threadId, turnId: run.turnId, inputSha256: run.inputSha256, reply: original.reply });
      this.apply(record, run); return "recovered" as const;
    } finally { await client.close(); }
  }
}
