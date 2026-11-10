import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { atomicJson, immutableBytes, immutableJson, readJson, valueHash } from "../records/files.ts";
import { operationIdSchema } from "../records/operation-store.ts";
import { AssetStore } from "../records/asset-store.ts";
import { assetSchema } from "../records/media-contracts.ts";
import { DocumentStore } from "../records/document-store.ts";
import type { DocumentRef } from "../records/authoring-contracts.ts";
import type { WorkRecord, WorkStore, WorkVersion } from "../records/work-store.ts";
import { generateImage, synthesizeSpeech, speechSegments, validateVoiceInstruction, ProviderRequestError } from "../media/providers.ts";
import type { ProviderSettings, Fetcher, ProviderResponse } from "../media/providers.ts";
import { processExists } from "./process-state.ts";

export type AssetOptions = { providerSettings?: ProviderSettings; providerFetch?: Fetcher; signal?: AbortSignal };
export type Generation = { kind: "image"; document: DocumentRef; prompt: string; referenceAssetIds: string[]; description: string; background?: "auto" | "opaque" | "transparent" } |
  { kind: "speech"; document: DocumentRef; segmentIds: string[]; speechRate: number; voiceInstruction?: string; description: string };
const requestSchema = z.object({ workId: z.string(), operationId: z.string(), providerRequestId: z.string(),
  document: z.object({ id: z.string(), sha256: z.string() }), kind: z.enum(["image", "speech"]), description: z.string(),
  role: z.enum(["image", "narration"]), extension: z.enum([".png", ".mp3"]),
  parameters: z.record(z.string(), z.unknown()), runtime: z.record(z.string(), z.unknown()),
  parent: z.object({ runId: z.string(), versionId: z.string() }).optional() });
type Request = z.infer<typeof requestSchema>;

export class AssetService {
  readonly store: WorkStore;
  readonly assets: AssetStore;
  readonly options: AssetOptions;
  constructor(store: WorkStore, options: AssetOptions = {}) { this.store = store; this.options = options; this.assets = new AssetStore(store); }

  validate(work: WorkRecord, input: Generation, parent?: WorkVersion) {
    if (parent) {
      if (work.execution.status !== "running" || work.execution.runId !== parent.runId || work.execution.versionId !== parent.id ||
        this.store.lockOwner(work.id)?.pid !== process.pid) throw new Error("内部素材调用不属于当前持锁制作任务。");
      if (!parent.designRef || valueHash(parent.designRef) !== valueHash(input.document)) throw new Error("内部素材须使用本轮已采用设计。");
    } else if (["running", "unknown"].includes(work.execution.status)) throw new Error("原任务结果尚未核清，不能发起新的素材生成。");
    const documents = new DocumentStore(this.store), source = documents.read(work, input.document);
    const settings = this.options.providerSettings ?? configuration.providers;
    if (!settings[input.kind === "image" ? "image" : "speech"]) throw new Error("尚未配置" + (input.kind === "image" ? "GPT 图片 API" : "豆包语音的凭据与已有音色") + "；前置草稿和设计可以继续，未发起付费调用。");
    if (input.kind === "image") {
      if (!input.prompt.trim()) throw new Error("图片描述不能为空。");
      const references = this.assets.select(work, input.referenceAssetIds);
      if (references.some(asset => !asset.mimeType.startsWith("image/"))) throw new Error("图片参考只接受图像素材。");
      return { source, text: undefined, references, voiceInstruction: undefined };
    }
    documents.adopted(work, input.document);
    const voiceInstruction = validateVoiceInstruction(settings.speech!, input.voiceInstruction);
    const segments = speechSegments(source.markdown);
    if (!input.segmentIds.length || new Set(input.segmentIds).size !== input.segmentIds.length) throw new Error("须明确选择非重复的实际台词片段。");
    const selected = input.segmentIds.map(id => {
      const segment = segments.find(item => item.id === id);
      if (!segment) throw new Error("台词片段不存在：" + id); return segment;
    });
    const text = selected.map(item => item.text).join("\n");
    if (text.length > 5000) throw new Error("本次台词超过豆包接口长度，请明确分批范围。");
    return { source, text, references: [], voiceInstruction };
  }

