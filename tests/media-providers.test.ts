import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateImage, synthesizeSpeech, speechSegments, ProviderRequestError } from "../src/media/providers.ts";
import { rgbPng } from "../src/media/review-materials.ts";
import { mediaBinaries, mediaCommand } from "../src/media/render.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { DocumentStore } from "../src/records/document-store.ts";
import { AssetStore } from "../src/records/asset-store.ts";
import { ExecutionStore } from "../src/records/execution-store.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { valueHash } from "../src/records/files.ts";
import { executeTool, executeToolInline as call } from "../src/mcp/server.ts";
import { ExecutionBudgetExceeded, StopRequested } from "../src/runtime/execution-control.ts";
import { fixtureRoot } from "./helpers.ts";

function silentWav() {
  const samples = 2400, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

test("台词从明确区块逐字提取，动作说明不进入配音；错误区块拒绝", () => {
  const markdown = "# 动作\n角色递出道具。\n```speech:a\n  合成台词第一句。\n```\n轻声，不要朗读此说明。\n```speech:b\n第二句用于测试。\n```\n";
  assert.deepEqual(speechSegments(markdown), [{ id: "a", text: "  合成台词第一句。" }, { id: "b", text: "第二句用于测试。" }]);
  assert.throws(() => speechSegments("```speech:a\n没有结尾"), /未闭合/);
  assert.throws(() => speechSegments("```speech:a\n一\n```\n```speech:a\n二\n```\n"), /重复/);
});

test("豆包协议保留原文、使用指定音色及真实字词时间；未知结果不重试且不泄露正文", async () => {
  let calls = 0, payload: any;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++; payload = JSON.parse(String(init?.body));
    assert.equal((init?.headers as Record<string, string>)["X-Api-Request-Id"], "fixed-provider-request");
    return new Response([
      JSON.stringify({ code: 0, data: Buffer.from("合成协议音频字节").toString("base64") }),
      JSON.stringify({ code: 0, data: null, sentence: { words: [{ word: "你好", startTime: 0.12, endTime: 0.8 }] } }),
      JSON.stringify({ code: 20000000, data: null, usage: { text_words: 2 } }),
    ].join("\n"));
  };
  const settings = { apiKey: "test-not-real-secret", speaker: "test-owned-voice", resourceId: "seed-icl-2.0", model: "test-model", timeoutMs: 1000 };
  const result = await synthesizeSpeech(settings, "  你好。\n", -10, fetcher, undefined, "fixed-provider-request");
  assert.equal(calls, 1); assert.equal(payload.req_params.text, "  你好。\n"); assert.equal(payload.req_params.speaker, settings.speaker);
  assert.equal(payload.req_params.audio_params.enable_subtitle, true);
  assert.equal(payload.req_params.additions, undefined, "未要求声音表演时不补造指令");
  assert.deepEqual(result.metadata.words, [{ text: "你好", startMs: 120, endMs: 800 }]);
  let failed = 0;
  await assert.rejects(synthesizeSpeech(settings, "你好", 0, async () => {
    failed++; return new Response("test-not-real-secret", { status: 503 });
  }), error => error instanceof ProviderRequestError && error.uncertain && !error.message.includes(settings.apiKey));
  assert.equal(failed, 1);
});

