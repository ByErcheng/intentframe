import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { AssetStore } from "../src/records/asset-store.ts";
import { AssetCatalog } from "../src/records/asset-catalog.ts";
import { AssetService } from "../src/runtime/asset-service.ts";
import { ProductionMediaTools } from "../src/runtime/production-media.ts";
import { NativeToolOutput } from "../src/runtime/codex-client.ts";
import { audioPlacementSchema, mapNarration } from "../src/media/audio-timing.ts";
import { readAudioPlan, saveAudioPlan } from "../src/runtime/audio-plan.ts";
import { publicImageUrl } from "../src/media/download-image.ts";
import { rgbPng } from "../src/media/review-materials.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { adoptedDesign, fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

async function setup() {
  const root = fixtureRoot(), store = new WorkStore(root.path), initial = store.create("内部素材", "合成验证");
  const ref = await adoptedDesign(store, initial.id, "# 合成设计\n声音：温柔。\n```speech:offer\n这朵花，送给你。\n```\n");
  const work = store.read(initial.id), version = readyVersion(store, work.id, "v001", "sample");
  version.designRef = ref; version.production = "creating"; work.versions.push(version);
  work.execution = { status: "running", runId: version.runId, versionId: version.id }; store.save(work);
  return { root, store, work, version, ref };
}
function wav() {
  const data = Buffer.alloc(44 + 24000 * 2); data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(data.length - 44, 40); return data;
}

test("制作内部生成不覆盖父任务身份；同编号重取、同素材复用和真实图片查看不再次生成", async () => {
  const { root, store, work, version } = await setup(); let calls = 0;
  try {
    const bytes = rgbPng(8, 8, Buffer.alloc(192, 60));
    const service = new AssetService(store, { providerSettings: { image: { apiKey: "secret-image-key", model: "fixture", timeoutMs: 1000 } },
      providerFetch: async () => { calls++; return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }); } });
    const tools = new ProductionMediaTools(store, work, version.runId, service, version, { libraries: [] });
    await store.withLock(work.id, async () => {
      const input = { operationKey: "bear", prompt: "合成图片", description: "测试角色" };
      const first = await tools.call("intentframe_generate_image", input) as { id: string; source: string; location: string };
      const second = await tools.call("intentframe_generate_image", input) as { id: string };
      assert.equal(calls, 1); assert.equal(first.id, second.id); assert.deepEqual(readFileSync(first.location), bytes);
      assert.equal(store.read(work.id).execution.runId, version.runId);
      assert.equal(store.read(work.id).execution.status, "running");
      assert(existsSync(join(dirname(store.resolvePath(version.sourcePath)), "public", first.source)));
      await assert.rejects(tools.call("intentframe_generate_image", { ...input, prompt: "另一个请求" }), /不同输入/);
      const inspected = await tools.call("intentframe_inspect_asset", { source: { kind: "work", workId: work.id, assetId: first.id } });
      assert(inspected instanceof NativeToolOutput);
      assert(inspected.contentItems.some(item => item.type === "inputImage" && item.imageUrl.startsWith("data:image/png;base64,")));
      await tools.settled();
    });
    const requestId = version.assetRequestIds![0]!;
    const response = readFileSync(join(store.workDirectory(work.id), "assets", "requests", requestId, "provider-response.json"), "utf8");
    assert(!response.includes("secret-image-key"));
    assert.equal(version.assets!.length, 1);
  } finally { root.cleanup(); }
});

test("内部生成结果不明时保留父任务和请求，禁止换编号重发或通过完成检查", async () => {
  const { root, store, work, version } = await setup(); let calls = 0;
  try {
    const assets = new AssetService(store, { providerSettings: { image: { apiKey: "fixture", model: "fixture", timeoutMs: 1000 } },
      providerFetch: async () => { calls++; throw new Error("未知网络结果"); } });
    const tools = new ProductionMediaTools(store, work, version.runId, assets, version, { libraries: [] });
    await store.withLock(work.id, async () => {
      await assert.rejects(tools.call("intentframe_generate_image", { operationKey: "first", prompt: "图", description: "图" }));
      await assert.rejects(tools.call("intentframe_generate_image", { operationKey: "second", prompt: "图", description: "图" }), /尚未核清/);
      await assert.rejects(tools.settled(), /尚未核清/);
      assert.equal(work.execution.runId, version.runId); assert.equal(calls, 1);
    });
  } finally { root.cleanup(); }
});

