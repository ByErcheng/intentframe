import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assetLibrarySchema, configuration } from "../src/config.ts";
import { fileHash } from "../src/common/file-hash.ts";
import { captureSourceSnapshot } from "../src/records/source-snapshot.ts";
import { rebuildLibraryIndex, libraryIndexPath, libraryRole, libraryUsage, currentLibraryUsage, readLibraryCatalog } from "../src/records/asset-library.ts";
import { AssetCatalog } from "../src/records/asset-catalog.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { AssetStore } from "../src/records/asset-store.ts";
import { readAudioPlan, saveAudioPlan } from "../src/runtime/audio-plan.ts";
import { inputs } from "../src/mcp/server.ts";
import { workSummary, workSection } from "../src/mcp/work-view.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fixtureRoot, readyVersion } from "./helpers.ts";

function fixture() {
  const root = fixtureRoot(), path = join(root.path, "library/music");
  const libraries = [{ id: "music", path, role: "music" as const,
    roleOverrides: [{ path: "自然-特效", role: "sound_effect" as const }] }];
  const put = (name: string, bytes: string | Buffer = name) => {
    const location = join(path, name); mkdirSync(dirname(location), { recursive: true }); writeFileSync(location, bytes); return location;
  };
  put("舒缓/曲目.mp3", "same"); put("另一分类/副本.mp3", "same"); put("自然-特效/雨声.mp3");
  put("舒缓/来源.txt", "合成来源说明，未核实。");
  return { ...root, libraries, put, store: new WorkStore(root.path) };
}

test("索引仅凭名称分类并记录字节身份、说明附件及重复内容，不需音频解码或试听", () => {
  const f = fixture();
  try {
    f.put(".hidden.mp3"); symlinkSync(join(f.path, "outside.mp3"), join(f.libraries[0]!.path, "link.mp3"));
    const result = rebuildLibraryIndex(f.path, f.libraries);
    assert.equal(result.total, 3); assert.equal(result.documents, 1); assert.equal(result.duplicateGroups, 1);
    assert.deepEqual(result.roles, { reference: 0, image: 0, narration: 0, music: 2, sound_effect: 1 });
    const index = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(index.basis, "directory_and_filename"); assert.equal(index.listeningStatus, "not_checked");
    assert.equal(index.onlineStatus, "not_checked");
    const catalog = new AssetCatalog(f.store, f.libraries);
    const found = catalog.search({ query: "雨声", role: "sound_effect" });
    assert.equal(found.index.status, "current"); assert.equal(found.total, 1); assert.deepEqual(found.warnings, []);
    assert.equal(found.items[0]!.listeningStatus, "not_checked");
    assert.equal(found.items[0]!.source.kind, "library");
    assert.equal(found.items[0]!.sha256, fileHash(join(f.libraries[0]!.path, "自然-特效/雨声.mp3")));
    const music = catalog.search({ query: "舒缓", role: "music" });
    assert.equal(music.total, 1); assert.deepEqual(music.items[0]!.documents, [{ libraryId: "music", path: "舒缓/来源.txt" }]);
    assert.equal(catalog.search({ query: "", role: "music" }).total, 2);
    const first = catalog.search({ limit: 2 }); assert.equal(first.nextOffset, 2);
    assert.equal(catalog.search({ offset: 2, limit: 2 }).items.length, 1);
    // 两个用途的任务共用配置库和总目录索引，不读取另一区域的作品记录。
    const testing = new WorkStore(join(f.path, "testing"), "test", f.path);
    assert.equal(new AssetCatalog(testing, f.libraries).search({ role: "sound_effect" }).index.status, "current");
  } finally { f.cleanup(); }
});

test("新增、移除、改名、内容及分类变化使索引过期，检索退回当前文件并提示刷新", () => {
  const f = fixture(), catalog = new AssetCatalog(f.store, f.libraries);
  try {
    assert.equal(catalog.search({}).index.status, "missing");
    rebuildLibraryIndex(f.path, f.libraries);
    const selected = catalog.search({ role: "sound_effect" }).items[0]!.source;
    f.put("自然-特效/雨声.mp3", "changed");
    assert.equal(catalog.search({}).index.status, "stale");
    assert.throws(() => catalog.resolve(selected), /索引素材已改变/);
    rebuildLibraryIndex(f.path, f.libraries);
    f.put("舒缓/新增.mp3");
    assert.equal(catalog.search({ query: "新增" }).total, 1);
    assert.equal(catalog.search({}).index.status, "stale");
    rebuildLibraryIndex(f.path, f.libraries);
    rmSync(join(f.libraries[0]!.path, "舒缓/新增.mp3"));
    assert.equal(catalog.search({ query: "新增" }).total, 0);
    assert.equal(catalog.search({}).index.status, "stale");
    rebuildLibraryIndex(f.path, f.libraries);
    renameSync(join(f.libraries[0]!.path, "自然-特效/雨声.mp3"), join(f.libraries[0]!.path, "自然-特效/降雨.mp3"));
    assert.equal(catalog.search({ query: "雨声" }).total, 0);
    assert.equal(catalog.search({ query: "降雨" }).total, 1);
    assert.match(catalog.search({}).warnings.join(" "), /index-assets/);
    rebuildLibraryIndex(f.path, f.libraries);
    const changed = [{ ...f.libraries[0]!, roleOverrides: [] }];
    const result = new AssetCatalog(f.store, changed).search({ role: "sound_effect" });
    assert.equal(result.index.status, "stale"); assert.equal(result.total, 0);
  } finally { f.cleanup(); }
});

