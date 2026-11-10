import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { configuration, repositoryRoot } from "../config.ts";
import { fileHash, renderVersion, restoreVideoPreviews } from "../media/render.ts";
import { WorkStore } from "../records/work-store.ts";
import type { WorkRecord, WorkVersion } from "../records/work-store.ts";
import { KnowledgeStore, pendingLearningSources } from "../records/knowledge-store.ts";
import { ComparisonStore } from "../records/comparison-store.ts";
import { immutableJson, readJson, valueHash } from "../records/files.ts";
import { learningResultSchema } from "../records/contracts.ts";
import { knowledgeToolDefinitions, LearningService } from "./learning-service.ts";
import { executionConditions, productionRules, systemFingerprint } from "./context.ts";
import { processExists } from "./process-state.ts";
import { checkExecution } from "./execution-control.ts";
import { appliedFeedback, selectProduction } from "./production-selection.ts";
import type { ProductionSelection } from "./production-selection.ts";
import { fillPrompt, readPrompt } from "./prompts.ts";
import { productionHistory, productionHistoryTool } from "./production-history.ts";
import { productionReceiptPath, readProductionReceipt, saveProductionReceipt } from "./production-receipt.ts";
import type { ProductionReceipt } from "./production-receipt.ts";
import { parseProductionResult, productionOutputSchema } from "./production-result.ts";
import { AuthoringService } from "./authoring-service.ts";
import { DocumentStore } from "../records/document-store.ts";
import { ReviewService } from "./review-service.ts";
import { AssetService } from "./asset-service.ts";
import type { ReviewRange } from "../media/review-materials.ts";
import { MAX_INTERNAL_REPAIRS, internalReviewPassed } from "../records/media-contracts.ts";
import type { AssetOptions } from "./asset-service.ts";
import { ProductionMediaTools, mediaToolDefinitions } from "./production-media.ts";
import { readAudioPlan } from "./audio-plan.ts";
import type { LibraryRoot } from "../records/asset-catalog.ts";
import { ProviderRequestError, speechSegments } from "../media/providers.ts";
import {
  CodexAppServerClient, codexTurnSchema, describeError, executionFailureStatus, UnknownExecutionOutcome,
} from "./codex-client.ts";

type ServiceOptions = AssetOptions & { render?: typeof renderVersion; restorePreviews?: typeof restoreVideoPreviews; codexExecutable?: string; timeoutMs?: number; knowledge?: KnowledgeStore;
  assetLibraries?: LibraryRoot[];
  prepareReview?: (record: WorkRecord, version: WorkVersion) => Promise<unknown>;
  signal?: AbortSignal; onProgress?: (phase: string) => void; onRunner?: (pid: number) => void; productionSnapshot?: WorkRecord };

export class WorkService {
  readonly store: WorkStore;
  readonly knowledge: KnowledgeStore;
  readonly learning: LearningService;
  readonly comparisons: ComparisonStore;
  readonly authoring: AuthoringService;
  readonly documents: DocumentStore;
  readonly reviewMaterials: ReviewService;
  readonly assets: AssetService;
  private options: ServiceOptions;
  constructor(store = new WorkStore(), options: ServiceOptions = {}) {
    this.store = store; this.options = options;
    this.knowledge = options.knowledge ?? new KnowledgeStore(store.assetRoot);
    this.learning = new LearningService(store, this.knowledge);
    this.comparisons = new ComparisonStore(store, this.knowledge);
    this.authoring = new AuthoringService(store, options);
    this.documents = this.authoring.documents;
    this.reviewMaterials = new ReviewService(store, options);
    this.assets = new AssetService(store, options);
  }

  assertCanProduce(record: WorkRecord, kind: "sample" | "complete"): void {
    if (["running", "unknown"].includes(record.execution.status)) {
      throw new Error("已有执行尚未取得明确结果，不能重复发起。");
    }
    if (kind === "complete" && !record.authoring && !record.directionApproval) {
      throw new Error("尚无用户对样例方向的明确确认，不能展开完整制作。");
    }
  }

  private appliedFeedback(record: WorkRecord, base?: WorkVersion): string[] {
    return appliedFeedback(this.store, record, base);
  }

  async produce(
    id: string, kind: "sample" | "complete", feedbackId?: string,
    threadMode: "fresh" | "resume" = "fresh", baseVersionId?: string, baseReason?: string,
    operationId?: string, selection: ProductionSelection = {},
  ): Promise<WorkRecord> {
    checkExecution(this.options.signal);
    return this.store.withLock(id, async () => {
      const record = this.store.read(id);
      if (this.options.productionSnapshot) {
        if (this.options.productionSnapshot.id !== id) throw new Error("受理时的制作输入不属于当前作品。");
        record.feedback = this.options.productionSnapshot.feedback;
        record.directionApproval = this.options.productionSnapshot.directionApproval;
        record.authoring = this.options.productionSnapshot.authoring;
      }
      await this.produceLocked(record, kind, feedbackId, threadMode, baseVersionId, baseReason, operationId, selection);
      await this.finishInternalReview(record, record.versions.at(-1)!);
      return record;
    });
  }

