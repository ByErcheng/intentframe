import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration } from "../config.ts";
import { selectModel } from "../records/model-settings.ts";
import type { ModelsConfiguration } from "../records/model-settings.ts";
import { checkModel, modelThreadParameters, modelThreadSchema, modelTurnParameters, verifyModelThread } from "./model-call.ts";
import { fileHash } from "../common/file-hash.ts";
import { atomicJson, immutableJson, readJson, valueHash } from "../records/files.ts";
import { DocumentStore } from "../records/document-store.ts";
import { AssetStore } from "../records/asset-store.ts";
import { authoringResultSchema, documentRefSchema, draftReviewResultSchema } from "../records/authoring-contracts.ts";
import { experienceRefSchema } from "../records/experience-ref.ts";
import type { AuthoringRun, DocumentRef } from "../records/authoring-contracts.ts";
import type { WorkRecord, WorkStore } from "../records/work-store.ts";
import { CodexAppServerClient, codexTurnSchema, describeError, executionFailureStatus } from "./codex-client.ts";
import { checkExecution } from "./execution-control.ts";
import { processExists } from "./process-state.ts";
import { readPrompt } from "./prompts.ts";
import { knowledgeToolDefinitions, LearningService } from "./learning-service.ts";
import { ProductionMediaTools, mediaToolDefinitions } from "./production-media.ts";
import { AssetService } from "./asset-service.ts";
import type { LibraryRoot } from "../records/asset-catalog.ts";
import { assertAnalysesSettled, ModelAnalysisService } from "./model-analysis-service.ts";

export type AuthoringOptions = { codexExecutable?: string; timeoutMs?: number; signal?: AbortSignal; assetLibraries?: LibraryRoot[];
  models?: ModelsConfiguration;
  onProgress?: (phase: string) => void; onRunner?: (pid: number) => void };
const knowledgeEvidenceSchema = z.object({ searches: z.number().int().nonnegative(), reads: z.array(experienceRefSchema) });

export class AuthoringService {
  readonly documents: DocumentStore;
  readonly store: WorkStore;
  readonly options: AuthoringOptions;
  constructor(store: WorkStore, options: AuthoringOptions = {}) { this.store = store; this.options = options; this.documents = new DocumentStore(store); }

  validate(record: WorkRecord, kind: AuthoringRun["kind"], base: DocumentRef) {
    if (["running", "unknown"].includes(record.execution.status) || record.analysisRuns?.some(item => ["preparing", "running", "unknown"].includes(item.status))) throw new Error("原执行尚未核清，不能重复发起稿件生成。");
    const document = this.documents.document(record, base);
    if (kind === "revise_draft") {
      if (document.kind !== "draft" || record.authoring!.drafts.at(-1)?.id !== document.id) throw new Error("修改须使用最新草稿。");
    } else {
      if (kind === "review_draft" && document.kind !== "draft") throw new Error("入项检查须指定草稿版本。");
      const draft = document.kind === "draft" ? base : document.draft!;
      this.documents.assertHandedOff(record, draft);
      if (kind === "design") this.documents.assertReviewed(record, draft);
    }
    return document;
  }

