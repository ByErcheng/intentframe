import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { immutableBytes, immutableJson, readJson, valueHash } from "./files.ts";
import { assetSchema, assetIdSchema } from "./media-contracts.ts";
import type { Asset } from "./media-contracts.ts";
import type { DocumentRef } from "./authoring-contracts.ts";
import type { WorkRecord, WorkStore } from "./work-store.ts";
import { mediaBinaries, mediaCommand } from "../media/render.ts";
import { checkExecution } from "../runtime/execution-control.ts";
import { assetMimeTypes, isAudioRole, voiceInfoSchema } from "./asset-types.ts";
import type { VoiceInfo, LibraryUsage } from "./asset-types.ts";
import { currentLibraryUsage } from "./asset-library.ts";

export class AssetStore {
  readonly store: WorkStore;
  constructor(store: WorkStore) { this.store = store; }

  get(record: WorkRecord, id: string): Asset {
    assetIdSchema.parse(id);
    const asset = record.assets?.find(value => value.id === id);
    if (!asset || !asset.path.startsWith(join("works", record.id, "assets", id) + "/") || fileHash(this.store.resolvePath(asset.path)) !== asset.sha256) throw new Error("素材不存在、归属错误或文件已经变化。");
    if (asset.metadataPath && (!asset.metadataSha256 || !asset.metadataPath.startsWith(join("works", record.id, "assets", id) + "/") || fileHash(this.store.resolvePath(asset.metadataPath)) !== asset.metadataSha256)) throw new Error("素材时间或来源记录发生变化。");
    return asset;
  }

  view(record: WorkRecord, id: string) {
    const asset = this.get(record, id);
    return { ...asset, currentLibraryUsage: currentLibraryUsage(asset.origin, configuration.assetLibraries, asset.usage), location: this.store.resolvePath(asset.path),
      metadata: asset.metadataPath ? readJson(this.store.resolvePath(asset.metadataPath)) : undefined };
  }

  select(record: WorkRecord, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new Error("素材编号不能重复。");
    return ids.map(id => this.get(record, id));
  }