test("供应商原响应先保存；派生输出丢失时离线恢复，不使用新配置重发", async t => {
  const { root, store, work, ref } = await setup(); let calls = 0;
  try {
    work.execution = { status: "idle" }; store.save(work);
    const bytes = rgbPng(8, 8, Buffer.alloc(192, 100)), assets = new AssetService(store, {
      providerSettings: { image: { apiKey: "fixture-secret", model: "fixture-model", timeoutMs: 1000 } },
      providerFetch: async () => { calls++; return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }); },
    });
    t.mock.method(assets.assets, "write", async () => { throw new Error("模拟保存中断"); }, { times: 1 });
    await assert.rejects(assets.generate(work.id, { kind: "image", document: ref, prompt: "图", referenceAssetIds: [], description: "恢复" }, "raw-response"));
    const directory = join(store.workDirectory(work.id), "assets", "requests", "raw-response");
    assert(existsSync(join(directory, "provider-response.json")));
    // 模拟只剩已接收原响应的现场。
    rmSync(join(directory, "provider-output.bin")); rmSync(join(directory, "provider-output.json"));
    const recovered = await new AssetService(store, { providerSettings: {}, providerFetch: async () => { throw new Error("恢复不能联网"); } }).recover(work.id);
    assert.equal(recovered.status, "recovered"); assert.equal(calls, 1);
    const asset = store.read(work.id).assets![0]!;
    assert.deepEqual(readFileSync(store.resolvePath(asset.path)), bytes);
  } finally { root.cleanup(); }
});

test("本机素材按配置目录检索、试听和复用；越界及文件替换拒绝，历史作品可跨作品复用", async () => {
  const { root, store, work, version } = await setup();
  try {
    const library = join(root.path, "music"), source = join(library, "轻松", "候选.wav"); mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, wav());
    symlinkSync(join(root.path, "outside.wav"), join(library, "link.wav"));
    const libraries = [{ id: "music", path: library, role: "music" as const }], catalog = new AssetCatalog(store, libraries);
    const found = catalog.search({ query: "轻松", role: "music" }); assert.equal(found.total, 1);
    const sourceRef = found.items[0]!.source, resolved = catalog.resolve(sourceRef);
    assert.throws(() => catalog.resolve({ kind: "library", libraryId: "music", path: "../outside.wav" }), /根目录/);
    assert.throws(() => catalog.resolve({ kind: "library", libraryId: "music", path: "link.wav" }), /链接/);
    const tools = new ProductionMediaTools(store, work, version.runId, new AssetService(store), version, { libraries });
    await store.withLock(work.id, async () => {
      const prepared = await tools.call("intentframe_inspect_asset", { source: sourceRef, prepareAudioPreview: true, durationSeconds: 0.3 }) as { listeningStatus: string; audioLocation: string };
      assert.equal(prepared.listeningStatus, "not_checked"); assert(existsSync(prepared.audioLocation));
      assert(!JSON.stringify(prepared).includes("base64"), "不将音频内容发送给模型");
      await tools.call("intentframe_reuse_asset", { operationKey: "music", source: sourceRef, expectedSha256: resolved.sha256, description: "测试音乐" });
      writeFileSync(source, Buffer.concat([wav(), Buffer.from("变化")]));
      await assert.rejects(tools.call("intentframe_reuse_asset", { operationKey: "changed", source: sourceRef, expectedSha256: resolved.sha256, description: "已变化" }), /已改变/);
    });
    const other = store.create("其他作品", "复用素材"), stored = work.assets![0]!;
    await store.withLock(other.id, () => catalog.reuseOwned(other, { kind: "work", workId: work.id, assetId: stored.id }, "reuse", "复用音乐"));
    assert.equal(store.read(other.id).assets![0]!.sha256, stored.sha256);
    assert.equal(new AssetCatalog(store, []).search({ query: "测试音乐" }).total, 1);
  } finally { root.cleanup(); }
});

test("语音事件使用真实边界，播放偏移与速度一致换算；重复词和字内定位不能猜测", () => {
  const metadata = { text: "你好。你好。", timingSource: "provider_returned" as const,
    words: [{ text: "你", startMs: 100, endMs: 200 }, { text: "好。", startMs: 200, endMs: 500 }, { text: "你", startMs: 600, endMs: 700 }, { text: "好。", startMs: 700, endMs: 900 }] };
  const placement = audioPlacementSchema.parse({ id: "voice", assetId: "test", startMs: 3000, playbackRate: 2,
    cues: [{ name: "hello", quote: "你", occurrence: 2 }, { name: "end", quote: "好", occurrence: 2, edge: "end" }] });
  const result = mapNarration(placement, metadata, 1000);
  assert.equal(result.events.hello, 3300); assert.equal(result.events.end, 3450); assert.equal(result.words[0]!.startMs, 3050);
  assert.throws(() => mapNarration({ ...placement, cues: [{ name: "bad", quote: "你", edge: "start" }] }, metadata, 1000), /重复/);
  assert.throws(() => mapNarration({ ...placement, trimStartMs: 150 }, metadata, 1000), /字词内部/);
  assert.throws(() => mapNarration({ ...placement, cues: [{ name: "bad", quote: "不存在", edge: "start" }] }, metadata, 1000), /不存在/);
  const single = { ...metadata, text: "hello", words: [{ text: "hello", startMs: 0, endMs: 800 }] };
  assert.throws(() => mapNarration({ ...placement, cues: [{ name: "bad", quote: "ell", edge: "start" }] }, single, 1000), /缺少精确边界/);
});

