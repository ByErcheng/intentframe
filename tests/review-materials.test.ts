import { confirmedDraft } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mediaBinaries, mediaCommand, renderVersion } from "../src/media/render.ts";
import { prepareReviewBatch, readReviewBatch } from "../src/media/review-materials.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { adoptedDesign, fakeCodex, fixtureRoot, readyVersion, videoSource } from "./helpers.ts";
import { backgroundFixture } from "./background-helpers.ts";

test("项目从实际视频准备永久帧图和时间拼图；加密另存批次并拒绝错配或覆盖", { timeout: 40_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("材料测试", "合成媒体。");
    const version = readyVersion(store, work.id, "v001", "sample");
    const output = join(root.path, "actual.mp4");
    const rendered = await renderVersion(store.resolvePath(version.sourcePath), output, join(root.path, "cache"));
    const directory = join(root.path, "review/r001");
    const batch = await prepareReviewBatch(output, rendered.videoSha256, directory);
    assert.equal(batch.frames[0]!.frame, 0); assert.equal(batch.frames.at(-1)!.frame, 9);
    for (const frame of batch.frames) assert.equal(frame.seconds, frame.frame / batch.fps);
    assert(batch.sheets.length); assert.equal(batch.audio, undefined);
    assert.equal(batch.temporalAnalysis!.framePairs, 9);
    const temporal = JSON.parse(readFileSync(join(directory, batch.temporalAnalysis!.path), "utf8"));
    assert.equal(temporal.decodedFrames, 10); assert.equal(temporal.changes.length, 9);
    assert(temporal.changes.every((item: { meanDifference: number }) => item.meanDifference === 0));
    const original = readFileSync(join(directory, "index.json"));
    const extra = await prepareReviewBatch(output, rendered.videoSha256, join(root.path, "review/r002"), [{ startSeconds: 0.2, endSeconds: 0.8, fps: 10, reason: "检查中间动作" }]);
    assert(extra.frames.some(frame => frame.frame === 3));
    const exact = await prepareReviewBatch(output, rendered.videoSha256, join(root.path, "review/exact-budget"),
      [{ startSeconds: 0.2, endSeconds: 0.4, fps: 10, reason: "三帧范围恰好占满三帧预算" }], undefined, 3);
    assert.deepEqual(exact.frames.map(frame => frame.frame), [2, 3, 4], "补帧只保留请求范围，不额外加入片头片尾");
    assert.deepEqual(readFileSync(join(directory, "index.json")), original);
    await assert.rejects(prepareReviewBatch(output, "a".repeat(64), join(root.path, "review/wrong")), /原视频已变化/);
    await assert.rejects(prepareReviewBatch(output, rendered.videoSha256, directory, [{ startSeconds: 0, endSeconds: 0.8, fps: 10, reason: "不能覆盖旧批次" }]), /新批次/);
    await assert.rejects(prepareReviewBatch(output, rendered.videoSha256, join(root.path, "review/outside"), [{ startSeconds: 0, endSeconds: 2, fps: 10, reason: "越界" }]), /时长/);
    writeFileSync(join(directory, batch.frames[0]!.path), "破坏检查材料");
    assert.throws(() => readReviewBatch(directory, rendered.videoSha256), /变化/);
  } finally { root.cleanup(); }
});