  /** 同一制作请求及其自动修复始终持有作品写锁；每次修复仍保存独立版本和原生回执。 */
  private async produceLocked(
    record: WorkRecord, kind: "sample" | "complete", feedbackId?: string,
    threadMode: "fresh" | "resume" = "fresh", baseVersionId?: string, baseReason?: string,
    operationId?: string, selection: ProductionSelection = {}, internalRepair?: WorkVersion["internalRepair"],
  ): Promise<void> {
      const id = record.id;
      this.assertCanProduce(record, kind);
      const comparison = this.comparisons.context(record);
      if (comparison && (comparison.state !== "open" || record.versions.length || record.feedback.length)) throw new Error("比较使用固定输入的首次制作；已有结果请先评价或新建比较。");
      if (record.learningPending) {
        try { this.learning.finishPending(record); }
        catch (error) { record.learningError = describeError(error); this.store.save(record); }
      }
      const chosen = selectProduction(this.store, record, kind, feedbackId, threadMode, baseVersionId, baseReason, selection);
      const { previous, inherited, requested } = chosen;
      const design = this.documents.adopted(record, selection.designRef);
      const assetIds = [...new Set([...(design?.document.assetIds ?? []), ...(previous?.assets?.map(asset => asset.id) ?? []), ...(selection.assetIds ?? [])])];
      const selectedAssets = this.assets.assets.select(record, assetIds);
      baseReason = chosen.baseReason;
      // 会失败的只读准备先完成，不为缺失需求留下占位目录。
      const brief = readFileSync(this.store.resolvePath(record.briefPath), "utf8");
      let number = Math.max(0, ...record.versions.map(v => Number(v.id.slice(1)))) + 1;
      if (!Number.isSafeInteger(number)) throw new Error("版本编号超出可用范围。");
      // 旧实现可能留下未登记目录；保留它并使用新编号，不覆盖或删除未知文件。
      while (existsSync(join(this.store.workDirectory(id), "versions", "v" + String(number).padStart(3, "0")))) number++;
      const versionId = "v" + String(number).padStart(3, "0"), runId = "run-" + randomUUID();
      const version: WorkVersion = {
        id: versionId, kind, production: "creating",
        sourcePath: "works/" + id + "/versions/" + versionId + "/source/entry.tsx",
        mediaPath: "media/" + id + "/" + versionId + "/video.mp4",
        createdAt: new Date().toISOString(), feedbackId, feedbackIds: requested, runId,
        basedOnVersionId: previous?.id, baseReason, review: { status: "not_reviewed" }, acceptance: "pending",
        directionId: chosen.newDirection || !previous ? versionId : previous.directionId ?? previous.id,
        newDirection: chosen.newDirection,
        operationId, sendState: "not_sent", systemFingerprint: systemFingerprint(),
        designRef: design ? { id: design.document.id, sha256: design.document.sha256 } : undefined,
        designDecisionId: design?.decision.operationId,
        assets: selectedAssets,
        mediaToolsVersion: design ? 1 : undefined,
        audioPlan: previous?.audioPlan ? { ...previous.audioPlan } : undefined,
        internalRepair: design ? internalRepair ?? { rootVersionId: versionId, attempt: 0 } : undefined,
      };
      const sourceDirectory = dirname(this.store.resolvePath(version.sourcePath));
      const relevantFeedback = record.feedback.filter(f => inherited.includes(f.id) || requested.includes(f.id));
      const pendingSources = pendingLearningSources(record);
      pendingSources.items = pendingSources.items.filter(source => source.kind === "feedback" ?
        relevantFeedback.some(f => source.id === "feedback:" + f.id) : source.versionId === previous?.id);
      const sourceIds = pendingSources.items.map(source => source.id);
      const tools = this.learning.tools(record, runId);
      const history = productionHistory(record, previous, inherited, tools.feedbackReads);
      const selectedFeedback = relevantFeedback.filter(item => requested.includes(item.id));
      const feedbackText = JSON.stringify(selectedFeedback.map(item => ({ ...item, inheritedInBase: inherited.includes(item.id), requestedThisTurn: true })), null, 2);
      const inlineFeedback = feedbackText.length <= 25_000;
      if (inlineFeedback) for (const item of selectedFeedback) tools.feedbackReads.add(item.id);
      const developer = readPrompt("production", "执行约束"), template = readPrompt("task"), startPrompt = readPrompt("production", "启动消息");
      const rules = productionRules(kind, relevantFeedback.some(f => f.location), relevantFeedback.length > 0);
      const turnInput = fillPrompt(startPrompt.text, { runId });
      const context = fillPrompt(template.text, {
        assets: JSON.stringify(selectedAssets.map(asset => ({ ...this.assets.assets.view(record, asset.id),
          source: "assets/" + asset.id + asset.path.slice(asset.path.lastIndexOf(".")),
          metadataSource: "assets/" + asset.id + "-metadata.json" })), null, 2),
        design: design ? [JSON.stringify({ designRef: version.designRef, adoptedBy: design.decision.source,
          adoptionNotes: design.decision.notes, draftRef: { id: design.draft.id, sha256: design.draft.sha256 } }, null, 2),
          "#### 采用的脚本正文", design.markdown, "#### 用户交接的草稿原文", design.draft.markdown].join("\n\n") : "旧任务没有独立脚本记录，按原有有效需求接续；不补造历史脚本。",
        brief: previous ? brief : "首次制作的原始需求已在上方完整提供；本轮尚无历史工程。",
        task: JSON.stringify({ purpose: record.purpose ?? "unspecified", versionId, kind, newDirection: chosen.newDirection }),
        baseline: previous ? JSON.stringify({ baseVersionId: previous.id, baseReason,
          currentProduction: previous.production, availability: this.store.availability(previous),
          review: previous.review, acceptance: previous.acceptance,
          ...(previous.error ? { error: previous.error } : {}),
          ...(previous.agentResult && previous.production !== "ready" ? { unfinished: {
            summary: previous.agentResult.summary, blockers: previous.agentResult.blockers,
            unresolvedFeedbackIds: previous.agentResult.unresolvedFeedbackIds } } : {}) }, null, 2) : "首次制作，无历史工程。",
        feedback: selectedFeedback.length ? inlineFeedback ? feedbackText : "本轮反馈较多，使用 intentframe_read_feedback 按本轮编号读取完整原文；未读取前不能声称处理完成。" : previous ? "本轮没有选定反馈；按本轮制作阶段和所选基线接续，保留有效成果，不执行其他未选意见。" : brief,
        inherited: JSON.stringify(history.snapshot.inheritedFeedback.map(item => ({ id: item.id, versionId: item.versionId,
          supersededByFeedbackIds: item.supersededByFeedbackIds })), null, 2),
        feedbackIds: JSON.stringify(requested), direction: design ? "按上方已采用脚本及本轮制作范围执行；AI 采用不等于用户认可成片。" : record.directionApproval ? JSON.stringify(record.directionApproval, null, 2) : "尚未确认方向，仅制作样例。",
        conditionalRules: rules.filter(r => r.section !== "经验使用").map(r => r.text).join("\n"),
        experience: rules.find(r => r.section === "经验使用")!.text + (comparison ? "\n本轮为固定输入比较，仅使用已开放的知识范围。" : ""),
        sourceIds: JSON.stringify(sourceIds), sources: pendingSources.items.length ? JSON.stringify(pendingSources.items.map(source =>
          source.kind === "feedback" ? { id: source.id, kind: source.kind, versionId: source.versionId } : source), null, 2) : "无待整理来源。",
      });

      let codex: CodexAppServerClient | undefined;
      let mediaTools: ProductionMediaTools | undefined;
      let phase: "preparing" | "awaiting_result" | "checking_result" | "rendering" = "preparing";
      record.versions.push(version);
      record.execution = { status: "running", runId, versionId };
      // 先登记版本，再准备文件；后续准备失败仍有明确失败记录和下次可用编号。
      this.store.save(record);
      try {
        checkExecution(this.options.signal);
        this.options.onProgress?.("准备制作输入与版本工程");
        mkdirSync(sourceDirectory, { recursive: true });
        if (previous) cpSync(dirname(this.store.resolvePath(previous.sourcePath)), sourceDirectory, { recursive: true });
        else this.comparisons.prepare(record, sourceDirectory);
        this.assets.assets.copyToSource(record, assetIds, sourceDirectory);
        writeFileSync(join(sourceDirectory, "context.md"), context);
        version.contextSha256 = fileHash(join(sourceDirectory, "context.md"));
        version.inputManifestPath = "works/" + id + "/runs/" + runId + "/input.json";
        immutableJson(this.store.resolvePath(version.inputManifestPath), { context, developerInstructions: developer.text, turnInput,
          outputSchema: productionOutputSchema, sources: [developer, template, startPrompt, ...rules], history: history.snapshot });
        version.inputManifestSha256 = fileHash(this.store.resolvePath(version.inputManifestPath));
        this.store.save(record);
        this.store.appendEvent(id, runId, { kind: "production_started", versionId, basedOnVersionId: previous?.id, feedbackIds: requested });
        version.executionConditions = executionConditions(this.options.codexExecutable, this.options.timeoutMs);
        this.store.save(record);
        mediaTools = new ProductionMediaTools(this.store, record, runId, this.assets, version,
          { libraries: this.options.assetLibraries, render: this.options.render, signal: this.options.signal });
        const currentMediaTools = mediaTools;
        codex = new CodexAppServerClient({
          cwd: sourceDirectory, executable: this.options.codexExecutable,
          onEvent: event => this.store.appendEvent(id, runId, event),
          timeoutMs: this.options.timeoutMs, turnTimeoutMs: this.options.timeoutMs ?? configuration.runtime.productionTimeoutMs,
          signal: this.options.signal,
          onToolCall: (name, input, identity) => {
            if (identity.threadId !== version.threadId || (version.turnId && identity.turnId !== version.turnId)) throw new Error("工具调用不属于本轮制作。");
            if (name === productionHistoryTool.name) return history.read(input);
            if (currentMediaTools.has(name)) return currentMediaTools.call(name, input);
            return tools.call(name, input);
          },
        });
        version.runnerPid = codex.pid; this.store.save(record);
        if (codex.pid) this.options.onRunner?.(codex.pid);
        await codex.initializeConnection();
        checkExecution(this.options.signal);
        const response = z.object({ thread: z.object({ id: z.string() }), model: z.string().optional() })
          .parse(await codex.sendRequest(threadMode === "resume" ? "thread/resume" : "thread/start", {
            ...(threadMode === "resume" ? { threadId: previous?.threadId, excludeTurns: true } : {}),
            cwd: sourceDirectory, sandbox: "workspace-write", approvalPolicy: "never",
            dynamicTools: [...knowledgeToolDefinitions, productionHistoryTool, ...mediaToolDefinitions(!design)],
            config: { web_search: "live" },
            developerInstructions: developer.text,
          }));
        version.threadId = response.thread.id;
        version.model = response.model;
        this.store.save(record);
        checkExecution(this.options.signal);
        this.options.onProgress?.("项目主 AI 正在制作工程");
        phase = "awaiting_result";
        version.sendState = "sending"; this.store.save(record);
        const started = z.object({ turn: codexTurnSchema }).parse(await codex.sendRequest("turn/start", {
          threadId: version.threadId, outputSchema: productionOutputSchema,
          input: [{ type: "text", text: turnInput }],
        }));
        version.turnId = started.turn.id;
        version.sendState = "acknowledged";
        this.store.save(record);
        const completed = await codex.waitForTurnCompletion(started.turn.id, version.threadId);
        if (completed.status === "inProgress") throw new UnknownExecutionOutcome("原执行尚未结束。");
        await mediaTools.drain();
        phase = "checking_result";
        let reply = "";
        try { reply = codex.finalReply(started.turn.id); } catch { /* 终态仍保存；空结果在制作判定中明确失败。 */ }
        const receipt = saveProductionReceipt(this.store, record, version, {
          threadId: version.threadId!, turnId: completed.id, status: completed.status, reply,
          ...(completed.error ? { error: completed.error.message } : {}),
          knowledgeReads: [...tools.reads.values()], feedbackReads: [...tools.feedbackReads], learningSourceIds: sourceIds,
        });
        await mediaTools.settled();
        if (this.applyProductionReceipt(record, version, receipt)) {
          checkExecution(this.options.signal);
          phase = "rendering";
          await this.render(record, version);
        }
        this.saveLearningResult(record, version, receipt);
      } catch (error) {
        const status = record.execution.status === "unknown" || (error instanceof ProviderRequestError && error.uncertain) ? "unknown" : executionFailureStatus(error, phase);
        if (version.production !== "ready") version.production = status;
        version.error = (codex?.stopReason ? codex.stopReason + " " : "") + describeError(error);
        record.execution = { status, runId, versionId, error: version.error };
        this.store.save(record);
        try { this.store.appendEvent(id, runId, { kind: "execution_error", phase, status: record.execution.status, message: version.error }); }
        catch (logError) { throw new Error(version.error + "；错误记录另有失败：" + describeError(logError)); }
        throw new Error(version.error, { cause: error });
      } finally { await mediaTools?.drain(); await codex?.close(); }
  }

