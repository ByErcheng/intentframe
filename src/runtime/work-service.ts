import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { repositoryRoot } from "../config.ts";
import { fileHash, renderVersion } from "../media/render.ts";
import { captureSourceSnapshot } from "../records/source-snapshot.ts";
import { WorkStore } from "../records/work-store.ts";
import type { WorkRecord, WorkVersion } from "../records/work-store.ts";
import { parseProductionResult, productionOutputSchema } from "./production-result.ts";
import {
  CodexAppServerClient, UnknownExecutionOutcome, RpcRequestRejected, codexTurnSchema, describeError,
} from "./codex-client.ts";

type ServiceOptions = { render?: typeof renderVersion; codexExecutable?: string; timeoutMs?: number };

export class WorkService {
  readonly store: WorkStore;
  private options: ServiceOptions;
  constructor(store = new WorkStore(), options: ServiceOptions = {}) { this.store = store; this.options = options; }

  assertCanProduce(record: WorkRecord, kind: "sample" | "complete"): void {
    if (["running", "unknown"].includes(record.execution.status)) {
      throw new Error("已有执行尚未取得明确结果，不能重复发起。");
    }
    if (kind === "complete" && !record.directionApproval) {
      throw new Error("尚无用户对样例方向的明确确认，不能展开完整制作。");
    }
  }

  private appliedFeedback(record: WorkRecord, base?: WorkVersion): string[] {
    const result = new Set<string>(), visited = new Set<string>();
    let current = base;
    while (current) {
      if (visited.has(current.id)) throw new Error("版本基线关系存在循环。");
      visited.add(current.id);
      for (const id of current.appliedFeedbackIds ?? []) result.add(id);
      // 兼容旧记录：入口校验值只会在原生制作明确结束后写入。
      if (!current.agentResult && current.sourceSha256 && current.feedbackId) result.add(current.feedbackId);
      current = current.basedOnVersionId ? this.store.version(record, current.basedOnVersionId) : undefined;
    }
    return [...result];
  }