test("相邻帧指标保留一帧颜色变化，可按原帧率补短片段且不代替播放检查", { timeout: 40_000 }, async () => {
  const root = fixtureRoot();
  try {
    const entry = join(root.path, "source/entry.tsx"); mkdirSync(dirname(entry));
    writeFileSync(entry, 'import React from "react";import {Composition,registerRoot,AbsoluteFill,useCurrentFrame} from "remotion";' +
      'const Scene=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{backgroundColor:f===7?"#0000ff":"#000000"}}/>;};' +
      'registerRoot(()=> <Composition id="Video" component={Scene} width={160} height={90} fps={30} durationInFrames={30}/>);');
    const output = join(root.path, "video.mp4"), rendered = await renderVersion(entry, output, join(root.path, "cache"));
    const directory = join(root.path, "review/r001"), batch = await prepareReviewBatch(output, rendered.videoSha256, directory);
    const metrics = JSON.parse(readFileSync(join(directory, batch.temporalAnalysis!.path), "utf8"));
    assert.equal(metrics.changes.length, 29);
    for (const frame of [7, 8]) assert(metrics.changes.find((item: { frame: number }) => item.frame === frame).meanDifference > 0.2);
    const detail = await prepareReviewBatch(output, rendered.videoSha256, join(root.path, "review/r002"),
      [{ startSeconds: 0.2, endSeconds: 0.3, fps: 30, reason: "核对一帧闪现" }]);
    assert([6, 7, 8, 9].every(frame => detail.frames.some(item => item.frame === frame)));
    const bounded = await prepareReviewBatch(output, rendered.videoSha256, join(root.path, "review/non-divisor"),
      [{ startSeconds: 0.2, endSeconds: 0.8, fps: 8, reason: "30fps视频中的8fps采样不得提升为10fps" }], undefined, 6);
    assert(bounded.frames.length <= 6);
    assert.equal(bounded.frames[0]!.frame, 6); assert.equal(bounded.frames.at(-1)!.frame, 24);
    assert(detail.limitations.some(text => text.includes("不等于连续播放")));
    writeFileSync(join(directory, batch.temporalAnalysis!.path), "{}");
    assert.throws(() => readReviewBatch(directory, rendered.videoSha256), /变化或缺失/);
  } finally { root.cleanup(); }
});

test("内检发现缺陷后内部制作新版本并复查，只交付通过版本且保留原始证据", { timeout: 60_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("内部修复", "合成的连接关系检查。");
    const designRef = await adoptedDesign(store, work.id);
    const observations: boolean[] = [];
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "quality_repair"),
      onProgress: message => { if (message.includes("内部修复")) observations.push(store.summary(store.read(work.id)).delivery.videoLocation === null); } });
    const made = await service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "repair-test", { designRef });
    assert.equal(made.versions.length, 2); assert.equal(made.execution.status, "idle"); assert.deepEqual(observations, [true]);
    const [original, repaired] = made.versions;
    assert.equal(original!.reviewPreparation!.inspections.at(-1)!.result!.quality!.status, "needs_repair");
    assert.equal(repaired!.reviewPreparation!.inspections.at(-1)!.result!.quality!.status, "passed");
    assert.equal(repaired!.basedOnVersionId, original!.id); assert.deepEqual(repaired!.designRef, original!.designRef);
    assert.equal(repaired!.internalRepair!.attempt, 1); assert.equal(repaired!.operationId, "repair-test");
    assert.equal(made.feedback.length, 1); assert.equal(made.feedback[0]!.source, "internal_check");
    assert.deepEqual(repaired!.agentResult!.appliedFeedbackIds, [made.feedback[0]!.id]);
    const view = store.summary(made);
    assert.equal(view.versions[0]!.videoLocation, null); assert(view.versions[0]!.diagnosticVideoLocation);
    assert.equal(view.delivery.versionId, repaired!.id); assert.equal(view.delivery.status, "ready_for_external_review");
    assert.equal(view.versions[1]!.review.status, "not_reviewed"); assert.equal(view.versions[1]!.acceptance, "pending");
    store.assertAvailable(original!); store.assertAvailable(repaired!);
    const inspection = repaired!.reviewPreparation!.inspections.at(-1)!;
    const input = JSON.parse(readFileSync(store.resolvePath(inspection.inputPath), "utf8"));
    assert.deepEqual([...input.outputSchema.required].sort(), Object.keys(input.outputSchema.properties).sort(), "原生结构化输出要求对象字段全部明确必填");
    assert(!Object.hasOwn(input.outputSchema.properties, "sound"), "不请求模型自动判断听感");
    assert.equal(inspection.result!.sound!.status, "not_checked", "模型夹具的未经依据听音声明不能改变程序记录");
    assert.equal(input.previousInternalReview.quality.status, "needs_repair");
    assert.deepEqual(input.assetUsage, service.reviewMaterials.view(store.read(work.id), repaired!).assetUsage,
      "项目内检与外部材料查询接收同一份本机使用说明");
    assert.equal(input.feedback[0].id, made.feedback[0]!.id);
  } finally { root.cleanup(); }
});