  private async finishInternalReview(record: WorkRecord, startingVersion: WorkVersion, operationId?: string): Promise<void> {
    let version = startingVersion;
    operationId ??= startingVersion.reviewPreparation?.operationId ?? startingVersion.operationId;
    if (!version.designRef || version.production !== "ready") return;
    for (;;) {
      checkExecution(this.options.signal);
      if (internalReviewPassed(version.reviewPreparation)) {
        version.error = undefined; record.execution = { status: "idle" }; this.store.save(record); return;
      }
      const inspection = version.reviewPreparation?.inspections.at(-1), quality = inspection?.result?.quality;
      const cycle = version.internalRepair ?? { rootVersionId: version.id, attempt: 0 };
      if (version.reviewPreparation?.status !== "available" || inspection?.status !== "completed" ||
          quality?.status !== "needs_repair" || cycle.attempt >= MAX_INTERNAL_REPAIRS) {
        const reason = quality?.status === "needs_confirmation" ? "内检发现问题需要调整设计或澄清意图，须返回确认。" :
          cycle.attempt >= MAX_INTERNAL_REPAIRS ? "已达到本次自动修复上限，复查仍有问题，未作为合格结果交付。" :
          "项目内检或材料覆盖尚未通过，未交付给外部 AI 验收。";
        version.error = [reason, ...(quality?.issues.map(item => item.description) ?? []), version.reviewPreparation?.error].filter(Boolean).join("\n");
        record.execution = { status: "waiting_input", runId: version.runId, versionId: version.id, error: version.error };
        this.store.save(record); return;
      }
      const text = ["项目内检发现以下实现问题。保持已采用的设计与原有有效修改，仅修复这些缺陷；不能擅自改变设计。",
        ...quality.issues.map((item, index) => `${index + 1}. ${item.description}\n修正要求：${item.correction}`),
        "修复后由项目重新渲染并回看，源码修改本身不能证明问题已经消失。"].join("\n\n");
      const feedbackId = await this.store.internalFeedback(record, version.id, text, inspection.id);
      this.options.onProgress?.(`项目正在内部修复并复查（${cycle.attempt + 1}/${MAX_INTERNAL_REPAIRS}）`);
      record.execution = { status: "idle" }; this.store.save(record);
      await this.produceLocked(record, version.kind, undefined, "fresh", version.id, "按项目内检修复实现缺陷，保持采用设计。",
        operationId ?? version.operationId, { designRef: version.designRef, assetIds: version.assets?.map(asset => asset.id), feedbackIds: [feedbackId] },
        { rootVersionId: cycle.rootVersionId, attempt: cycle.attempt + 1, inspectionId: inspection.id });
      version = record.versions.at(-1)!;
      if (version.production !== "ready") return;
    }
  }

