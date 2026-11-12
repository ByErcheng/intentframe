import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { z } from "zod";
import { assetLibrarySchema, libraryRelativePathSchema } from "../config.ts";
import type { LibraryRoot } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { assetMimeTypes, assetRoleSchema, isAudioRole } from "./asset-types.ts";
import type { LibraryUsage } from "./asset-types.ts";
import { atomicJson, ownedPath, readJson, valueHash } from "./files.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.object({ libraryId: z.string(), path: libraryRelativePathSchema,
  bytes: z.number().int().nonnegative(), mtimeMs: z.number(), ctimeMs: z.number() });
const entrySchema = fileSchema.extend({ name: z.string(), category: z.string(), role: assetRoleSchema, mimeType: z.string() });
const indexSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime(), configSha256: digest,
  libraries: z.array(assetLibrarySchema),
  basis: z.literal("directory_and_filename"), listeningStatus: z.literal("not_checked"), onlineStatus: z.literal("not_checked"),
  entries: z.array(entrySchema.extend({ sha256: digest })),
  documents: z.array(fileSchema.extend({ sha256: digest })),
});
type LibraryFile = z.infer<typeof fileSchema>;
type Entry = z.infer<typeof entrySchema>;
type Index = z.infer<typeof indexSchema>;
const documentExtensions = new Set([".md", ".txt", ".pdf", ".doc", ".docx", ".url"]);
export const refreshLibraryCommand = "./scripts/intentframe index-assets";

export function libraryUsage(library: LibraryRoot, path: string) {
  libraryRelativePathSchema.parse(path);
  const attributionRequired = library.attributionPaths?.some(prefix => path === prefix || path.startsWith(prefix + "/"));
  return { source: "local_library" as const, libraryId: library.id, path, notes: library.usageNotes, attributionRequired,
    ...(attributionRequired ? { attributionReminder: "发布时需署名；交付时附已有署名信息，缺失可后续补充，不阻塞制作和交付。" } : {}) };
}

/** 当前配置说明单独返回；不会覆盖历史素材和版本中保存的使用声明。 */
export function currentLibraryUsage(origin: string, libraries: LibraryRoot[], inheritedUsage?: LibraryUsage) {
  // 跨作品复制保留直接来源为 work:；库引用由历史声明延续，仅用于查当前配置，不改写历史声明。
  const inherited = origin.startsWith("work:") ? inheritedUsage : undefined;
  for (const library of [...libraries].sort((a, b) => b.path.length - a.path.length)) {
    const prefix = "library:" + library.id + "/";
    const path = origin.startsWith(prefix) ? origin.slice(prefix.length) :
      origin.startsWith("local:") ? relative(library.path, origin.slice("local:".length)) :
      inherited?.libraryId === library.id ? inherited.path : undefined;
    if (path && libraryRelativePathSchema.safeParse(path).success) return libraryUsage(library, path);
  }
  return undefined;
}

export function libraryIndexPath(assetRoot: string): string { return ownedPath(assetRoot, "library/index.json"); }

/** 文件名或子目录的明确配置优先；同一文件只属于一个用途，旧目录不必搬动。 */
export function libraryRole(library: LibraryRoot, path: string) {
  return [...library.roleOverrides ?? []].sort((a, b) => b.path.length - a.path.length)
    .find(rule => path === rule.path || path.startsWith(rule.path + "/"))?.role ?? library.role;
}