test("内检无法修好的问题有轮数上限，设计变更返回确认，不伪造合格交付", { timeout: 60_000 }, async () => {
  for (const [mode, expectedVersions, message] of [["quality_persistent", 3, "修复上限"], ["quality_change", 1, "返回确认"]] as const) {
    const root = fixtureRoot();
    try {
      const store = new WorkStore(root.path), work = store.create("内检边界", "合成的未解决缺陷。");
      const designRef = await adoptedDesign(store, work.id);
      const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, mode) });
      const made = await service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "blocked-test", { designRef });
      assert.equal(made.versions.length, expectedVersions); assert.equal(made.execution.status, "waiting_input");
      assert.match(made.execution.error!, new RegExp(message)); assert.equal(store.summary(made).delivery.videoLocation, null);
      const callsBefore = readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8");
      await service.recover(work.id);
      assert.equal(store.read(work.id).versions.length, expectedVersions);
      assert.equal(readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8"), callsBefore, "恢复不重置自动修复预算，也不重复已完成内检");
    } finally { root.cleanup(); }
  }
});

test("内检终态失联时沿原回复恢复，再执行有依据的修复，不重发未知检查", { timeout: 60_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("内检恢复修复", "合成断线检查。");
    const designRef = await adoptedDesign(store, work.id);
    const initial = new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_quality"), timeoutMs: 2000 });
    await assert.rejects(initial.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "recover-repair", { designRef }));
    const interrupted = store.read(work.id);
    assert.equal(interrupted.execution.status, "unknown"); assert.equal(interrupted.versions.length, 1);
    assert.equal(store.summary(interrupted).delivery.videoLocation, null);
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "quality_repair"), timeoutMs: 2000 });
    await service.recover(work.id);
    const made = store.read(work.id);
    assert.equal(made.versions.length, 2); assert.equal(made.execution.status, "idle");
    assert.equal(made.versions[0]!.reviewPreparation!.inspections.length, 1);
    assert.equal(readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"turn/start"')).length, 8, "首稿和修复各含素材方案、制作、视觉理解、内检；恢复不重发原检查");
    assert.equal(store.summary(made).delivery.versionId, "v002");
  } finally { root.cleanup(); }
});

test("实际 MCP 后台内检要求确认时返回 waiting_input，外部审查与用户认可保持未完成", { timeout: 40_000 }, async () => {
  const fixture = backgroundFixture("quality_change");
  try {
    const client = await fixture.connect();
    const work = await fixture.call(client, "create_work", confirmedDraft({ operationId: "create", title: "内检交接", brief: "合成后台状态测试。", purpose: "test" }));
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data);
    const designRef = await adoptedDesign(store, work.id);
    const request = await fixture.call(client, "produce_version", { operationId: "produce", workId: work.id, kind: "sample", designRef });
    const outcome = await fixture.wait(client, request.executionId);
    assert.equal(outcome.status, "waiting_input", JSON.stringify(outcome));
    assert.equal(outcome.result.delivery.status, "not_ready"); assert.equal(outcome.result.delivery.videoLocation, null);
    assert.equal(outcome.result.versions.length, 1); assert.equal(outcome.result.versions[0].videoLocation, null);
    assert.equal(outcome.result.versions[0].review.status, "not_reviewed"); assert.equal(outcome.result.versions[0].acceptance, "pending");
    assert.equal(fixture.countTurns(), 4, "素材方案、代码制作、视觉理解和内检各一轮，不擅自改设计");
  } finally { await fixture.cleanup(); }
});

test("对历史版本的内检失联恢复保留原操作身份，不误关联最新制作", { timeout: 40_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("历史版本内检", "合成操作身份。");
    const designRef = await adoptedDesign(store, work.id);
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path) });
    await service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "first-production", { designRef });
    await service.produce(work.id, "sample", undefined, "fresh", undefined, undefined, "second-production", { designRef });
    const interrupted = new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result"), timeoutMs: 2000 });
    await assert.rejects(interrupted.prepareMaterials(work.id, "v001", [], "historical-inspection"));
    const recovered = await new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only"), timeoutMs: 2000 }).recover(work.id);
    assert.equal(recovered.status, "recovered"); assert("operationId" in recovered);
    assert.equal(recovered.operationId, "historical-inspection");
    assert.equal(store.read(work.id).versions.length, 2);
    assert.equal(store.read(work.id).versions[1]!.operationId, "second-production");
  } finally { root.cleanup(); }
});