  async generate(workId: string, kind: AuthoringRun["kind"], base: DocumentRef, instruction: string, operationId: string, assetIds?: string[]) {
    return this.store.withLock(workId, async () => {
      checkExecution(this.options.signal);
      const record = this.store.read(workId), source = this.validate(record, kind, base);
      const runId = "authoring-" + randomUUID(), inputPath = join("works", workId, "authoring", runId, "input.json");
      const modelSelection = selectModel(this.options.models ?? configuration.models,
        kind === "review_draft" ? "draft_review" : kind === "revise_draft" ? "draft_revision" : "design");
      const directory = dirname(this.store.resolvePath(inputPath)); mkdirSync(directory, { recursive: true });
      const developer = readPrompt("authoring", kind === "review_draft" ? "草稿检查" : kind === "design" ? "设计" : "草稿修改");
      const assetRules = kind !== "revise_draft" ? readPrompt("asset-acquisition") : undefined;
      const developerInstructions = [developer.text, assetRules?.text].filter(Boolean).join("\n\n");
      const draft = source.kind === "draft" ? base : source.draft!;
      const combinedAssetIds = assetIds ?? source.assetIds, assets = new AssetStore(this.store);
      if (kind === "review_draft" && valueHash(combinedAssetIds) !== valueHash(source.assetIds)) throw new Error("草稿检查使用该版本实际附件，修改附件须提交新稿。");
      assets.select(record, combinedAssetIds);
      const attachments = combinedAssetIds.map(id => assets.view(record, id));
      const input = { runId, kind, instruction, modelSelection, base: this.documents.read(record, base),
        draft: source.kind === "draft" ? { ref: draft, note: "草稿原文及附件已完整放在 base，不重复内联。" } : this.documents.read(record, draft), assetIds: combinedAssetIds, attachments,
        handoff: record.authoring!.handoffs.at(-1),
        draftReview: this.documents.latestDraftReview(record, draft)?.draftReview,
        ...(kind === "review_draft" && source.basedOn ? { previousReview: this.documents.latestDraftReview(record, source.basedOn)?.draftReview } : {}),
        developer, ...(assetRules ? { assetRules } : {}), developerInstructions,
        outputSchema: z.toJSONSchema(kind === "review_draft" ? draftReviewResultSchema : authoringResultSchema) };
      immutableJson(this.store.resolvePath(inputPath), input);
      const run: AuthoringRun = { id: runId, operationId, kind, base, instruction, assetIds: input.assetIds,
        status: "preparing", inputPath, inputSha256: fileHash(this.store.resolvePath(inputPath)), blockers: [], sendState: "not_sent", modelSelection };
      record.authoring!.runs.push(run); record.execution = { status: "running", runId }; this.store.save(record);
      let client: CodexAppServerClient | undefined, phase: "preparing" | "awaiting_result" | "checking_result" = "preparing";
      const tools = new LearningService(this.store).tools(record, runId, source.creativeProfile?.ref.id);
      let searches = 0;
      const knowledgePath = join(directory, "knowledge-evidence.json");
      const mediaTools = new ProductionMediaTools(this.store, record, runId, new AssetService(this.store), undefined,
        { libraries: this.options.assetLibraries, signal: this.options.signal, visualAnalysis: new ModelAnalysisService(this.store, this.options) });
      try {
        const images = attachments.filter(asset => asset.mimeType.startsWith("image/")).map(asset => asset.location);
        const visualAnalysis = images.length ? await new ModelAnalysisService(this.store, this.options).run(record, runId,
          "visual_understanding", { instruction, attachments }, images) : undefined;
        if (visualAnalysis) immutableJson(join(directory, "visual-analysis.json"), visualAnalysis);
        if (visualAnalysis?.status === "needs_input") {
          run.status = "needs_input"; run.blockers = [visualAnalysis.markdown];
          record.execution = { status: "waiting_input", runId, error: visualAnalysis.markdown }; this.store.save(record);
          return this.view(record, run);
        }
        this.options.onProgress?.(kind === "review_draft" ? "项目 AI 正在结合相关经验检查草稿" : kind === "design" ? "项目 AI 正在设计视频脚本" : "项目 AI 正在按要求修改草稿");
        client = new CodexAppServerClient({ cwd: directory, executable: this.options.codexExecutable, signal: this.options.signal,
          timeoutMs: this.options.timeoutMs, turnTimeoutMs: this.options.timeoutMs ?? configuration.runtime.productionTimeoutMs,
          onEvent: event => this.store.appendEvent(workId, runId, event),
          onToolCall: (name, args, identity) => {
            if (identity.threadId !== run.threadId || (run.turnId && identity.turnId !== run.turnId)) throw new Error("工具调用不属于当前稿件执行。");
            if (kind !== "revise_draft" && mediaTools.has(name)) return mediaTools.call(name, args);
            const result = tools.call(name, args);
            if (name === "intentframe_search_experience") searches++;
            if (kind === "review_draft") atomicJson(knowledgePath, { searches, reads: [...tools.reads.values()] });
            return result;
          } });
        run.runnerPid = client.pid; if (client.pid) this.options.onRunner?.(client.pid); this.store.save(record);
        await client.initializeConnection(); checkExecution(this.options.signal);
        await checkModel(client, modelSelection);
        const thread = modelThreadSchema.parse(await client.sendRequest("thread/start", {
          cwd: directory, sandbox: "read-only", approvalPolicy: "never", developerInstructions,
          dynamicTools: [...knowledgeToolDefinitions, ...(kind !== "revise_draft" ? mediaToolDefinitions(true) : [])],
          ...modelThreadParameters(modelSelection, kind !== "revise_draft" ? { web_search: "live" } : {}),
        }));
        run.threadId = thread.thread.id; run.model = thread.model; run.reasoningEffort = thread.reasoningEffort; this.store.save(record);
        verifyModelThread(modelSelection, thread);
        const turnInput = [{ type: "text", text: "本次执行编号：" + runId + "\n读取 input.json，完成指定任务并返回结构化结果。" +
          (visualAnalysis ? "\n视觉理解结果：" + JSON.stringify(visualAnalysis) : "") }];
        immutableJson(join(directory, "turn-input.json"), { modelSelection, input: turnInput, outputSchema: input.outputSchema });
        run.sendState = "sending"; run.status = "running"; this.store.save(record);
        phase = "awaiting_result";
        const response = z.object({ turn: codexTurnSchema }).parse(await client.sendRequest("turn/start", {
          threadId: run.threadId, outputSchema: input.outputSchema,
          ...modelTurnParameters(modelSelection),
          input: turnInput,
        }));
        run.turnId = response.turn.id; run.sendState = "acknowledged"; this.store.save(record);
        const completed = await client.waitForTurnCompletion(run.turnId, run.threadId);
        if (completed.status === "inProgress") throw new Error("原稿件执行尚未结束。");
        phase = "checking_result";
        if (completed.status !== "completed") throw new Error(completed.error?.message ?? "稿件生成未完成。");
        const reply = client.finalReply(run.turnId);
        immutableJson(join(directory, "result.json"), { threadId: run.threadId, turnId: run.turnId, inputSha256: run.inputSha256, reply, operationId });
        this.apply(record, run, operationId, reply);
        return this.view(record, run);
      } catch (error) {
        run.status = record.analysisRuns?.some(item => item.status === "unknown") ? "unknown" : executionFailureStatus(error, phase); run.error = describeError(error);
        record.execution = { status: run.status, runId, error: run.error }; this.store.save(record); throw error;
      } finally { await mediaTools.drain(); await client?.close(); }
    });
  }