  async prepareMaterials(id: string, versionId: string, ranges: ReviewRange[], operationId?: string) {
    return this.store.withLock(id, async () => {
      const record = this.store.read(id), version = this.store.version(record, versionId);
      this.assertCanProduce(record, "sample");
      version.reviewPreparation ??= { status: "preparing", batches: [], inspections: [] };
      version.reviewPreparation.operationId = operationId;
      record.execution = { status: "running", runId: version.runId, versionId };
      this.store.save(record);
      await this.reviewMaterials.prepare(record, version, ranges, true);
      const count = record.versions.length;
      await this.finishInternalReview(record, version, operationId);
      if (!version.designRef) { record.execution = { status: "idle" }; this.store.save(record); }
      const final = record.versions.length > count ? record.versions.at(-1)! : version;
      return { ...this.reviewMaterials.view(record, final), requestedVersionId: versionId, versionId: final.id,
        delivery: this.store.delivery({ ...record, versions: [final] }) };
    });
  }

  private applyProductionReceipt(record: WorkRecord, version: WorkVersion, receipt: ProductionReceipt): boolean {
    this.assets.assertSettled(record, version);
    version.turnId = receipt.turnId;
    version.nativeResult = { threadId: receipt.threadId, turnId: receipt.turnId, status: receipt.status, reply: receipt.reply,
      ...(receipt.error ? { error: receipt.error } : {}) };
    version.agentReply = receipt.reply;
    if (receipt.status !== "completed") throw new Error(receipt.error ?? ("原生执行结束：" + receipt.status));
    if (!receipt.reply) throw new Error("原生执行结束，但没有明确的最终制作结果。");
    const result = parseProductionResult(receipt.reply, version.feedbackIds ?? []);
    version.agentResult = result;
    const used = result.usedExperienceRefs ?? [];
    if (used.some(ref => !receipt.knowledgeReads.some(read => valueHash(ref) === valueHash(read)))) throw new Error("主 AI 声称采用了未实际取得的经验版本。");
    if (result.appliedFeedbackIds.some(id => !receipt.feedbackReads.includes(id))) throw new Error("主 AI 声称完成了未取得原文的反馈。");
    version.knowledgeUsed = used;
    const previous = version.basedOnVersionId ? this.store.version(record, version.basedOnVersionId) : undefined;
    if (receipt.sourceSnapshot) {
      version.sourceSnapshot = receipt.sourceSnapshot;
      version.sourceSha256 = receipt.sourceSnapshot.files["entry.tsx"];
      version.appliedFeedbackIds = [...new Set([...this.appliedFeedback(record, previous), ...result.appliedFeedbackIds])];
    } else if (result.status === "completed" || result.appliedFeedbackIds.length) throw new Error("主 AI 声称完成制作或反馈，但没有可核对的工程入口。");
    if (result.status === "needs_input") {
      version.production = "blocked"; version.error = result.blockers.join("\n");
      record.execution = { status: "waiting_input", runId: version.runId, versionId: version.id, error: version.error };
      this.store.save(record); return false;
    }
    if (result.status === "failed") throw new Error(result.summary + "\n" + result.blockers.join("\n"));
    const audio = version.audioPlan ? readAudioPlan(this.store, version) : undefined;
    if (version.mediaToolsVersion === 1 && version.designRef && speechSegments(this.documents.read(record, version.designRef).markdown).length &&
      !audio?.clips.some(clip => clip.words?.length && clip.volume > 0)) throw new Error("采用脚本包含人声，但缺少已编排的真实配音与字词时间，不能交付为完成。");
    // 已交付版本的完成事实不随媒体缺失或只补存而降级；可用性另行核对。
    if (version.production !== "ready") version.production = "source_ready";
    version.error = undefined;
    this.store.save(record); return true;
  }

