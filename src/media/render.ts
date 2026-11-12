import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, openBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import type { Compiler } from "webpack";
import { z } from "zod";
import { configuration, repositoryRoot } from "../config.ts";
import { captureSourceSnapshot, sourceFingerprint, verifySourceSnapshot } from "../records/source-snapshot.ts";
import { fileHash } from "../common/file-hash.ts";
import type { SourceSnapshot } from "../records/source-snapshot.ts";
import { checkExecution, ExecutionBudgetExceeded } from "../runtime/execution-control.ts";
import { previewFractions, previewPath } from "./previews.ts";
import { immutableBytes } from "../records/files.ts";
import { assertRendererPatch } from "./renderer-patch.ts";
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

const receiptSchema = z.object({ sourceFingerprint: z.string(), videoSha256: z.string(), frameRange: z.tuple([z.number(), z.number()]).optional() });
export type RenderStage = "bundle" | "browser" | "composition" | "render" | "frames" | "encoding" | "verification" | "cleanup";
export type RenderOptions = { sourceSnapshot?: SourceSnapshot; expectedVideoSha256?: string; signal?: AbortSignal; frameRange?: [number, number];
  onStage?: (stage: RenderStage) => void };

/** 本项目导出恒定帧率视频；技术时间连续性不表示动作或节奏已审查。 */
export function verifyFrameTiming(frameCount: number, frameTimes: number[], expectedFrames: number, fps: number) {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(expectedFrames) || expectedFrames < 1 ||
    frameCount !== expectedFrames || frameTimes.length !== expectedFrames || frameTimes.some((time, index) =>
      !Number.isFinite(time) || (index > 0 && time <= frameTimes[index - 1]!) || Math.abs(time - index / fps) > 0.1 / fps + 0.0001)) {
    throw new Error("成片帧数或帧时间戳与制作工程不一致。");
  }
  return { checked: true, monotonic: true, expectedStepSeconds: 1 / fps };
}

/** 停止后等实际子进程关闭，避免释放任务占用时媒体工具仍在写文件。 */
export function mediaCommand(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
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
  assertRendererPatch();
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

/** 帧号属于原工程；局部视频从零计时，抽取时须减去其起始帧。 */
export async function extractPreviewFrames(output: string, expectedHash: string, fps: number, frameCount: number,
  frames: number[], sourceStartFrame = 0, signal?: AbortSignal) {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(frameCount) || frameCount < 1 ||
      !Number.isSafeInteger(sourceStartFrame) || sourceStartFrame < 0 || !frames.length || frames.length > 12 ||
      new Set(frames).size !== frames.length || frames.some(frame => !Number.isSafeInteger(frame) ||
        frame < sourceStartFrame || frame >= sourceStartFrame + frameCount)) throw new Error("指定预览帧须唯一且位于实际渲染范围内，每次最多12帧。");
  checkExecution(signal);
  if (fileHash(output) !== expectedHash) throw new Error("预览视频已变化，不能按旧记录抽帧。");
  const results = [];
  for (const frame of frames) {
    const path = join(dirname(output), "selected-frame-" + String(frame).padStart(6, "0") + ".png");
    const temporary = path + "." + randomUUID() + ".png", videoFrame = frame - sourceStartFrame;
    try {
      await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-ss", String(videoFrame / fps), "-i", output,
        "-frames:v", "1", "-n", temporary], configuration.media.previewTimeoutMs, signal);
      if (!existsSync(temporary) || statSync(temporary).size === 0) throw new Error("指定帧未实际生成：" + frame);
      immutableBytes(path, readFileSync(temporary));
      results.push({ path, sha256: fileHash(path), frame, seconds: frame / fps, videoFrame, videoSeconds: videoFrame / fps });
    } finally { rmSync(temporary, { force: true }); }
  }
  if (fileHash(output) !== expectedHash) throw new Error("抽帧期间预览视频发生变化，结果未获确认。");
  return results;
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

