import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { repositoryRoot } from "../src/config.ts";
import type { VoiceInfo } from "../src/records/asset-types.ts";
import { downloadAsset, identifyMedia, publicAssetUrl } from "../src/media/download-asset.ts";
import { rgbPng } from "../src/media/review-materials.ts";
import { mediaBinaries, mediaCommand } from "../src/media/render.ts";
import { generateAudio, selectSpeechVoice } from "../src/media/providers.ts";
import type { ProviderResponse } from "../src/media/providers.ts";
import { AssetService } from "../src/runtime/asset-service.ts";
import { ProductionMediaTools, mediaToolDefinitions } from "../src/runtime/production-media.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { AssetStore } from "../src/records/asset-store.ts";
import { AssetCatalog } from "../src/records/asset-catalog.ts";
import { captureSourceSnapshot } from "../src/records/source-snapshot.ts";
import { executeTool, executeToolInline, inputs } from "../src/mcp/server.ts";
import { ExecutionStore } from "../src/records/execution-store.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { valueHash } from "../src/records/files.ts";
import { readAudioPlan, saveAudioPlan } from "../src/runtime/audio-plan.ts";
import { adoptedDesign, fakeCodex, fixtureRender, fixtureRoot, readyVersion } from "./helpers.ts";

type Transport = NonNullable<Parameters<typeof downloadAsset>[3]>;
function transport(responses: { status?: number; headers?: Record<string, string>; bytes?: Buffer; aborted?: boolean }[], addresses = ["93.184.215.14"]) {
  const requests: string[] = [];
  const adapter: Transport = {
    lookup: async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 })),
    request: (url, options, callback) => {
      requests.push(url.href);
      const spec = responses[requests.length - 1]; assert(spec, "不能隐式重新下载");
      options.lookup!(url.hostname, { all: true }, (error: unknown, actual: unknown) => {
        assert.equal(error, null); assert.deepEqual(actual, [{ address: addresses[0], family: addresses[0]!.includes(":") ? 6 : 4 }]);
      });
      const req = new EventEmitter() as ClientRequest;
      req.end = (() => {
        const stream = new PassThrough(), response = stream as unknown as IncomingMessage;
        response.statusCode = spec.status ?? 200; response.headers = spec.headers ?? { "content-type": "application/octet-stream" };
        callback(response);
        queueMicrotask(() => { if (!response.destroyed) { if (spec.aborted) response.emit("aborted"); else stream.end(spec.bytes); } });
        return req;
      }) as ClientRequest["end"];
      return req;
    },
  };
  return { requests, adapter };
}
function wav() {
  const data = Buffer.alloc(44 + 2400 * 2); data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40); return data;
}
async function mp3(root: string) {
  const input = join(root, "fixture.wav"), output = join(root, "fixture.mp3");
  writeFileSync(input, wav());
  await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-i", input, "-n", output], 10000);
  return readFileSync(output);
}
async function setup(markdown?: string) {
  const root = fixtureRoot(), store = new WorkStore(root.path), initial = store.create("素材获取回归", "只验证合成材料，不试听。");
  const ref = await adoptedDesign(store, initial.id, markdown), work = store.read(initial.id), version = readyVersion(store, work.id, "v001", "sample");
  version.designRef = ref; version.production = "creating"; work.versions.push(version);
  work.execution = { status: "running", runId: version.runId, versionId: version.id }; store.save(work);
  return { root, store, work, version, ref };
}

test("网上图片与三种音频用途复用同一下载边界，文件类型从字节确定", async () => {
  for (const role of ["music", "sound_effect", "narration"] as const) {
    const fake = transport([{ status: 302, headers: { location: "https://cdn.example.org/file.bin" } }, { bytes: wav() }]);
    const result = await downloadAsset("https://example.org/media", role, undefined, fake.adapter);
    assert.equal(result.extension, ".wav"); assert.equal(result.mimeType, "audio/wav");
    assert.equal(result.finalUrl, "https://cdn.example.org/file.bin"); assert.deepEqual(result.bytes, wav());
  }
  const bytes = rgbPng(4, 4, Buffer.alloc(48, 60));
  const result = await downloadAsset("https://example.org/image", "image", undefined, transport([{ bytes }]).adapter);
  assert.equal(result.extension, ".png");
  await assert.rejects(downloadAsset("https://example.org/file.png", "image", undefined, transport([{ bytes: wav() }]).adapter), /用途不符/);
  await assert.rejects(downloadAsset("https://example.org/file.mp3", "music", undefined,
    transport([{ bytes: Buffer.from("<html>not audio</html>"), headers: { "content-type": "audio/mpeg" } }]).adapter), /不是支持/);
  assert.throws(() => identifyMedia(Buffer.from("#!/bin/sh\n")), /不是支持/);
});