test("声音播放依据驱动工程并保留每次记录，改配音后事件更新且旧素材不变", async () => {
  const { root, store, work, version } = await setup();
  try {
    await store.withLock(work.id, async () => {
      const assets = new AssetStore(store);
      const create = async (operationId: string, start: number) => {
        const asset = await assets.write(work, { bytes: wav(), extension: ".wav", role: "narration", description: "合成声音",
          origin: "fixture", operationId, metadata: { response: { text: "你好。", timingSource: "provider_returned", words: [{ text: "你好。", startMs: start, endMs: 900 }] } } });
        assets.register(work, asset); return asset;
      };
      const first = await create("first", 100), second = await create("second", 300);
      const settings = { id: "hello", startMs: 2000, cues: [{ name: "start", quote: "你好。" }] };
      saveAudioPlan(store, work, version, { clips: [{ ...settings, assetId: first.id }] });
      assert.equal(readAudioPlan(store, version)!.events["hello.start"], 2100);
      saveAudioPlan(store, work, version, { clips: [{ ...settings, assetId: second.id }] });
      assert.equal(readAudioPlan(store, version)!.events["hello.start"], 2300);
      assert.deepEqual(readFileSync(store.resolvePath(first.path)), wav());
      writeFileSync(join(dirname(store.resolvePath(version.sourcePath)), "intentframe-audio.tsx"), "被改坏");
      assert.throws(() => readAudioPlan(store, version), /工具外改变/);
    });
  } finally { root.cleanup(); }
});

test("网上图片入口拒绝本机、私网、凭据和非HTTPS地址", () => {
  for (const url of ["http://example.com/image.png", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://user:pass@example.com/x"]) {
    assert.throws(() => publicImageUrl(url), /公开/);
  }
  assert.equal(publicImageUrl("https://example.com/image.png").protocol, "https:");
});

test("采用脚本需要人声时不能仅凭模型完成声明交付无配音工程", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("配音缺失", "合成需要配音的需求");
    const designRef = await adoptedDesign(store, work.id, "```speech:voice\n你好。\n```\n");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender, assetLibraries: [] });
    await assert.rejects(service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "missing-voice", { designRef }), /缺少已编排的真实配音/);
    assert.notEqual(store.read(work.id).versions[0]!.production, "ready");
  } finally { root.cleanup(); }
});

test("运行中的 Agent 能调用素材工具并继续交付源码；未知素材不会被完成声明掩盖", async t => {
  for (const unknown of [false, true]) await t.test(unknown ? "unknown" : "completed", async () => {
    const root = fixtureRoot(); let calls = 0;
    try {
      const store = new WorkStore(root.path), initial = store.create("原生工具交接", "合成素材与源码交接。");
      const designRef = await adoptedDesign(store, initial.id);
      const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "media_tools"), render: fixtureRender,
        prepareReview: async () => undefined, assetLibraries: [], providerSettings: { image: { apiKey: "fixture-secret", model: "fixture", timeoutMs: 1000 } },
        providerFetch: async () => { calls++; if (unknown) throw new Error("模拟请求未知"); return Response.json({ data: [{ b64_json: rgbPng(8, 8, Buffer.alloc(192, 20)).toString("base64") }] }); } });
      const operation = service.produce(initial.id, "sample", undefined, "fresh", undefined, undefined, "internal-tool", { designRef });
      if (unknown) { await assert.rejects(operation, /尚未核清/); assert.equal(store.read(initial.id).execution.status, "unknown"); }
      else {
        const result = await operation, version = result.versions[0]!;
        assert.equal(version.assets!.length, 1); assert.equal(version.assetRequestIds!.length, 1);
        assert(version.sourceSnapshot!.files["media-tool-results.json"]);
        const received = JSON.parse(readFileSync(join(dirname(store.resolvePath(version.sourcePath)), "media-tool-results.json"), "utf8"));
        assert.equal(received.first.success, true); assert.equal(received.second.success, true);
        assert.equal(JSON.parse(received.first.contentItems[0].text).id, JSON.parse(received.second.contentItems[0].text).id);
      }
      assert.equal(calls, 1);
    } finally { root.cleanup(); }
  });
});
