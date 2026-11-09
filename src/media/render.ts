import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { Compiler } from "webpack";
import { z } from "zod";
import { repositoryRoot } from "../config.ts";
import { captureSourceSnapshot, fileHash, sourceFingerprint, verifySourceSnapshot } from "../records/source-snapshot.ts";
import type { SourceSnapshot } from "../records/source-snapshot.ts";
export { fileHash } from "../records/source-snapshot.ts";

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
export type RenderOptions = { sourceSnapshot?: SourceSnapshot; expectedVideoSha256?: string };

/** 现有成片只有在来源与字节均能核对时才复用；未知文件保留并报错。 */
export async function renderVersion(entryPoint: string, output: string, cacheDirectory: string, options: RenderOptions = {}) {
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
  const composition = await selectComposition({ serveUrl, id: "Video" });
  const temporary = output + ".partial.mp4", candidate = outputExists ? output : temporary;
  if (!outputExists) {
    await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: temporary,
      pixelFormat: "yuv420p", concurrency: 2, overwrite: true });
  }
  const { ffmpeg, ffprobe } = mediaBinaries();
  const metadata = z.object({
    streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(),
      width: z.number().optional(), height: z.number().optional(), avg_frame_rate: z.string().optional() })),
    format: z.object({ duration: z.string() }),
  }).parse(JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", candidate],
    { encoding: "utf8", timeout: 30_000, env: mediaEnvironment() })));
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
  execFileSync(ffmpeg, ["-v", "error", "-xerror", "-i", candidate, "-c:v", "rawvideo", "-c:a", "pcm_s16le", "-f", "null", "-"],
    { timeout: 60_000, env: mediaEnvironment() });
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
  const previews: string[] = [];
  for (const [index, fraction] of [0.12, 0.5, 0.86].entries()) {
    const path = join(dirname(output), "frame-" + (index + 1) + ".png");
    // 按有效帧号确定取图时间，避免极短片段定位到最后一帧之后。
    const frame = Math.floor((composition.durationInFrames - 1) * fraction);
    execFileSync(ffmpeg, ["-v", "error", "-ss", String(frame / composition.fps), "-i", output, "-frames:v", "1", "-y", path],
      { timeout: 30_000, env: mediaEnvironment() });
    if (!existsSync(path) || statSync(path).size === 0) throw new Error("预览图片未实际生成：" + path);
    previews.push(path);
  }
  if (fileHash(output) !== videoSha256) throw new Error("检查期间成片发生变化，结果未获确认。");
  verifySourceSnapshot(entryPoint, snapshot);
  return { width: video.width, height: video.height, fps, durationSeconds: duration,
    videoCodec: video.codec_name, audioStreams: metadata.streams.filter(s => s.codec_type === "audio").length,
    decoded: true, videoSha256, sourceSha256: fileHash(entryPoint), previews, checkedAt: new Date().toISOString() };
}