  async produce(
    id: string, kind: "sample" | "complete", feedbackId?: string,
    threadMode: "fresh" | "resume" = "fresh", baseVersionId?: string, baseReason?: string,
  ): Promise<WorkRecord> {
    return this.store.withLock(id, async () => {
      const record = this.store.read(id);
      this.assertCanProduce(record, kind);
      const feedback = feedbackId ? record.feedback.find(item => item.id === feedbackId) : undefined;
      if (feedbackId && !feedback) throw new Error("反馈标识不存在。");
      const latest = record.versions.filter(v => v.sourceSnapshot || (v.production === "ready" && v.sourceSha256)).at(-1);
      const previous = baseVersionId ? this.store.version(record, baseVersionId) : latest;
      if (baseVersionId && baseVersionId !== latest?.id && !baseReason?.trim()) {
        throw new Error("选择历史基线须提供 baseReason，说明如何处理后续修改。");
      }
      if (previous) this.store.verifySource(previous);
      if (threadMode === "resume" && !previous?.threadId) throw new Error("没有可恢复的原生线程。");
      // 会失败的只读准备先完成，不为缺失需求留下占位目录。
      const brief = readFileSync(this.store.resolvePath(record.briefPath), "utf8");
      const inherited = this.appliedFeedback(record, previous);
      const requested = feedback ? [feedback.id] : record.feedback.filter(item => !inherited.includes(item.id)).map(item => item.id);
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
      };
      const sourceDirectory = dirname(this.store.resolvePath(version.sourcePath));
      const context = [
        "# 本次制作上下文", brief,
        "本次版本：" + versionId + "；类型：" + kind,
        previous ? "修改基线：" + previous.id : "首次样例",
        baseReason ? "基线选择依据：" + baseReason : "延续最新已有工程。",
        "原始反馈（按接收顺序保留；后续明确变更可替代先前要求，未被替代的要求与已完成修改继续有效）：",
        JSON.stringify(record.feedback.map(item => ({ ...item, inheritedInBase: inherited.includes(item.id), requestedThisTurn: requested.includes(item.id) })), null, 2),
        "本次需要处理的反馈编号：" + JSON.stringify(requested),
        "只处理本次选定的反馈，保留基线中仍有效的修改；其他未处理事项继续保留，不得擅自标记完成。",
        record.directionApproval ? "用户已确认方向：" + record.directionApproval.scope : "尚未确认方向，仅允许制作样例。",
      ].join("\n\n");

      let codex: CodexAppServerClient | undefined;
      let phase: "preparing" | "awaiting_result" | "checking_result" | "rendering" = "preparing";
      record.versions.push(version);
      record.execution = { status: "running", runId, versionId };
      // 先登记版本，再准备文件；后续准备失败仍有明确失败记录和下次可用编号。
      this.store.save(record);
      try {
        mkdirSync(sourceDirectory, { recursive: true });
        if (previous) cpSync(dirname(this.store.resolvePath(previous.sourcePath)), sourceDirectory, { recursive: true });
        writeFileSync(join(sourceDirectory, "context.md"), context);
        this.store.appendEvent(id, runId, { kind: "production_started", versionId, basedOnVersionId: previous?.id, feedbackIds: requested });
        codex = new CodexAppServerClient({
          cwd: sourceDirectory, executable: this.options.codexExecutable,
          onEvent: event => this.store.appendEvent(id, runId, event),
          timeoutMs: this.options.timeoutMs ?? 240_000,
        });
        await codex.initializeConnection();
        const response = z.object({ thread: z.object({ id: z.string() }), model: z.string().optional() })
          .parse(await codex.sendRequest(threadMode === "resume" ? "thread/resume" : "thread/start", {
            ...(threadMode === "resume" ? { threadId: previous?.threadId, excludeTurns: true } : {}),
            cwd: sourceDirectory, sandbox: "workspace-write", approvalPolicy: "never",
            developerInstructions: [
              "你承担 intentframe 的项目主 AI，按 context.md 创建或修改本目录的 Remotion 工程。",
              "交付 entry.tsx，使用 React 和 remotion，调用 registerRoot 注册 id 为 Video 的 Composition。",
              "只修改本目录的源码和本地素材；保留 context.md，不引用目录外的工程或素材，不安装依赖、不联网、不读取凭据、不委派其他 Agent。",
              "渲染与任务状态由外层负责。说明性注释使用中文。",
              "最终按指定 JSON 结构返回真实结果：completed 表示本次源码及选定反馈已完成；needs_input 表示缺少必要输入，blockers 写明缺口；failed 表示明确失败。",
              "appliedFeedbackIds 只列本次实际完成的反馈；unresolvedFeedbackIds 列本次未解决项。不因旧源码存在便声称本次完成。",
            ].join("\n"),
          }));
        version.threadId = response.thread.id;
        version.model = response.model;
        this.store.save(record);
        phase = "awaiting_result";
        const started = z.object({ turn: codexTurnSchema }).parse(await codex.sendRequest("turn/start", {
          threadId: version.threadId, outputSchema: productionOutputSchema,
          input: [{ type: "text", text: "阅读 context.md 和已有工程，完成本次制作。保存源码后返回结构化结果；缺少必要信息时明确报告，不用旧结果代替本次完成。" }],
        }));
        version.turnId = started.turn.id;
        this.store.save(record);
        const completed = await codex.waitForTurnCompletion(started.turn.id);
        phase = "checking_result";
        if (completed.status !== "completed") throw new Error(completed.error?.message ?? ("原生执行结束：" + completed.status));
        version.agentReply = codex.finalReply(started.turn.id);
        this.store.save(record);
        version.agentResult = parseProductionResult(version.agentReply, requested);
        if (version.agentResult.status === "needs_input") {
          version.production = "blocked";
          version.error = version.agentResult.blockers.join("\n");
          record.execution = { status: "waiting_input", runId, versionId, error: version.error };
          this.store.save(record);
          return record;
        }
        if (version.agentResult.status === "failed") throw new Error(version.agentResult.summary + "\n" + version.agentResult.blockers.join("\n"));
        if (readFileSync(join(sourceDirectory, "context.md"), "utf8") !== context) throw new Error("主 AI 改写了制作上下文，不能确认本次来源。");
        const entry = this.store.resolvePath(version.sourcePath);
        version.sourceSnapshot = captureSourceSnapshot(entry);
        version.sourceSha256 = fileHash(entry);
        version.appliedFeedbackIds = [...new Set([...inherited, ...version.agentResult.appliedFeedbackIds])];
        version.production = "source_ready";
        this.store.save(record);
        phase = "rendering";
        await this.render(record, version);
      } catch (error) {
        const unknown = error instanceof UnknownExecutionOutcome ||
          (phase === "awaiting_result" && !(error instanceof RpcRequestRejected));
        version.production = unknown ? "unknown" : "failed";
        version.error = describeError(error);
        record.execution = { status: unknown ? "unknown" : "failed", runId, versionId, error: version.error };
        this.store.save(record);
        try { this.store.appendEvent(id, runId, { kind: "execution_error", phase, status: record.execution.status, message: version.error }); }
        catch (logError) { throw new Error(version.error + "；错误记录另有失败：" + describeError(logError)); }
        throw error;
      } finally { await codex?.close(); }
      return record;
    });
  }

  private async render(record: WorkRecord, version: WorkVersion): Promise<void> {
    // 修复已交付文件的可用性时，保留历史完成与用户认可。
    if (version.production !== "ready") version.production = "rendering";
    this.store.save(record);
    const result = await (this.options.render ?? renderVersion)(
      this.store.resolvePath(version.sourcePath), this.store.resolvePath(version.mediaPath),
      join(repositoryRoot, ".cache", "render", record.id, version.id),
      { sourceSnapshot: version.sourceSnapshot, expectedVideoSha256: version.videoSha256 },
    );
    version.technicalCheck = result;
    version.sourceSha256 = result.sourceSha256;
    version.videoSha256 = result.videoSha256;
    version.production = "ready";
    version.error = undefined;
    record.execution = { status: "idle" };
    this.store.appendEvent(record.id, version.runId, { kind: "video_ready", versionId: version.id, ...result });
    this.store.save(record);
  }

  /** 校验已有结果，或从已完成工程恢复丢失产物；不重复调用模型。 */
  async renderExisting(id: string, versionId: string): Promise<WorkRecord> {
    return this.store.withLock(id, async () => {
      const record = this.store.read(id);
      this.assertCanProduce(record, "sample");
      const version = this.store.version(record, versionId);
      if (["unknown", "blocked", "creating"].includes(version.production)) throw new Error("尚无已确认完成的源码，不能直接重渲染。");
      this.store.verifySource(version);
      if (version.production === "ready" && this.store.availability(version).status === "available") return record;
      const historicalReady = version.production === "ready";
      record.execution = { status: "running", runId: version.runId, versionId };
      try { await this.render(record, version); }
      catch (error) {
        version.production = historicalReady ? "ready" : "failed";
        version.error = describeError(error);
        record.execution = { status: "failed", runId: version.runId, versionId, error: version.error };
        this.store.save(record);
        try { this.store.appendEvent(id, version.runId, { kind: "render_error", versionId, message: version.error }); }
        catch (logError) { throw new Error(version.error + "；错误记录另有失败：" + describeError(logError)); }
        throw error;
      }
      return record;
    });
  }
}