test("损坏或漏项索引不能冒充当前清单，不完整重建保留旧索引，路径与类型边界保持可见", () => {
  const f = fixture();
  try {
    rebuildLibraryIndex(f.path, f.libraries);
    const path = libraryIndexPath(f.path), original = readFileSync(path, "utf8");
    const index = JSON.parse(original); index.entries.pop(); writeFileSync(path, JSON.stringify(index));
    assert.equal(readLibraryCatalog(f.path, f.libraries).index.status, "stale");
    writeFileSync(path, "invalid");
    assert.equal(readLibraryCatalog(f.path, f.libraries).index.status, "invalid");
    rebuildLibraryIndex(f.path, f.libraries);
    const before = readFileSync(path, "utf8");
    assert.throws(() => rebuildLibraryIndex(f.path, [...f.libraries, { id: "missing", path: join(f.path, "missing"), role: "image" }]), /不完整/);
    assert.equal(readFileSync(path, "utf8"), before);
    f.put("舒缓/错放图片.png");
    assert.throws(() => rebuildLibraryIndex(f.path, f.libraries), /扩展名与配置用途不符/);
    assert.equal(readFileSync(path, "utf8"), before);
    const catalog = new AssetCatalog(f.store, f.libraries);
    for (const key of ["../outside.mp3", "/outside.mp3", "自然-特效/../舒缓/曲目.mp3"]) {
      assert.throws(() => catalog.resolve({ kind: "library", libraryId: "music", path: key }), /根目录/);
    }
    assert.throws(() => assetLibrarySchema.parse({ ...f.libraries[0], roleOverrides: [{ path: "../outside", role: "sound_effect" }] }), /根目录/);
    assert.throws(() => assetLibrarySchema.parse({ ...f.libraries[0], roleOverrides: [
      { path: "音效", role: "sound_effect" }, { path: "音效", role: "music" }] }), /分类路径不能重复/);
  } finally { f.cleanup(); }
});

test("用途覆盖按完整路径边界和最长路径选择，支持个别文件纠正而不移动原件", () => {
  const library = assetLibrarySchema.parse({ id: "music", path: "/synthetic", role: "music", roleOverrides: [
    { path: "effects", role: "sound_effect" }, { path: "effects/曲目.mp3", role: "music" },
  ] });
  assert.equal(libraryRole(library, "effects/rain.wav"), "sound_effect");
  assert.equal(libraryRole(library, "effects/曲目.mp3"), "music");
  assert.equal(libraryRole(library, "effects-extra/曲目.mp3"), "music");
});

function silentWav() {
  const bytes = Buffer.alloc(44 + 24000 * 2); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}

test("本机声明与署名提醒按配置及完整路径返回，不外推到邻接目录或网上素材", () => {
  const f = fixture();
  try {
    const library = assetLibrarySchema.parse({ ...f.libraries[0], usageNotes: "合成用户声明：本库可商用。", attributionPaths: ["需署名"] });
    f.put("需署名/曲目.mp3"); f.put("需署名-其他/曲目.mp3");
    const catalog = new AssetCatalog(f.store, [library]);
    const rows = catalog.search({ query: "曲目" }).items;
    const credit = rows.find(item => item.label === "需署名/曲目.mp3")!.usage!;
    assert.match(credit.notes!, /合成用户声明/); assert.equal(credit.attributionRequired, true); assert.match(credit.attributionReminder!, /不阻塞/);
    assert.equal(rows.find(item => item.label === "需署名-其他/曲目.mp3")!.usage!.attributionRequired, false);
    assert.equal(catalog.resolve({ kind: "library", libraryId: library.id, path: "需署名/曲目.mp3" }).usage!.source, "local_library");
    assert.deepEqual(currentLibraryUsage("local:" + join(library.path, "需署名/曲目.mp3"), [library]), credit);
    assert.equal(currentLibraryUsage("local:" + join(library.path + "-other", "曲目.mp3"), [library]), undefined);
    assert.equal(currentLibraryUsage("https://example.com/曲目.mp3", [library]), undefined);
    assert.equal(currentLibraryUsage("library:music/../outside.mp3", [library]), undefined);
    assert.equal(libraryUsage(f.libraries[0]!, "舒缓/曲目.mp3").attributionRequired, undefined);
    assert.equal(assetLibrarySchema.safeParse({ ...library, attributionPaths: ["../outside"] }).success, false);
    assert.equal(assetLibrarySchema.safeParse({ ...library, usageNotes: " " }).success, false);
  } finally { f.cleanup(); }
});

