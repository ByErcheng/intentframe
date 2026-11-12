import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractPreviewFrames, mediaBinaries, mediaEnvironment } from "../src/media/render.ts";
import { selectReviewImages } from "../src/media/review-image-selection.ts";
import { ProductionMediaTools } from "../src/runtime/production-media.ts";
import { AssetService } from "../src/runtime/asset-service.ts";
import { NativeToolOutput } from "../src/runtime/codex-client.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { adoptedDesign, fixtureRoot, readyVersion } from "./helpers.ts";

test("精确帧预览贯通制作工具，局部时间不冒充原工程时间", { timeout: 90_000 }, async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), initial = store.create("定向画面", "合成颜色时序，只验证取帧。");
    const design = await adoptedDesign(store, initial.id);
    const work = store.read(initial.id), version = readyVersion(store, work.id, "v001", "sample");
    version.designRef = design; version.production = "creating"; work.versions.push(version);
    work.execution = { status: "running", runId: version.runId, versionId: version.id }; store.save(work);
    writeFileSync(store.resolvePath(version.sourcePath), `import React from 'react';
import {Composition,registerRoot,AbsoluteFill,useCurrentFrame} from 'remotion';
const Scene=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{backgroundColor:f<3?'red':f<5?'blue':'lime'}}/>};
registerRoot(()=> <Composition id="Video" component={Scene} durationInFrames={10} fps={10} width={160} height={90}/>);
`);
    const tools = new ProductionMediaTools(store, work, version.runId, new AssetService(store), version, { libraries: [] });
    await store.withLock(work.id, async () => {
      for (const args of [{ frameRange: [5, 2] }, { frameRange: [2, 5], frames: [1] }, { frames: [3, 3] }, { frames: [] },
        { frames: [1.5] }, { frames: Array.from({ length: 13 }, (_, i) => i) }, { frames: [0], foreign: true }]) {
        await assert.rejects(tools.call("intentframe_preview_video", args));
      }
      const response = await tools.call("intentframe_preview_video", { frameRange: [2, 5], frames: [5, 2, 3] });
      assert(response instanceof NativeToolOutput);
      const text = response.contentItems.find(item => item.type === "inputText");
      assert(text?.type === "inputText");
      const result = JSON.parse(text.text);
      assert.deepEqual(result.frameImages.map((item: any) => item.frame), [5, 2, 3]);
      assert.deepEqual(result.frameImages.map((item: any) => item.videoFrame), [3, 0, 1]);
      assert.deepEqual(result.frameImages.map((item: any) => item.seconds), [0.5, 0.2, 0.3]);
      assert.equal(response.contentItems.filter(item => item.type === "inputImage").length, 3);
      for (const [index, channel] of [1, 0, 2].entries()) {
        const rgb = execFileSync(mediaBinaries().ffmpeg, ["-v", "error", "-i", result.frameImages[index].path,
          "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "image2pipe", "-"], { env: mediaEnvironment() });
        assert(rgb[channel]! > 200, "实际画面的颜色须对应原工程指定帧");
        assert(rgb[(channel + 1) % 3]! < 40);
      }
      const receipt = JSON.parse(readFileSync(join(dirname(result.video), "preview.json"), "utf8"));
      assert.deepEqual(receipt.frameImages, result.frameImages);
      const overview = await tools.call("intentframe_preview_video", { frameRange: [2, 5] });
      assert(overview instanceof NativeToolOutput);
      const overviewText = overview.contentItems.find(item => item.type === "inputText");
      assert(overviewText?.type === "inputText");
      assert.deepEqual(JSON.parse(overviewText.text).frameImages.map((item: any) => item.frame), [2, 3, 4],
        "不指定帧时仍返回原有三张概览，并标明原工程位置");
      await assert.rejects(extractPreviewFrames(result.video, result.check.videoSha256, 10, 4, [6], 2), /范围/);
      const abort = new AbortController(); abort.abort(new Error("合成取消"));
      await assert.rejects(extractPreviewFrames(result.video, result.check.videoSha256, 10, 4, [2], 2, abort.signal), /合成取消/);
      writeFileSync(result.video, "已变化");
      await assert.rejects(extractPreviewFrames(result.video, result.check.videoSha256, 10, 4, [2], 2), /已变化/);
      assert.equal(version.acceptance, "pending"); assert.equal(version.review.status, "not_reviewed");
      assert.equal(store.read(work.id).versions[0]!.production, "creating");
    });
  } finally { root.cleanup(); }
});

test("审查附图兼顾全片与最近补帧，预算不足时保留可解释的覆盖", () => {
  const batch = (prefix: string, count: number, targeted = false) => ({ ranges: targeted ? [{}] : [],
    sheets: Array.from({ length: count }, (_, i) => ({ location: prefix + i })) });
  assert.deepEqual(selectReviewImages([batch("overview", 2), batch("new", 3, true)]), ["overview0", "overview1", "new0", "new1", "new2"]);
  const selected = selectReviewImages([batch("overview", 15), batch("old", 20, true), batch("new", 8, true)]);
  assert.equal(selected.length, 12);
  assert(selected.includes("overview0") && selected.includes("overview14"));
  for (let i = 0; i < 8; i++) assert(selected.includes("new" + i), "新补材料不应被大量旧拼图挤出");
  const dense = selectReviewImages([batch("overview", 4), batch("new", 20, true)]);
  assert.equal(dense.length, 12); assert(dense.includes("new0") && dense.includes("new19"));
  assert.deepEqual(selectReviewImages([batch("overview", 20)], 2), ["overview0", "overview19"]);
  assert.deepEqual(selectReviewImages([batch("new", 20, true)], 1), ["new10"]);
  assert.deepEqual(selectReviewImages([]), []);
  assert.throws(() => selectReviewImages([], 0), /正整数/);
});