test("项目 AI 发现覆盖不足后主动补帧，材料核对不替外部审查或用户认可", { timeout: 40_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("补帧测试", "合成动作核对。");
    const version = readyVersion(store, work.id, "v001", "sample");
    const output = join(root.path, "real.mp4"), result = await renderVersion(store.resolvePath(version.sourcePath), output, join(root.path, "cache"));
    writeFileSync(store.resolvePath(version.mediaPath), readFileSync(output));
    version.videoSha256 = result.videoSha256; version.technicalCheck = result;
    work.versions.push(version); store.save(work);
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "coverage_more") });
    const material = await store.withLock(work.id, () => service.reviewMaterials.prepare(work, version));
    assert.equal(material.status, "needs_attention"); assert.equal(material.batches.length, 2);
    assert.equal(material.batches[1]!.ranges[0]!.reason, "合成请求：需要动作中间帧。");
    assert.equal(material.inspections?.length, 2); assert.equal(store.read(work.id).versions[0]!.review.status, "not_reviewed");
    const followup = JSON.parse(readFileSync(store.resolvePath(material.inspections![1]!.inputPath), "utf8"));
    assert.deepEqual(followup.previousInternalReview, material.inspections![0]!.result, "补帧复查保留本版上一轮问题，不能丢失原检查上下文");
    assert.equal(version.acceptance, "pending");
    assert(readFileSync(join(dirname(store.resolvePath(version.reviewPreparation!.batches[0]!.path)), "sheet-001.png")).length > 0);
  } finally { root.cleanup(); }
});

test("材料核对失联后恢复原回复，不重复付出一轮模型调用", { timeout: 40_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("材料恢复", "合成素材");
    const version = readyVersion(store, work.id, "v001", "sample");
    const output = join(root.path, "real.mp4"), result = await renderVersion(store.resolvePath(version.sourcePath), output, join(root.path, "cache"));
    writeFileSync(store.resolvePath(version.mediaPath), readFileSync(output));
    version.videoSha256 = result.videoSha256; version.technicalCheck = result; work.versions.push(version); store.save(work);
    const initial = new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect_after_result"), timeoutMs: 2000 });
    await assert.rejects(store.withLock(work.id, () => initial.reviewMaterials.prepare(work, version)));
    assert.equal(store.read(work.id).versions[0]!.reviewPreparation!.status, "unknown");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "read_only"), timeoutMs: 2000 });
    const current = store.read(work.id);
    const recovered = await store.withLock(work.id, () => service.reviewMaterials.prepare(current, current.versions[0]!));
    assert.equal(recovered.status, "available"); assert.equal(recovered.inspections!.length, 1);
    assert.equal(readFileSync(join(root.path, "native-fixture/calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"turn/start"')).length, 2, "视觉理解和内检各一次，恢复不重发");
  } finally { root.cleanup(); }
});