test("下载拒绝私网及跳转越界、异常返回、超大和不完整内容，取消不再发请求", async () => {
  for (const url of ["http://example.org/a", "https://u:p@example.org/a", "https://127.0.0.1/a", "https://[::ffff:127.0.0.1]/a"]) {
    assert.throws(() => publicAssetUrl(url), /公开 HTTPS/);
  }
  const privateDns = transport([{ bytes: wav() }], ["127.0.0.1"]);
  await assert.rejects(downloadAsset("https://example.org/a", "music", undefined, privateDns.adapter), /非公开/);
  assert.equal(privateDns.requests.length, 0);
  const redirect = transport([{ status: 302, headers: { location: "https://127.0.0.1/a" } }]);
  await assert.rejects(downloadAsset("https://example.org/a", "music", undefined, redirect.adapter), /公开 HTTPS/);
  assert.equal(redirect.requests.length, 1);
  const cases: Parameters<typeof transport>[0] = [{ status: 403 }, { headers: { "content-type": "text/html" } },
    { headers: { "content-length": String(129 * 1024 * 1024) } }, { aborted: true }];
  for (const spec of cases) {
    const fake = transport([spec]);
    await assert.rejects(downloadAsset("https://example.org/a", "music", undefined, fake.adapter));
    assert.equal(fake.requests.length, 1);
  }
  const controller = new AbortController(); controller.abort();
  const fake = transport([]);
  await assert.rejects(downloadAsset("https://example.org/a", "music", controller.signal, fake.adapter));
  assert.equal(fake.requests.length, 0);
  const duringDns = new AbortController(), pending = transport([]);
  pending.adapter.lookup = async () => new Promise(() => undefined);
  const waiting = downloadAsset("https://example.org/a", "music", duringDns.signal, pending.adapter);
  duringDns.abort();
  await assert.rejects(waiting, /取消或超时/); assert.equal(pending.requests.length, 0);
});

test("通用下载保留原声身份；登记失败后同编号复用已下载字节，旧图片入口仍可用", async () => {
  const f = await setup(); let downloads = 0;
  try {
    const assets = new AssetService(f.store), input = { operationKey: "speech", url: "https://example.org/audio",
      sourcePage: "https://example.org/speech", description: "原始讲话片段", usageNotes: "合成来源",
      role: "narration", voice: { kind: "recording", speaker: "合成讲话者", source: "来源页面说明",
        transcript: { text: "你好", source: "来源页面字幕" } } };
    const tools = new ProductionMediaTools(f.store, f.work, f.version.runId, assets, f.version, { libraries: [],
      download: async (url, role) => { downloads++; const bytes = role === "image" ? rgbPng(4, 4, Buffer.alloc(48)) : wav();
        return { bytes, ...identifyMedia(bytes), finalUrl: url }; } });
    await f.store.withLock(f.work.id, async () => {
      const register = assets.assets.register.bind(assets.assets);
      assets.assets.register = () => { throw new Error("模拟登记失败"); };
      await assert.rejects(tools.call("intentframe_download_asset", input), /登记失败/);
      assets.assets.register = register;
      const result = await tools.call("intentframe_download_asset", input) as ReturnType<AssetStore["view"]>;
      assert.equal(downloads, 1); assert.equal(result.voice!.kind, "recording");
      assert.equal(result.voice!.speaker, "合成讲话者");
      await tools.call("intentframe_set_audio_playback", { operationKey: "play", clips: [{ id: "speech", assetId: result.id, startMs: 0 }] });
      const plan = readAudioPlan(f.store, f.version)!;
      assert.equal(plan.clips[0]!.words, undefined); assert.equal(plan.clips[0]!.voice?.kind, "recording");
      await assert.rejects(tools.call("intentframe_set_audio_playback", { operationKey: "no-guessed-cue",
        clips: [{ id: "speech", assetId: result.id, startMs: 0, cues: [{ name: "hello", quote: "你好" }] }] }), /没有供应商字词时间/);
      const old = await tools.call("intentframe_download_image", { operationKey: "image", url: "https://example.org/image",
        sourcePage: "https://example.org", description: "图", usageNotes: "合成" }) as ReturnType<AssetStore["view"]>;
      assert.equal(old.role, "image");
      await assert.rejects(tools.call("intentframe_download_asset", { ...input, description: "更改已固定请求" }), /不同输入/);
    });
    const other = f.store.create("复用讲话", "验证来源保留"), catalog = new AssetCatalog(f.store, []);
    assert.equal(catalog.search({ query: "合成讲话者" }).total, 1);
    const original = f.work.assets!.find(asset => asset.role === "narration")!;
    const reused = await catalog.reuseOwned(other, { kind: "work", workId: f.work.id, assetId: original.id }, "reuse-recording", "复用原声");
    assert.deepEqual(reused.voice, original.voice);
    assert(!mediaToolDefinitions(true).some(tool => ["intentframe_download_asset", "intentframe_generate_music", "intentframe_generate_sound_effect"].includes(tool.name)));
  } finally { f.root.cleanup(); }
});