  private apply(record: WorkRecord, run: AuthoringRun, operationId: string, reply: string) {
    assertAnalysesSettled(record);
    if (fileHash(this.store.resolvePath(run.inputPath)) !== run.inputSha256) throw new Error("原稿件输入已变化，不能保存为原执行结果。");
    if (run.kind === "review_draft") {
      this.documents.assertHandedOff(record, run.base);
      const result = draftReviewResultSchema.parse(JSON.parse(reply));
      const path = join(dirname(this.store.resolvePath(run.inputPath)), "knowledge-evidence.json");
      if (!existsSync(path)) throw new Error("草稿检查缺少实际经验检索依据，不能当作检查完成。");
      const evidence = knowledgeEvidenceSchema.parse(readJson(path));
      if (!evidence.searches || result.usedExperienceRefs.some(ref => !evidence.reads.some(read => valueHash(read) === valueHash(ref)))) {
        throw new Error("草稿检查未实际检索经验，或声称采用了未读取的经验版本。");
      }
      run.draftReview = result; run.status = "completed"; run.error = undefined;
      run.blockers = result.issues.map(issue => issue.problem);
      record.execution = result.status === "passed" ? { status: "idle", runId: run.id } : { status: "waiting_input", runId: run.id, error: result.summary };
      this.store.save(record); return;
    }
    const result = authoringResultSchema.parse(JSON.parse(reply));
    if (result.status === "completed" && (result.blockers.length || !result.markdown.trim())) throw new Error("稿件完成声明与正文或阻塞项不一致。");
    if (result.status === "needs_input" && !result.blockers.length) throw new Error("等待输入须说明具体缺口。");
    if (result.markdown.trim()) {
      const base = this.documents.document(record, run.base);
      const document = this.documents.append(record, run.kind === "design" ? "design" : "draft", result.markdown, {
        operationId, source: "project_ai", instruction: run.instruction, basedOn: run.base,
        draft: run.kind === "design" ? base.kind === "draft" ? run.base : base.draft : undefined, assetIds: run.assetIds,
        ...(run.kind === "revise_draft" && base.reviewRequired ? { reviewRequired: true } : {}),
      });
      run.outputDocument = documentRefSchema.parse(document);
    }
    run.status = result.status; run.blockers = result.blockers; run.error = result.status === "failed" ? result.summary : undefined;
    record.execution = { status: result.status === "completed" ? "idle" : result.status === "needs_input" ? "waiting_input" : "failed", runId: run.id, error: run.error };
    this.store.save(record);
  }