test("声音指令独立传递并记录，支持复刻增强版和公版 2.0，不改台词", async () => {
  const voiceInstruction = "轻声，先犹豫后真诚；不要朗读这段说明。", text = "  这朵花，送给你。\n";
  for (const resource of [{ resourceId: "seed-icl-2.0", model: "seed-tts-2.0-expressive" }, { resourceId: "seed-tts-2.0" }]) {
    let calls = 0;
    const result = await synthesizeSpeech({ apiKey: "fixture-secret", speaker: "fixture-voice", timeoutMs: 1000, ...resource }, text, 0, async (_url, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.req_params.text, text);
      assert.equal(typeof payload.req_params.additions, "string");
      assert.deepEqual(JSON.parse(payload.req_params.additions), { context_texts: [voiceInstruction] });
      assert.equal(payload.req_params.model, resource.model);
      assert.equal(payload.req_params.audio_params.enable_subtitle, true);
      return new Response([
        JSON.stringify({ code: 0, data: Buffer.from("合成测试音频").toString("base64") }),
        JSON.stringify({ code: 0, data: null, sentence: { words: [{ word: "这朵花，送给你。", startTime: 0.1, endTime: 1.2 }] } }),
        JSON.stringify({ code: 20000000, data: null }),
      ].join("\n"));
    }, undefined, "voice-instruction-test", voiceInstruction);
    assert.equal(calls, 1); assert.equal(result.metadata.voiceInstruction, voiceInstruction);
    assert.equal(result.metadata.text, text); assert.equal(result.metadata.requiresListening, true);
    assert(!JSON.stringify(result.metadata).includes("fixture-secret"));
  }
});

test("空白、过长或模型不支持的声音指令在发送前拒绝", async () => {
  const settings = { apiKey: "fixture-secret", speaker: "fixture-voice", resourceId: "seed-icl-2.0", timeoutMs: 1000 };
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("不得发起请求"); };
  for (const voiceInstruction of [" ", "轻".repeat(2001)]) {
    await assert.rejects(synthesizeSpeech({ ...settings, model: "seed-tts-2.0-expressive" }, "你好。", 0,
      fetcher, undefined, "invalid", voiceInstruction), /声音指令须/);
  }
  for (const resource of [{}, { model: "seed-tts-2.0-standard" }, { resourceId: "seed-tts-2.0-expressive" }, { resourceId: "seed-icl-1.0" }]) {
    await assert.rejects(synthesizeSpeech({ ...settings, ...resource }, "你好。", 0,
      fetcher, undefined, "unsupported", "轻声"), /不支持声音指令/);
  }
  assert.equal(calls, 0);
});

test("MCP 配音传递脚本声音要求并保存音轨、逐字时间及指令；不支持时不登记请求", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("情绪配音", "合成测试台词与声音要求。");
    const documents = new DocumentStore(store); documents.initialize(work, "合成草稿。", "draft");
    const draft = work.authoring!.drafts[0]!;
    await documents.handoff(work.id, draft, "合成测试交接", "handoff");
    const record = store.read(work.id), voiceInstruction = "轻声、真诚。";
    const design = documents.append(record, "design", "片段 a 的声音要求：" + voiceInstruction + "\n```speech:a\n你好。\n```\n", {
      operationId: "design", source: "project_ai", instruction: "合成设计", draft, assetIds: [],
    });
    store.save(record);
    await documents.decide(work.id, { operationId: "adopt", design, status: "adopted", source: "external_ai", notes: "合成采用记录" });
    const ref = { id: design.id, sha256: design.sha256 };
    const settings = { apiKey: "fixture-secret", speaker: "fixture-voice", resourceId: "seed-icl-2.0", timeoutMs: 1000 };
    const rejected = new WorkService(store, { providerSettings: { speech: settings }, providerFetch: async () => { throw new Error("不得发起请求"); } });
    const input = { workId: work.id, document: ref, segmentIds: ["a"], voiceInstruction, description: "合成声音表演验证" };
    await assert.rejects(call("synthesize_speech", { ...input, operationId: "unsupported-voice" }, rejected), /不支持声音指令/);
    assert(!existsSync(join(store.workDirectory(work.id), "assets", "requests", "unsupported-voice")));
    assert.equal(store.read(work.id).execution.status, "idle");
    const wav = join(root.path, "silence.wav"), mp3 = join(root.path, "silence.mp3");
    writeFileSync(wav, silentWav());
    await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-i", wav, "-n", mp3], 10000);
    const bytes = readFileSync(mp3); let calls = 0;
    const service = new WorkService(store, { providerSettings: { speech: { ...settings, model: "seed-tts-2.0-expressive" } }, providerFetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.req_params.text, "你好。");
      assert.deepEqual(JSON.parse(request.req_params.additions), { context_texts: [voiceInstruction] });
      return new Response([
        JSON.stringify({ code: 0, data: bytes.toString("base64") }),
        JSON.stringify({ code: 0, data: null, sentence: { words: [{ word: "你好。", startTime: 0.01, endTime: 0.08 }] } }),
        JSON.stringify({ code: 20000000, data: null }),
      ].join("\n"));
    } });
    const asset = await call("synthesize_speech", { ...input, operationId: "expressive-voice" }, service) as ReturnType<AssetStore["view"]>;
    assert.equal(calls, 1); assert.deepEqual(readFileSync(asset.location), bytes);
    const saved = JSON.parse(readFileSync(store.resolvePath(asset.metadataPath!), "utf8"));
    assert.equal(saved.source.request.parameters.voiceInstruction, voiceInstruction);
    assert.equal(saved.source.response.voiceInstruction, voiceInstruction);
    assert.equal(saved.source.response.text, "你好。");
    assert.deepEqual(saved.source.response.words, [{ text: "你好。", startMs: 10, endMs: 80 }]);
    assert.equal(saved.source.response.timingSource, "provider_returned");
    assert(!JSON.stringify(saved).includes(settings.apiKey));
    assert.equal(store.read(work.id).assets!.length, 1);
    assert.equal(store.read(work.id).execution.status, "idle");
  } finally { root.cleanup(); }
});

