import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix);
for (const [network, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(network, prefix, "ipv6");
blocked.addAddress("::1", "ipv6");
export function publicImageUrl(value: string) {
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    host === "localhost" || host.endsWith(".local") || (isIP(host) && blocked.check(host, isIP(host) === 6 ? "ipv6" : "ipv4"))) {
    throw new Error("网上素材只接受公开 HTTPS 图片地址。");
  }
  return url;
}

/** 使用 HTTPS 下载现成搜索工具已找到的图片；DNS 结果固定到本次连接，重定向逐跳检查。 */
export async function downloadImage(value: string, signal?: AbortSignal) {
  const controller = AbortSignal.timeout(60000), combined = signal ? AbortSignal.any([signal, controller]) : controller;
  let current = publicImageUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const host = current.hostname.replace(/^\[|\]$/g, ""), addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(item => blocked.check(item.address, item.family === 6 ? "ipv6" : "ipv4"))) throw new Error("素材地址解析到非公开网络。");
    const address = addresses[0]!;
    const result = await new Promise<{ redirect?: string; bytes?: Buffer; mimeType?: string }>((resolve, reject) => {
      const req = request(current, { signal: combined, headers: { "User-Agent": "intentframe/0.0.0", Accept: "image/png,image/jpeg,image/webp" },
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
        } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.resume(); resolve({ redirect: response.headers.location }); return;
        }
        const mimeType = response.headers["content-type"]?.split(";")[0]?.trim();
        if (response.statusCode !== 200 || !["image/png", "image/jpeg", "image/webp"].includes(mimeType ?? "")) {
          response.resume(); reject(new Error("来源未返回可用 PNG/JPEG/WebP 图片。")); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) response.destroy(new Error("图片超过 32 MiB。")); else chunks.push(chunk); });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks), mimeType }));
        response.on("error", reject);
      });
      req.on("error", () => reject(new Error("网上图片下载未完成；未自动重试。"))); req.end();
    });
    if (result.redirect) { current = publicImageUrl(new URL(result.redirect, current).href); continue; }
    if (!result.bytes?.length || !result.mimeType) throw new Error("网上图片为空。");
    return { bytes: result.bytes, mimeType: result.mimeType, finalUrl: current.href };
  }
  throw new Error("网上图片重定向次数超过限制。");
}
