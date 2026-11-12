import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { LookupAddress } from "node:dns";
import { assetMimeTypes, isAudioRole } from "../records/asset-types.ts";
import type { AssetRole } from "../records/asset-types.ts";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix);
for (const [network, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(network, prefix, "ipv6");
blocked.addAddress("::1", "ipv6");
export function publicAssetUrl(value: string) {
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    host.startsWith("::ffff:") || host === "localhost" || host.endsWith(".local") || (isIP(host) && blocked.check(host, isIP(host) === 6 ? "ipv6" : "ipv4"))) {
    throw new Error("网上素材只接受公开 HTTPS 素材地址。");
  }
  return url;
}

/** 使用 HTTPS 下载现成搜索工具已找到的媒体；DNS 结果固定到本次连接，重定向逐跳检查。 */
export type DownloadTransport = {
  lookup: (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;
  request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
};
export async function downloadAsset(value: string, role: AssetRole, signal?: AbortSignal,
  transport: DownloadTransport = { lookup, request }) {
  const limit = (isAudioRole(role) ? 128 : 32) * 1024 * 1024;
  const controller = AbortSignal.timeout(60000), combined = signal ? AbortSignal.any([signal, controller]) : controller;
  let current = publicAssetUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    combined.throwIfAborted();
    const host = current.hostname.replace(/^\[|\]$/g, "");
    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      const abort = () => reject(new Error("素材域名解析已取消或超时。"));
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) { abort(); combined.removeEventListener("abort", abort); return; }
      transport.lookup(host, { all: true }).then(resolve, () => reject(new Error("素材域名解析失败。")))
        .finally(() => combined.removeEventListener("abort", abort));
    });
    combined.throwIfAborted();
    if (!addresses.length || addresses.some(item => item.address.toLowerCase().startsWith("::ffff:") || blocked.check(item.address, item.family === 6 ? "ipv6" : "ipv4"))) throw new Error("素材地址解析到非公开网络。");
    const address = addresses[0]!;
    const result = await new Promise<{ redirect?: string; bytes?: Buffer; mimeType?: string }>((resolve, reject) => {
      const req = transport.request(current, { signal: combined, headers: { "User-Agent": "intentframe/0.0.0", Accept: isAudioRole(role) ? "audio/*,application/octet-stream" : "image/png,image/jpeg,image/webp,application/octet-stream" },
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
        } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.destroy(); resolve({ redirect: response.headers.location }); return;
        }
        const mimeType = response.headers["content-type"]?.split(";")[0]?.trim();
        const allowed = new Set([...Object.values(assetMimeTypes), "audio/mp3", "audio/x-wav", "audio/x-flac", "audio/x-m4a", "application/ogg", "application/octet-stream", "binary/octet-stream"]);
        if (response.statusCode !== 200 || (mimeType && !allowed.has(mimeType.toLowerCase()))) {
          response.destroy(); reject(new Error("来源未返回支持的媒体文件。")); return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limit) { response.destroy(); reject(new Error("素材超过下载大小上限。")); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) response.destroy(new Error("素材超过下载大小上限。")); else chunks.push(chunk); });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks), mimeType }));
        response.on("error", () => reject(new Error("媒体下载中断。")));
        response.on("aborted", () => reject(new Error("媒体下载未完整结束。")));
      });
      req.on("error", () => reject(new Error("网上素材下载未完成；未自动重试。"))); req.end();
    });
    if (result.redirect) { current = publicAssetUrl(new URL(result.redirect, current).href); continue; }
    if (!result.bytes?.length) throw new Error("网上素材为空。");
    const format = identifyMedia(result.bytes);
    if (!format.mimeType.startsWith(isAudioRole(role) ? "audio/" : "image/")) throw new Error("下载文件的实际类型与素材用途不符。");
    return { bytes: result.bytes, ...format, finalUrl: current.href };
  }
  throw new Error("网上素材重定向次数超过限制。");
}

/** 文件头仅作前置筛选，实际格式和完整解码仍由 AssetStore 核对。 */
export function identifyMedia(bytes: Buffer) {
  let extension: string | undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = ".png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = ".jpg";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") extension = ".webp";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") extension = ".wav";
  else if (bytes.toString("ascii", 0, 4) === "fLaC") extension = ".flac";
  else if (bytes.toString("ascii", 0, 4) === "OggS") extension = ".ogg";
  else if (bytes.toString("ascii", 4, 8) === "ftyp") extension = ".m4a";
  else if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) extension = ".mp3";
  if (!extension) throw new Error("下载内容不是支持的图片或音频格式。");
  return { extension, mimeType: assetMimeTypes[extension]! };
}