test("GPT 图片生成使用单次调用，参考图编辑使用上传文件；无隐式重新生成", async () => {
  const bytes = rgbPng(8, 8, Buffer.alloc(8 * 8 * 3, 100)), settings = { apiKey: "test-api-key", model: "test-image-model", timeoutMs: 1000 };
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    if (calls === 1) { assert(String(url).endsWith("/generations")); assert.equal(JSON.parse(String(init?.body)).n, 1); }
    else { assert(String(url).endsWith("/edits")); assert(init?.body instanceof FormData); assert.equal(init.body.getAll("image[]").length, 1); assert.equal(init.body.get("background"), "transparent"); }
    return Response.json({ data: [{ b64_json: bytes.toString("base64") }], usage: { output_tokens: 1 } });
  };
  assert.deepEqual((await generateImage(settings, "合成图片", [], fetcher)).bytes, bytes);
  await generateImage(settings, "合成编辑", [{ bytes, mimeType: "image/png", name: "reference.png" }], fetcher, undefined, undefined, "transparent");
  assert.equal(calls, 2);
});

test("图片保存到本机并绑定稿件；未配置不调用，未知请求不能换编号重做", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("图片资产", "合成需求");
    const documents = new DocumentStore(store); documents.initialize(work, "# 草稿\n需要参考图片。", "initial");
    const document = work.authoring!.drafts[0]!, bytes = rgbPng(8, 8, Buffer.alloc(8 * 8 * 3, 50));
    let calls = 0;
    const service = new WorkService(store, { providerSettings: { image: { apiKey: "test-secret", model: "test-model", timeoutMs: 1000 } },
      providerFetch: async () => { calls++; return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }); } });
    const input = { kind: "image" as const, document, prompt: "合成图像", referenceAssetIds: [], description: "仅测试保存" };
    const result = await service.assets.generate(work.id, input, "image-op");
    assert.equal(calls, 1); assert.deepEqual(readFileSync(result.location), bytes);
    assert(!JSON.stringify(result).includes("test-secret"));
    const latest = await documents.submit(work.id, "引用图片的新稿。", "with-image", "加入参考图", document, [result.id]);
    assert.equal(latest.attachments[0]!.id, result.id);
    const inherited = await documents.submit(work.id, "仅修改文字。", "retain-image", "保留附件", latest);
    assert.equal(inherited.attachments[0]!.id, result.id);
    writeFileSync(result.location, "损坏图片");
    assert.throws(() => documents.read(store.read(work.id), latest), /素材.*变化/);
    const other = store.create("未配置", "不应调用"); documents.initialize(other, "草稿", "other-initial");
    const unavailable = new WorkService(store, { providerSettings: {}, providerFetch: async () => { throw new Error("不得触发"); } });
    await assert.rejects(unavailable.assets.generate(other.id, { ...input, document: other.authoring!.drafts[0]! }, "missing-config"), /尚未配置/);
    const broken = new WorkService(store, { providerSettings: { image: { apiKey: "test-secret", model: "test-model", timeoutMs: 1000 } },
      providerFetch: async () => { calls++; throw new Error("test-secret network error"); } });
    await assert.rejects(broken.assets.generate(other.id, { ...input, document: other.authoring!.drafts[0]! }, "unknown-image"), /结果未核实/);
    const before = calls;
    await assert.rejects(broken.assets.generate(other.id, { ...input, document: other.authoring!.drafts[0]! }, "must-not-retry"), /尚未核清/);
    assert.equal(calls, before); assert.equal((await broken.assets.recover(other.id)).status, "unknown");
  } finally { root.cleanup(); }
});

