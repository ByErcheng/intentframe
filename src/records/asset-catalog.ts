import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { configuration } from "../config.ts";
import { ownedPath } from "./files.ts";
import { fileHash } from "../common/file-hash.ts";
import { AssetStore, assetMimeTypes } from "./asset-store.ts";
import type { WorkRecord, WorkStore } from "./work-store.ts";
import type { Asset } from "./media-contracts.ts";
import { narrationMetadata } from "../media/audio-timing.ts";

export const assetSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), libraryId: z.string(), path: z.string().min(1) }),
  z.object({ kind: z.literal("work"), workId: z.string(), assetId: z.string() }),
]);
export type AssetSource = z.infer<typeof assetSourceSchema>;
export type LibraryRoot = { id: string; path: string; role: Asset["role"] };
export const assetSearchSchema = z.object({ query: z.string().max(500).default(""), role: z.enum(["reference", "image", "narration", "music"]).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) });

/** 复用作品记录作索引，不移动旧文件；本机目录只读发现，选择后才复制到当前作品。 */
export class AssetCatalog {
  readonly store: WorkStore;
  readonly libraries: LibraryRoot[];
  constructor(store: WorkStore, libraries: LibraryRoot[] = configuration.assetLibraries) { this.store = store; this.libraries = libraries; }

  search(input: z.input<typeof assetSearchSchema>) {
    const args = assetSearchSchema.parse(input), terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows: { source: AssetSource; label: string; role: Asset["role"]; state: string; bytes: number; sha256?: string; usedIn?: string[] }[] = [];
    const matches = (text: string, role: string) => (!args.role || args.role === role) && terms.every(term => text.toLocaleLowerCase().includes(term));
    for (const work of this.store.list().map(item => this.store.read(item.id))) for (const asset of work.assets ?? []) {
      if (!matches(work.title + " " + asset.description + " " + asset.origin, asset.role)) continue;
      const usedIn = work.versions.filter(version => version.assets?.some(item => item.id === asset.id)).map(version => version.id);
      rows.push({ source: { kind: "work", workId: work.id, assetId: asset.id }, label: asset.description,
        role: asset.role, state: usedIn.length ? "used" : "candidate", bytes: asset.bytes, sha256: asset.sha256, usedIn });
    }
    let scanned = 0; const warnings: string[] = [];
    for (const library of this.libraries) {
      if (args.role && library.role !== args.role) continue;
      const visit = (key: string, depth: number) => {
        if (scanned >= 10000 || depth > 20) { warnings.push("目录扫描达到本次上限：" + library.id); return; }
        const directory = ownedPath(library.path, key);
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++scanned > 10000) { warnings.push("目录扫描达到本次上限：" + library.id); return; }
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const path = join(key, entry.name);
          if (entry.isDirectory()) visit(path, depth + 1);
          else if (entry.isFile() && assetMimeTypes[extname(path).toLowerCase()] && matches(path, library.role)) {
            rows.push({ source: { kind: "library", libraryId: library.id, path }, label: path, role: library.role,
              state: "uninspected", bytes: lstatSync(ownedPath(library.path, path)).size });
          }
        }
      };
      try { visit("", 0); } catch { warnings.push("素材库不可读取：" + library.id); }
    }
    const end = args.offset + args.limit;
    return { items: rows.slice(args.offset, end), total: rows.length, nextOffset: end < rows.length ? end : null,
      warnings: [...new Set(warnings)], note: "分类和名称仅用于候选检索，不能代替查看或试听；used 只表示被引用过，不代表适合本次设计。" };
  }

  resolve(source: AssetSource) {
    source = assetSourceSchema.parse(source);
    if (source.kind === "library") {
      const library = this.libraries.find(item => item.id === source.libraryId);
      if (!library) throw new Error("素材库未配置。");
      const location = ownedPath(library.path, source.path), stat = lstatSync(location);
      const mimeType = assetMimeTypes[extname(location).toLowerCase()];
      if (!stat.isFile() || !mimeType || stat.size > 128 * 1024 * 1024) throw new Error("素材类型或体积不受支持。");
      return { location, mimeType, role: library.role, sha256: fileHash(location), description: source.path, metadata: undefined as unknown };
    }
    const record = this.store.read(source.workId), assets = new AssetStore(this.store), view = assets.view(record, source.assetId);
    return { location: view.location, mimeType: view.mimeType, role: view.role, sha256: view.sha256, description: view.description, metadata: view.metadata };
  }

  async reuseOwned(work: WorkRecord, source: AssetSource, operationId: string, description: string, expectedSha256?: string, signal?: AbortSignal) {
    const resolved = this.resolve(source);
    if (expectedSha256 && resolved.sha256 !== expectedSha256) throw new Error("所选素材已改变，请重新检查。");
    const bytes = readFileSync(resolved.location);
    const narration = narrationMetadata(resolved.metadata);
    const assets = new AssetStore(this.store);
    const asset = await assets.write(work, { bytes, extension: extname(resolved.location).toLowerCase(), role: resolved.role,
      description, origin: source.kind === "work" ? "work:" + source.workId + "/" + source.assetId : "library:" + source.libraryId + "/" + source.path,
      operationId, metadata: { source, sha256: resolved.sha256, original: resolved.metadata ?? null,
        ...(narration ? { response: narration } : {}) } }, signal);
    if (asset.sha256 !== resolved.sha256) throw new Error("素材读取期间发生变化，未登记。");
    return assets.register(work, asset);
  }
}
