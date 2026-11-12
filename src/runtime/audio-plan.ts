import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fileHash } from "../common/file-hash.ts";
import { immutableJson, ownedPath, readJson, valueHash } from "../records/files.ts";
import { AssetStore } from "../records/asset-store.ts";
import { voiceInfoSchema } from "../records/asset-types.ts";
import type { WorkRecord, WorkStore, WorkVersion } from "../records/work-store.ts";
import { audioPlacementSchema, audioRuntimeSource, mapNarration, narrationMetadata } from "../media/audio-timing.ts";

const planFile = "public/intentframe/audio-plan.json", runtimeFile = "intentframe-audio.tsx", dataFile = "intentframe-audio-data.ts";
export const audioPlanInputSchema = z.object({ clips: z.array(audioPlacementSchema).max(50) });

export function readAudioPlan(store: WorkStore, version: WorkVersion) {
  if (!version.audioPlan) return undefined;
  const directory = dirname(store.resolvePath(version.sourcePath));
  for (const [path, hash] of [[planFile, version.audioPlan.sha256], [runtimeFile, version.audioPlan.runtimeSha256], [dataFile, version.audioPlan.dataSha256]]) {
    if (fileHash(ownedPath(directory, path!)) !== hash) throw new Error("配音播放依据已在工具外改变，请通过声音编排工具更新。");
  }
  return z.object({ schemaVersion: z.literal(1), clips: z.array(z.object({ id: z.string(), assetId: z.string(), sha256: z.string(),
    source: z.string(), startMs: z.number(), endMs: z.number(), trimStartMs: z.number(), trimEndMs: z.number(), playbackRate: z.number(), volume: z.number(),
    fadeInMs: z.number().optional(), fadeOutMs: z.number().optional(), voice: voiceInfoSchema.optional(),
    text: z.string().optional(), voiceInstruction: z.string().optional(), words: z.array(z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })).optional() })),
    events: z.record(z.string(), z.number()), limitations: z.array(z.string()) }).parse(readJson(ownedPath(directory, planFile)));
}

export function audioPlanSummary(store: WorkStore, version: WorkVersion) {
  const plan = readAudioPlan(store, version);
  if (!plan) return undefined;
  return { ...plan, clips: plan.clips.map(({ words, ...clip }) => ({ ...clip, wordCount: words?.length ?? 0 })),
    wordTimingLocation: join(dirname(store.resolvePath(version.sourcePath)), planFile),
    note: "默认展示片段台词与成片时间；精确字词数据在所列本机文件中，按需要展开。" };
}

export function saveAudioPlan(store: WorkStore, work: WorkRecord, version: WorkVersion, input: z.input<typeof audioPlanInputSchema>) {
  const args = audioPlanInputSchema.parse(input);
  if (new Set(args.clips.map(clip => clip.id)).size !== args.clips.length) throw new Error("音频片段编号重复。");
  const directory = dirname(store.resolvePath(version.sourcePath)), assets = new AssetStore(store);
  if (version.audioPlan) readAudioPlan(store, version);
  else if ([planFile, runtimeFile, dataFile].some(path => existsSync(ownedPath(directory, path)))) throw new Error("声音编排位置已有未登记文件，不能覆盖。");
  const events: Record<string, number> = {};
  const clips = args.clips.map(clip => {
    const asset = assets.get(work, clip.assetId);
    if (!asset.mimeType.startsWith("audio/")) throw new Error("声音编排只接受音频素材。");
    const metadata = asset.metadataPath ? readJson(store.resolvePath(asset.metadataPath)) : undefined;
    const probe = z.object({ probe: z.object({ format: z.object({ duration: z.string() }) }) }).parse(metadata);
    const duration = Number(probe.probe.format.duration) * 1000, end = clip.trimEndMs ?? duration;
    if (!Number.isFinite(duration) || duration <= 0 || end > duration + 1 || end <= clip.trimStartMs) throw new Error("音频范围无效。");
    const spoken = narrationMetadata(metadata);
    if (clip.cues.length && !spoken) throw new Error("所选音轨没有供应商字词时间，不能绑定台词事件。");
    const timing = spoken ? mapNarration(clip, spoken, duration) : undefined;
    for (const [name, time] of Object.entries(timing?.events ?? {})) events[clip.id + "." + name] = time;
    const copy = assets.copyToSource(work, [asset.id], directory)[0]!;
    version.assets ??= []; if (!version.assets.some(item => item.id === asset.id)) version.assets.push(asset);
    return { ...clip, source: copy.source, sha256: asset.sha256, trimEndMs: end, ...(asset.voice ? { voice: asset.voice } : {}),
      endMs: clip.startMs + (end - clip.trimStartMs) / clip.playbackRate,
      ...(timing ? { text: timing.text, words: timing.words, voiceInstruction: timing.voiceInstruction, timingSource: timing.timingSource } : { timingSource: "no_word_timing" }) };
  });
  const plan = { schemaVersion: 1 as const, clips, events,
    limitations: ["字词时间由供应商结果和实际播放安排换算，不是对成片重新转写。", "需在工程中使用 ProjectAudio；播放记录本身不能证明成片听感和口播内容已经核对。"] };
  const serialized = JSON.stringify(plan, null, 2) + "\n", data = `// 由声音编排工具生成，请通过工具更新。
export type PlaybackClip = { id: string; assetId: string; source: string; sha256: string; startMs: number; endMs: number;
  trimStartMs: number; trimEndMs: number; playbackRate: number; volume: number; fadeInMs: number; fadeOutMs: number;
  cues: {name: string; quote: string; edge: string; occurrence?: number}[]; text?: string; voiceInstruction?: string;
  voice?: {kind: "recording" | "synthesized" | "unknown"; speaker?: string; source?: string; transcript?: {text: string; source: string}};
  timingSource: string; words?: {text: string; startMs: number; endMs: number}[] };
export const playback: {schemaVersion: number; clips: PlaybackClip[]; events: Record<string, number>; limitations: string[]} = ${JSON.stringify(plan)};
`;
  const runtime = audioRuntimeSource();
  mkdirSync(dirname(ownedPath(directory, planFile)), { recursive: true });
  writeFileSync(ownedPath(directory, planFile), serialized);
  writeFileSync(ownedPath(directory, dataFile), data);
  writeFileSync(ownedPath(directory, runtimeFile), runtime);
  version.audioPlan = { sha256: fileHash(ownedPath(directory, planFile)), dataSha256: fileHash(ownedPath(directory, dataFile)), runtimeSha256: fileHash(ownedPath(directory, runtimeFile)) };
  const evidence = join("works", work.id, "runs", version.runId, "audio-plans", valueHash(plan) + ".json");
  immutableJson(store.resolvePath(evidence), plan);
  store.save(work);
  return { plan: audioPlanSummary(store, version), location: ownedPath(directory, planFile), importFrom: "./intentframe-audio", audioComponent: "ProjectAudio",
    instructions: "导入 ProjectAudio、playback、cueFrame。音轨由 ProjectAudio 播放；字幕读 playback.clips[].words，动画用 cueFrame('片段ID.事件名', fps)。不得另写重复音轨或修改工具生成文件。" };
}