test("导入本机音乐保留原文件并验证媒体，不能把文本伪装成音频", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("本机音乐", "合成音乐素材。");
    const wav = silentWav();
    const path = join(root.path, "music.wav"); writeFileSync(path, wav);
    const assets = new AssetStore(store), imported = await assets.import(work.id, path, "music", "合成静音音轨", "import-music");
    assert.deepEqual(readFileSync(path), wav); assert.deepEqual(readFileSync(imported.location), wav);
    assert.equal(imported.role, "music"); assert(imported.metadata);
    const bad = join(root.path, "bad.mp3"); writeFileSync(bad, "这不是音频");
    await assert.rejects(assets.import(work.id, bad, "music", "错误输入", "bad-audio"));
    assert.equal(store.read(work.id).assets!.length, 1);
  } finally { root.cleanup(); }
});

test("素材输出恢复补齐原后台回执，补存中断后仍沿原操作接续", async t => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("素材恢复回执", "合成图片服务。");
    const documents = new DocumentStore(store); documents.initialize(work, "需要合成参考图。", "draft");
    const document = work.authoring!.drafts[0]!, bytes = rgbPng(8, 8, Buffer.alloc(8 * 8 * 3, 50));
    let calls = 0;
    const service = new WorkService(store, { providerSettings: { image: { apiKey: "fixture-key", model: "fixture-image", timeoutMs: 1000 } },
      providerFetch: async () => { calls++; return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }); } });
    const input = { operationId: "image_recovery", workId: work.id, document: { id: document.id, sha256: document.sha256 }, prompt: "合成图片", referenceAssetIds: [], description: "恢复测试" };
    const operations = new OperationStore(root.path), executions = new ExecutionStore(root.path);
    const accepted = { status: "accepted", executionId: input.operationId };
    await operations.execute(input.operationId, "generate_image", input, () => accepted, "production", "accepted");
    const request = executions.create({ operationId: input.operationId, workId: work.id, name: "generate_image", input, inputHash: valueHash(input),
      purpose: "production", createdAt: new Date().toISOString(), receivedAt: new Date().toISOString(), systemFingerprint: "fixture", configurationFingerprint: "fixture" });
    t.mock.method(service.assets.assets, "register", () => { throw new Error("合成登记失败"); }, { times: 1 });
    await assert.rejects(service.assets.generate(work.id, { ...input, kind: "image" }, input.operationId), /恢复原请求/);
    executions.finish(request, { status: "unknown", error: "合成登记失败后工作进程收尾" });
    const originalBytes = readFileSync(executions.path(input.operationId, "outcome.json"));
    t.mock.method(ExecutionStore.prototype, "recordRecovery", () => { throw new Error("合成恢复回执保存失败"); }, { times: 1 });
    await assert.rejects(call("recover_work", { operationId: "recover-first", workId: work.id }, service), /合成恢复回执保存失败/);
    assert.equal(store.read(work.id).assets?.length, 1, "素材已登记，后续只需补回执");
    const recovered = await call("recover_work", { operationId: "recover-second", workId: work.id }, service) as { status: string; asset: { id: string } };
    assert.equal(recovered.status, "recovered");
    const original = await executeTool("get_execution", { executionId: input.operationId }, service) as {
      status: string; result: { id: string; location: string }; timing: { elapsedMs: number };
    };
    assert.equal(original.status, "succeeded"); assert.equal(original.result.id, recovered.asset.id);
    assert.deepEqual(readFileSync(original.result.location), bytes); assert(original.timing.elapsedMs >= 0);
    assert.deepEqual(readFileSync(executions.path(input.operationId, "outcome.json")), originalBytes);
    assert.deepEqual(await call("generate_image", input, service), accepted);
    assert.equal(calls, 1); assert.equal(store.read(work.id).assets?.length, 1);
  } finally { root.cleanup(); }
});

