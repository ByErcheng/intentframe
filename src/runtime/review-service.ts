import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { immutableJson, readJson, valueHash } from "../records/files.ts";
import { DocumentStore } from "../records/document-store.ts";
import type { ReviewInspection } from "../records/media-contracts.ts";
import { internalQualitySchema, internalReviewPassed } from "../records/media-contracts.ts";
import type { WorkRecord, WorkStore, WorkVersion } from "../records/work-store.ts";
import { prepareReviewBatch, readReviewBatch, reviewRangeSchema } from "../media/review-materials.ts";
import type { ReviewRange } from "../media/review-materials.ts";
import { CodexAppServerClient, codexTurnSchema, describeError, executionFailureStatus } from "./codex-client.ts";
import { audioPlanSummary } from "./audio-plan.ts";
import type { AuthoringOptions } from "./authoring-service.ts";
import { readPrompt } from "./prompts.ts";
import { processExists } from "./process-state.ts";

const resultSchema = z.object({ sufficient: z.boolean(), notes: z.string().trim().min(1).max(5000),
  additionalRanges: z.array(reviewRangeSchema).max(6), limitations: z.array(z.string().max(2000)).max(20),
  quality: internalQualitySchema });

/** 项目从实际媒体内检；修复由制作服务执行，外部审查与用户认可另存。 */
export class ReviewService {
  readonly store: WorkStore;
  readonly options: AuthoringOptions;
  constructor(store: WorkStore, options: AuthoringOptions = {}) { this.store = store; this.options = options; }

  view(record: WorkRecord, version: WorkVersion) {
    this.store.assertAvailable(version);
    if (!version.videoSha256) throw new Error("版本没有可核对视频。");
    const material = version.reviewPreparation;
    return { status: material?.status ?? "not_prepared", readyForExternalReview: internalReviewPassed(material),
      video: this.store.resolvePath(version.mediaPath),
      videoSha256: version.videoSha256, designRef: version.designRef,
      audioTimeline: audioPlanSummary(this.store, version), audioInspection: "manual",
      design: version.designRef ? new DocumentStore(this.store).read(record, version.designRef) : undefined,
      batches: (material?.batches ?? []).map(ref => {
        const path = this.store.resolvePath(ref.path);
        if (fileHash(path) !== ref.sha256) throw new Error("抽帧索引已变化。");
        const batch = readReviewBatch(dirname(path), version.videoSha256!);
        return { ...batch, indexRef: ref.path, indexLocation: path, frames: batch.frames.map(item => ({ ...item, location: join(dirname(path), item.path) })),
          sheets: batch.sheets.map(item => ({ ...item, location: join(dirname(path), item.path) })),
          audio: batch.audio ? { ...batch.audio, location: join(dirname(path), batch.audio.path) } : undefined };
      }), inspections: material?.inspections, error: material?.error,
      review: version.review, note: "内检通过只表示在已声明范围内未发现待修问题；外部 AI 仍须独立审查，用户认可另存。" };
  }

  async prepare(record: WorkRecord, version: WorkVersion, requested?: ReviewRange[], forceInspection = false) {
    this.store.assertAvailable(version);
    version.reviewPreparation ??= { status: "preparing", batches: [], inspections: [], operationId: version.operationId };
    const preparation = version.reviewPreparation;
    try {
    const unfinished = preparation.inspections.find(item => ["preparing", "running", "unknown"].includes(item.status));
    if (unfinished) {
      await this.inspect(record, version, unfinished);
      if (unfinished.result?.sufficient && unfinished.result.quality && !requested?.length && !forceInspection) {
        preparation.status = "available"; preparation.error = undefined;
        this.store.save(record); return this.view(record, version);
      }
    }
    if (requested?.length) await this.batch(record, version, requested);
    if (!preparation.batches.length) await this.batch(record, version, []);
    if (!forceInspection && !requested?.length && preparation.status === "available" && preparation.inspections.at(-1)?.result?.quality) return this.view(record, version);
    preparation.status = "preparing"; preparation.error = undefined; this.store.save(record);
      // 每次准备最多两轮检查；材料不足不能进入可交付状态。
      for (let attempt = 0; attempt < 2; attempt++) {
        const last = preparation.inspections.at(-1);
        if (last?.status === "completed" && last.result?.additionalRanges.length && !requested?.length) {
          await this.batch(record, version, last.result.additionalRanges);
        }
        const run = await this.newInspection(record, version);
        await this.inspect(record, version, run);
        if (run.result?.sufficient) { preparation.status = "available"; this.store.save(record); return this.view(record, version); }
        if (!run.result?.additionalRanges.length) break;
        requested = undefined;
      }
      const last = preparation.inspections.at(-1);
      if (last?.result?.additionalRanges.length) await this.batch(record, version, last.result.additionalRanges);
      preparation.status = "needs_attention";
      preparation.error = "补充材料已保存；达到本次自动核对轮数，材料仍不足，尚不能交付。";
      this.store.save(record); return this.view(record, version);
    } catch (error) {
      preparation.status = preparation.inspections.at(-1)?.status === "unknown" ? "unknown" : "failed";
      preparation.error = describeError(error);
      record.execution = { status: preparation.status, runId: version.runId, versionId: version.id, error: preparation.error };
      this.store.save(record); throw error;
    }
  }

