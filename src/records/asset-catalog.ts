import { lstatSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { z } from "zod";
import { configuration, libraryRelativePathSchema } from "../config.ts";
import { ownedPath, valueHash } from "./files.ts";
import { fileHash } from "../common/file-hash.ts";
import { AssetStore } from "./asset-store.ts";
import { assetMimeTypes, assetRoleSchema, isAudioRole, voiceDeclarationSchema } from "./asset-types.ts";
import { libraryRole, libraryUsage, currentLibraryUsage, readLibraryCatalog } from "./asset-library.ts";
import type { LibraryUsage } from "./asset-types.ts";
import type { LibraryRoot } from "../config.ts";
import type { WorkRecord, WorkStore } from "./work-store.ts";
import type { Asset } from "./media-contracts.ts";
import { narrationMetadata } from "../media/audio-timing.ts";

export const assetSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), libraryId: z.string(), path: libraryRelativePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.object({ kind: z.literal("work"), workId: z.string(), assetId: z.string() }),
]);
export type AssetSource = z.infer<typeof assetSourceSchema>;
export type { LibraryRoot } from "../config.ts";
export const assetSearchSchema = z.object({ query: z.string().max(500).default(""), role: assetRoleSchema.optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) });

/** 复用作品记录作索引，不移动旧文件；本机目录只读发现，选择后才复制到当前作品。 */
export class AssetCatalog {
  readonly store: WorkStore;
  readonly libraries: LibraryRoot[];
  constructor(store: WorkStore, libraries: LibraryRoot[] = configuration.assetLibraries) { this.store = store; this.libraries = libraries; }

  search(input: z.input<typeof assetSearchSchema>) {
    const args = assetSearchSchema.parse(input), terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows: { source: AssetSource; label: string; role: Asset["role"]; state: string; bytes: number; sha256?: string; usedIn?: string[];
      usage?: LibraryUsage; currentLibraryUsage?: LibraryUsage;
      classificationBasis?: string; listeningStatus?: string; documents?: { libraryId: string; path: string }[] }[] = [];
    const matches = (text: string, role: string) => (!args.role || args.role === role) && terms.every(term => text.toLocaleLowerCase().includes(term));
    for (const work of this.store.list().map(item => this.store.read(item.id))) for (const asset of work.assets ?? []) {
      if (!matches(work.title + " " + asset.description + " " + asset.origin + " " + (asset.voice?.speaker ?? "") + " " + (asset.voice?.transcript?.text ?? ""), asset.role)) continue;
      const usedIn = work.versions.filter(version => version.assets?.some(item => item.id === asset.id)).map(version => version.id);
      rows.push({ source: { kind: "work", workId: work.id, assetId: asset.id }, label: asset.description,
        role: asset.role, state: usedIn.length ? "used" : "candidate", bytes: asset.bytes, sha256: asset.sha256, usedIn,
        usage: asset.usage, currentLibraryUsage: currentLibraryUsage(asset.origin, this.libraries, asset.usage) });
    }
    const library = readLibraryCatalog(this.store.assetRoot, this.libraries);
    for (const entry of library.entries) {
      if (!matches(entry.path, entry.role)) continue;
      const documents = library.documents.filter(document => document.libraryId === entry.libraryId &&
        (dirname(document.path) === "." || entry.path.startsWith(dirname(document.path) + "/")))
        .map(document => ({ libraryId: document.libraryId, path: document.path }));
      rows.push({ source: { kind: "library", libraryId: entry.libraryId, path: entry.path, sha256: entry.sha256 },
        label: entry.path, role: entry.role, state: "uninspected", bytes: entry.bytes, sha256: entry.sha256,
        usage: libraryUsage(this.libraries.find(item => item.id === entry.libraryId)!, entry.path),
        classificationBasis: "directory_and_filename", ...(entry.mimeType.startsWith("audio/") ? { listeningStatus: "not_checked" } : {}), documents });
    }
    const end = args.offset + args.limit;
    return { items: rows.slice(args.offset, end), total: rows.length, nextOffset: end < rows.length ? end : null,
      index: library.index, warnings: [...new Set(library.warnings)],
      note: "分类与文件名用于候选选择，未试听；本机使用说明以 usage/currentLibraryUsage 中的配置声明为准，无需重复追查已明确声明的许可。附件只表示存在说明，未读取其内容。used 只表示被引用过。" };
  }

  resolve(source: AssetSource) {
    source = assetSourceSchema.parse(source);
    if (source.kind === "library") {
      const library = this.libraries.find(item => item.id === source.libraryId);
      if (!library) throw new Error("素材库未配置。");
      const location = ownedPath(library.path, source.path), stat = lstatSync(location);
      const mimeType = assetMimeTypes[extname(location).toLowerCase()];
      if (!stat.isFile() || !mimeType || stat.size > 128 * 1024 * 1024) throw new Error("素材类型或体积不受支持。");
      const role = libraryRole(library, source.path), sha256 = fileHash(location);
      if (!mimeType.startsWith(isAudioRole(role) ? "audio/" : "image/")) throw new Error("素材用途与文件类型不符。");
      if (source.sha256 && source.sha256 !== sha256) throw new Error("所选索引素材已改变，请刷新索引并重新选择。");
      return { location, mimeType, role, sha256, description: source.path, voice: undefined,
        usage: libraryUsage(library, source.path), metadata: undefined as unknown };
    }
    const record = this.store.read(source.workId), assets = new AssetStore(this.store), view = assets.view(record, source.assetId);
    return { location: view.location, mimeType: view.mimeType, role: view.role, sha256: view.sha256, description: view.description,
      voice: view.voice, usage: currentLibraryUsage(view.origin, this.libraries, view.usage) ?? view.usage, metadata: view.metadata };
  }

  async reuseOwned(work: WorkRecord, source: AssetSource, operationId: string, description: string, expectedSha256?: string,
    signal?: AbortSignal, voice?: z.infer<typeof voiceDeclarationSchema>) {
    const resolved = this.resolve(source);
    if (expectedSha256 && resolved.sha256 !== expectedSha256) throw new Error("所选素材已改变，请重新检查。");
    const declaration = voice === undefined ? undefined : voiceDeclarationSchema.parse(voice);
    if (declaration && resolved.role !== "narration") throw new Error("人声身份声明仅适用于 narration 素材。");
    if (declaration && resolved.voice && valueHash(declaration) !== valueHash(resolved.voice)) {
      throw new Error("声明与已有的人声身份记录不一致，不能在复用时改写；请先核对来源。");
    }
    const bytes = readFileSync(resolved.location);
    const narration = narrationMetadata(resolved.metadata);
    const assets = new AssetStore(this.store);
    const asset = await assets.write(work, { bytes, extension: extname(resolved.location).toLowerCase(), role: resolved.role,
      description, origin: source.kind === "work" ? "work:" + source.workId + "/" + source.assetId : "library:" + source.libraryId + "/" + source.path,
      operationId, voice: resolved.voice ?? declaration, usage: resolved.usage, metadata: { source, sha256: resolved.sha256, original: resolved.metadata ?? null,
        ...(declaration ? { voiceDeclaration: declaration } : {}),
        ...(narration ? { response: narration } : {}) } }, signal);
    if (asset.sha256 !== resolved.sha256) throw new Error("素材读取期间发生变化，未登记。");
    return assets.register(work, asset);
  }
}