test("署名声明贯穿导入、复用、版本摘要和历史查询，当前说明不改写原记录或工程", async () => {
  const f = fixture(), originalLibraries = configuration.assetLibraries;
  try {
    const library = assetLibrarySchema.parse({ ...f.libraries[0], usageNotes: "合成用户声明：可商用。", attributionPaths: ["需署名"] });
    configuration.assetLibraries = [library];
    const path = f.put("需署名/合成.wav", silentWav()), work = f.store.create("使用说明交接", "合成素材，无真实模型。");
    const assets = new AssetStore(f.store), imported = await assets.import(work.id, path, "music", "合成音乐", "usage-import");
    assert.equal(imported.usage!.attributionRequired, true);
    const old = f.store.read(work.id), oldAsset = old.assets![0]!;
    // 模拟升级前已导入的素材：没有结构化声明，旧文字和字节仍保留。
    delete oldAsset.usage; oldAsset.description = "历史：许可未核实";
    const version = readyVersion(f.store, work.id, "v001", "sample"); version.assets = [oldAsset]; old.versions.push(version); f.store.save(old);
    const task = join(f.path, "works", work.id, "task.json"), before = readFileSync(task, "utf8"), sourceHash = fileHash(f.store.resolvePath(version.sourcePath));
    const view = assets.view(f.store.read(work.id), oldAsset.id);
    assert.equal(view.usage, undefined); assert.match(view.currentLibraryUsage!.notes!, /可商用/);
    const service = new WorkService(f.store), summary = workSummary(service, work.id);
    assert.equal(summary.assetUsage[0]!.currentLibraryUsage!.attributionRequired, true);
    const materials = service.reviewMaterials.view(f.store.read(work.id), version);
    assert.equal(materials.assetUsage[0]!.currentLibraryUsage!.attributionRequired, true);
    assert.match(materials.assetUsage[0]!.currentLibraryUsage!.notes!, /可商用/);
    const section = workSection(service, work.id, "assets", 0, 20);
    assert.equal((section.items[0] as typeof view).currentLibraryUsage!.attributionRequired, true);
    assert.equal(readFileSync(task, "utf8"), before); assert.equal(fileHash(f.store.resolvePath(version.sourcePath)), sourceHash);
    const target = f.store.create("复用声明", "合成复用");
    const catalog = new AssetCatalog(f.store, [library]);
    const copied = await f.store.withLock(target.id, () => catalog.reuseOwned(target,
      { kind: "work", workId: work.id, assetId: oldAsset.id }, "usage-reuse", "复用合成音乐"));
    assert.equal(copied.usage!.attributionRequired, true);
    configuration.assetLibraries = [];
    assert.equal(new AssetCatalog(f.store, []).resolve({ kind: "work", workId: target.id, assetId: copied.id }).usage!.attributionRequired, true);
    assert.match(f.store.read(work.id).assets![0]!.description, /历史：许可未核实/);
  } finally { configuration.assetLibraries = originalLibraries; f.cleanup(); }
});