  private saveLearningResult(record: WorkRecord, version: WorkVersion, receipt: ProductionReceipt) {
    const result = version.agentResult?.learning;
    if (!result || (!result.checkedSourceIds.length && !result.proposals.length)) return;
    try {
      // 来源编号仅限定可整理范围；正文已内联或由工具读回才算取得反馈原文。
      if (result.checkedSourceIds.some(id => id.startsWith("feedback:") && !receipt.feedbackReads.includes(id.slice("feedback:".length)))) {
        throw new Error("主 AI 声称检查了未取得原文的反馈，经验整理进度未保存。");
      }
      this.learning.accept(record, version, "learning-" + version.runId, result, receipt.learningSourceIds);
    }
    catch (error) {
      // 制作完成和经验保存分别报告；未保存的进度继续可见，不抹掉已经完成的作品。
      record.learningError = describeError(error); this.store.save(record);
    }
  }

  /** 使用同一项目主 AI 整理已保存事实；只读分析，不编辑制作工程。 */
  async organize(id: string): Promise<WorkRecord> {
    checkExecution(this.options.signal);
    return this.store.withLock(id, async () => {
      const record = this.store.read(id);
      this.assertCanProduce(record, "sample");
      if (record.learningPending) { this.learning.finishPending(record); return record; }
      if (record.learningRun && !record.learningRun.completed) throw new Error("原经验整理尚未核清，请先恢复原调用。");
      const pending = this.learning.pending(record);
      if (!pending.items.length) return record;
      const version = record.versions.at(-1) ?? record.authoring?.designs.at(-1) ?? record.authoring?.drafts.at(-1);
      if (!version) throw new Error("暂无可关联的稿件或制作版本。");
      const runId = "learning-" + randomUUID(), directory = this.store.resolvePath("works/" + id + "/learning/" + runId);
      mkdirSync(directory, { recursive: true });
      const learningPrompt = readPrompt("learning", "执行约束"), startPrompt = readPrompt("learning", "启动消息");
      const turnInput = fillPrompt(startPrompt.text, { runId });
      const input = { workId: id, purpose: record.purpose ?? "unspecified", versionId: version.id,
        sources: pending.items, remaining: pending.remaining,
        rule: learningPrompt.text, promptSources: [learningPrompt, startPrompt], turnInput, outputSchema: z.toJSONSchema(learningResultSchema) };
      immutableJson(join(directory, "context.json"), input);
      record.learningRun = { id: runId, versionId: version.id, sourceIds: pending.items.map(source => source.id),
        contextSha256: fileHash(join(directory, "context.json")), sendState: "not_sent",
        previousExecution: { ...record.execution }, completed: false, createdAt: new Date().toISOString() };
      record.execution = { status: "running", runId, versionId: version.id.startsWith("v") ? version.id : undefined };
      this.store.save(record);
      const run = record.learningRun, tools = this.learning.tools(record, runId);
      let client: CodexAppServerClient | undefined;
      let ended = false;
      try {
        checkExecution(this.options.signal);
        this.options.onProgress?.("项目主 AI 正在整理新增记录");
        client = new CodexAppServerClient({ cwd: directory, executable: this.options.codexExecutable,
          timeoutMs: this.options.timeoutMs, turnTimeoutMs: this.options.timeoutMs ?? configuration.runtime.productionTimeoutMs,
          signal: this.options.signal,
          onEvent: event => this.store.appendEvent(id, runId, event),
          onToolCall: (name, args, identity) => {
            if (identity.threadId !== run.threadId || (run.turnId && identity.turnId !== run.turnId)) throw new Error("工具调用不属于本轮整理。");
            return tools.call(name, args);
          } });
        run.runnerPid = client.pid; this.store.save(record);
        if (client.pid) this.options.onRunner?.(client.pid);
        await client.initializeConnection();
        checkExecution(this.options.signal);
        const started = z.object({ thread: z.object({ id: z.string() }) }).parse(await client.sendRequest("thread/start", {
          cwd: directory, sandbox: "read-only", approvalPolicy: "never", dynamicTools: knowledgeToolDefinitions,
          developerInstructions: learningPrompt.text,
        }));
        run.threadId = started.thread.id;
        checkExecution(this.options.signal);
        run.sendState = "sending"; this.store.save(record);
        const response = z.object({ turn: codexTurnSchema }).parse(await client.sendRequest("turn/start", {
          threadId: run.threadId, outputSchema: z.toJSONSchema(learningResultSchema),
          input: [{ type: "text", text: turnInput }],
        }));
        run.turnId = response.turn.id; run.sendState = "acknowledged"; this.store.save(record);
        const completed = await client.waitForTurnCompletion(run.turnId, run.threadId);
        ended = completed.status !== "inProgress";
        if (completed.status !== "completed") throw new Error(completed.error?.message ?? "经验整理未完成。");
        const reply = client.finalReply(run.turnId);
        immutableJson(join(directory, "result.json"), { threadId: run.threadId, turnId: run.turnId, reply, contextSha256: run.contextSha256 });
        this.applyLearningReply(record, reply);
        return record;
      } catch (error) {
        record.learningError = (client?.stopReason ? client.stopReason + " " : "") + describeError(error);
        const phase = run.sendState === "not_sent" ? "preparing" : ended ? "checking_result" : "awaiting_result";
        if (executionFailureStatus(error, phase) === "failed") { run.completed = true; record.execution = run.previousExecution; }
        else record.execution = { status: "unknown", runId, versionId: version.id.startsWith("v") ? version.id : undefined, error: record.learningError };
        this.store.save(record); throw new Error(record.learningError, { cause: error });
      } finally { await client?.close(); }
    });
  }