/** 每次渲染持有自己的浏览器，成功、失败与取消都等待该实例关闭。 */
async function renderCandidate(serveUrl: string, candidate: string, createMedia: boolean, options: RenderOptions) {
  options.onStage?.("browser"); checkExecution(options.signal);
  const browser = await openBrowser("chrome");
  let failure: unknown;
  try {
    checkExecution(options.signal);
    options.onStage?.("composition");
    const composition = await selectComposition({ serveUrl, id: "Video", puppeteerInstance: browser });
    if (options.frameRange && (!options.frameRange.every(Number.isSafeInteger) || options.frameRange[0] < 0 ||
      options.frameRange[1] < options.frameRange[0] || options.frameRange[1] >= composition.durationInFrames)) throw new Error("预览帧范围超出工程。");
    checkExecution(options.signal);
    if (createMedia) {
      const { cancel, cancelSignal } = makeCancelSignal();
      let started = false, encodingReported = false;
      // 4.0.541 在启动完成前取消会先执行 cleanup，随后才创建轮换标签页的定时器。
      // 先记住取消，等 onStart 表明启动清理已注册后再交给依赖；不以 Promise 返回代替资源关闭。
      const abort = () => { if (started) cancel(); };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        checkExecution(options.signal); options.onStage?.("render");
        await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: candidate, puppeteerInstance: browser,
          pixelFormat: "yuv420p", concurrency: configuration.media.concurrency, overwrite: true, cancelSignal, frameRange: options.frameRange,
          onStart: () => { started = true; options.onStage?.("frames"); if (options.signal?.aborted) cancel(); },
          onProgress: progress => { if (progress.encodedFrames > 0 && !encodingReported) { encodingReported = true; options.onStage?.("encoding"); } },
        });
      } finally { options.signal?.removeEventListener("abort", abort); }
    }
    checkExecution(options.signal);
    return composition;
  } catch (error) {
    failure = options.signal?.aborted ? options.signal.reason ?? error : error;
    throw failure;
  } finally {
    try { options.onStage?.("cleanup"); }
    finally {
      try { await browser.close({ silent: true }); }
      catch (error) { throw new AggregateError(failure ? [failure, error] : [error], "渲染浏览器清理失败，未确认资源已关闭。"); }
    }
  }
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
      if (JSON.stringify(receipt.frameRange) !== JSON.stringify(options.frameRange)) throw new Error("已有渲染的帧范围与本次不一致。");
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
  options.onStage?.("bundle");
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
  const temporary = output + ".partial.mp4", candidate = outputExists ? output : temporary;
  const composition = await renderCandidate(serveUrl, candidate, !outputExists, options);
  checkExecution(options.signal);
  options.onStage?.("verification");
  const { ffmpeg, ffprobe } = mediaBinaries();
  const metadata = z.object({
    streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(),
      width: z.number().optional(), height: z.number().optional(), avg_frame_rate: z.string().optional(), nb_read_frames: z.string().optional() })),
    frames: z.array(z.object({ media_type: z.string(), best_effort_timestamp_time: z.string().optional() })),
    format: z.object({ duration: z.string() }),
  }).parse(JSON.parse(await mediaCommand(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-show_frames",
    "-show_entries", "stream:format:frame=media_type,best_effort_timestamp_time", "-of", "json", candidate],
    configuration.media.probeTimeoutMs, options.signal)));
  const video = metadata.streams.find(stream => stream.codec_type === "video");
  const [numerator, denominator] = (video?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator !== undefined && denominator !== undefined ? numerator / denominator : NaN;
  const duration = Number(metadata.format.duration), expectedFrames = options.frameRange ? options.frameRange[1] - options.frameRange[0] + 1 : composition.durationInFrames;
  const expectedDuration = expectedFrames / composition.fps;
  const frameCount = Number(video?.nb_read_frames), frameTimes = metadata.frames.filter(frame => frame.media_type === "video")
    .map(frame => frame.best_effort_timestamp_time === undefined ? NaN : Number(frame.best_effort_timestamp_time));
  if (!video || video.width !== composition.width || video.height !== composition.height ||
      !Number.isFinite(fps) || Math.abs(fps - composition.fps) > 0.001 ||
      !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 0.15) {
    throw new Error("成片规格（包括实际帧率）与制作工程不一致。");
  }
  const frameTiming = verifyFrameTiming(frameCount, frameTimes, expectedFrames, fps);
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
    writeFileSync(receiptTemporary, JSON.stringify({ sourceFingerprint: fingerprint, videoSha256, frameRange: options.frameRange }) + "\n", { flag: "wx" });
    renameSync(receiptTemporary, receiptPath);
    linkSync(temporary, output);
    unlinkSync(temporary);
  }
  const previews = await extractPreviews(output, composition.fps, expectedFrames, options.signal);
  if (fileHash(output) !== videoSha256) throw new Error("检查期间成片发生变化，结果未获确认。");
  verifySourceSnapshot(entryPoint, snapshot);
  return { width: video.width, height: video.height, fps, durationSeconds: duration,
    frameCount, frameTiming,
    videoCodec: video.codec_name, audioStreams: metadata.streams.filter(s => s.codec_type === "audio").length,
    decoded: true, videoSha256, sourceSha256: fileHash(entryPoint), previews, checkedAt: new Date().toISOString() };
}