/** 只读名称与文件状态；不解码、不试听、不把目录名解释成授权或内容验证。 */
export function scanLibraries(libraries: LibraryRoot[]) {
  const entries: Entry[] = [], documents: LibraryFile[] = [], warnings: string[] = [];
  let scanned = 0;
  for (const library of libraries) {
    const visit = (key: string, depth: number) => {
      if (depth > 20 || scanned >= 10000) throw new Error("目录扫描达到本次上限");
      for (const item of readdirSync(ownedPath(library.path, key), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
        if (++scanned > 10000) throw new Error("目录扫描达到本次上限");
        const path = join(key, item.name);
        if (item.isDirectory()) visit(path, depth + 1);
        else if (item.isFile()) {
          const mimeType = assetMimeTypes[extname(path).toLowerCase()];
          if (!mimeType && !documentExtensions.has(extname(path).toLowerCase())) continue;
          const stat = lstatSync(ownedPath(library.path, path));
          if (!stat.isFile()) throw new Error("文件类型在扫描期间改变");
          const file = { libraryId: library.id, path, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
          if (mimeType) {
            const role = libraryRole(library, path);
            if (!mimeType.startsWith(isAudioRole(role) ? "audio/" : "image/")) {
              warnings.push("素材扩展名与配置用途不符：" + library.id + "/" + path); continue;
            }
            entries.push({ ...file, name: basename(path), category: dirname(path) === "." ? "" : dirname(path), role, mimeType });
          } else documents.push(file);
        }
      }
    };
    try { visit("", 0); }
    catch (error) { warnings.push("素材库扫描不完整：" + library.id + "（" + (error instanceof Error ? error.message : "未知错误") + "）"); }
  }
  return { entries, documents, warnings };
}

function inventoryHash(scan: { entries: Entry[]; documents: LibraryFile[] }) {
  return valueHash({ entries: scan.entries, documents: scan.documents });
}
function unhashed(index: Index) {
  return { entries: index.entries.map(({ sha256, ...file }) => file), documents: index.documents.map(({ sha256, ...file }) => file) };
}

/** 完整扫描与摘要校验后原子替换索引；失败保留上一份，索引不能替代文件。 */
export function rebuildLibraryIndex(assetRoot: string, libraries: LibraryRoot[]) {
  const path = libraryIndexPath(assetRoot), scan = scanLibraries(libraries);
  if (scan.warnings.length) throw new Error(scan.warnings.join("\n"));
  const withHash = <T extends LibraryFile>(file: T) => {
    const library = libraries.find(item => item.id === file.libraryId)!;
    return { ...file, sha256: fileHash(ownedPath(library.path, file.path)) };
  };
  const index = indexSchema.parse({ schemaVersion: 1, generatedAt: new Date().toISOString(),
    configSha256: valueHash(libraries), libraries, basis: "directory_and_filename", listeningStatus: "not_checked", onlineStatus: "not_checked",
    entries: scan.entries.map(withHash), documents: scan.documents.map(withHash) });
  const after = scanLibraries(libraries);
  if (after.warnings.length || inventoryHash(after) !== inventoryHash(scan)) throw new Error("建立索引期间素材目录发生变化，未替换旧索引。");
  atomicJson(path, index);
  const groups = new Map<string, number>();
  for (const entry of index.entries) groups.set(entry.sha256, (groups.get(entry.sha256) ?? 0) + 1);
  return { path, generatedAt: index.generatedAt, total: index.entries.length, documents: index.documents.length,
    roles: Object.fromEntries(assetRoleSchema.options.map(role => [role, index.entries.filter(entry => entry.role === role).length])),
    duplicateGroups: [...groups.values()].filter(count => count > 1).length,
    note: "按目录与文件名建立索引；重复内容仅统计，原件未改动。未试听、未进行网上核实。" };
}

/** 每次检索先核对清单和文件状态；旧索引不用作当前事实，退回实时目录并明确提示。 */
export function readLibraryCatalog(assetRoot: string, libraries: LibraryRoot[]) {
  const scan = scanLibraries(libraries), path = libraryIndexPath(assetRoot);
  let status: "current" | "missing" | "stale" | "invalid" = "missing";
  if (existsSync(path)) {
    try {
      const index = indexSchema.parse(readJson(path));
      if (!scan.warnings.length && index.configSha256 === valueHash(libraries) && index.configSha256 === valueHash(index.libraries) &&
        inventoryHash(unhashed(index)) === inventoryHash(scan)) {
        return { entries: index.entries as (Entry & { sha256?: string })[], documents: index.documents,
          warnings: scan.warnings, index: { path, status: "current" as const, generatedAt: index.generatedAt } };
      }
      status = "stale";
    } catch { status = "invalid"; }
  }
  if (libraries.length) scan.warnings.push("素材索引" + ({ missing: "尚未建立", stale: "已过期", invalid: "不可读取或格式无效" }[status]) +
    "；本次按实时目录返回候选。请运行 " + refreshLibraryCommand + " 刷新。");
  return { entries: scan.entries as (Entry & { sha256?: string })[], documents: scan.documents,
    warnings: scan.warnings, index: { path, status } };
}