test("音乐与音效生成发送独立参数、保存原二进制响应，并可离线恢复登记", async () => {
  const f = await setup(); let calls = 0;
  try {
    const bytes = await mp3(f.root.path), providerSettings = {
      music: { apiKey: "fixture-private-key", model: "music_v2_5", timeoutMs: 1000 },
      sound_effect: { apiKey: "fixture-private-key", model: "eleven_text_to_sound_v3", timeoutMs: 1000 },
    };
    const service = new AssetService(f.store, { providerSettings, providerFetch: async (url, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      assert.equal((init?.headers as Record<string, string>)["xi-api-key"], "fixture-private-key");
      if (String(url).includes("/music?")) { assert.equal(body.music_length_ms, 3000); assert.equal(body.force_instrumental, true); }
      else { assert.equal(body.duration_seconds, 1); assert.equal(body.loop, true); }
      return new Response(bytes, { headers: { "content-type": "audio/mpeg", "request-id": "fixture-id" } });
    } });
    const tools = new ProductionMediaTools(f.store, f.work, f.version.runId, service, f.version, { libraries: [] });
    await f.store.withLock(f.work.id, async () => {
      await tools.call("intentframe_generate_music", { operationKey: "music", prompt: "合成背景音乐", durationSeconds: 3, description: "音乐" });
      await tools.call("intentframe_generate_sound_effect", { operationKey: "effect", prompt: "合成雨声", durationSeconds: 1, loop: true, description: "音效" });
      await tools.call("intentframe_generate_music", { operationKey: "music", prompt: "合成背景音乐", durationSeconds: 3, description: "音乐" });
      assert.equal(calls, 2); assert.equal(f.store.read(f.work.id).execution.runId, f.version.runId);
      for (const id of f.version.assetRequestIds!) {
        const directory = join(f.store.workDirectory(f.work.id), "assets/requests", id);
        const archived = readFileSync(join(directory, "provider-response.json"), "utf8");
        assert(!archived.includes("fixture-private-key")); assert(archived.includes('"bodyEncoding": "base64"'));
        rmSync(join(directory, "provider-output.bin")); rmSync(join(directory, "provider-output.json")); rmSync(join(directory, "result.json"));
      }
      f.work.assets = []; f.store.save(f.work);
      const recovery = new AssetService(f.store, { providerSettings: {}, providerFetch: async () => { throw new Error("恢复禁止联网"); } });
      await recovery.recoverProduction(f.work, f.version);
      assert.deepEqual(f.work.assets!.map(asset => asset.role), ["music", "sound_effect"]);
      assert.deepEqual(readFileSync(f.store.resolvePath(f.work.assets![0]!.path)), bytes);
    });
  } finally { f.root.cleanup(); }
});