  private applyLearningReply(record: WorkRecord, reply: string): void {
    const run = record.learningRun;
    if (!run) throw new Error("缺少原经验整理身份。");
    const path = this.store.resolvePath("works/" + record.id + "/learning/" + run.id + "/context.json");
    if (fileHash(path) !== run.contextSha256) throw new Error("原经验整理输入已经变化。");
    const result = learningResultSchema.parse(JSON.parse(reply));
    this.learning.accept(record, this.learning.target(record, run.versionId), run.id, result, run.sourceIds);
    run.completed = true; record.execution = run.previousExecution; record.learningError = undefined;
    this.store.save(record);
  }

  /** 沿原身份核对并接续已知剩余工作；未知调用不重发，原进程存活时保留现场。 */
  async recover(id: string, render = true) {
    checkExecution(this.options.signal);
    const before = this.store.read(id);
    if (before.execution.runId?.startsWith("asset-")) return this.assets.recover(id);
    if (before.authoring?.runs.some(run => run.id === before.execution.runId)) return this.authoring.recover(id);
    this.options.onProgress?.("核对原调用、进程与本机回执");
    return this.store.withRecoveryGuard(id, async () => {
      const record = this.store.read(id), owner = this.store.lockOwner(id);
      if (owner && processExists(owner.pid)) return { status: "running", message: "原任务进程仍在运行，继续查询原进度。", work: this.store.summary(record) };
      const learningRun = record.learningRun && !record.learningRun.completed && record.execution.runId === record.learningRun.id ? record.learningRun : undefined;
      const version = record.execution.versionId ? this.store.version(record, record.execution.versionId) : record.versions.at(-1);
      const runnerPid = learningRun?.runnerPid ?? version?.runnerPid;
      if (runnerPid && processExists(runnerPid, process.platform !== "win32")) return { status: "running", message: "原运行器或其写入进程尚未结束，保留占用。", work: this.store.summary(record) };
      if (owner && !runnerPid) return { status: "unknown", message: "旧占用缺少原写入进程依据，未解除保护。", work: this.store.summary(record) };
      let observed: Awaited<ReturnType<CodexAppServerClient["readOriginalTurn"]>> | undefined;
      if (owner) {
        // 解除占用前同时核原进程与原执行；仅看到PID消失不能证明调用已结束。
        if (learningRun && learningRun.sendState !== "not_sent") {
          const resultPath = this.store.resolvePath("works/" + id + "/learning/" + learningRun.id + "/result.json");
          if (existsSync(resultPath)) this.readLearningReceipt(record);
          else {
            if (!learningRun.threadId) throw new UnknownExecutionOutcome("缺少原整理线程，保留占用。");
            observed = await this.inspectOriginal(learningRun.threadId, learningRun.turnId,
              this.store.resolvePath("works/" + id + "/learning/" + learningRun.id), learningRun.id);
          }
        } else if (!learningRun && version?.sendState !== "not_sent") {
          if (!version?.threadId || !version.contextSha256) throw new UnknownExecutionOutcome("缺少原制作身份，保留占用。");
          if (existsSync(productionReceiptPath(this.store, id, version.runId))) readProductionReceipt(this.store, record, version);
          else observed = await this.inspectOriginal(version.threadId, version.turnId, dirname(this.store.resolvePath(version.sourcePath)), version.runId);
        }
        if (observed?.turn.status === "inProgress") return { status: "running", message: "原执行未取得终态，保留占用。", work: this.store.summary(record) };
      }
      if (owner) this.store.releaseStaleLock(id, owner);
      return this.store.withLock(id, async () => {
        if (learningRun) return this.recoverLearning(record, observed);
        if (!version) return { status: "unchanged", work: this.store.summary(record) };
        const operationId = version.reviewPreparation?.operationId ?? version.operationId;
        if (version.production === "ready" && this.store.availability(version).status === "available") {
          if (render && this.store.previewAvailability(version).status !== "available") await this.repairPreviews(record, version);
          if (render && (version.designRef || version.reviewPreparation)) await this.reviewMaterials.prepare(record, version);
          if (existsSync(productionReceiptPath(this.store, id, version.runId))) this.saveLearningResult(record, version, readProductionReceipt(this.store, record, version));
          if (record.learningPending) this.learning.finishPending(record);
          if (render && version.designRef) await this.finishInternalReview(record, version);
          // 只收尾已核实版本对应的执行；未完成的经验保存与历史错误证据仍保留。
          const materialsSettled = !version.reviewPreparation || ["available", "needs_attention"].includes(version.reviewPreparation.status);
          if (!version.designRef && materialsSettled && !record.learningPending && !record.learningError &&
              record.execution.runId === version.runId && record.execution.versionId === version.id) {
            version.error = undefined;
            record.execution = { status: "idle" };
            this.store.save(record);
          }
          return { status: ["running", "unknown"].includes(record.execution.status) ? record.execution.status : "recovered",
            operationId, work: this.store.summary(record) };
        }
        if (version.sendState === "not_sent") {
          version.production = "failed"; version.error = "原制作尚未发送；准备现场已保留，可用新的操作继续。";
          record.execution = { status: "failed", runId: version.runId, versionId: version.id, error: version.error };
          this.store.save(record); return { status: "not_sent", work: this.store.summary(record) };
        }
        const receiptPath = productionReceiptPath(this.store, id, version.runId);
        if (!existsSync(receiptPath)) {
          if (!version.threadId || !version.contextSha256) return { status: "unknown", message: "原调用缺少可靠身份或输入记录，未重新制作。", work: this.store.summary(record) };
          const original = observed ?? await this.inspectOriginal(version.threadId, version.turnId, dirname(this.store.resolvePath(version.sourcePath)), version.runId);
          if (original.turn.status === "inProgress") return { status: "running", work: this.store.summary(record) };
          version.nativeResult = { threadId: version.threadId, turnId: original.turn.id, status: original.turn.status, reply: original.reply,
            ...(original.turn.error ? { error: original.turn.error.message } : {}) };
          version.turnId = original.turn.id;
          // 原终态与文件身份分开记录；当前文件不能补造当时未保存的源码证据。
          version.production = "unknown";
          version.error = "已核回原执行终态，但缺少当时的工程回执；保留原结果与文件，须进一步核对。";
          record.execution = { status: "unknown", runId: version.runId, versionId: version.id, error: version.error };
          this.store.save(record);
          return { status: "needs_verification", work: this.store.summary(record) };
        }
        const historicalReady = version.production === "ready";
        await this.assets.recoverProduction(record, version);
        // 身份或工程依据尚未核实时，保留原状态和重发保护，不按明确制作失败收尾。
        const receipt = readProductionReceipt(this.store, record, version);
        try {
          if (this.applyProductionReceipt(record, version, receipt)) {
            if (render) await this.render(record, version);
            else { record.execution = { status: "idle" }; this.store.save(record); }
          }
          this.saveLearningResult(record, version, receipt);
          if (render) await this.finishInternalReview(record, version);
          return { status: "recovered", operationId, work: this.store.summary(record) };
        } catch (error) {
          if (record.versions.at(-1)?.id !== version.id) throw error;
          version.error = describeError(error);
          version.production = historicalReady ? "ready" : "failed";
          if (record.execution.status !== "unknown") record.execution = { status: "failed", runId: version.runId, versionId: version.id, error: version.error };
          this.store.save(record); throw error;
        }
      }, true);
    });
  }

