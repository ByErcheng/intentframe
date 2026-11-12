import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration, repositoryRoot } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { immutableBytes, immutableJson, readJson, valueHash } from "../records/files.ts";
import { AssetCatalog, assetSourceSchema, assetSearchSchema } from "../records/asset-catalog.ts";
import type { LibraryRoot } from "../records/asset-catalog.ts";
import { AssetService } from "./asset-service.ts";
import { musicInputSchema, soundEffectInputSchema, voiceIdSchema, voiceInstructionSchema, configuredVoices } from "../media/providers.ts";
import { renderVersion, mediaCommand, mediaBinaries } from "../media/render.ts";
import { downloadAsset, publicAssetUrl } from "../media/download-asset.ts";
import { assetRoleSchema, voiceDeclarationSchema, voiceInfoSchema } from "../records/asset-types.ts";
import { captureSourceSnapshot, sourceFingerprint } from "../records/source-snapshot.ts";
import type { WorkRecord, WorkStore, WorkVersion } from "../records/work-store.ts";
import { NativeToolOutput } from "./codex-client.ts";
import { checkExecution } from "./execution-control.ts";
import { audioPlanInputSchema, readAudioPlan, saveAudioPlan } from "./audio-plan.ts";
import { ModelAnalysisService } from "./model-analysis-service.ts";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), description = z.string().trim().min(1).max(2000);
const schemas = {
  intentframe_media_capabilities: z.object({}),
  intentframe_search_assets: assetSearchSchema,
  intentframe_inspect_asset: z.object({ source: assetSourceSchema, startSeconds: z.number().nonnegative().default(0),
    durationSeconds: z.number().positive().max(15).default(10), prepareAudioPreview: z.boolean().default(false) }),
  intentframe_reuse_asset: z.object({ operationKey: key, source: assetSourceSchema, description, expectedSha256: z.string().optional(),
    voice: voiceDeclarationSchema.optional().describe("仅为缺少身份记录的 narration 素材补充有来源的声明；source 必填，已有身份沿用，不凭目录或文件名推断。") }),
  intentframe_generate_image: z.object({ operationKey: key, prompt: z.string().trim().min(1).max(16000), referenceAssetIds: z.array(z.string()).max(8).default([]), background: z.enum(["auto", "opaque", "transparent"]).default("auto"), description }),
  intentframe_synthesize_speech: z.object({ operationKey: key, segmentIds: z.array(z.string()).min(1).max(100),
    speechRate: z.number().int().min(-50).max(100).default(0), voiceInstruction: voiceInstructionSchema.optional(), voiceId: voiceIdSchema.optional(), description }),
  intentframe_generate_music: musicInputSchema.extend({ operationKey: key, description }),
  intentframe_generate_sound_effect: soundEffectInputSchema.extend({ operationKey: key, description }),
  intentframe_download_asset: z.object({ operationKey: key, url: z.url(), sourcePage: z.url(), usageNotes: description, description,
    role: assetRoleSchema, voice: voiceInfoSchema.optional() }).refine(input => !input.voice || input.role === "narration", "讲话信息仅适用于 narration"),
  intentframe_download_image: z.object({ operationKey: key, url: z.url(), sourcePage: z.url(), usageNotes: description, description }),
  intentframe_set_audio_playback: audioPlanInputSchema.extend({ operationKey: key }),
  intentframe_preview_video: z.object({ frameRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional() }),
};
type Name = keyof typeof schemas;
const descriptions: Record<Name, string> = {
  intentframe_media_capabilities: "核对本轮素材工具、模型配置和素材库；没有凭据时不假装能够生成。",
  intentframe_search_assets: "按关键词、用途分页查本机配置目录与同用途区域已有作品素材；名称和分类只提供候选。",
  intentframe_inspect_asset: "查看实际图片或音频元信息。prepareAudioPreview=true 保存最多15秒试听文件供用户播放；不向模型传音频，听感保持未检查。",
  intentframe_reuse_asset: "把检查过的本机或其他作品素材保存到本作品，并复制进当前工程；保留原件、来源和确切字节。缺少身份的 narration 可附含 source 的 voice 声明，已有身份自动继承。",
  intentframe_generate_image: "按采用设计生成或编辑 GPT 图片，保存原响应及素材并放入当前工程；使用付费额度，未知结果不能换编号重发。",
  intentframe_synthesize_speech: "项目内部按已采用脚本的speech片段生成配音，独立传递voiceInstruction；保留MP3、逐字时间和指令并放入工程。",
  intentframe_generate_music: "按本轮采用设计生成背景音乐，保存请求和原始MP3；需要配置音乐服务，使用API额度，未知结果不重发。",
  intentframe_generate_sound_effect: "按本轮采用设计生成指定时长的音效或环境声，可请求循环；需要配置音效服务，未知结果不重发。",
  intentframe_download_asset: "保存原生搜索找到的公开HTTPS图片、音乐、音效或讲话原声；注明用途、出处和选用说明，不执行下载内容，不试听。",
  intentframe_download_image: "保存通过现成网上搜索工具找到的公开HTTPS图片，保留来源页面和使用说明；下载不表示已认可或已确认许可。",
  intentframe_set_audio_playback: "记录本版实际音轨安排与台词事件，生成工程直接引用的ProjectAudio、playback、cueFrame；缺少真实字词边界时拒绝猜测。",
  intentframe_preview_video: "渲染当前源码的全片或指定帧范围预览，返回实际帧图和本机视频；不创建成片认可，不重生成素材。",
};
const readOnly = new Set<Name>(["intentframe_media_capabilities", "intentframe_search_assets", "intentframe_inspect_asset"]);
export function mediaToolDefinitions(designOnly = false) {
  return (Object.keys(schemas) as Name[]).filter(name => !designOnly || readOnly.has(name))
    .map(name => ({ type: "function" as const, name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) }));
}