test("独立音乐与音效登记失败后恢复原回执及后台终态，重复恢复不再生成", async t => {
  for (const name of ["generate_music", "generate_sound_effect"] as const) for (const background of [false, true]) {
    await t.test(name + (background ? " 后台回执" : " 同步回执"), async t => {
      const root = fixtureRoot();
      try {
        const store = new WorkStore(root.path), work = store.create("合成音频恢复", "不调用真实服务。");
        const document = await adoptedDesign(store, work.id), bytes = await mp3(root.path);
        const kind = name === "generate_music" ? "music" : "sound_effect";
        let calls = 0;
        const service = new WorkService(store, { providerSettings: { [kind]: { apiKey: "fixture", model: "fixture", timeoutMs: 1000 } },
          providerFetch: async () => { calls++; return new Response(bytes); } });
        const input = inputs[name].parse({ operationId: "audio", workId: work.id, document, prompt: "合成音频", durationSeconds: 3, description: "恢复用例" });
        const operations = new OperationStore(root.path), executions = new ExecutionStore(root.path);
        const accepted = { status: "accepted", executionId: input.operationId };
        let originalOutcome: Buffer | undefined;
        if (background) {
          await operations.execute(input.operationId, name, input, () => accepted, "production", "accepted");
          const request = executions.create({ operationId: input.operationId, workId: work.id, name, input, inputHash: valueHash(input),
            purpose: "production", createdAt: new Date().toISOString(), systemFingerprint: "fixture", configurationFingerprint: "fixture" });
          t.mock.method(service.assets.assets, "register", () => { throw new Error("合成登记失败"); }, { times: 1 });
          const generation = name === "generate_music" ? { ...inputs.generate_music.parse(input), kind: "music" as const } :
            { ...inputs.generate_sound_effect.parse(input), kind: "sound_effect" as const };
          await assert.rejects(service.assets.generate(work.id, generation, input.operationId), /恢复原请求/);
          executions.finish(request, { status: "unknown", error: "合成登记失败" });
          originalOutcome = readFileSync(executions.path(input.operationId, "outcome.json"));
        } else {
          t.mock.method(service.assets.assets, "register", () => { throw new Error("合成登记失败"); }, { times: 1 });
          await assert.rejects(executeToolInline(name, input, service), /恢复原请求/);
          assert.equal(operations.read(input.operationId).state, "failed");
        }
        assert.equal(store.read(work.id).execution.status, "unknown");
        const recoveryInput = { operationId: "recover", workId: work.id, mode: "reconcile_only" };
        const recovered = await executeToolInline("recover_work", recoveryInput, service) as { status: string; asset: { id: string; location: string } };
        assert.equal(recovered.status, "recovered");
        assert.deepEqual(readFileSync(recovered.asset.location), bytes);
        if (background) {
          const original = await executeTool("get_execution", { executionId: input.operationId }, service) as { status: string; result: { id: string } };
          assert.equal(original.status, "succeeded"); assert.equal(original.result.id, recovered.asset.id);
          assert.deepEqual(readFileSync(executions.path(input.operationId, "outcome.json")), originalOutcome);
          assert.deepEqual(await executeToolInline(name, input, service), accepted);
        } else {
          assert.equal(operations.read(input.operationId).state, "succeeded");
          assert.equal((await executeToolInline(name, input, service) as { id: string }).id, recovered.asset.id);
        }
        assert.deepEqual(await executeToolInline("recover_work", recoveryInput, service), recovered);
        await executeToolInline("recover_work", { ...recoveryInput, operationId: "recover-again" }, service);
        assert.equal(calls, 1); assert.equal(store.read(work.id).assets!.length, 1);
        assert.equal(store.read(work.id).execution.status, "idle");
      } finally { root.cleanup(); }
    });
  }
});