  private view(record: WorkRecord, run: AuthoringRun) {
    return { runId: run.id, status: run.kind === "review_draft" && run.draftReview && run.draftReview.status !== "passed" ? "needs_input" : run.status,
      blockers: run.blockers, error: run.error, draftReview: run.draftReview,
      document: run.outputDocument ? this.documents.read(record, run.outputDocument) : undefined,
      next: run.kind === "review_draft" ? run.draftReview?.status === "passed" ? "草稿检查通过，可在已有交接授权内继续 design_video；尚未设计或制作。" :
        "外部 AI 按问题处理：已有要求内纠错可提交新版，意图歧义须询问用户；新稿须重新检查。" :
        run.kind === "design" ? "交给外部 AI 审查，再记录设计采用结论；未开始代码制作。" : "交给用户与外部 AI 继续讨论；未自动进入设计。" };
  }

  async recover(workId: string) {
    return this.store.withRecoveryGuard(workId, async () => {
      const record = this.store.read(workId), run = record.authoring?.runs.find(item => item.id === record.execution.runId);
      if (!run) throw new Error("没有对应的原稿件执行。");
      const owner = this.store.lockOwner(workId);
      if ((owner && processExists(owner.pid)) || (run.runnerPid && processExists(run.runnerPid, process.platform !== "win32"))) return { status: "running" as const };
      if (owner && !run.runnerPid) return { status: "unknown" as const, message: "原锁缺少运行器依据，未解除保护。" };
      const directory = dirname(this.store.resolvePath(run.inputPath)), receiptPath = join(directory, "result.json");
      let receipt: { threadId: string; turnId: string; inputSha256: string; reply: string; operationId: string } | undefined;
      if (existsSync(receiptPath)) receipt = z.object({ threadId: z.string(), turnId: z.string(), inputSha256: z.string(), reply: z.string(), operationId: z.string() }).parse(readJson(receiptPath));
      else if (run.sendState !== "not_sent") {
        if (!run.threadId) return { status: "unknown" as const, message: "缺少原线程身份，未重发。" };
        const client = new CodexAppServerClient({ cwd: directory, executable: this.options.codexExecutable, timeoutMs: this.options.timeoutMs });
        if (client.pid) this.options.onRunner?.(client.pid);
        try {
          await client.initializeConnection();
          const original = await client.readOriginalTurn(run.threadId, run.turnId, directory, run.id);
          if (original.turn.status === "inProgress") return { status: "running" as const };
          if (original.turn.status !== "completed") { run.status = "failed"; run.error = "原稿件执行未完成。"; }
          else {
            // 只读任务的原文输出可直接沿原线程核回；不从当前工程补造旧结果。
            run.turnId = original.turn.id;
            receipt = { threadId: run.threadId, turnId: run.turnId, inputSha256: run.inputSha256, reply: original.reply, operationId: run.operationId };
            immutableJson(receiptPath, receipt);
          }
        } finally { await client.close(); }
      }
      if (receipt && (receipt.threadId !== run.threadId || receipt.turnId !== run.turnId || receipt.inputSha256 !== run.inputSha256 || receipt.operationId !== run.operationId)) throw new Error("原稿件回执身份不符。");
      if (owner) this.store.releaseStaleLock(workId, owner);
      return this.store.withLock(workId, () => {
        if (receipt) this.apply(record, run, receipt.operationId, receipt.reply);
        else { run.status = "failed"; record.execution = { status: "failed", runId: run.id, error: run.error ?? "原稿件请求未发送。" }; this.store.save(record); }
        return { status: "recovered" as const, kind: "authoring" as const, operationId: run.operationId,
          result: this.view(record, run), work: this.store.summary(record) };
      }, true);
    });
  }
}