test("旧任务内检恢复须核原线程，未恢复材料时不清除未知或补认成功", { timeout: 40_000 }, async () => {
  const fixture = backgroundFixture("disconnect_after_result");
  try {
    const client = await fixture.connect();
    const work = await fixture.createLegacyWork(client, { operationId: "create", title: "旧任务材料恢复", brief: "合成一秒视频。", purpose: "test" });
    const store = new WorkStore(join(fixture.data, "testing"), "test", fixture.data), record = store.read(work.id);
    const version = readyVersion(store, work.id, "v001", "sample");
    const output = join(fixture.path, "real.mp4"), rendered = await renderVersion(store.resolvePath(version.sourcePath), output, join(fixture.path, "cache"));
    writeFileSync(store.resolvePath(version.mediaPath), readFileSync(output));
    version.videoSha256 = rendered.videoSha256; version.technicalCheck = rendered; record.versions.push(version); store.save(record);
    await fixture.call(client, "prepare_review_materials", { mode: "inspect_and_repair", operationId: "inspect", workId: work.id, versionId: version.id });
    assert.equal((await fixture.wait(client, "inspect")).status, "unknown");
    await fixture.call(client, "recover_work", { operationId: "without-materials", workId: work.id, render: false });
    assert.equal((await fixture.wait(client, "without-materials")).status, "unknown");
    assert.equal(store.read(work.id).execution.status, "unknown");
    assert(!existsSync(fixture.executions.path("inspect", "recovered.json")));
    await fixture.call(client, "recover_work", { mode: "resume", operationId: "recover", workId: work.id });
    assert.equal((await fixture.wait(client, "recover")).status, "succeeded");
    const original = await fixture.call(client, "get_execution", { executionId: "inspect" });
    assert.equal(original.status, "succeeded");
    const material = await fixture.call(client, "get_review_materials", { workId: work.id, versionId: version.id });
    assert.equal(material.status, "available"); assert.equal(material.inspections[0].status, "completed");
    assert.equal(material.inspections.length, 1); assert.equal(material.review.status, "not_reviewed");
    assert.equal(store.read(work.id).versions.length, 1); assert.equal(store.read(work.id).execution.status, "idle");
    assert.equal(fixture.countTurns(), 2, "视觉理解和内检各一次；只恢复原内检，不重发检查或制作");
  } finally { await fixture.cleanup(); }
});

test("小尺寸实际视频的多行拼图保留画面像素和时间标签，已发布批次可原样读取", { timeout: 40_000 }, async () => {
  const root = fixtureRoot();
  try {
    const entry = join(root.path, "source", "entry.tsx"); mkdirSync(dirname(entry));
    writeFileSync(entry, videoSource("red", 10).replace("width={160} height={90}", "width={2} height={2}"));
    const output = join(root.path, "video.mp4"), rendered = await renderVersion(entry, output, join(root.path, "cache"));
    const directory = join(root.path, "review"), ranges = [{ startSeconds: 0, endSeconds: 0.9, fps: 10, reason: "检查全部十帧" }];
    const batch = await prepareReviewBatch(output, rendered.videoSha256, directory, ranges);
    assert.equal(batch.frames.length, 10); assert.equal(batch.sheets.length, 1);
    const png = readFileSync(join(directory, batch.sheets[0]!.path));
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    assert(width >= 3 * 57, "每格需容纳四个字符及左右空白");
    assert.equal(batch.width, 2); assert.equal(batch.height, 2);
    const raw = join(root.path, "sheet.rgb");
    await mediaCommand(mediaBinaries().ffmpeg, ["-v", "error", "-i", join(directory, batch.sheets[0]!.path),
      "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "image2pipe", "-n", raw], 30_000);
    const pixels = readFileSync(raw);
    assert.equal(pixels.length, width * height * 3);
    const tileWidth = width / 3, tileHeight = height / 4;
    for (let index = 0; index < 10; index++) {
      const x = index % 3 * tileWidth, y = Math.floor(index / 3) * tileHeight;
      // 每格底部仍是视频的红色像素，扩宽后的其余区域保留白底，不能串行复制到邻格。
      const offset = ((y + tileHeight - 1) * width + x) * 3;
      assert(pixels[offset]! > 200 && pixels[offset + 1]! < 30 && pixels[offset + 2]! < 30);
      assert.deepEqual([...pixels.subarray(offset + 3, offset + 6)], [255, 255, 255]);
      let labelPixels = 0;
      for (let row = y; row < y + tileHeight - 1; row++) for (let column = x; column < x + tileWidth; column++) {
        if (pixels[(row * width + column) * 3] === 30) labelPixels++;
      }
      assert(labelPixels > 0, "每格须保留时间标签");
    }
    // 重读结果与实际保存的 JSON 一致；未提供的可选字段不会写入 JSON。
    const savedIndex = readFileSync(join(directory, "index.json"));
    assert.deepEqual(await prepareReviewBatch(output, rendered.videoSha256, directory, ranges), JSON.parse(savedIndex.toString("utf8")));
    assert.deepEqual(readFileSync(join(directory, "index.json")), savedIndex);
    assert.deepEqual(readFileSync(join(directory, batch.sheets[0]!.path)), png);
  } finally { root.cleanup(); }
});