/** 复用当前 Agent 的动态工具；写操作排队执行，始终沿用外层制作持有的作品锁。 */
export class ProductionMediaTools {
  readonly catalog: AssetCatalog;
  readonly store: WorkStore;
  readonly work: WorkRecord;
  readonly runId: string;
  readonly assets: AssetService;
  readonly version?: WorkVersion;
  readonly options: { libraries?: LibraryRoot[]; render?: typeof renderVersion; signal?: AbortSignal; download?: typeof downloadAsset;
    visualAnalysis?: ModelAnalysisService };
  private pending: Promise<unknown> = Promise.resolve();
  constructor(store: WorkStore, work: WorkRecord, runId: string, assets: AssetService,
    version?: WorkVersion, options: ProductionMediaTools["options"] = {}) {
    this.store = store; this.work = work; this.runId = runId; this.assets = assets; this.version = version; this.options = options;
    this.catalog = new AssetCatalog(store, options.libraries);
  }
  has(name: string) { return Object.hasOwn(schemas, name); }
  async call(name: string, input: unknown) {
    if (!this.has(name)) throw new Error("未知素材工具。");
    const action = () => this.execute(name as Name, input);
    const result = this.pending.then(action, action);
    this.pending = result.catch(() => undefined);
    return result;
  }
  async settled() { await this.pending; if (this.version) this.assets.assertSettled(this.work, this.version); }
  async drain() { await this.pending; }
  private production() {
    const version = this.version;
    if (!version?.designRef) throw new Error("该工具需要本轮已采用设计。");
    if (this.work.execution.runId !== this.runId || this.work.execution.status !== "running" || this.store.lockOwner(this.work.id)?.pid !== process.pid) throw new Error("工具不属于当前持锁制作。");
    return version;
  }
  private attach(assetId: string) {
    const version = this.production(), asset = this.assets.assets.get(this.work, assetId);
    const copied = this.assets.assets.copyToSource(this.work, [asset.id], dirname(this.store.resolvePath(version.sourcePath)))[0]!;
    version.assets ??= []; if (!version.assets.some(item => item.id === asset.id)) version.assets.push(asset);
    this.store.save(this.work);
    return { ...this.assets.assets.view(this.work, asset.id), source: copied.source, metadataSource: copied.metadataSource };
  }
  private async execute(name: Name, raw: unknown): Promise<unknown> {
    checkExecution(this.options.signal);
    if (!this.version && !readOnly.has(name)) throw new Error("设计阶段只允许查找和检查素材。");
    const parsed = schemas[name].parse(raw), callKey = "operationKey" in parsed ? parsed.operationKey : randomUUID();
    const operationId = "tool-" + valueHash({ runId: this.runId, name, callKey }).slice(0, 32);
    const directory = this.store.resolvePath(join("works", this.work.id, "runs", this.runId, "media-tools", operationId));
    const inputPath = join(directory, "input.json"), signature = { name, input: parsed };
    if (existsSync(inputPath) && valueHash(readJson(inputPath)) !== valueHash(signature)) throw new Error("同一工具操作已有不同输入，不能覆盖。");
    immutableJson(inputPath, signature);
    let output: unknown;
    switch (name) {
      case "intentframe_media_capabilities": output = { libraries: this.catalog.libraries.map(item => ({ id: item.id, role: item.role,
        roleOverrides: item.roleOverrides, usageNotes: item.usageNotes, attributionPaths: item.attributionPaths })),
        imageConfigured: Boolean((this.assets.options.providerSettings ?? configuration.providers).image),
        speechConfigured: Boolean((this.assets.options.providerSettings ?? configuration.providers).speech),
        musicConfigured: Boolean((this.assets.options.providerSettings ?? configuration.providers).music),
        soundEffectConfigured: Boolean((this.assets.options.providerSettings ?? configuration.providers).sound_effect),
        voices: configuredVoices(this.assets.options.providerSettings ?? configuration.providers),
        acquisition: { local: assetRoleSchema.options, download: assetRoleSchema.options,
          generation: ["image", "narration", "music", "sound_effect"], note: "生成须先核对对应配置；已配置不表示已实调成功。获取方式按需要选择，不设固定先后。" },
        webSearch: "使用运行器原生网上搜索；实际可用性受运行器和账号配置控制，不能伪造搜索结果。",
        audioInput: false,
        audioReview: "自动听音已停用；提供音频元信息、逐字时间和用户试听文件，不能声称模型已检查听感。" }; break;
      case "intentframe_search_assets": output = this.catalog.search(schemas.intentframe_search_assets.parse(raw)); break;
      case "intentframe_inspect_asset": {
        const args = schemas.intentframe_inspect_asset.parse(raw), found = this.catalog.resolve(args.source);
        const binaries = mediaBinaries();
        const probe = JSON.parse(await mediaCommand(binaries.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", found.location], 30000, this.options.signal));
        const info = { source: args.source, sha256: found.sha256, mimeType: found.mimeType, usage: found.usage, metadata: found.metadata, probe };
        if (found.mimeType.startsWith("image/")) {
          const target = join(directory, "preview.png");
          await mediaCommand(binaries.ffmpeg, ["-v", "error", "-i", found.location, "-vf", "scale=960:-1", "-frames:v", "1", "-n", target], 30000, this.options.signal);
          if (fileHash(found.location) !== found.sha256) throw new Error("检查期间素材发生变化。");
          if (this.options.visualAnalysis) {
            const analysis = await this.options.visualAnalysis.run(this.work, this.runId, "visual_understanding",
              { material: info, question: "描述素材实际内容与使用限制，供素材选择者判断。" }, [target]);
            output = { ...info, imageLocation: target, visualAnalysis: analysis };
          } else output = new NativeToolOutput([{ type: "inputText", text: JSON.stringify({ ...info, imageLocation: target }) },
            { type: "inputImage", imageUrl: "data:image/png;base64," + readFileSync(target).toString("base64") }]);
        } else if (args.prepareAudioPreview) {
          const target = join(directory, "audition.wav"), duration = Number(probe.format?.duration);
          if (!Number.isFinite(duration) || args.startSeconds >= duration) throw new Error("试听起点超出实际音轨。");
          await mediaCommand(binaries.ffmpeg, ["-v", "error", "-ss", String(args.startSeconds), "-i", found.location, "-t", String(args.durationSeconds),
            "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-n", target], 30000, this.options.signal);
          if (fileHash(found.location) !== found.sha256) throw new Error("试听期间素材发生变化。");
          output = { ...info, audioLocation: target,
            startSeconds: args.startSeconds, endSeconds: Math.min(duration, args.startSeconds + args.durationSeconds),
            listeningStatus: "not_checked", note: "试听文件已保存供用户播放；未进行模型听音。" };
        } else output = { ...info, listeningStatus: "not_checked" };
        break;
      }
      case "intentframe_reuse_asset": {
        this.production(); const args = schemas.intentframe_reuse_asset.parse(raw);
        const asset = await this.catalog.reuseOwned(this.work, args.source, operationId, args.description, args.expectedSha256, this.options.signal, args.voice);
        output = this.attach(asset.id); break;
      }
      case "intentframe_generate_image": {
        const version = this.production(), args = schemas.intentframe_generate_image.parse(raw);
        const asset = await this.assets.generateInProduction(this.work, version, { ...args, kind: "image", document: version.designRef! }, args.operationKey);
        output = this.attach(asset.id); break;
      }
      case "intentframe_synthesize_speech": {
        const version = this.production(), args = schemas.intentframe_synthesize_speech.parse(raw);
        const asset = await this.assets.generateInProduction(this.work, version, { ...args, kind: "speech", document: version.designRef! }, args.operationKey);
        output = this.attach(asset.id); break;
      }
      case "intentframe_generate_music": {
        const version = this.production(), args = schemas.intentframe_generate_music.parse(raw);
        const asset = await this.assets.generateInProduction(this.work, version, { ...args, kind: "music", document: version.designRef! }, args.operationKey);
        output = this.attach(asset.id); break;
      }
      case "intentframe_generate_sound_effect": {
        const version = this.production(), args = schemas.intentframe_generate_sound_effect.parse(raw);
        const asset = await this.assets.generateInProduction(this.work, version, { ...args, kind: "sound_effect", document: version.designRef! }, args.operationKey);
        output = this.attach(asset.id); break;
      }
      case "intentframe_download_image":
      case "intentframe_download_asset": {
        this.production();
        const args = name === "intentframe_download_image"
          ? { ...schemas.intentframe_download_image.parse(raw), role: "image" as const, voice: undefined }
          : schemas.intentframe_download_asset.parse(raw);
        publicAssetUrl(args.url); publicAssetUrl(args.sourcePage);
        const saved = this.work.assets?.find(item => item.operationId === operationId);
        if (saved) { output = this.attach(saved.id); break; }
        const bytesPath = join(directory, "download.bin"), metadataPath = join(directory, "download.json");
        const metadataSchema = z.object({ finalUrl: z.string(), extension: z.string(), mimeType: z.string(), sha256: z.string() });
        let downloaded: Awaited<ReturnType<typeof downloadAsset>>;
        if (existsSync(bytesPath) || existsSync(metadataPath)) {
          if (!existsSync(bytesPath) || !existsSync(metadataPath)) throw new Error("原下载保存未完整结束；保留原文件，不自动重新下载。");
          const metadata = metadataSchema.parse(readJson(metadataPath));
          if (fileHash(bytesPath) !== metadata.sha256) throw new Error("原下载内容已改变，不能继续登记。");
          downloaded = { ...metadata, bytes: readFileSync(bytesPath) };
        } else {
          downloaded = await (this.options.download ?? downloadAsset)(args.url, args.role, this.options.signal);
          immutableBytes(bytesPath, downloaded.bytes);
          immutableJson(metadataPath, { finalUrl: downloaded.finalUrl, extension: downloaded.extension, mimeType: downloaded.mimeType, sha256: fileHash(bytesPath) });
        }
        const asset = await this.assets.assets.write(this.work, { bytes: downloaded.bytes, extension: downloaded.extension, role: args.role, voice: args.voice,
          operationId, description: args.description,
          origin: args.sourcePage, metadata: { url: args.url, finalUrl: downloaded.finalUrl, sourcePage: args.sourcePage, usageNotes: args.usageNotes } }, this.options.signal);
        this.assets.assets.register(this.work, asset); output = this.attach(asset.id); break;
      }
      case "intentframe_set_audio_playback": output = saveAudioPlan(this.store, this.work, this.production(), schemas.intentframe_set_audio_playback.parse(raw)); break;
      case "intentframe_preview_video": {
        const version = this.production(), args = schemas.intentframe_preview_video.parse(raw), entry = this.store.resolvePath(version.sourcePath);
        await this.assets.assertSettled(this.work, version); readAudioPlan(this.store, version);
        const snapshot = captureSourceSnapshot(entry), video = join(directory, "preview.mp4");
        const cache = join(repositoryRoot, ".cache", "production-previews", this.work.id, this.runId, operationId);
        const checked = await (this.options.render ?? renderVersion)(entry, video, cache, { sourceSnapshot: snapshot, frameRange: args.frameRange, signal: this.options.signal });
        const result = { video, sourceFingerprint: sourceFingerprint(snapshot), frameRange: args.frameRange, check: checked, previewOnly: true };
        immutableJson(join(directory, "preview.json"), result);
        const images = checked.previews.slice(0, 3);
        const visualAnalysis = this.options.visualAnalysis ? await this.options.visualAnalysis.run(this.work, this.runId,
          "visual_understanding", { ...result, question: "描述本轮局部预览中的实际内容、遮挡与动作线索，列出未覆盖范围。" }, images) : undefined;
        output = new NativeToolOutput([{ type: "inputText", text: JSON.stringify({ ...result, visualAnalysis }) }, ...images.map(path => ({ type: "inputImage" as const, imageUrl: "data:image/png;base64," + readFileSync(path).toString("base64") }))]);
        break;
      }
    }
    // 媒体已保存到本机；回执仅保存文字索引，避免把整段base64重复写入日志。
    immutableJson(join(directory, "result.json"), output instanceof NativeToolOutput ? { content: output.contentItems.filter(item => item.type === "inputText") } : output);
    return output;
  }
}