  private async inspectOriginal(threadId: string, turnId: string | undefined, cwd: string, runId: string) {
    checkExecution(this.options.signal);
    const client = new CodexAppServerClient({ cwd, executable: this.options.codexExecutable,
      timeoutMs: this.options.timeoutMs ?? configuration.runtime.requestTimeoutMs });
    if (client.pid) this.options.onRunner?.(client.pid);
    try { await client.initializeConnection(); return await client.readOriginalTurn(threadId, turnId, cwd, runId); }
    finally { await client.close(); }
  }

  private async recoverLearning(record: WorkRecord, known?: Awaited<ReturnType<CodexAppServerClient["readOriginalTurn"]>>) {
    const run = record.learningRun!;
    if (run.sendState === "not_sent") {
      run.completed = true; record.execution = run.previousExecution;
      record.learningError = "原整理未发送，待处理来源已保留。"; this.store.save(record);
      return { status: "not_sent", work: this.store.summary(record) };
    }
    const directory = this.store.resolvePath("works/" + record.id + "/learning/" + run.id), receiptPath = join(directory, "result.json");
    if (!existsSync(receiptPath)) {
      if (!run.threadId) throw new UnknownExecutionOutcome("原整理缺少线程身份。");
      const observed = known ?? await this.inspectOriginal(run.threadId, run.turnId, directory, run.id);
      if (observed.turn.status === "inProgress") return { status: "running", work: this.store.summary(record) };
      if (observed.turn.status !== "completed") {
        run.completed = true; record.execution = run.previousExecution;
        record.learningError = observed.turn.error?.message ?? "原整理已失败或停止，未推进整理进度。";
        this.store.save(record); return { status: "failed", work: this.store.summary(record) };
      }
      run.turnId = observed.turn.id;
      immutableJson(receiptPath, { threadId: run.threadId, turnId: run.turnId, reply: observed.reply, contextSha256: run.contextSha256 });
    }
    const receipt = this.readLearningReceipt(record);
    try { this.applyLearningReply(record, receipt.reply); }
    catch (error) {
      // 只读原调用的身份与终态已核对；内容无效或保存失败属于明确失败，待办仍保留。
      run.completed = true; record.execution = run.previousExecution; record.learningError = describeError(error);
      this.store.save(record); throw error;
    }
    return { status: "recovered", work: this.store.summary(record) };
  }