test("音频服务未配置、明确拒绝和未知结果分别处理，不把原始讲话误记为合成配音", async () => {
  const f = await setup();
  try {
    const input = { kind: "music" as const, prompt: "合成", durationSeconds: 3, forceInstrumental: true, description: "音乐", document: f.ref };
    assert.throws(() => new AssetService(f.store, { providerSettings: {} }).validate(f.work, input), /原任务结果尚未核清/);
    await f.store.withLock(f.work.id, async () => {
      assert.throws(() => new AssetService(f.store, { providerSettings: {} }).validate(f.work, input, f.version), /尚未配置音乐/);
      const service = new AssetService(f.store, { providerSettings: { music: { apiKey: "secret", model: "music_v2_5", timeoutMs: 1000 } },
        providerFetch: async () => { throw new Error("模拟连接未知 secret"); } });
      await assert.rejects(service.generateInProduction(f.work, f.version, input, "unknown"), /未核实/);
      await assert.rejects(service.generateInProduction(f.work, f.version, input, "replacement"), /尚未核清/);
    });
    let archived: ProviderResponse | undefined;
    await assert.rejects(generateAudio({ apiKey: "secret", model: "music_v2_5", timeoutMs: 1000 }, input,
      async () => new Response("secret", { status: 403 }), undefined, { capture: response => { archived = response; } }),
      error => error instanceof Error && "uncertain" in error && error.uncertain === false && !error.message.includes("secret"));
    assert(!archived!.body.includes("secret"));
    const settings = { apiKey: "secret", speaker: "own-voice", resourceId: "seed-icl-2.0", timeoutMs: 1000,
      voices: [{ id: "announcer", label: "公版播音", speaker: "public-voice", resourceId: "seed-tts-2.0" }] };
    assert.equal(selectSpeechVoice(settings).speaker, "own-voice");
    assert.equal(selectSpeechVoice(settings, "announcer").speaker, "public-voice");
    assert.throws(() => selectSpeechVoice(settings, "unconfigured"), /未配置/);
  } finally { f.root.cleanup(); }
});

test("外部入口接收原声说明及独立音乐请求，沿用素材存储与结果记录", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("外部素材", "合成检查");
    const document = await adoptedDesign(store, work.id), bytes = await mp3(root.path);
    const service = new WorkService(store, { providerSettings: { music: { apiKey: "fixture", model: "music_v2_5", timeoutMs: 1000 } },
      providerFetch: async () => new Response(bytes) });
    const music = await executeToolInline("generate_music", { operationId: "music", workId: work.id, document,
      prompt: "合成", durationSeconds: 3, description: "背景音乐" }, service) as ReturnType<AssetStore["view"]>;
    assert.equal(music.role, "music");
    const voice = await executeToolInline("import_asset", { operationId: "speech", workId: work.id, path: join(root.path, "fixture.wav"),
      role: "narration", description: "合成原声", voice: { kind: "recording", speaker: "讲话者" } }, service) as ReturnType<AssetStore["view"]>;
    assert.equal(voice.voice!.kind, "recording");
    const record = store.read(work.id), version = readyVersion(store, work.id, "v001", "sample"); record.versions.push(version);
    saveAudioPlan(store, record, version, { clips: [{ id: "speech", assetId: voice.id, startMs: 0 }] });
    assert.equal(readAudioPlan(store, version)!.clips[0]!.voice?.speaker, "讲话者");
  } finally { root.cleanup(); }
});

test("原声没有字词时间仍可接续制作，静音录音不能满足人声要求", async () => {
  for (const volume of [1, 0]) {
    const fence = String.fromCharCode(96).repeat(3);
    const f = await setup("引用已提供原声。\n" + fence + "speech:quote\n你好。\n" + fence + "\n");
    try {
      const path = join(f.root.path, "recording.wav"); writeFileSync(path, wav());
      const asset = await new AssetStore(f.store).import(f.work.id, path, "narration", "合成原声", "recording", undefined, undefined,
        { kind: "recording", speaker: "测试讲话者", transcript: { text: "你好。", source: "用户提供的合成文字" } });
      f.work.assets = f.store.read(f.work.id).assets;
      saveAudioPlan(f.store, f.work, f.version, { clips: [{ id: "speech", assetId: asset.id, startMs: 0, volume }] });
      f.version.production = "source_ready";
      f.version.sourceSnapshot = captureSourceSnapshot(f.store.resolvePath(f.version.sourcePath));
      f.work.execution = { status: "idle" }; f.store.save(f.work);
      // 本用例检查完成判定；替身明确模拟带音轨成片，真实解码由前面的导入用例覆盖。
      const service = new WorkService(f.store, { codexExecutable: fakeCodex(f.root.path),
        render: async (...args) => ({ ...await fixtureRender(...args), audioStreams: 1 }),
        prepareReview: async () => undefined, assetLibraries: [] });
      const result = service.produce(f.work.id, "sample", undefined, "fresh", f.version.id, "接续合成原声工程", "continue-recording",
        { designRef: f.ref, feedbackIds: [] });
      if (volume === 0) await assert.rejects(result, /缺少已编排的真实配音/);
      else {
        const completed = await result;
        assert.equal(completed.versions.at(-1)!.production, "ready");
        assert.equal(readAudioPlan(f.store, completed.versions.at(-1)!)!.clips[0]!.words, undefined);
      }
    } finally { f.root.cleanup(); }
  }
});