  private async batch(record: WorkRecord, version: WorkVersion, ranges: ReviewRange[]) {
    for (const ref of version.reviewPreparation!.batches) {
      const saved = readReviewBatch(dirname(this.store.resolvePath(ref.path)), version.videoSha256!);
      if (valueHash(saved.ranges) === valueHash(ranges)) return;
    }
    const preparation = version.reviewPreparation!, id = "r" + String(preparation.batches.length + 1).padStart(3, "0");
    const path = join(dirname(version.mediaPath), "review", id, "index.json");
    this.options.onProgress?.("项目正在生成并保存视频审查材料");
    await prepareReviewBatch(this.store.resolvePath(version.mediaPath), version.videoSha256!, dirname(this.store.resolvePath(path)), ranges, this.options.signal);
    preparation.requiresAudioCheck = false;
    preparation.batches.push({ path, sha256: fileHash(this.store.resolvePath(path)) }); this.store.save(record);
  }

  private async newInspection(record: WorkRecord, version: WorkVersion) {
    const id = "inspection-" + randomUUID(), inputPath = join("works", record.id, "runs", id, "input.json");
    const directory = dirname(this.store.resolvePath(inputPath)); mkdirSync(directory, { recursive: true });
    const view = this.view(record, version), prompt = readPrompt("review-materials");
    const allSheets = view.batches.flatMap(batch => batch.sheets.map(item => item.location));
    // 请求必须说明实际传入哪几张图；长片不能把未读材料称为已看。
    const images = allSheets.length <= 12 ? allSheets : Array.from({ length: 12 }, (_, index) => allSheets[Math.round(index * (allSheets.length - 1) / 11)]!);
    immutableJson(this.store.resolvePath(inputPath), { runId: id, versionId: version.id, videoSha256: version.videoSha256, design: view.design,
      internalRepair: version.internalRepair,
      externalReview: version.review,
      feedback: record.feedback.filter(item => item.versionId === version.id || version.feedbackIds?.includes(item.id)).slice(-10),
      previousInternalReview: version.internalRepair?.inspectionId ? record.versions.flatMap(item => item.reviewPreparation?.inspections ?? [])
        .find(item => item.id === version.internalRepair!.inspectionId)?.result : undefined,
      batches: view.batches, audioTimeline: view.audioTimeline, audioInspection: view.audioInspection,
      images, omittedSheetCount: allSheets.length - images.length, prompt, outputSchema: z.toJSONSchema(resultSchema) });
    const run: ReviewInspection = { id, inputPath, inputSha256: fileHash(this.store.resolvePath(inputPath)),
      operationId: version.reviewPreparation!.operationId, sendState: "not_sent", status: "preparing" };
    version.reviewPreparation!.inspections.push(run); this.store.save(record); return run;
  }