  async write(record: WorkRecord, input: { bytes: Buffer; extension: string; role: Asset["role"]; description: string; origin: string;
    operationId: string; document?: DocumentRef; metadata?: unknown; voice?: VoiceInfo; usage?: LibraryUsage }, signal?: AbortSignal): Promise<Asset> {
    checkExecution(signal);
    const voice = input.voice === undefined ? undefined : voiceInfoSchema.parse(input.voice);
    if (voice && input.role !== "narration") throw new Error("说话人和讲话记录仅适用于人声素材。");
    if (!input.bytes.length || input.bytes.length > 128 * 1024 * 1024 || !assetMimeTypes[input.extension]) throw new Error("素材类型或体积不受支持。");
    const isAudio = isAudioRole(input.role);
    if (!assetMimeTypes[input.extension]!.startsWith(isAudio ? "audio/" : "image/")) throw new Error("素材用途与文件类型不符。");
    const id = "asset-" + valueHash({ workId: record.id, operationId: input.operationId }).slice(0, 24);
    const directory = join("works", record.id, "assets", id), path = join(directory, "asset" + input.extension);
    mkdirSync(this.store.resolvePath(directory), { recursive: true });
    const target = this.store.resolvePath(path), sha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (existsSync(target)) { if (fileHash(target) !== sha256) throw new Error("同一素材操作已有不同结果，不能覆盖。"); }
    else immutableBytes(target, input.bytes);
    const probe = JSON.parse(await mediaCommand(mediaBinaries().ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", target], configuration.media.probeTimeoutMs, signal));
    const checked = z.object({ streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(), width: z.number().optional(), height: z.number().optional() })),
      format: z.object({ duration: z.string().optional(), format_name: z.string().optional() }).optional() }).parse(probe);
    if (!checked.streams.some(stream => stream.codec_type === (isAudio ? "audio" : "video"))) throw new Error("素材不含所需的实际音频或图像流。");
    const formats = checked.format?.format_name?.split(",") ?? [];
    const expected = ({ ".png": "png", ".jpg": "mjpeg", ".jpeg": "mjpeg", ".webp": "webp", ".mp3": "mp3", ".wav": "wav", ".m4a": "mov", ".ogg": "ogg", ".flac": "flac" } as Record<string, string>)[input.extension]!;
    if (isAudio ? !formats.includes(expected) : !checked.streams.some(stream => stream.codec_name === expected)) throw new Error("素材实际格式与扩展名不符。");
    if (!isAudio && checked.streams.some(stream => (stream.width ?? 0) * (stream.height ?? 0) > 16_777_216)) throw new Error("图像尺寸超过当前素材检查上限。");
    await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-xerror", "-i", target, "-c:v", "rawvideo", "-c:a", "pcm_s16le", "-f", "null", "-"], configuration.media.decodeTimeoutMs, signal);
    const metadataPath = join(directory, "metadata.json");
    immutableJson(this.store.resolvePath(metadataPath), { source: input.metadata ?? null, probe: checked });
    return assetSchema.parse({ id, path, sha256, bytes: input.bytes.length, mimeType: assetMimeTypes[input.extension], role: input.role,
      description: input.description, origin: input.origin, operationId: input.operationId, document: input.document, voice, usage: input.usage,
      metadataPath, metadataSha256: fileHash(this.store.resolvePath(metadataPath)), createdAt: new Date().toISOString() });
  }

  register(record: WorkRecord, asset: Asset) {
    record.assets ??= [];
    const previous = record.assets.find(item => item.id === asset.id);
    if (previous) {
      if (previous.sha256 !== asset.sha256 || previous.metadataSha256 !== asset.metadataSha256) throw new Error("同一素材的登记内容不一致。");
    } else record.assets.push(asset);
    this.get(record, asset.id); this.store.save(record);
    return this.view(record, asset.id);
  }

  async import(workId: string, sourcePath: string, role: Asset["role"], description: string, operationId: string, document?: DocumentRef, signal?: AbortSignal, voice?: VoiceInfo) {
    checkExecution(signal);
    if (!isAbsolute(sourcePath)) throw new Error("本机素材路径须为明确的绝对路径。");
    return this.store.withLock(workId, async () => {
      checkExecution(signal);
      const extension = extname(sourcePath).toLowerCase();
      if (!assetMimeTypes[extension]) throw new Error("只接收支持的本机图片与音频文件。");
      const descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("素材必须是受支持大小的普通文件。");
        bytes = readFileSync(descriptor);
      } finally { closeSync(descriptor); }
      const record = this.store.read(workId), asset = await this.write(record, { bytes, extension, role, description,
        origin: "local:" + sourcePath, operationId, document, voice,
        usage: currentLibraryUsage("local:" + sourcePath, configuration.assetLibraries) }, signal);
      checkExecution(signal);
      return this.register(record, asset);
    });
  }

  copyToSource(record: WorkRecord, ids: string[], sourceDirectory: string) {
    const assets = this.select(record, ids);
    const directory = join(sourceDirectory, "public", "assets"); mkdirSync(directory, { recursive: true });
    return assets.map(asset => {
      const name = asset.id + extname(asset.path), target = join(directory, name);
      if (existsSync(target)) { if (fileHash(target) !== asset.sha256) throw new Error("工程内同名素材已经变化。"); }
      else copyFileSync(this.store.resolvePath(asset.path), target, constants.COPYFILE_EXCL);
      if (fileHash(target) !== asset.sha256) throw new Error("素材复制后内容不一致。");
      if (asset.metadataPath) {
        const metadata = join(directory, asset.id + "-metadata.json");
        if (!existsSync(metadata)) copyFileSync(this.store.resolvePath(asset.metadataPath), metadata, constants.COPYFILE_EXCL);
        if (fileHash(metadata) !== asset.metadataSha256) throw new Error("素材元数据副本不一致。");
      }
      return { ...asset, currentLibraryUsage: currentLibraryUsage(asset.origin, configuration.assetLibraries, asset.usage),
        source: "assets/" + basename(target), metadataSource: asset.metadataPath ? "assets/" + asset.id + "-metadata.json" : undefined };
    });
  }
}