  async generate(workId: string, input: Generation, operationId: string) {
    return this.store.withLock(workId, async () => {
      return this.generateLocked(this.store.read(workId), input, operationId);
    });
  }

  /** 仅由已经持有作品锁的制作工具调用；素材操作不覆盖主制作的运行身份。 */
  async generateInProduction(work: WorkRecord, version: WorkVersion, input: Generation, key: string) {
    this.assertSettled(work, version);
    return this.generateLocked(work, input, "internal-" + valueHash({ runId: version.runId, key }).slice(0, 32), version);
  }

  assertSettled(work: WorkRecord, version: WorkVersion) {
    for (const id of version.assetRequestIds ?? []) {
      const directory = this.store.resolvePath(join("works", work.id, "assets", "requests", id));
      if (existsSync(join(directory, "result.json"))) {
        const saved = z.object({ asset: assetSchema }).parse(readJson(join(directory, "result.json")));
        if (work.assets?.some(asset => asset.id === saved.asset.id)) { this.assets.get(work, saved.asset.id); continue; }
      }
      const state = existsSync(join(directory, "state.json")) ? z.object({ status: z.string() }).parse(readJson(join(directory, "state.json"))).status : "unknown";
      if (state !== "failed") throw new ProviderRequestError("内部素材请求结果尚未核清，不能生成替代品或交付；须恢复原请求。", true);
    }
  }

  private async generateLocked(work: WorkRecord, input: Generation, operationId: string, parent?: WorkVersion) {
      const workId = work.id, validated = this.validate(work, input, parent);
      const settings = this.options.providerSettings ?? configuration.providers;
      const directory = this.store.resolvePath(join("works", workId, "assets", "requests", operationId));
      const requestPath = join(directory, "request.json");
      const previous = existsSync(requestPath) ? requestSchema.parse(readJson(requestPath)) : undefined;
      if (previous && !parent) throw new Error("原素材请求已登记，须恢复原结果，不能重发。");
      const request = requestSchema.parse({ workId, operationId, providerRequestId: randomUUID(), document: input.document,
        ...(parent ? { parent: { runId: parent.runId, versionId: parent.id } } : {}),
        kind: input.kind, description: input.description, role: input.kind === "image" ? "image" : "narration", extension: input.kind === "image" ? ".png" : ".mp3",
        parameters: input.kind === "image" ? { prompt: input.prompt, background: input.background ?? "auto", references: validated.references.map(asset => ({ id: asset.id, sha256: asset.sha256 })) } :
          { text: validated.text, segmentIds: input.segmentIds, speechRate: input.speechRate,
            ...(validated.voiceInstruction ? { voiceInstruction: validated.voiceInstruction } : {}) },
        runtime: input.kind === "image" ? { provider: "openai", model: settings.image!.model } :
          { provider: "doubao", speaker: settings.speech!.speaker, resourceId: settings.speech!.resourceId, model: settings.speech!.model } });
      if (previous) {
        if (valueHash({ ...request, providerRequestId: previous.providerRequestId }) !== valueHash(previous)) throw new Error("同一内部操作编号已有不同请求，不能覆盖。");
        if (!existsSync(join(directory, "result.json"))) throw new ProviderRequestError("原内部请求未完成，不自动重发。", true);
        return this.finish(work, previous, directory);
      }
      immutableJson(requestPath, request);
      atomicJson(join(directory, "state.json"), { status: "running" });
      if (parent) { parent.assetRequestIds ??= []; parent.assetRequestIds.push(operationId); }
      else work.execution = { status: "running", runId: "asset-" + operationId };
      this.store.save(work);
      try {
        const exchange = { capture: (response: ProviderResponse) => immutableJson(join(directory, "provider-response.json"), { response, sha256: valueHash(response) }) };
        const result = input.kind === "image" ? await generateImage(settings.image!, input.prompt,
          validated.references.map(asset => ({ bytes: readFileSync(this.store.resolvePath(asset.path)), mimeType: asset.mimeType, name: basename(asset.path) })), this.options.providerFetch, this.options.signal, exchange, input.background) :
          await synthesizeSpeech(settings.speech!, validated.text!, input.speechRate, this.options.providerFetch, this.options.signal, request.providerRequestId, validated.voiceInstruction, exchange);
        // 外部生成与本机登记分开落盘，保存失败后可核回已有字节，不再付费生成。
        immutableBytes(join(directory, "provider-output.bin"), result.bytes);
        immutableJson(join(directory, "provider-output.json"), { sha256: fileHash(join(directory, "provider-output.bin")), metadata: result.metadata });
        return await this.finish(work, request, directory);
      } catch (error) {
        const uncertain = !(error instanceof ProviderRequestError) || error.uncertain;
        const message = error instanceof ProviderRequestError ? error.message : "素材响应后的本机保存或检查未完成，须恢复原请求。";
        atomicJson(join(directory, "state.json"), { status: uncertain ? "unknown" : "failed", message });
        if (!parent) work.execution = { status: uncertain ? "unknown" : "failed", runId: "asset-" + operationId, error: message };
        this.store.save(work); throw new Error(message);
      }
  }