  private async inspect(record: WorkRecord, version: WorkVersion, run: ReviewInspection) {
    const directory = dirname(this.store.resolvePath(run.inputPath)), receiptPath = join(directory, "result.json");
    if (fileHash(this.store.resolvePath(run.inputPath)) !== run.inputSha256) throw new Error("材料核对输入已变化。");
    const input = z.object({ videoSha256: z.string(), images: z.array(z.string()), prompt: z.object({ text: z.string() }), outputSchema: z.unknown() }).parse(readJson(this.store.resolvePath(run.inputPath)));
    if (input.videoSha256 !== version.videoSha256) throw new Error("核对输入属于不同视频版本。");
    let client: CodexAppServerClient | undefined;
    let phase: "preparing" | "awaiting_result" | "checking_result" = run.sendState === "not_sent" ? "preparing" : "awaiting_result";
    try {
      if (!existsSync(receiptPath)) {
        if (run.runnerPid && ["running", "unknown"].includes(run.status) && processExists(run.runnerPid, process.platform !== "win32")) throw new Error("原材料核对运行器仍在运行，请查询原执行。");
        client = new CodexAppServerClient({ cwd: directory, executable: this.options.codexExecutable, timeoutMs: this.options.timeoutMs,
          turnTimeoutMs: this.options.timeoutMs ?? configuration.runtime.productionTimeoutMs, signal: this.options.signal,
          onEvent: event => this.store.appendEvent(record.id, run.id, event) });
        run.runnerPid = client.pid; version.runnerPid = client.pid;
        if (client.pid) this.options.onRunner?.(client.pid); this.store.save(record);
        await client.initializeConnection();
        let reply: string;
        if (run.sendState !== "not_sent") {
          if (!run.threadId) throw new Error("原材料核对缺少线程，不能重新发送。");
          phase = "awaiting_result";
          const original = await client.readOriginalTurn(run.threadId, run.turnId, directory, run.id);
          if (original.turn.status === "inProgress") throw new Error("原材料核对尚未结束。");
          phase = "checking_result";
          if (original.turn.status !== "completed") throw new Error("原材料核对失败，未重发。");
          run.turnId = original.turn.id; reply = original.reply;
        } else {
          this.options.onProgress?.("项目 AI 正在回看实际画面，检查缺陷与材料覆盖");
          const response = z.object({ thread: z.object({ id: z.string() }), model: z.string().optional() }).parse(await client.sendRequest("thread/start", {
            cwd: directory, sandbox: "read-only", approvalPolicy: "never", developerInstructions: input.prompt.text,
          }));
          run.threadId = response.thread.id; run.model = response.model; run.sendState = "sending"; run.status = "running"; this.store.save(record); phase = "awaiting_result";
          const started = z.object({ turn: codexTurnSchema }).parse(await client.sendRequest("turn/start", {
            threadId: run.threadId, outputSchema: input.outputSchema,
            input: [{ type: "text", text: "本次执行编号：" + run.id + "\n读取 input.json，查看实际附图，对照采用脚本检查画面与动作；报告可修缺陷、设计歧义和确有需要的补帧范围。" },
              ...input.images.map(path => ({ type: "localImage", path }))],
          }));
          run.turnId = started.turn.id; run.sendState = "acknowledged"; this.store.save(record);
          const completed = await client.waitForTurnCompletion(run.turnId, run.threadId);
          if (completed.status === "inProgress") throw new Error("材料核对尚未完成。");
          phase = "checking_result";
          if (completed.status !== "completed") throw new Error("材料核对失败：" + (completed.error?.message ?? completed.status));
          reply = client.finalReply(run.turnId);
        }
        immutableJson(receiptPath, { threadId: run.threadId, turnId: run.turnId, inputSha256: run.inputSha256, reply });
      }
      phase = "checking_result";
      const receipt = z.object({ threadId: z.string(), turnId: z.string(), inputSha256: z.string(), reply: z.string() }).parse(readJson(receiptPath));
      if (receipt.threadId !== run.threadId || receipt.turnId !== run.turnId || receipt.inputSha256 !== run.inputSha256) throw new Error("材料核对回执身份不符。");
      const expectsQuality = Boolean(z.object({ properties: z.record(z.string(), z.unknown()) }).parse(input.outputSchema).properties.quality);
      const result: NonNullable<ReviewInspection["result"]> = (expectsQuality ? resultSchema : resultSchema.omit({ quality: true })).parse(JSON.parse(receipt.reply));
      if (result.sufficient && result.additionalRanges.length) throw new Error("材料覆盖结论与补帧要求矛盾。");
      if (result.quality?.status === "passed" && (!result.sufficient || result.quality.issues.length)) throw new Error("内检通过与材料不足或待修问题矛盾。");
      if (result.quality && ["needs_repair", "needs_confirmation"].includes(result.quality.status) && !result.quality.issues.length) throw new Error("内检未通过须给出明确问题与处理要求。");
      result.sound = { status: "not_checked", notes: "按用户要求不执行自动听音；音频和逐字时间已保留供人工试听与同步核对。", ranges: [] };
      run.result = result; run.status = "completed"; run.error = undefined; this.store.save(record);
    } catch (error) { run.status = executionFailureStatus(error, phase); run.error = describeError(error); this.store.save(record); throw error; }
    finally { await client?.close(); }
  }
}
