import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateReviewCoverage } from "../src/records/media-contracts.ts";
import type { ReviewCoverage } from "../src/records/media-contracts.ts";
import { executeToolInline } from "../src/mcp/server.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { fixtureRoot, readyVersion } from "./helpers.ts";

const framesOnly = (): ReviewCoverage => ({
  frames: { status: "checked", ranges: [{ startSeconds: 0, endSeconds: 12 }], notes: "仅检查全片的时间采样图。" },
  temporal: { status: "not_checked", ranges: [], notes: "未核对相邻帧或变化指标。" },
  playback: { status: "not_watched", ranges: [], notes: "未实际连续观看。" },
});

test("帧图、时序和实际播放的范围分别校验，不从passed补认观看", () => {
  const scope = framesOnly();
  assert.equal(validateReviewCoverage(scope, 12).playback.status, "not_watched");
  assert.throws(() => validateReviewCoverage(scope, undefined), /时长未核实/);
  assert.throws(() => validateReviewCoverage(scope, 11), /超出实际成片/);
  assert.throws(() => validateReviewCoverage({ ...scope, playback: { ...scope.playback, status: "full" } }, 12), /实际播放须列/);
  assert.throws(() => validateReviewCoverage({ ...scope, playback: { ...scope.playback, ranges: [{ startSeconds: 0, endSeconds: 12, rate: 1 }] } }, 12), /未观看/);
  const full: ReviewCoverage = { ...scope, playback: { status: "full", ranges: [
    { startSeconds: 6, endSeconds: 12, rate: 1 }, { startSeconds: 0, endSeconds: 6, rate: 0.5 },
  ], notes: "合成声明：分别按记录速度观看两个区间。" } };
  assert.equal(validateReviewCoverage(full, 12).playback.status, "full");
  assert.throws(() => validateReviewCoverage({ ...full, playback: { ...full.playback, ranges: [{ startSeconds: 0, endSeconds: 6, rate: 1 }] } }, 12), /未覆盖全片/);
  assert.throws(() => validateReviewCoverage({ ...full, playback: { ...full.playback, ranges: [
    { startSeconds: 0, endSeconds: 5, rate: 1 }, { startSeconds: 6, endSeconds: 12, rate: 1 },
  ] } }, 12), /未覆盖的时间段/);
  assert.throws(() => validateReviewCoverage({ ...scope, temporal: { status: "checked", ranges: [{ startSeconds: 3, endSeconds: 3 }], notes: "只有一帧" } }, 12), /相邻时刻/);
});

test("MCP保存明确检查范围并保留历史缺值，错误声明不写操作或审查", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), service = new WorkService(store), work = store.create("合成范围记录", "只验证范围与记录，不声明真实观看。");
    const version = readyVersion(store, work.id, "v001", "sample");
    version.technicalCheck = { ...version.technicalCheck, durationSeconds: 12 };
    work.versions.push(version); store.save(work);
    await store.review(work.id, version.id, "passed", "历史未提供结构化范围", "user");
    const prior = readFileSync(join(store.workDirectory(work.id), "task.json"));
    const invalid = { operationId: "bad-scope", workId: work.id, versionId: version.id, status: "passed", notes: "合成错误范围", source: "user",
      coverage: { ...framesOnly(), playback: { status: "full", ranges: [{ startSeconds: 0, endSeconds: 5, rate: 1 }], notes: "只看了5秒" } } };
    await assert.rejects(executeToolInline("record_review", invalid, service), /未覆盖全片/);
    assert.deepEqual(readFileSync(join(store.workDirectory(work.id), "task.json")), prior);
    assert(!existsSync(join(root.path, "operations/bad-scope")));
    const request = { ...invalid, operationId: "frames-only", coverage: framesOnly(), notes: "本次只看帧图。" };
    const result = await executeToolInline("record_review", request, service) as { versions: { review: { coverage: ReviewCoverage } }[] };
    assert.equal(result.versions[0]!.review.coverage.playback.status, "not_watched");
    const summary = await executeToolInline("get_work", { workId: work.id }, service) as { latestVersion: { review: { coverage: ReviewCoverage } } };
    assert.equal(summary.latestVersion.review.coverage.playback.status, "not_watched");
    const saved = store.read(work.id).versions[0]!;
    assert.equal(saved.reviews![0]!.coverage, undefined, "不能改写历史缺值");
    assert.deepEqual(saved.reviews!.at(-1)!.coverage, framesOnly());
    assert.equal(saved.acceptance, "pending");
    assert.deepEqual(await executeToolInline("record_review", request, service), result);
  } finally { root.cleanup(); }
});