test("本机原声复用保存来源声明，登记失败可接续并完成含人声脚本的制作", async t => {
  const f = await setup("引用本机原声。\n```speech:quote\n你好。\n```\n");
  try {
    const library = join(f.root.path, "recordings"); mkdirSync(library);
    const path = join(library, "quote.wav"), original = wav(); writeFileSync(path, original);
    const assets = new AssetService(f.store), tools = new ProductionMediaTools(f.store, f.work, f.version.runId, assets, f.version,
      { libraries: [{ id: "recordings", path: library, role: "narration" }] });
    const source = tools.catalog.search({ role: "narration" }).items[0]!.source;
    const voice = { kind: "recording" as const, speaker: "合成讲话者", source: "用户提供的录音说明",
      transcript: { text: "你好。", source: "用户提供的文字稿" } };
    const input = { operationKey: "recording", source, description: "已提供原声", voice };
    await f.store.withLock(f.work.id, async () => {
      t.mock.method(AssetStore.prototype, "register", () => { throw new Error("模拟登记失败"); }, { times: 1 });
      await assert.rejects(tools.call("intentframe_reuse_asset", input), /登记失败/);
      const reused = await tools.call("intentframe_reuse_asset", input) as ReturnType<AssetStore["view"]>;
      assert.deepEqual(reused.voice, voice);
      assert.deepEqual(JSON.parse(readFileSync(f.store.resolvePath(reused.metadataPath!), "utf8")).source.voiceDeclaration, voice);
      assert.deepEqual(await tools.call("intentframe_reuse_asset", input), reused);
      await assert.rejects(tools.call("intentframe_reuse_asset", { ...input, voice: { ...voice, speaker: "其他人" } }), /不同输入/);
      await tools.call("intentframe_set_audio_playback", { operationKey: "play", clips: [{ id: "speech", assetId: reused.id, startMs: 0 }] });
      const plan = readAudioPlan(f.store, f.version)!;
      assert.deepEqual(plan.clips[0]!.voice, voice); assert.equal(plan.clips[0]!.words, undefined);
      assert.deepEqual(readFileSync(join(dirname(f.store.resolvePath(f.version.sourcePath)), "public", plan.clips[0]!.source)), original);
    });
    const asset = f.store.read(f.work.id).assets![0]!;
    const other = f.store.create("复用已知原声", "不改写原任务");
    const reused = await tools.catalog.reuseOwned(other, { kind: "work", workId: f.work.id, assetId: asset.id }, "copy", "继承来源");
    assert.deepEqual(reused.voice, voice);
    f.version.production = "source_ready";
    f.version.sourceSnapshot = captureSourceSnapshot(f.store.resolvePath(f.version.sourcePath));
    f.work.execution = { status: "idle" }; f.store.save(f.work);
    const service = new WorkService(f.store, { codexExecutable: fakeCodex(f.root.path),
      render: async (...args) => ({ ...await fixtureRender(...args), audioStreams: 1 }),
      prepareReview: async () => undefined, assetLibraries: [] });
    const completed = await service.produce(f.work.id, "sample", undefined, "fresh", f.version.id, "接续本机原声工程", "continue-local-recording",
      { designRef: f.ref, feedbackIds: [] });
    assert.equal(completed.versions.at(-1)!.production, "ready");
    assert.deepEqual(readAudioPlan(f.store, completed.versions.at(-1)!)!.clips[0]!.voice, voice);
    assert.deepEqual(readFileSync(path), original);
  } finally { f.root.cleanup(); }
});