test("素材导入在媒体检查期间响应取消和总预算，不登记被停止的素材", async t => {
  for (const reason of [new StopRequested("合成用户取消"), new ExecutionBudgetExceeded("合成总预算耗尽")]) await t.test(reason.constructor.name, async t => {
    const root = fixtureRoot();
    try {
      const store = new WorkStore(root.path), work = store.create("停止导入", "合成音轨。");
      const path = join(root.path, "music.wav"), bytes = silentWav(); writeFileSync(path, bytes);
      const controller = new AbortController(), service = new WorkService(store, { signal: controller.signal });
      const write = service.assets.assets.write.bind(service.assets.assets);
      t.mock.method(service.assets.assets, "write", (...args: Parameters<AssetStore["write"]>) => {
        // write 已启动真实媒体检查并进入异步等待，此时模拟后台控制器发出停止。
        const pending = write(...args); controller.abort(reason); return pending;
      });
      await assert.rejects(call("import_asset", { operationId: "import", workId: work.id, path, role: "music", description: "合成导入" }, service), error => error === reason);
      assert(controller.signal.aborted); assert.equal(store.read(work.id).assets?.length ?? 0, 0);
      assert.deepEqual(readFileSync(path), bytes); assert.equal(store.lockOwner(work.id), undefined);
    } finally { root.cleanup(); }
  });
});

test("素材恢复区分服务明确拒绝与未知结果，只补有依据的原执行终态", async t => {
  for (const [httpStatus, expected] of [[400, "failed"], [503, "unknown"]] as const) await t.test(expected, async () => {
    const root = fixtureRoot();
    try {
      const store = new WorkStore(root.path), work = store.create("素材失败恢复", "合成服务响应。");
      const documents = new DocumentStore(store); documents.initialize(work, "合成稿件", "draft");
      const document = work.authoring!.drafts[0]!;
      let calls = 0;
      const service = new WorkService(store, { providerSettings: { image: { apiKey: "fixture-key", model: "fixture-image", timeoutMs: 1000 } },
        providerFetch: async () => { calls++; return new Response("合成服务错误", { status: httpStatus }); } });
      const input = { operationId: "image", workId: work.id, document: { id: document.id, sha256: document.sha256 }, prompt: "合成图片", referenceAssetIds: [], description: "明确失败与未知" };
      const operations = new OperationStore(root.path), executions = new ExecutionStore(root.path);
      await operations.execute(input.operationId, "generate_image", input, () => ({ status: "accepted", executionId: input.operationId }), "production", "accepted");
      const request = executions.create({ operationId: input.operationId, workId: work.id, name: "generate_image", input, inputHash: valueHash(input), purpose: "production",
        createdAt: new Date().toISOString(), systemFingerprint: "fixture", configurationFingerprint: "fixture" });
      await assert.rejects(service.assets.generate(work.id, { ...input, kind: "image" }, input.operationId), /HTTP/);
      executions.finish(request, { status: "unknown", error: "模拟业务已记录，但后台未取得终态。" });
      await call("recover_work", { operationId: "recover", workId: work.id }, service);
      const original = executions.view(input.operationId);
      assert.equal(original.status, expected); assert.equal(store.read(work.id).execution.status, expected);
      if (expected === "failed") assert.match(original.error!, /HTTP 400/);
      else assert.equal(executions.outcome(request)?.result, undefined);
      assert.equal(calls, 1); assert.equal(store.read(work.id).assets?.length ?? 0, 0);
    } finally { root.cleanup(); }
  });
});