test("跨作品副本沿保存的库引用读取当前声明，历史记录不变且继续复用保留来源", async () => {
  const f = fixture(), originalLibraries = configuration.assetLibraries;
  try {
    const library = { ...f.libraries[0]!, usageNotes: "合成旧声明", attributionPaths: [] as string[] };
    configuration.assetLibraries = [library];
    const path = f.put("需署名/合成.wav", silentWav()), catalog = new AssetCatalog(f.store, [library]);
    const first = f.store.create("合成 A", "库引用"), second = f.store.create("合成 B", "跨作品引用");
    const original = await catalog.reuseOwned(first, { kind: "library", libraryId: library.id, path: "需署名/合成.wav" }, "first", "合成素材");
    const copied = await catalog.reuseOwned(second, { kind: "work", workId: first.id, assetId: original.id }, "copy", "跨作品副本");
    assert.equal(copied.usage!.attributionRequired, false);
    const version = readyVersion(f.store, second.id, "v001", "sample"); version.assets = [copied];
    const assets = new AssetStore(f.store);
    assets.copyToSource(second, [copied.id], dirname(f.store.resolvePath(version.sourcePath)));
    version.sourceSnapshot = captureSourceSnapshot(f.store.resolvePath(version.sourcePath));
    second.versions.push(version); f.store.save(second);
    const task = f.store.resolvePath("works/" + second.id + "/task.json"), before = readFileSync(task);
    const originalHash = fileHash(path);
    const current = { ...library, usageNotes: "合成新声明：发布需署名", attributionPaths: ["需署名"] };
    configuration.assetLibraries = [current];
    const service = new WorkService(f.store), record = f.store.read(second.id);
    const expected = libraryUsage(current, "需署名/合成.wav");
    assert.equal(currentLibraryUsage(copied.origin, [current]), undefined, "旧副本缺少库引用时不猜测来源");
    assert.equal(currentLibraryUsage(copied.origin, [current], { ...copied.usage!, path: "../outside.wav" }), undefined);
    assert.equal(currentLibraryUsage(copied.origin, [current], { ...copied.usage!, libraryId: "missing" }), undefined);
    assert.equal(currentLibraryUsage("https://example.com/a.wav", [current], copied.usage), undefined, "不将库声明扩展到网上来源");
    assert.deepEqual(assets.view(record, copied.id).currentLibraryUsage, expected);
    assert.deepEqual(workSummary(service, second.id).assetUsage[0]!.currentLibraryUsage, expected);
    assert.deepEqual((workSection(service, second.id, "assets", 0, 20).items[0] as typeof copied).currentLibraryUsage, expected);
    assert.deepEqual(service.reviewMaterials.view(record, version).assetUsage[0]!.currentLibraryUsage, expected);
    const latestCatalog = new AssetCatalog(f.store, [current]);
    assert.deepEqual(latestCatalog.search({}).items.find(item => item.source.kind === "work" && item.source.workId === second.id)!.currentLibraryUsage, expected);
    assert.deepEqual(assets.copyToSource(record, [copied.id], dirname(f.store.resolvePath(version.sourcePath)))[0]!.currentLibraryUsage, expected);
    const third = f.store.create("合成 C", "继续复用");
    const next = await latestCatalog.reuseOwned(third, { kind: "work", workId: second.id, assetId: copied.id }, "next", "再次复用");
    assert.deepEqual(next.usage, expected);
    assert.equal(f.store.read(second.id).assets![0]!.usage!.attributionRequired, false);
    assert.deepEqual(readFileSync(task), before); assert.equal(fileHash(path), originalHash);
    assert.deepEqual(captureSourceSnapshot(f.store.resolvePath(version.sourcePath)), version.sourceSnapshot);
    configuration.assetLibraries = [];
    const removed = assets.view(record, copied.id);
    assert.equal(removed.currentLibraryUsage, undefined); assert.equal(removed.usage!.attributionRequired, false);
  } finally { configuration.assetLibraries = originalLibraries; f.cleanup(); }
});

test("音效从索引进入作品、工程副本及播放安排，原件变化不破坏已保存版本", async () => {
  const f = fixture();
  try {
    const sourcePath = f.put("自然-特效/合成.wav", silentWav()), catalog = new AssetCatalog(f.store, f.libraries);
    rebuildLibraryIndex(f.path, f.libraries);
    const source = catalog.search({ query: "合成", role: "sound_effect" }).items[0]!.source;
    const work = f.store.create("合成音效验证", "不试听、不调用模型。");
    inputs.import_asset.parse({ operationId: "sound-effect", workId: work.id, path: sourcePath, role: "sound_effect", description: "合成音效" });
    const asset = await f.store.withLock(work.id, () => catalog.reuseOwned(work, source, "effect", "按名称选取的合成音效"));
    assert.equal(asset.role, "sound_effect");
    const version = readyVersion(f.store, work.id, "v001", "sample"); work.versions.push(version);
    saveAudioPlan(f.store, work, version, { clips: [{ id: "rain", assetId: asset.id, startMs: 500, trimEndMs: 750 }] });
    assert.equal(readAudioPlan(f.store, version)!.clips[0]!.endMs, 1250);
    const copy = new AssetStore(f.store).copyToSource(work, [asset.id], dirname(f.store.resolvePath(version.sourcePath)))[0]!;
    const location = join(dirname(f.store.resolvePath(version.sourcePath)), "public", copy.source);
    assert.equal(fileHash(location), asset.sha256);
    f.put("自然-特效/合成.wav", Buffer.from("changed"));
    assert.equal(fileHash(location), asset.sha256); assert.equal(new AssetStore(f.store).get(work, asset.id).sha256, asset.sha256);
  } finally { f.cleanup(); }
});
