import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { providersSchema } from "../config.ts";

export type ProviderSettings = z.infer<typeof providersSchema>;
export type Fetcher = typeof fetch;
export type ProviderResponse = { status: number; body: string };
export type ProviderExchange = { saved?: ProviderResponse; capture?: (response: ProviderResponse) => void };
export const voiceInstructionSchema = z.string().trim().min(1).max(2000);

/** 标准复刻模型会忽略声音指令；调用前拒绝，避免脚本要求被静默丢弃。 */
export function validateVoiceInstruction(settings: NonNullable<ProviderSettings["speech"]>, value?: string) {
  if (value === undefined) return undefined;
  const parsed = voiceInstructionSchema.safeParse(value);
  if (!parsed.success) throw new Error("声音指令须为 1–2000 个字符，不能只有空白。");
  if (settings.resourceId !== "seed-tts-2.0" &&
    !(settings.resourceId === "seed-icl-2.0" && settings.model === "seed-tts-2.0-expressive")) {
    throw new Error("当前豆包资源或模型不支持声音指令；复刻 2.0 须配置 resourceId=seed-icl-2.0、model=seed-tts-2.0-expressive，未发起调用。");
  }
  return parsed.data;
}

export class ProviderRequestError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain: boolean) { super(message); this.uncertain = uncertain; }
}
export function speechSegments(markdown: string) {
  const expression = /^```speech:([a-zA-Z0-9_-]+)\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/gm;
  const segments = [...markdown.matchAll(expression)].map(match => ({ id: match[1]!, text: match[2]! }));
  if ((markdown.match(/^```speech:/gm)?.length ?? 0) !== segments.length || new Set(segments.map(item => item.id)).size !== segments.length || segments.some(item => !item.text.trim())) throw new Error("人声台词区块未闭合、为空或编号重复。");
  return segments;
}
async function limitedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new ProviderRequestError("服务未返回内容，保留原请求。", true);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length; if (size > limit) { await reader.cancel(); throw new ProviderRequestError("服务返回内容超过本次允许大小，未重发。", true); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
async function send(fetcher: Fetcher, endpoint: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal,
  exchange?: ProviderExchange, secret?: string) {
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    let result = exchange?.saved;
    if (!result) {
      const response = await fetcher(endpoint, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      const body = await limitedBody(response, 100 * 1024 * 1024);
      result = { status: response.status, body: secret ? body.replaceAll(secret, "[REDACTED]") : body };
      // 在解析媒体和字幕之前保存完整响应；解析或登记失败可沿原请求离线恢复。
      exchange?.capture?.(result);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new ProviderRequestError("生成服务返回 HTTP " + result.status + "；未自动重试。", ![400, 401, 403, 404, 422, 429].includes(result.status));
    }
    return result.body;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    // 网络错误和响应正文均可能携带凭据，不把底层文本转发给模型或日志。
    throw new ProviderRequestError("生成服务连接结果未核实，保留原请求且不自动重发。", true);
  }
}
function decodeBase64(value: string, limit: number) {
  if (!value || value.length > Math.ceil(limit * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("生成内容编码无效。");
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > limit) throw new Error("生成内容体积无效。");
  return data;
}

export async function generateImage(settings: NonNullable<ProviderSettings["image"]>, prompt: string,
  references: { bytes: Buffer; mimeType: string; name: string }[], fetcher: Fetcher = fetch, signal?: AbortSignal, exchange?: ProviderExchange,
  background: "auto" | "opaque" | "transparent" = "auto") {
  let body: BodyInit, headers: Record<string, string> = { Authorization: "Bearer " + settings.apiKey };
  const values = { model: settings.model, prompt, n: "1", output_format: "png", size: "1024x1024", quality: "medium", background };
  if (references.length) {
    const form = new FormData(); for (const [key, value] of Object.entries(values)) form.set(key, value);
    for (const item of references) form.append("image[]", new Blob([new Uint8Array(item.bytes)], { type: item.mimeType }), item.name);
    body = form;
  } else { headers = { ...headers, "Content-Type": "application/json" }; body = JSON.stringify({ ...values, n: 1 }); }
  const response = await send(fetcher, "https://api.openai.com/v1/images/" + (references.length ? "edits" : "generations"), { method: "POST", headers, body }, settings.timeoutMs, signal, exchange, settings.apiKey);
  try {
    const parsed = z.object({ data: z.array(z.object({ b64_json: z.string(), revised_prompt: z.string().optional() })).length(1), usage: z.unknown().optional() })
      .parse(JSON.parse(response));
    return { bytes: decodeBase64(parsed.data[0]!.b64_json, 64 * 1024 * 1024), metadata: { model: settings.model,
      prompt, background, revisedPrompt: parsed.data[0]!.revised_prompt, usage: parsed.usage ?? null } };
  } catch { throw new ProviderRequestError("图片服务响应不完整或无效，未自动重发。", true); }
}

export async function synthesizeSpeech(settings: NonNullable<ProviderSettings["speech"]>, text: string, speechRate: number,
  fetcher: Fetcher = fetch, signal?: AbortSignal, requestId: string = randomUUID(), voiceInstruction?: string, exchange?: ProviderExchange) {
  if (!text.trim() || text.length > 5000) throw new Error("本次配音原文须为 1–5000 字符；较长台词请明确选择片段分次制作。");
  if (!Number.isInteger(speechRate) || speechRate < -50 || speechRate > 100) throw new Error("配音语速参数超出支持范围。");
  const instruction = validateVoiceInstruction(settings, voiceInstruction);
  const response = await send(fetcher, "https://openspeech.bytedance.com/api/v3/tts/unidirectional", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": settings.apiKey,
      "X-Api-Resource-Id": settings.resourceId, "X-Api-Request-Id": requestId, "X-Control-Require-Usage-Tokens-Return": "*" },
    body: JSON.stringify({ req_params: { text, speaker: settings.speaker, ...(settings.model ? { model: settings.model } : {}),
      ...(instruction ? { additions: JSON.stringify({ context_texts: [instruction] }) } : {}),
      audio_params: { format: "mp3", sample_rate: 24000, speech_rate: speechRate, enable_subtitle: true } } }),
  }, settings.timeoutMs, signal, exchange, settings.apiKey);
  try {
    const raw = response, chunks: Buffer[] = [], words: { text: string; startMs: number; endMs: number }[] = [];
    let total = 0, usage: unknown = null, finished = false;
    for (const line of raw.split(/\r?\n/).filter(line => line.trim())) {
      const event = z.object({ code: z.number().int(), data: z.string().nullable().optional(), sentence: z.unknown().optional(), usage: z.unknown().optional() }).parse(JSON.parse(line));
      if (![0, 20000000].includes(event.code)) throw new ProviderRequestError("豆包语音明确返回错误代码 " + event.code + "；未自动重试。", event.code >= 50000000);
      if (event.code === 20000000) finished = true;
      if (event.data) { const chunk = decodeBase64(event.data, 32 * 1024 * 1024); total += chunk.length; if (total > 32 * 1024 * 1024) throw new Error("音轨超出上限。"); chunks.push(chunk); }
      if (event.sentence) {
        const sentence = z.object({ words: z.array(z.object({ word: z.string().min(1), startTime: z.number().finite().nonnegative(), endTime: z.number().finite().nonnegative() })) }).parse(event.sentence);
        for (const word of sentence.words) {
          if (word.endTime < word.startTime) throw new Error("时间信息无效。");
          const item = { text: word.word, startMs: Math.round(word.startTime * 1000), endMs: Math.round(word.endTime * 1000) };
          if (!words.some(previous => previous.text === item.text && previous.startMs === item.startMs && previous.endMs === item.endMs)) words.push(item);
        }
      }
      if (event.usage) usage = event.usage;
    }
    if (!finished || !chunks.length || !words.length || words.some((word, index) => index > 0 && word.startMs < words[index - 1]!.startMs)) throw new Error("语音或时间信息不完整。");
    return { bytes: Buffer.concat(chunks), metadata: { text, speaker: settings.speaker, resourceId: settings.resourceId,
      model: settings.model, requestId, speechRate, ...(instruction ? { voiceInstruction: instruction } : {}),
      words, timingSource: "provider_returned", usage, requiresListening: true } };
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError("豆包语音响应不完整或无效，原请求未重发。", true);
  }
}
