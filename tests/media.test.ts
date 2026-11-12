import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileHash, renderVersion, restoreVideoPreviews, verifyFrameTiming } from "../src/media/render.ts";
import { captureSourceSnapshot, sourceSnapshotSchema, verifySourceSnapshot } from "../src/records/source-snapshot.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fixtureRoot, readyVersion, videoSource } from "./helpers.ts";

test("技术时间校验拒绝缺帧、重复、倒序、跳变与未知时间戳", () => {
  assert.equal(verifyFrameTiming(3, [0, 0.1, 0.2], 3, 10).monotonic, true);
  assert.equal(verifyFrameTiming(1, [0], 1, 30).checked, true);
  for (const times of [[0, 0.1], [0, 0.1, 0.1], [0, 0.2, 0.1], [0, 0.15, 0.2], [0, NaN, 0.2]]) {
    assert.throws(() => verifyFrameTiming(3, times, 3, 10), /帧数或帧时间戳/);
  }
  assert.throws(() => verifyFrameTiming(2, [0, 0.1, 0.2], 3, 10), /帧数或帧时间戳/);
});

test("局部预览按实际帧范围渲染并保存可用帧图，不与完整渲染混用", { timeout: 90000 }, async () => {
  const root = fixtureRoot();
  try {
    const entry = join(root.path, "source/entry.tsx"); mkdirSync(dirname(entry)); writeFileSync(entry, videoSource("green", 10));
    const output = join(root.path, "media/preview.mp4");
    const result = await renderVersion(entry, output, join(root.path, "cache"), { frameRange: [2, 5] });
    assert(Math.abs(result.durationSeconds - 0.4) < 0.1); assert(result.previews.every(path => existsSync(path)));
    await assert.rejects(renderVersion(entry, output, join(root.path, "cache")), /帧范围/);
    const repeat = await renderVersion(entry, output, join(root.path, "cache"), { frameRange: [2, 5] });
    assert.equal(repeat.videoSha256, result.videoSha256);
  } finally { root.cleanup(); }
});

test("真实渲染核对帧率、拒绝陌生成片，并能恢复丢失的已认可文件", { timeout: 180_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("真实媒体回归", "一秒纯色测试画面。");
    const version = readyVersion(store, work.id, "v001", "complete");
    const entry = store.resolvePath(version.sourcePath), output = store.resolvePath(version.mediaPath);
    rmSync(output);
    const result = await renderVersion(entry, output, join(root.path, "cache-a"), { sourceSnapshot: version.sourceSnapshot });
    assert.equal(result.fps, 10); assert.equal(result.decoded, true);
    assert.equal(result.frameCount, 10); assert.equal(result.frameTiming.monotonic, true);
    version.technicalCheck = result; version.videoSha256 = result.videoSha256;
    work.versions.push(version); store.save(work);
    await store.confirm(work.id, version.id, "acceptance", "合成回归中的确认");
    const service = new WorkService(store);
    const before = fileHash(output);
    await service.renderExisting(work.id, version.id);
    assert.equal(fileHash(output), before);
    rmSync(output);
    await service.renderExisting(work.id, version.id);
    assert.equal(fileHash(output), before);
    assert.equal(store.read(work.id).versions[0]?.acceptance, "accepted");
    assert.equal(store.summary(store.read(work.id)).versions[0]?.availability.status, "available");

    const blue = join(root.path, "blue/source/entry.tsx"), blueOutput = join(root.path, "blue/media/video.mp4");
    mkdirSync(dirname(blue), { recursive: true }); writeFileSync(blue, videoSource("blue", 20));
    const blueResult = await renderVersion(blue, blueOutput, join(root.path, "cache-b"));
    assert.equal(blueResult.fps, 20);
    const unrelated = join(root.path, "unrelated/video.mp4");
    mkdirSync(dirname(unrelated)); copyFileSync(blueOutput, unrelated);
    await assert.rejects(renderVersion(entry, unrelated, join(root.path, "cache-c")), /缺少可核对的来源/);
    assert.equal(fileHash(unrelated), blueResult.videoSha256);
    await assert.rejects(renderVersion(entry, unrelated, join(root.path, "cache-c"), {
      sourceSnapshot: version.sourceSnapshot, expectedVideoSha256: blueResult.videoSha256,
    }), /实际帧率/);

    // 发布前留下的收据使“已生成、任务记录尚未补存”的结果可安全核对。
    const recovered = await renderVersion(blue, blueOutput, join(root.path, "cache-b"));
    assert.equal(recovered.videoSha256, blueResult.videoSha256);
    const receipt = join(dirname(blueOutput), "render-receipt.json");
    assert(existsSync(receipt));
    writeFileSync(blueOutput, "被替换的无关文件");
    await assert.rejects(renderVersion(blue, blueOutput, join(root.path, "cache-b")), /校验值不一致/);
    assert.equal(readFileSync(blueOutput, "utf8"), "被替换的无关文件");
  } finally { root.cleanup(); }
});

test("完整工程包含被导入源码和本地素材，拒绝目录外依赖", { timeout: 90_000 }, async () => {
  const root = fixtureRoot();
  try {
    const entry = join(root.path, "source/entry.tsx"), helper = join(dirname(entry), "color.ts");
    mkdirSync(dirname(entry)); writeFileSync(entry, videoSource("red", 10, true));
    writeFileSync(helper, 'export const color="red";\n');
    mkdirSync(join(dirname(entry), "public")); writeFileSync(join(dirname(entry), "public/asset.txt"), "本地测试素材");
    const snapshot = captureSourceSnapshot(entry);
    assert(Object.hasOwn(snapshot.files, "color.ts"));
    assert(Object.hasOwn(snapshot.files, "public/asset.txt"));
    writeFileSync(helper, 'export const color="blue";\n');
    await assert.rejects(renderVersion(entry, join(root.path, "media/video.mp4"), join(root.path, "cache"), { sourceSnapshot: snapshot }), /工程或制作依赖/);
    writeFileSync(join(root.path, "outside.ts"), 'export const color="green";\n');
    writeFileSync(entry, videoSource("red", 10, true).replace('"./color"', '"../outside"'));
    await assert.rejects(renderVersion(entry, join(root.path, "media/video.mp4"), join(root.path, "cache")), /版本目录外/);
  } finally { root.cleanup(); }
});