  private async restoreOutput(request: Request, directory: string) {
    if (existsSync(join(directory, "provider-output.json"))) return;
    const archived = z.object({ response: z.object({ status: z.number().int(), body: z.string() }), sha256: z.string() })
      .parse(readJson(join(directory, "provider-response.json")));
    if (valueHash(archived.response) !== archived.sha256) throw new Error("原供应商响应已改变。");
    const noNetwork: Fetcher = async () => { throw new Error("恢复不能重新发送请求。"); };
    const runtime = request.runtime, parameters = request.parameters, exchange = { saved: archived.response };
    const result = request.kind === "image" ? await generateImage({ apiKey: "", model: z.string().parse(runtime.model), timeoutMs: 1000 },
      z.string().parse(parameters.prompt), [], noNetwork, this.options.signal, exchange, z.enum(["auto", "opaque", "transparent"]).default("auto").parse(parameters.background)) :
      await synthesizeSpeech({ apiKey: "", speaker: z.string().parse(runtime.speaker), resourceId: z.string().parse(runtime.resourceId),
        model: z.string().optional().parse(runtime.model), timeoutMs: 1000 }, z.string().parse(parameters.text), z.number().parse(parameters.speechRate),
        noNetwork, this.options.signal, request.providerRequestId, z.string().optional().parse(parameters.voiceInstruction), exchange);
    immutableBytes(join(directory, "provider-output.bin"), result.bytes);
    immutableJson(join(directory, "provider-output.json"), { sha256: fileHash(join(directory, "provider-output.bin")), metadata: result.metadata });
  }

  async recoverProduction(work: WorkRecord, version: WorkVersion) {
    for (const id of version.assetRequestIds ?? []) {
      const directory = this.store.resolvePath(join("works", work.id, "assets", "requests", id));
      if (existsSync(join(directory, "result.json"))) {
        const saved = z.object({ asset: assetSchema }).parse(readJson(join(directory, "result.json")));
        if (work.assets?.some(asset => asset.id === saved.asset.id)) { this.assets.get(work, saved.asset.id); continue; }
      }
      const request = requestSchema.parse(readJson(join(directory, "request.json")));
      if (request.workId !== work.id || request.parent?.runId !== version.runId || request.parent?.versionId !== version.id) throw new Error("内部素材恢复归属不符。");
      if (existsSync(join(directory, "state.json")) && z.object({ status: z.string() }).parse(readJson(join(directory, "state.json"))).status === "failed") continue;
      if (!existsSync(join(directory, "provider-response.json"))) { this.assertSettled(work, version); return; }
      await this.restoreOutput(request, directory);
      await this.finish(work, request, directory);
    }
    this.assertSettled(work, version);
  }