  private readLearningReceipt(record: WorkRecord) {
    const run = record.learningRun!;
    const directory = this.store.resolvePath("works/" + record.id + "/learning/" + run.id);
    const receipt = z.object({ threadId: z.string(), turnId: z.string(), reply: z.string(), contextSha256: z.string() }).parse(readJson(join(directory, "result.json")));
    if (receipt.threadId !== run.threadId || (run.turnId && receipt.turnId !== run.turnId) || receipt.contextSha256 !== run.contextSha256 ||
        fileHash(join(directory, "context.json")) !== run.contextSha256) throw new UnknownExecutionOutcome("整理结果与原调用或输入不一致。");
    return receipt;
  }

  private async render(record: WorkRecord, version: WorkVersion, prepareReview = true): Promise<void> {
    checkExecution(this.options.signal);
    this.options.onProgress?.("正在渲染并核对成片");
    // 修复已交付文件的可用性时，保留历史完成与用户认可。
    if (version.production !== "ready") version.production = "rendering";
    this.store.save(record);
    const result = await (this.options.render ?? renderVersion)(
      this.store.resolvePath(version.sourcePath), this.store.resolvePath(version.mediaPath),
      join(repositoryRoot, ".cache", "render", record.id, version.id),
      { sourceSnapshot: version.sourceSnapshot, expectedVideoSha256: version.videoSha256, signal: this.options.signal },
    );
    const audio = readAudioPlan(this.store, version);
    if (audio?.clips.some(clip => clip.endMs > result.durationSeconds * 1000 + 100)) throw new Error("声音播放安排超出实际成片，须调整工程。");
    if (audio?.clips.some(clip => clip.volume > 0) && result.audioStreams === 0) throw new Error("工程登记了声音但成片没有音轨，须使用 ProjectAudio 并重新制作。");
    version.technicalCheck = result;
    version.sourceSha256 = result.sourceSha256;
    version.videoSha256 = result.videoSha256;
    version.production = "ready";
    version.error = undefined;
    record.execution = version.designRef && prepareReview ? { status: "running", runId: version.runId, versionId: version.id } : { status: "idle" };
    this.store.appendEvent(record.id, version.runId, { kind: "video_ready", versionId: version.id, ...result });
    this.store.save(record);
    if (version.designRef && prepareReview) await (this.options.prepareReview ?? this.reviewMaterials.prepare.bind(this.reviewMaterials))(record, version);
    this.store.save(record);
  }

  private async repairPreviews(record: WorkRecord, version: WorkVersion): Promise<void> {
    this.options.onProgress?.("正在从原视频恢复预览");
    try {
      if (!version.videoSha256) throw new Error("缺少原视频校验值，不能恢复预览。");
      const result = await (this.options.restorePreviews ?? restoreVideoPreviews)(
        this.store.resolvePath(version.mediaPath), version.videoSha256, this.options.signal);
      this.store.verifySource(version);
      version.technicalCheck = { ...version.technicalCheck, ...result };
      if (this.store.previewAvailability(version).status !== "available") throw new Error("预览恢复后仍有不可交付文件。");
      version.error = undefined;
      this.store.appendEvent(record.id, version.runId, { kind: "previews_ready", versionId: version.id, ...result });
    } catch (error) {
      version.error = "预览恢复失败：" + describeError(error);
      record.execution = { status: "failed", runId: version.runId, versionId: version.id, error: version.error };
      this.store.save(record);
      throw new Error(version.error);
    }
    // 修复派生产物只清除此版本的失败，不抹掉其他版本或整理任务的执行状态。
    if (record.execution.versionId === version.id && record.execution.runId === version.runId) record.execution = { status: "idle" };
    this.store.save(record);
  }

  /** 校验已有结果，或从已完成工程恢复丢失产物；不重复调用模型。 */
  async renderExisting(id: string, versionId: string): Promise<WorkRecord> {
    checkExecution(this.options.signal);
    return this.store.withLock(id, async () => {
      const record = this.store.read(id);
      this.assertCanProduce(record, "sample");
      const version = this.store.version(record, versionId);
      if (["unknown", "blocked", "creating"].includes(version.production) ||
          (version.agentResult && version.agentResult.status !== "completed")) {
        throw new Error("尚无已确认完成的源码，不能直接重渲染。");
      }
      this.store.verifySource(version);
      if (version.production === "ready" && this.store.availability(version).status === "available") {
        if (this.store.previewAvailability(version).status !== "available") await this.repairPreviews(record, version);
        return record;
      }
      const historicalReady = version.production === "ready";
      record.execution = { status: "running", runId: version.runId, versionId };
      try { await this.render(record, version, false); }
      catch (error) {
        version.production = historicalReady ? "ready" : "failed";
        version.error = describeError(error);
        if (record.execution.status !== "unknown") record.execution = { status: "failed", runId: version.runId, versionId, error: version.error };
        this.store.save(record);
        try { this.store.appendEvent(id, version.runId, { kind: "render_error", versionId, message: version.error }); }
        catch (logError) { throw new Error(version.error + "；错误记录另有失败：" + describeError(logError)); }
        throw error;
      }
      return record;
    });
  }
}