test("单帧视频交付的每个预览路径都指向实际生成的图片", { timeout: 90_000 }, async () => {
  const root = fixtureRoot();
  try {
    const entry = join(root.path, "source/entry.tsx"); mkdirSync(dirname(entry));
    writeFileSync(entry, videoSource("red", 30).replace("durationInFrames={30}", "durationInFrames={1}"));
    const result = await renderVersion(entry, join(root.path, "media/video.mp4"), join(root.path, "cache"));
    assert.equal(result.previews.length, 3);
    for (const preview of result.previews) assert(existsSync(preview), "不能交付不存在的预览：" + preview);
    rmSync(result.previews[0]!);
    const restored = await restoreVideoPreviews(join(root.path, "media/video.mp4"), result.videoSha256);
    assert.equal(restored.previews.length, 3);
    assert(restored.previews.every(path => existsSync(path)));
  } finally { root.cleanup(); }
});

test("缺失和空预览单独恢复，失败可见且不重渲染视频或改变认可", { timeout: 90_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("预览恢复", "一秒合成视频。");
    const version = readyVersion(store, work.id, "v001", "complete");
    const entry = store.resolvePath(version.sourcePath), output = store.resolvePath(version.mediaPath);
    rmSync(output);
    const rendered = await renderVersion(entry, output, join(root.path, "render"), { sourceSnapshot: version.sourceSnapshot });
    version.technicalCheck = rendered; version.videoSha256 = rendered.videoSha256;
    work.versions.push(version); store.save(work);
    const confirmed = await store.confirm(work.id, version.id, "acceptance", "合成认可，仅测状态");
    rmSync(rendered.previews[0]!); writeFileSync(rendered.previews[1]!, "");
    const view = store.summary(store.read(work.id)).versions[0]!;
    assert.equal(view.availability.status, "available");
    assert.equal(view.previewAvailability.status, "incomplete");
    assert.deepEqual(view.technicalCheck!.previews, [rendered.previews[2]]);
    assert.deepEqual(store.read(work.id).versions[0]!.technicalCheck!.previews, rendered.previews, "只读查询不改写历史检查");
    const failure = new WorkService(store, { restorePreviews: async () => { throw new Error("合成抽帧失败"); } });
    await assert.rejects(failure.renderExisting(work.id, version.id), /预览恢复失败.*合成抽帧失败/);
    const failed = store.read(work.id);
    assert.equal(failed.execution.status, "failed");
    assert.equal(failed.versions[0]!.production, "ready"); assert.equal(failed.versions[0]!.acceptance, "accepted");
    assert.equal(fileHash(output), rendered.videoSha256);
    const service = new WorkService(store, { render: async () => { throw new Error("不应重新渲染视频"); } });
    await service.renderExisting(work.id, version.id);
    const restored = store.read(work.id);
    assert.equal(restored.execution.status, "idle"); assert.equal(restored.versions[0]!.error, undefined);
    assert.equal(store.previewAvailability(restored.versions[0]!).status, "available");
    assert.deepEqual(restored.confirmations, confirmed.confirmations);
    assert.equal(restored.versions[0]!.technicalCheck!.checkedAt, rendered.checkedAt);
    assert.equal(fileHash(output), rendered.videoSha256);
    const unchanged = readFileSync(join(store.workDirectory(work.id), "task.json"), "utf8");
    await service.renderExisting(work.id, version.id);
    assert.equal(readFileSync(join(store.workDirectory(work.id), "task.json"), "utf8"), unchanged);
    // 原调用恢复同样补齐预览；render=false 保留现场。
    rmSync(rendered.previews[0]!);
    await service.recover(work.id, false); assert(!existsSync(rendered.previews[0]!));
    await service.recover(work.id, true); assert(existsSync(rendered.previews[0]!));
    assert.equal(fileHash(output), rendered.videoSha256);
  } finally { root.cleanup(); }
});

test("完整工程快照不能静默漏记特殊文件名，改动后不能通过原版本核验", () => {
  const root = fixtureRoot();
  try {
    const entry = join(root.path, "source", "entry.tsx"); mkdirSync(dirname(entry)); writeFileSync(entry, videoSource());
    mkdirSync(join(dirname(entry), "assets"));
    mkdirSync(join(dirname(entry), "__proto__"));
    const names = ["assets/__proto__", "__proto__/material.txt", "constructor", "toString"];
    for (const name of names) writeFileSync(join(dirname(entry), name), "原始内容");
    const snapshot = sourceSnapshotSchema.parse(JSON.parse(JSON.stringify(captureSourceSnapshot(entry))));
    for (const name of names) assert(Object.hasOwn(snapshot.files, name), name + " 未被记录");
    assert.doesNotThrow(() => verifySourceSnapshot(entry, snapshot));
    writeFileSync(join(dirname(entry), "assets/__proto__"), "已改变");
    assert.throws(() => verifySourceSnapshot(entry, snapshot), /变化/);
    rmSync(join(dirname(entry), "__proto__"), { recursive: true });
    writeFileSync(join(dirname(entry), "__proto__"), "不能漏记");
    assert.throws(() => captureSourceSnapshot(entry), /__proto__.*重命名/);
  } finally { root.cleanup(); }
});
