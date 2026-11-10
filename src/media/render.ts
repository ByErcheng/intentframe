import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import type { Compiler } from "webpack";
import { z } from "zod";
import { configuration, repositoryRoot } from "../config.ts";
import { captureSourceSnapshot, sourceFingerprint, verifySourceSnapshot } from "../records/source-snapshot.ts";
import { fileHash } from "../common/file-hash.ts";
import type { SourceSnapshot } from "../records/source-snapshot.ts";
import { checkExecution, ExecutionBudgetExceeded } from "../runtime/execution-control.ts";
import { previewFractions, previewPath } from "./previews.ts";
export { fileHash } from "../common/file-hash.ts";

const require = createRequire(import.meta.url);
export function mediaBinaries() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("当前工具安装仅验证了 Apple Silicon Mac。");
  const directory = dirname(require.resolve("@remotion/compositor-darwin-arm64/package.json"));
  return { ffmpeg: join(directory, "ffmpeg"), ffprobe: join(directory, "ffprobe") };
}
export function mediaEnvironment() {
  return { ...process.env, DYLD_LIBRARY_PATH: dirname(mediaBinaries().ffmpeg) };
}
function inside(root: string, path: string) {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep);
}

const receiptSchema = z.object({ sourceFingerprint: z.string(), videoSha256: z.string() });
export type RenderOptions = { sourceSnapshot?: SourceSnapshot; expectedVideoSha256?: string; signal?: AbortSignal };

/** 停止后等实际子进程关闭，避免释放任务占用时媒体工具仍在写文件。 */
function mediaCommand(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  checkExecution(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: mediaEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", stopped: unknown, force: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: unknown) => {
      if (stopped) return;
      stopped = reason; child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), configuration.runtime.stopTimeoutMs);
    };
    const timer = setTimeout(() => stop(new ExecutionBudgetExceeded("媒体检查达到已配置的等待上限。")), timeoutMs);
    const abort = () => stop(signal?.reason ?? new Error("媒体处理已请求停止。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); if (force) clearTimeout(force); signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 8_000_000) stop(new Error("媒体工具返回内容超出本次核对范围。")); });
    child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-8_000); });
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error("媒体工具执行失败：" + errors));
      else resolve(output);
    });
  });
}

/** 现有成片只有在来源与字节均能核对时才复用；未知文件保留并报错。 */
export async function renderVersion(entryPoint: string, output: string, cacheDirectory: string, options: RenderOptions = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ExecutionBudgetExceeded("渲染达到已配置的等待上限。")), configuration.media.renderTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try { return await renderAndVerify(entryPoint, output, cacheDirectory, { ...options, signal }); }
  finally { clearTimeout(timer); }
}

async function extractPreviews(output: string, fps: number, frames: number, signal?: AbortSignal) {
  const previews: string[] = [];
  for (const [index, fraction] of previewFractions.entries()) {
    const path = previewPath(output, index), temporary = path + "." + randomUUID() + ".png";
    // 以有效帧号定位，单帧视频也不会定位到末帧之后；完整生成后再替换派生预览。
    const frame = Math.floor((frames - 1) * fraction);
    try {
      await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-ss", String(frame / fps), "-i", output,
        "-frames:v", "1", "-y", temporary], configuration.media.previewTimeoutMs, signal);
      if (!existsSync(temporary) || statSync(temporary).size === 0) throw new Error("预览图片未实际生成：" + path);
      previewPath(output, index); // 发布前再次拒绝被换成符号链接的目标。
      renameSync(temporary, path);
      previews.push(path);
    } finally { rmSync(temporary, { force: true }); }
  }
  return previews;
}

/** 从已核对字节的原视频重建派生预览，不打包工程、不渲染或替换视频。 */
export async function restoreVideoPreviews(output: string, expectedVideoSha256: string, signal?: AbortSignal) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ExecutionBudgetExceeded("预览恢复达到已配置的等待上限。")), configuration.media.renderTimeoutMs);
  try { return await restorePreviews(output, expectedVideoSha256, signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal); }
  finally { clearTimeout(timer); }
}

async function restorePreviews(output: string, expectedVideoSha256: string, signal: AbortSignal) {
  checkExecution(signal);
  if (fileHash(output) !== expectedVideoSha256) throw new Error("成片与原版本的校验值不一致，不能恢复预览。");
  const metadata = z.object({ streams: z.array(z.object({
    avg_frame_rate: z.string(), nb_read_frames: z.string(),
  })) }).parse(JSON.parse(await mediaCommand(mediaBinaries().ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=avg_frame_rate,nb_read_frames", "-of", "json", output],
    configuration.media.probeTimeoutMs, signal)));
  const video = metadata.streams[0];
  const [numerator, denominator] = (video?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator !== undefined && denominator !== undefined ? numerator / denominator : NaN;
  const frames = Number(video?.nb_read_frames);
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(frames) || frames < 1) throw new Error("无法核对原视频的帧率和帧数，未恢复预览。");
  const previews = await extractPreviews(output, fps, frames, signal);
  if (fileHash(output) !== expectedVideoSha256) throw new Error("恢复预览期间成片发生变化，结果未获确认。");
  return { previews, previewsCheckedAt: new Date().toISOString() };
}

