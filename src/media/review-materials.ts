import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { configuration } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { immutableBytes, immutableJson, ownedPath, readJson, valueHash } from "../records/files.ts";
import { checkExecution } from "../runtime/execution-control.ts";
import { mediaBinaries, mediaEnvironment, mediaCommand } from "./render.ts";

export const reviewRangeSchema = z.object({ startSeconds: z.number().finite().nonnegative(), endSeconds: z.number().finite().positive(),
  fps: z.number().finite().positive().max(60), reason: z.string().trim().min(1).max(1000) })
  .refine(value => value.endSeconds > value.startSeconds, "补帧区间结束须晚于开始。");
export type ReviewRange = z.infer<typeof reviewRangeSchema>;
const artifactSchema = z.object({ path: z.string(), sha256: z.string() });
export const reviewBatchSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), videoSha256: z.string(), planHash: z.string(),
  fps: z.number(), frameCount: z.number(), durationSeconds: z.number(), width: z.number(), height: z.number(),
  frames: z.array(artifactSchema.extend({ frame: z.number().int(), seconds: z.number(), reason: z.string() })),
  sheets: z.array(artifactSchema), audio: artifactSchema.optional(),
  temporalAnalysis: artifactSchema.extend({ method: z.literal("adjacent-sampled-rgb-v1"), framePairs: z.number().int().nonnegative(),
    sampledPixelStride: z.literal(16), maxMeanDifference: z.number().nonnegative().max(1) }).optional(),
  ranges: z.array(reviewRangeSchema), frameLimitReached: z.boolean(), limitations: z.array(z.string()), createdAt: z.string(),
});
export type ReviewBatch = z.infer<typeof reviewBatchSchema>;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function pngChunk(name: string, bytes: Buffer) {
  const body = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
  for (const byte of body) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  const length = Buffer.alloc(4), check = Buffer.alloc(4); length.writeUInt32BE(bytes.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, check]);
}
/** 用标准 PNG 编码保存解码得到的像素，不重新绘制视频画面。 */
export function rgbPng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("图片像素长度不符。");
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}
const digits: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"], ".": ["000", "000", "000", "000", "010"],
};
function contactSheet(width: number, height: number, items: { pixels: Buffer; frame: number }[], fps: number) {
  const columns = 3, label = 24, scale = 2, imageWidth = Math.floor(width / scale), tileHeight = Math.floor(height / scale);
  // 小尺寸画面仍需容纳完整时间标签，不能让标签写入相邻格或越过像素缓冲区。
  const tileWidth = Math.max(imageWidth, ...items.map(item => 12 + (item.frame / fps).toFixed(2).length * 12));
  const sheetWidth = tileWidth * columns, sheetHeight = Math.ceil(items.length / columns) * (tileHeight + label);
  const pixels = Buffer.alloc(sheetWidth * sheetHeight * 3, 255);
  items.forEach((item, index) => {
    const x = index % columns * tileWidth, y = Math.floor(index / columns) * (tileHeight + label);
    for (let row = 0; row < tileHeight; row++) for (let column = 0; column < imageWidth; column++) {
      const source = (row * scale * width + column * scale) * 3, target = ((y + label + row) * sheetWidth + x + column) * 3;
      item.pixels.copy(pixels, target, source, source + 3);
    }
    [...(item.frame / fps).toFixed(2)].forEach((digit, i) => digits[digit]?.forEach((line, row) => [...line].forEach((bit, column) => {
      if (bit === "1") for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        const offset = ((y + 3 + row * 3 + dy) * sheetWidth + x + 6 + i * 12 + column * 3 + dx) * 3;
        pixels.fill(30, offset, offset + 3);
      }
    })));
  });
  return rgbPng(sheetWidth, sheetHeight, pixels);
}

export function readReviewBatch(directory: string, expectedHash: string): ReviewBatch {
  const batch = reviewBatchSchema.parse(readJson(ownedPath(directory, "index.json")));
  if (batch.videoSha256 !== expectedHash) throw new Error("审查材料不属于当前视频。");
  for (const item of [...batch.frames, ...batch.sheets, ...(batch.audio ? [batch.audio] : []), ...(batch.temporalAnalysis ? [batch.temporalAnalysis] : [])]) {
    if (fileHash(ownedPath(directory, item.path)) !== item.sha256) throw new Error("审查文件已变化或缺失：" + item.path);
  }
  return batch;
}

