import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configuration, repositoryRoot } from "../config.ts";
import { valueHash } from "../records/files.ts";

const packageName = z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("npm"), package: packageName }),
  z.strictObject({ kind: z.literal("github"), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  z.strictObject({ kind: z.literal("node") }),
]);
const entrySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: z.string().min(1),
  packages: z.array(packageName).min(1).optional(), tool: z.enum(["node", "codex", "restic"]).optional(),
  source: sourceSchema, url: z.url().refine(value => value.startsWith("https://")), note: z.string().optional(),
}).refine(value => Boolean(value.packages) !== Boolean(value.tool), "清单项须且只能指定 packages 或 tool。");
export type UpdateEntry = z.infer<typeof entrySchema>;
export type UpdateSource = z.infer<typeof sourceSchema>;
export type Inventory = { fingerprint: string; entries: UpdateEntry[]; issues: string[];
  packages: Record<string, string>; tools: Record<string, { path: string; declaredVersion: string }> };

/** 清单显式覆盖直接依赖；新增依赖漏登记时返回缺口，不静默丢失监控。 */
export function readInventory(root = repositoryRoot, config = configuration): Inventory {
  const entries = z.array(entrySchema).parse(JSON.parse(readFileSync(join(root, "config/tool-updates.json"), "utf8")));
  const manifest = z.object({ dependencies: z.record(z.string(), z.string()).default({}),
    devDependencies: z.record(z.string(), z.string()).default({}),
    optionalDependencies: z.record(z.string(), z.string()).default({}) }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  const lock = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional() })) })
    .parse(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")));
  const direct = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }));
  const covered = entries.flatMap(entry => entry.packages ?? []), issues: string[] = [];
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || new Set(covered).size !== covered.length ||
    new Set(entries.flatMap(entry => entry.tool ? [entry.tool] : [])).size !== entries.filter(entry => entry.tool).length) {
    throw new Error("工具更新清单包含重复编号、依赖或独立工具。");
  }
  for (const name of direct) if (!covered.includes(name)) issues.push("直接依赖尚未登记更新来源：" + name);
  for (const name of covered) if (!direct.has(name)) issues.push("清单依赖已不在项目中，请同步移除：" + name);
  for (const name of Object.keys(config.tools)) if (!entries.some(entry => entry.tool === name)) issues.push("独立工具尚未登记更新来源：" + name);
  const packages: Record<string, string> = {};
  for (const name of covered.filter(name => direct.has(name))) {
    const locked = lock.packages["node_modules/" + name]?.version;
    try {
      const installed = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"))).version;
      packages[name] = installed;
      if (locked !== installed) issues.push(name + " 的安装版本 " + installed + " 与锁文件 " + (locked ?? "缺失") + " 不一致。");
    } catch {
      issues.push("无法读取实际安装版本：" + name + "；锁文件版本：" + (locked ?? "缺失"));
    }
  }
  const tools = Object.fromEntries(Object.entries(config.tools).map(([name, value]) =>
    [name, { path: config[name as keyof typeof config.tools], declaredVersion: value.version }]));
  const identities = Object.entries(tools).map(([name, tool]) => {
    try { const stat = statSync(tool.path); return [name, tool, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { return [name, tool, "unavailable"]; }
  });
  return { entries, packages, tools, issues,
    fingerprint: valueHash({ entries, packages, identities, manifest, lock, issues, dayStartHour: config.updates.dayStartHour }) };
}
