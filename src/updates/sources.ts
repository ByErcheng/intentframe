import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname } from "node:path";
import { z } from "zod";
import type { UpdateSource } from "./catalog.ts";

const run = promisify(execFile);
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function parseVersion(value: string) {
  const match = versionPattern.exec(value);
  if (!match || value.length > 128 || match[4]?.split(".").some(part => /^0\d+$/.test(part))) throw new Error("无法识别版本号。");
  return { numbers: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease: Boolean(match[4]) };
}
/** 候选须为正式版；按数字比较，不能将 4.0.9 当作高于 4.0.10。 */
export function newerStable(candidate: string, current: string): boolean {
  const next = parseVersion(candidate), previous = parseVersion(current);
  if (next.prerelease) throw new Error("上游默认通道返回预发布版，未作为正式更新推荐。");
  for (let index = 0; index < 3; index++) {
    if (next.numbers[index] !== previous.numbers[index]) return next.numbers[index]! > previous.numbers[index]!;
  }
  return previous.prerelease;
}

export function sourceUrl(source: UpdateSource): string {
  if (source.kind === "npm") return "https://registry.npmjs.org/" + encodeURIComponent(source.package) + "/latest";
  if (source.kind === "github") return "https://api.github.com/repos/" + source.repository + "/releases/latest";
  return "https://nodejs.org/dist/index.json";
}

/** 只读取公开元数据，不带用户凭据、不执行下载内容、不跟随重定向。 */
export async function latestVersion(source: UpdateSource, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  const response = await request(sourceUrl(source), { signal, redirect: "error",
    headers: { accept: "application/json", "user-agent": "intentframe-update-check" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error("官方版本查询返回 HTTP " + response.status); }
  if (!response.body) throw new Error("官方版本响应为空。");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2_000_000) throw new Error("官方版本响应超过大小限制。");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("官方版本响应不是有效 JSON。"); }
  let version: string;
  if (source.kind === "npm") version = z.object({ version: z.string() }).parse(data).version;
  else if (source.kind === "github") {
    version = z.object({ tag_name: z.string(), draft: z.literal(false), prerelease: z.literal(false) }).parse(data).tag_name;
  } else {
    const versions = z.array(z.object({ version: z.string() })).parse(data).map(item => item.version);
    const stable = versions.filter(item => { try { return !parseVersion(item).prerelease; } catch { return false; } });
    if (!stable.length) throw new Error("Node 发布列表没有可识别的正式版本。");
    version = stable.reduce((best, item) => newerStable(item, best) ? item : best);
  }
  if (parseVersion(version).prerelease) throw new Error("官方默认通道不是正式发布版本。");
  return version.replace(/^v/, "");
}

export async function toolVersion(tool: string, path: string, signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await run(path, [tool === "restic" ? "version" : "--version"],
      { signal, timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8",
        // npm 分发的工具可能通过 env node 启动；直接连接 CLI 时也使用当前项目 Node。
        env: { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? "") } });
    const line = stdout.trim().split("\n")[0]!;
    const patterns: Record<string, RegExp> = {
      node: /^v(\S+)$/, codex: /^codex(?:-cli)?\s+(\S+)$/, restic: /^restic\s+(\S+)(?:\s|$)/,
    };
    const version = patterns[tool]?.exec(line)?.[1];
    if (!version) throw new Error("格式不符");
    parseVersion(version);
    return version;
  } catch { throw new Error("无法取得 " + tool + " 的实际版本。"); }
}
