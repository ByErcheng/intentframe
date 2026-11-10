import { z } from "zod";

export const wordTimingSchema = z.object({ text: z.string().min(1), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative() })
  .refine(word => word.endMs >= word.startMs, "字词结束时间不能早于开始");
export const narrationMetadataSchema = z.object({ text: z.string(), words: z.array(wordTimingSchema).min(1),
  timingSource: z.literal("provider_returned"), voiceInstruction: z.string().optional() });
export const audioPlacementSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), assetId: z.string(),
  startMs: z.number().finite().nonnegative(), trimStartMs: z.number().finite().nonnegative().default(0),
  trimEndMs: z.number().finite().positive().optional(), playbackRate: z.number().finite().min(0.5).max(2).default(1),
  volume: z.number().finite().min(0).max(2).default(1),
  fadeInMs: z.number().finite().nonnegative().default(0), fadeOutMs: z.number().finite().nonnegative().default(0),
  cues: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), quote: z.string().min(1),
    occurrence: z.number().int().positive().optional(), edge: z.enum(["start", "end"]).default("start") })).default([]) });
export type AudioPlacement = z.infer<typeof audioPlacementSchema>;

/** 兼容作品间素材复用保留的来源包装；不按句长补造时间。 */
export function narrationMetadata(value: unknown, depth = 0): z.infer<typeof narrationMetadataSchema> | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  const result = narrationMetadataSchema.safeParse(value);
  if (result.success) return result.data;
  const record = value as Record<string, unknown>;
  for (const key of ["source", "response", "original"]) {
    const found = narrationMetadata(record[key], depth + 1); if (found) return found;
  }
  return undefined;
}

export function mapNarration(placement: AudioPlacement, metadata: z.infer<typeof narrationMetadataSchema>, durationMs: number) {
  const end = placement.trimEndMs ?? durationMs;
  if (end > durationMs + 1 || end <= placement.trimStartMs) throw new Error("音频播放范围超出实际文件。");
  const words = metadata.words;
  if (words.some((word, index) => word.endMs > durationMs + 100 || (index > 0 && word.startMs < words[index - 1]!.startMs))) throw new Error("字词时间与音轨不一致。");
  if (words.some(word => (placement.trimStartMs > word.startMs && placement.trimStartMs < word.endMs) || (end > word.startMs && end < word.endMs))) {
    throw new Error("裁切点位于字词内部，请选择停顿边界。");
  }
  const convert = (ms: number) => placement.startMs + (ms - placement.trimStartMs) / placement.playbackRate;
  const mapped = words.filter(word => word.startMs >= placement.trimStartMs && word.endMs <= end)
    .map(word => ({ ...word, startMs: convert(word.startMs), endMs: convert(word.endMs) }));
  const joined = words.map(word => word.text).join("");
  const offsets: { start: number; end: number }[] = []; let offset = 0;
  for (const word of words) { offsets.push({ start: offset, end: offset + word.text.length }); offset += word.text.length; }
  const events: Record<string, number> = {};
  for (const cue of placement.cues) {
    if (Object.hasOwn(events, cue.name)) throw new Error("事件名重复：" + cue.name);
    const matches: number[] = []; let position = joined.indexOf(cue.quote);
    while (position >= 0) { matches.push(position); position = joined.indexOf(cue.quote, position + 1); }
    if (!matches.length || (matches.length > 1 && cue.occurrence === undefined)) throw new Error("台词定位不存在或重复，须明确第几次出现：" + cue.quote);
    const at = matches[(cue.occurrence ?? 1) - 1];
    if (at === undefined) throw new Error("台词出现次数不存在。");
    const first = offsets.findIndex(item => item.start === at), last = offsets.findIndex(item => item.end === at + cue.quote.length);
    // 豆包可能把标点和字放在同条记录中；事件仅取已有边界，不插值估算字内时间。
    const firstInside = offsets.findIndex(item => item.start <= at && item.end > at);
    const lastInside = offsets.findIndex(item => item.start < at + cue.quote.length && item.end >= at + cue.quote.length);
    const index = cue.edge === "start" ? first : last;
    let ms: number;
    if (index >= 0) ms = cue.edge === "start" ? words[index]!.startMs : words[index]!.endMs;
    else if (cue.edge === "end" && lastInside >= 0 && /^[\p{P}\s]*$/u.test(joined.slice(at + cue.quote.length, offsets[lastInside]!.end))) ms = words[lastInside]!.endMs;
    else if (cue.edge === "start" && firstInside >= 0 && /^[\p{P}\s]*$/u.test(joined.slice(offsets[firstInside]!.start, at))) ms = words[firstInside]!.startMs;
    else throw new Error("所选事件位于供应商字词内部，缺少精确边界：" + cue.quote);
    if (ms < placement.trimStartMs || ms > end) throw new Error("事件落在裁掉的音频范围内。");
    events[cue.name] = convert(ms);
  }
  return { words: mapped, events, startMs: placement.startMs, endMs: convert(end),
    text: mapped.map(word => word.text).join(""), voiceInstruction: metadata.voiceInstruction,
    timingSource: "derived_from_provider_and_playback" as const };
}

/** 工程直接导入同一播放数据；字幕与动画事件读取同一导出值，避免另写时间表。 */
export function audioRuntimeSource() {
  return `import React from "react";
import {Audio, Sequence, staticFile, useVideoConfig, useCurrentFrame} from "remotion";
import {playback} from "./intentframe-audio-data";
import type {PlaybackClip} from "./intentframe-audio-data";
export {playback};
export const cueFrame = (name: string, fps: number) => {
  const time = playback.events[name];
  if (time === undefined) throw new Error("未找到声音事件：" + name);
  return Math.round(time * fps / 1000);
};
const AudioClip = ({clip}: {clip: PlaybackClip}) => { const {fps} = useVideoConfig(); const ms = useCurrentFrame()*1000/fps;
  const gain = Math.min(1, clip.fadeInMs ? ms/clip.fadeInMs : 1, clip.fadeOutMs ? (clip.endMs-clip.startMs-ms)/clip.fadeOutMs : 1);
  return <Audio src={staticFile(clip.source)} startFrom={Math.round(clip.trimStartMs*fps/1000)}
    endAt={Math.round(clip.trimEndMs*fps/1000)} playbackRate={clip.playbackRate} volume={clip.volume*Math.max(0,gain)}/>;
};
export const ProjectAudio = () => { const {fps} = useVideoConfig(); return <>{playback.clips.map(clip =>
  <Sequence key={clip.id} from={Math.round(clip.startMs * fps / 1000)} durationInFrames={Math.max(1, Math.ceil((clip.endMs-clip.startMs)*fps/1000))}>
    <AudioClip clip={clip}/>
  </Sequence>)}</>; };
`;
}