  private async finish(work: WorkRecord, request: z.infer<typeof requestSchema>, directory: string) {
    const output = z.object({ sha256: z.string(), metadata: z.unknown() }).parse(readJson(join(directory, "provider-output.json")));
    const bytesPath = join(directory, "provider-output.bin");
    if (fileHash(bytesPath) !== output.sha256) throw new Error("原素材输出内容发生变化。");
    const asset = await this.assets.write(work, { bytes: readFileSync(bytesPath), extension: request.extension,
      role: request.role, description: request.description, operationId: request.operationId, origin: String(request.runtime.provider),
      document: request.document, metadata: { request: { ...request, providerRequestId: request.providerRequestId }, response: output.metadata } }, this.options.signal);
    if (request.kind === "speech") {
      const media = z.object({ probe: z.object({ format: z.object({ duration: z.string() }) }) }).parse(readJson(this.store.resolvePath(asset.metadataPath!)));
      const timing = z.object({ words: z.array(z.object({ endMs: z.number() })) }).parse(output.metadata);
      if (timing.words.some(word => word.endMs > Number(media.probe.format.duration) * 1000 + 100)) throw new Error("豆包字词时间超出实际音轨，保留原音轨待核对。");
    }
    const receiptPath = join(directory, "result.json");
    if (!existsSync(receiptPath)) immutableJson(receiptPath, { workId: work.id, operationId: request.operationId, asset });
    const receipt = z.object({ workId: z.string(), operationId: z.string(), asset: assetSchema }).parse(readJson(receiptPath));
    if (receipt.workId !== work.id || receipt.operationId !== request.operationId || receipt.asset.sha256 !== asset.sha256) throw new Error("素材回执归属不符。");
    // 登记与原后台回执分开保存；回执补存失败后仍能沿此身份再次恢复。
    if (!request.parent) work.execution = { status: "idle", runId: "asset-" + request.operationId };
    const result = this.assets.register(work, receipt.asset);
    atomicJson(join(directory, "state.json"), { status: "completed" });
    return result;
  }

  async recover(workId: string) {
    return this.store.withRecoveryGuard(workId, async () => {
      const work = this.store.read(workId), owner = this.store.lockOwner(workId);
      if (owner && processExists(owner.pid)) return { status: "running" as const };
      if (!work.execution.runId?.startsWith("asset-")) throw new Error("缺少原素材请求编号。");
      const operationId = operationIdSchema.parse(work.execution.runId.slice("asset-".length));
      const directory = this.store.resolvePath(join("works", workId, "assets", "requests", operationId));
      const request = requestSchema.parse(readJson(join(directory, "request.json")));
      if (request.workId !== workId || request.operationId !== operationId) throw new Error("原素材请求归属错误。");
      if (!existsSync(join(directory, "provider-output.json")) && work.execution.status === "failed") {
        return { status: "failed" as const, kind: "asset" as const, operationId, message: work.execution.error ?? "原素材请求已明确失败。" };
      }
      if (!existsSync(join(directory, "provider-output.json")) && !existsSync(join(directory, "provider-response.json"))) {
        if (work.execution.status === "failed") return { status: "failed" as const, kind: "asset" as const, operationId, message: work.execution.error ?? "原素材请求已明确失败。" };
        return { status: "unknown" as const, message: work.execution.error ?? "未保存可核对的外部输出；原请求未重发，须核服务端结果。" };
      }
      if (owner) this.store.releaseStaleLock(workId, owner);
      return this.store.withLock(workId, async () => {
        try { await this.restoreOutput(request, directory); }
        catch (error) {
          if (error instanceof ProviderRequestError && error.uncertain) return { status: "unknown" as const, kind: "asset" as const, operationId, message: error.message };
          throw error;
        }
        return { status: "recovered" as const, kind: "asset" as const, operationId, asset: await this.finish(work, request, directory) };
      }, true);
    });
  }
}