async function renderAndVerify(entryPoint: string, output: string, cacheDirectory: string, options: RenderOptions) {
  checkExecution(options.signal);
  const snapshot = options.sourceSnapshot ?? captureSourceSnapshot(entryPoint);
  verifySourceSnapshot(entryPoint, snapshot);
  const fingerprint = sourceFingerprint(snapshot), receiptPath = join(dirname(output), "render-receipt.json");
  const outputExists = existsSync(output);
  if (outputExists) {
    let expected = options.expectedVideoSha256;
    if (!expected && existsSync(receiptPath)) {
      const receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
      if (receipt.sourceFingerprint !== fingerprint) throw new Error("已有成片的工程来源与本次不一致。");
      expected = receipt.videoSha256;
    }
    if (!expected) throw new Error("已有成片缺少可核对的来源记录，不能直接复用或覆盖。");
    if (fileHash(output) !== expected) throw new Error("已有成片与记录的校验值不一致，须从备份恢复或创建新版本。");
  }
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  const sourceRoot = realpathSync(dirname(entryPoint));
  const dependencies = realpathSync(join(repositoryRoot, "node_modules"));
  const configFiles = new Set(["package.json", "tsconfig.json"].map(name => realpathSync(join(repositoryRoot, name))));
  const serveUrl = await bundle({
    entryPoint, rootDir: repositoryRoot, outDir: join(cacheDirectory, "bundle"),
    publicDir: existsSync(join(sourceRoot, "public")) ? join(sourceRoot, "public") : null,
    webpackOverride: config => ({
      ...config,
      resolve: { ...config.resolve, modules: [join(repositoryRoot, "node_modules"), ...(config.resolve?.modules ?? ["node_modules"])] },
      plugins: [...(config.plugins ?? []), {
        apply(compiler: Compiler) {
          compiler.hooks.afterCompile.tap("IntentframeSourceBoundary", compilation => {
            for (const file of compilation.fileDependencies) {
              if (!existsSync(file)) continue;
              const path = realpathSync(file);
              // Webpack 也登记用于查找包的祖先目录；只有实际文件属于制作输入。
              if (statSync(path).isDirectory()) continue;
              if (!inside(sourceRoot, path) && !inside(dependencies, path) && !configFiles.has(path)) {
                throw new Error("工程引用了版本目录外的文件，请先将其纳入当前版本：" + file);
              }
            }
          });
        },
      }],
    }),
  });
  checkExecution(options.signal);
  const composition = await selectComposition({ serveUrl, id: "Video" });
  checkExecution(options.signal);
  const temporary = output + ".partial.mp4", candidate = outputExists ? output : temporary;
  if (!outputExists) {
    const { cancel, cancelSignal } = makeCancelSignal();
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      checkExecution(options.signal);
      await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: temporary,
        pixelFormat: "yuv420p", concurrency: configuration.media.concurrency, overwrite: true, cancelSignal });
    } finally { options.signal?.removeEventListener("abort", cancel); }
  }
  checkExecution(options.signal);
  const { ffmpeg, ffprobe } = mediaBinaries();
  const metadata = z.object({
    streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(),
      width: z.number().optional(), height: z.number().optional(), avg_frame_rate: z.string().optional() })),
    format: z.object({ duration: z.string() }),
  }).parse(JSON.parse(await mediaCommand(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", candidate],
    configuration.media.probeTimeoutMs, options.signal)));
  const video = metadata.streams.find(stream => stream.codec_type === "video");
  const [numerator, denominator] = (video?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator !== undefined && denominator !== undefined ? numerator / denominator : NaN;
  const duration = Number(metadata.format.duration), expectedDuration = composition.durationInFrames / composition.fps;
  if (!video || video.width !== composition.width || video.height !== composition.height ||
      !Number.isFinite(fps) || Math.abs(fps - composition.fps) > 0.001 ||
      !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 0.15) {
    throw new Error("成片规格（包括实际帧率）与制作工程不一致。");
  }
  // 包内精简 FFmpeg 需要显式选择解码验证的输出编码器。
  await mediaCommand(ffmpeg, ["-v", "error", "-xerror", "-i", candidate, "-c:v", "rawvideo", "-c:a", "pcm_s16le", "-f", "null", "-"],
    configuration.media.decodeTimeoutMs, options.signal);
  verifySourceSnapshot(entryPoint, snapshot);
  const videoSha256 = fileHash(candidate);
  if (options.expectedVideoSha256 && videoSha256 !== options.expectedVideoSha256) {
    throw new Error("重建文件与原版本字节不同；临时结果已保留，不能替换已记录版本。");
  }
  if (!outputExists) {
    // 先留可核对的收据，再以不覆盖已有文件的方式发布；记录补存失败后可安全接续。
    const receiptTemporary = receiptPath + "." + randomUUID() + ".tmp";
    writeFileSync(receiptTemporary, JSON.stringify({ sourceFingerprint: fingerprint, videoSha256 }) + "\n", { flag: "wx" });
    renameSync(receiptTemporary, receiptPath);
    linkSync(temporary, output);
    unlinkSync(temporary);
  }
  const previews = await extractPreviews(output, composition.fps, composition.durationInFrames, options.signal);
  if (fileHash(output) !== videoSha256) throw new Error("检查期间成片发生变化，结果未获确认。");
  verifySourceSnapshot(entryPoint, snapshot);
  return { width: video.width, height: video.height, fps, durationSeconds: duration,
    videoCodec: video.codec_name, audioStreams: metadata.streams.filter(s => s.codec_type === "audio").length,
    decoded: true, videoSha256, sourceSha256: fileHash(entryPoint), previews, checkedAt: new Date().toISOString() };
}