/** 所有材料写入明确版本的永久目录；按时序与实际像素变化补充采样，不代表语义审查通过。 */
export async function prepareReviewBatch(video: string, expectedHash: string, directory: string,
  ranges: ReviewRange[] = [], signal?: AbortSignal, frameLimit = 240): Promise<ReviewBatch> {
  if (fileHash(video) !== expectedHash) throw new Error("原视频已变化，不能准备审查材料。");
  ranges = z.array(reviewRangeSchema).max(12).parse(ranges);
  const planHash = valueHash({ ranges, frameLimit, algorithm: "temporal-motion-v3-scoped-rate-grid" });
  if (existsSync(ownedPath(directory, "index.json"))) {
    const previous = readReviewBatch(directory, expectedHash);
    if (previous.planHash !== planHash) throw new Error("本批抽帧参数已固定，补充材料须使用新批次。");
    return previous;
  }
  const probe = z.object({ streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional(),
    avg_frame_rate: z.string().optional(), nb_read_frames: z.string().optional() })), format: z.object({ duration: z.string() }) });
  const metadata = probe.parse(JSON.parse(await mediaCommand(mediaBinaries().ffprobe,
    ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", video], configuration.media.probeTimeoutMs, signal)));
  const stream = metadata.streams.find(item => item.codec_type === "video"), duration = Number(metadata.format.duration);
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number), fps = numerator! / denominator!, frameCount = Number(stream?.nb_read_frames);
  if (!stream?.width || !stream.height || !Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(frameCount) || frameCount < 1 || !Number.isFinite(duration) || duration <= 0) throw new Error("无法取得可靠的实际帧率、帧数和时长。");
  if (ranges.some(range => range.endSeconds > duration + 1 / fps)) throw new Error("补帧范围超过实际成片时长。");
  const factor = Math.min(1, 640 / Math.max(stream.width, stream.height));
  const width = Math.max(2, Math.round(stream.width * factor)), height = Math.max(2, Math.round(stream.height * factor));
  const required = new Set<number>();
  if (!ranges.length) {
    required.add(0); required.add(frameCount - 1);
    const stride = Math.max(1, Math.ceil(fps / 2), Math.ceil(frameCount / Math.min(160, frameLimit / 2)));
    for (let frame = 0; frame < frameCount; frame += stride) required.add(frame);
  } else for (const range of ranges) {
    // 指定范围已有自己的端点；额外加入全片首尾会挤占约定预算并引入范围外材料。
    const first = Math.max(0, Math.ceil(range.startSeconds * fps - 1e-8));
    const last = Math.min(frameCount - 1, Math.floor(range.endSeconds * fps + 1e-8));
    if (first > last) throw new Error("补帧区间未包含实际视频帧，请扩展至至少一帧。");
    // 保留非整数步长，避免30fps视频的8fps请求因步长向下取整而被抽成10fps。
    const step = Math.max(1, fps / range.fps);
    for (let sample = 0; first + sample * step <= last + 1e-8; sample++) required.add(Math.min(last, Math.round(first + sample * step)));
    required.add(last);
  }
  if (required.size > frameLimit) throw new Error("请求的补帧数量超过单批上限，请缩小范围或拆分批次。");
  mkdirSync(directory, { recursive: true });
  const selected: { frame: number; reason: string; pixels: Buffer }[] = [];
  let reached = false, previous: Buffer | undefined, count = 0, lastAdaptive = -Infinity;
  const changes: { frame: number; seconds: number; meanDifference: number }[] = [];
  await new Promise<void>((resolve, reject) => {
    checkExecution(signal);
    const child = spawn(mediaBinaries().ffmpeg, ["-v", "error", "-i", video, "-vf", `scale=${width}:${height}`, "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "image2pipe", "pipe:1"],
      { env: mediaEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let buffer = Buffer.alloc(0), failure: unknown, errors = "", force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: unknown) => { if (failure) return; failure = error; child.kill("SIGTERM"); force = setTimeout(() => child.kill("SIGKILL"), configuration.runtime.stopTimeoutMs); };
    const timer = setTimeout(() => stop(new Error("审查抽帧达到等待上限。")), configuration.media.renderTimeoutMs);
    const abort = () => stop(signal?.reason ?? new Error("抽帧已停止。")); signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-2000); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]); const bytes = width * height * 3;
      while (buffer.length >= bytes) {
        const current = buffer.subarray(0, bytes); let change = 0, rgbChange = 0, samples = 0;
        if (previous) {
          for (let i = 0; i < bytes; i += 48) {
            const redDifference = Math.abs(current[i]! - previous[i]!);
            change += redDifference;
            rgbChange += redDifference + Math.abs(current[i + 1]! - previous[i + 1]!) + Math.abs(current[i + 2]! - previous[i + 2]!);
            samples++;
          }
          changes.push({ frame: count, seconds: count / fps, meanDifference: Number((rgbChange / (samples * 3 * 255)).toFixed(6)) });
        }
        const adaptive = !ranges.length && change / Math.max(1, samples) / 255 > 0.006 && count - lastAdaptive >= Math.max(1, Math.floor(fps / 10));
        const mandatory = required.has(count);
        // 为尚未经过的均匀采样保留位置，不能用开头的密集动作耗尽整片覆盖。
        const remaining = [...required].filter(frame => frame > count).length;
        if (mandatory || (adaptive && selected.length + remaining < frameLimit)) {
          selected.push({ frame: count, reason: mandatory ? "时间覆盖或指定范围" : "实际画面变化触发加密", pixels: Buffer.from(current) });
          if (adaptive) lastAdaptive = count;
        } else if (adaptive) reached = true;
        previous = Buffer.from(current); count++; buffer = buffer.subarray(bytes);
      }
    });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer); if (force) clearTimeout(force); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure); else if (code !== 0 || buffer.length || count !== frameCount) reject(new Error("视频抽帧未完整解码：" + errors)); else resolve();
    });
    if (signal?.aborted) abort();
  });
  const artifact = (name: string, bytes: Buffer) => {
    const path = ownedPath(directory, name);
    if (existsSync(path)) { if (!readFileSync(path).equals(bytes)) throw new Error("已有检查材料内容不同，不能覆盖。"); }
    else immutableBytes(path, bytes);
    return { path: relative(directory, path), sha256: fileHash(path) };
  };
  const frames = selected.map(item => ({ ...artifact(`frame-${String(item.frame).padStart(6, "0")}.png`, rgbPng(width, height, item.pixels)),
    frame: item.frame, seconds: item.frame / fps, reason: item.reason }));
  const sheets = [];
  for (let index = 0; index < selected.length; index += 12) sheets.push(artifact(`sheet-${String(index / 12 + 1).padStart(3, "0")}.png`, contactSheet(width, height, selected.slice(index, index + 12), fps)));
  let audio;
  if (metadata.streams.some(item => item.codec_type === "audio")) {
    const path = ownedPath(directory, "mixed-audio.wav");
    const temporary = ownedPath(directory, "mixed-audio-" + randomUUID() + ".wav");
    try {
      await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-i", video, "-vn", "-ac", "2", "-ar", "24000", "-c:a", "pcm_s16le", "-n", temporary], configuration.media.decodeTimeoutMs, signal);
      immutableBytes(path, readFileSync(temporary));
    } finally { rmSync(temporary, { force: true }); }
    audio = { path: "mixed-audio.wav", sha256: fileHash(path) };
  }
  if (fileHash(video) !== expectedHash) throw new Error("抽帧期间视频变化，结果未获确认。");
  const temporalAnalysis = { ...artifact("frame-changes.json", Buffer.from(JSON.stringify({ videoSha256: expectedHash,
    method: "adjacent-sampled-rgb-v1", decodedFrames: count, width, height, fps, sampledPixelStride: 16,
    timeBasis: "frame-index / average-frame-rate", changes,
    limitation: "每个相邻解码帧均参与计算，但仅在缩放图像上每16个像素取样；变化量用于定位，不判断动作是否自然或语义是否正确。" }, null, 2) + "\n")),
    method: "adjacent-sampled-rgb-v1" as const, framePairs: changes.length, sampledPixelStride: 16 as const,
    maxMeanDifference: changes.reduce((maximum, item) => Math.max(maximum, item.meanDifference), 0) };
  const result: ReviewBatch = { schemaVersion: 1, id: directory.split(/[\\/]/).at(-1)!, videoSha256: expectedHash, planHash,
    fps, frameCount, durationSeconds: duration, width, height, frames, sheets, audio, temporalAnalysis, ranges, frameLimitReached: reached,
    limitations: ["图片为实际视频抽帧；静帧与拼图不等于连续播放或听音检查。", "相邻帧变化量仅用于采样与定位，不能证明所有语义问题或短暂事件均已覆盖。",
      ...(reached ? ["自动加密达到本批数量上限，仍保留全片时间覆盖；必要时按重点另建补充批次。"] : [])], createdAt: new Date().toISOString() };
  immutableJson(ownedPath(directory, "index.json"), result); return result;
}