test("复用人声不从目录推断身份，拒绝无来源、错用途及覆盖已有身份的声明", async () => {
  const f = await setup();
  try {
    const path = join(f.root.path, "library"); mkdirSync(path); writeFileSync(join(path, "voice.wav"), wav());
    const assets = new AssetService(f.store), tools = new ProductionMediaTools(f.store, f.work, f.version.runId, assets, f.version,
      { libraries: [{ id: "recordings", path, role: "narration" }, { id: "music", path, role: "music" }] });
    const source = { kind: "library" as const, libraryId: "recordings", path: "voice.wav" };
    const voice = { kind: "recording" as const, source: "用户确认的原声来源" };
    await f.store.withLock(f.work.id, async () => {
      const unknown = await tools.call("intentframe_reuse_asset", { operationKey: "unknown", source, description: "未知身份" }) as ReturnType<AssetStore["view"]>;
      assert.equal(unknown.voice, undefined, "narration 用途不能自动证明是原声");
      const before = f.store.read(f.work.id).assets;
      await assert.rejects(tools.call("intentframe_reuse_asset", { operationKey: "no-source", source, description: "缺少依据", voice: { kind: "recording" } }), /source/);
      await assert.rejects(tools.call("intentframe_reuse_asset", { operationKey: "wrong-role", source: { ...source, libraryId: "music" }, description: "错用途", voice }), /人声|narration/);
      assert.deepEqual(f.store.read(f.work.id).assets, before);
      const known = await tools.call("intentframe_reuse_asset", { operationKey: "known", source, description: "有来源", voice }) as ReturnType<AssetStore["view"]>;
      await assert.rejects(tools.call("intentframe_reuse_asset", { operationKey: "override", source: { kind: "work", workId: f.work.id, assetId: known.id },
        description: "冲突声明", voice: { ...voice, kind: "synthesized" } }), /已有.*人声|人声.*一致/);
      assert.deepEqual(assets.assets.get(f.store.read(f.work.id), known.id).voice, voice);
    });
  } finally { f.root.cleanup(); }
});

test("生成的声音数据及使用方通过类型检查，兼容原声、合成、未知和旧无身份素材", async () => {
  const f = await setup();
  try {
    const voices: (VoiceInfo | undefined)[] = [
      { kind: "recording", speaker: "合成讲话者", source: "合成来源", transcript: { text: "你好", source: "合成文字稿" } },
      { kind: "synthesized", speaker: "合成音色", source: "供应商", transcript: { text: "你好", source: "采用脚本" } },
      { kind: "unknown" }, undefined,
    ];
    const path = join(f.root.path, "voice.wav"); writeFileSync(path, wav());
    const assets = new AssetStore(f.store), ids: string[] = [];
    for (const [index, voice] of voices.entries()) {
      const asset = await assets.import(f.work.id, path, "narration", "合成人声", "voice-" + index, undefined, undefined, voice);
      ids.push(asset.id);
    }
    f.work.assets = f.store.read(f.work.id).assets;
    saveAudioPlan(f.store, f.work, f.version, { clips: ids.map((assetId, index) => ({ id: "clip" + index, assetId, startMs: 0 })) });
    assert.deepEqual(readAudioPlan(f.store, f.version)!.clips.map(clip => clip.voice), voices);
    const directory = dirname(f.store.resolvePath(f.version.sourcePath)), consumer = join(directory, "check-playback.ts");
    writeFileSync(consumer, `import {playback} from "./intentframe-audio-data.ts";
for (const clip of playback.clips) {
  const kind: "recording" | "synthesized" | "unknown" | undefined = clip.voice?.kind;
  const speaker: string | undefined = clip.voice?.speaker;
  const source: string | undefined = clip.voice?.source;
  const text: string | undefined = clip.voice?.transcript?.text;
  const textSource: string | undefined = clip.voice?.transcript?.source;
}
`);
    const checked = spawnSync(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
      "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--allowImportingTsExtensions", consumer],
    { cwd: f.root.path, encoding: "utf8", timeout: 10_000 });
    assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  } finally { f.root.cleanup(); }
});
