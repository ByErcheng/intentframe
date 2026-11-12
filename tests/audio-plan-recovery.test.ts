import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { AssetService } from "../src/runtime/asset-service.ts";
import { ProductionMediaTools } from "../src/runtime/production-media.ts";
import { readAudioPlan } from "../src/runtime/audio-plan.ts";
import { valueHash } from "../src/records/files.ts";
import { adoptedDesign, fixtureRoot, readyVersion } from "./helpers.ts";

async function setup() {
  const root = fixtureRoot(), store = new WorkStore(root.path), initial = store.create("编排恢复", "合成声音，不检查听感。");
  const design = await adoptedDesign(store, initial.id), work = store.read(initial.id);
  const version = readyVersion(store, work.id, "v001", "sample");
  version.designRef = design; version.production = "creating"; work.versions.push(version);
  work.execution = { status: "running", runId: version.runId, versionId: version.id }; store.save(work);
  const assets = new AssetService(store), bytes = Buffer.alloc(48044);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(48000, 40);
  const asset = await assets.assets.write(work, { bytes, extension: ".wav", role: "music", description: "合成静音",
    origin: "fixture", operationId: "audio-fixture" });
  assets.assets.register(work, asset);
  const tools = new ProductionMediaTools(store, work, version.runId, assets, version);
  const request = (operationKey: string, startMs: number) => ({ operationKey, clips: [{ id: "music", assetId: asset.id, startMs }] });
  const files = ["public/intentframe/audio-plan.json", "intentframe-audio-data.ts", "intentframe-audio.tsx"]
    .map(path => join(dirname(store.resolvePath(version.sourcePath)), path));
  return { root, store, work, version, tools, request, files };
}

test("声音编排 A、B 成功后重试 A 只返回原回执，不回退当前文件或版本记录", async () => {
  const f = await setup();
  try {
    await f.store.withLock(f.work.id, async () => {
      const first = await f.tools.call("intentframe_set_audio_playback", f.request("a", 0));
      await f.tools.call("intentframe_set_audio_playback", f.request("b", 500));
      const before = f.files.map(path => readFileSync(path, "utf8")), state = f.store.read(f.work.id);
      const fresh = new ProductionMediaTools(f.store, state, f.version.runId, new AssetService(f.store), state.versions[0]);
      assert.deepEqual(await fresh.call("intentframe_set_audio_playback", f.request("a", 0)), first);
      assert.equal(readAudioPlan(f.store, state.versions[0]!)!.clips[0]!.startMs, 500);
      assert.deepEqual(f.files.map(path => readFileSync(path, "utf8")), before);
      await assert.rejects(fresh.call("intentframe_set_audio_playback", f.request("a", 900)), /不同输入/);
    });
  } finally { f.root.cleanup(); }
});

for (const mode of ["initial", "task-before", "task-after", "receipt", "rollback"] as const) {
  test("声音提交故障后按持久事实接续：" + mode, async () => {
    const f = await setup(), originalRename = fs.renameSync, originalLink = fs.linkSync, originalSave = f.store.save.bind(f.store);
    let failing = true, interrupted = false;
    const request = f.request("attempt", 500);
    const resultPath = join(f.store.workDirectory(f.work.id), "runs", f.version.runId, "media-tools",
      "tool-" + valueHash({ runId: f.version.runId, name: "intentframe_set_audio_playback", callKey: "attempt" }).slice(0, 32), "result.json");
    try {
      await f.store.withLock(f.work.id, async () => {
        if (mode !== "initial") await f.tools.call("intentframe_set_audio_playback", f.request("old", 0));
        const before = f.files.map(path => existsSync(path) ? readFileSync(path, "utf8") : null);
        fs.renameSync = (from, to) => {
          if (failing && mode === "rollback" && String(to) === f.files[1]) interrupted = true;
          if (failing && ((mode === "initial" && String(to) === f.files[2]) ||
              (mode === "rollback" && interrupted && (String(to) === f.files[1] || String(to) === f.files[0])))) {
            throw new Error("合成文件提交失败");
          }
          originalRename(from, to);
        };
        fs.linkSync = (from, to) => {
          if (failing && mode === "receipt" && String(to) === resultPath) throw new Error("合成工具回执失败");
          originalLink(from, to);
        };
        f.store.save = work => {
          if (failing && mode === "task-before") throw new Error("合成任务保存前失败");
          originalSave(work);
          if (failing && mode === "task-after") throw new Error("合成任务保存后失败");
        };
        syncBuiltinESMExports();
        try { await assert.rejects(f.tools.call("intentframe_set_audio_playback", request), /合成|提交和回退/); }
        finally { failing = false; fs.renameSync = originalRename; fs.linkSync = originalLink; f.store.save = originalSave; syncBuiltinESMExports(); }
        if (mode === "initial" || mode === "task-before") {
          assert.deepEqual(f.files.map(path => existsSync(path) ? readFileSync(path, "utf8") : null), before);
        }
        if (mode === "rollback") assert.notEqual(readFileSync(f.files[0]!, "utf8"), before[0], "中断与回退失败留下已知的混合状态");
        const state = f.store.read(f.work.id), version = state.versions[0]!;
        const fresh = new ProductionMediaTools(f.store, state, version.runId, new AssetService(f.store), version);
        if (mode !== "receipt") {
          assert.throws(() => readAudioPlan(f.store, version), /尚未提交完整/);
          await assert.rejects(fresh.settled(), /尚未提交完整/);
          await assert.rejects(fresh.call("intentframe_set_audio_playback", f.request("other", 900)), /未完成/);
        } else {
          // 业务提交完成、外层回执丢失；后续成功更新后重试仍不能回退。
          await fresh.call("intentframe_set_audio_playback", f.request("later", 900));
        }
        const result = await fresh.call("intentframe_set_audio_playback", request);
        assert.equal(readAudioPlan(f.store, version)!.clips[0]!.startMs, mode === "receipt" ? 900 : 500);
        assert.deepEqual(await fresh.call("intentframe_set_audio_playback", request), result);
        assert.deepEqual(f.store.read(f.work.id).versions[0]!.audioPlan, version.audioPlan);
      });
    } finally { fs.renameSync = originalRename; fs.linkSync = originalLink; f.store.save = originalSave; syncBuiltinESMExports(); f.root.cleanup(); }
  });
}

test("待提交编排不覆盖未知文件；同一素材可在多个片段重复播放", async () => {
  const f = await setup(), originalSave = f.store.save.bind(f.store);
  try {
    await f.store.withLock(f.work.id, async () => {
      await f.tools.call("intentframe_set_audio_playback", f.request("old", 0));
      f.store.save = () => { throw new Error("合成保存失败"); };
      try { await assert.rejects(f.tools.call("intentframe_set_audio_playback", f.request("pending", 500)), /保存失败/); }
      finally { f.store.save = originalSave; }
      const before = readFileSync(f.files[0]!, "utf8"); writeFileSync(f.files[0]!, "无法确认的外部内容");
      await assert.rejects(f.tools.call("intentframe_set_audio_playback", f.request("pending", 500)), /工具外改动/);
      assert.equal(readFileSync(f.files[0]!, "utf8"), "无法确认的外部内容");
      writeFileSync(f.files[0]!, before);
      await f.tools.call("intentframe_set_audio_playback", f.request("pending", 500));
      const first = f.request("unused", 0).clips[0]!;
      await f.tools.call("intentframe_set_audio_playback", { operationKey: "repeated-clip", clips: [first, { ...first, id: "again", startMs: 1000 }] });
      assert.equal(readAudioPlan(f.store, f.version)!.clips.length, 2);
      assert.equal(f.version.assets!.length, 1);
    });
  } finally { f.store.save = originalSave; f.root.cleanup(); }
});

test("声音编排写入中断保留旧文件，重新读取作品后沿原请求补存", async () => {
  const f = await setup(), originalWrite = fs.writeFileSync, originalRename = fs.renameSync;
  try {
    await f.store.withLock(f.work.id, async () => {
      await f.tools.call("intentframe_set_audio_playback", f.request("old", 0));
      const before = f.files.map(path => readFileSync(path, "utf8")); let fail = true;
      fs.writeFileSync = ((path, ...args) => {
        if (fail && (String(path) === f.files[1] || String(path).startsWith(f.files[1] + "."))) {
          fail = false; throw new Error("合成 ENOSPC：第二份派生文件写入失败");
        }
        return originalWrite(path, ...args);
      }) as typeof fs.writeFileSync;
      fs.renameSync = (from, to) => {
        if (fail && String(to) === f.files[1]) { fail = false; throw new Error("合成 ENOSPC：第二份派生文件写入失败"); }
        return originalRename(from, to);
      };
      syncBuiltinESMExports();
      try { await assert.rejects(f.tools.call("intentframe_set_audio_playback", f.request("new", 500)), /ENOSPC/); }
      finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename; syncBuiltinESMExports(); }
      assert.deepEqual(f.files.map(path => readFileSync(path, "utf8")), before);
      const state = f.store.read(f.work.id), version = state.versions[0]!;
      const fresh = new ProductionMediaTools(f.store, state, version.runId, new AssetService(f.store), version);
      await fresh.call("intentframe_set_audio_playback", f.request("new", 500));
      assert.equal(readAudioPlan(f.store, version)!.clips[0]!.startMs, 500);
      assert.deepEqual(f.store.read(f.work.id).versions[0]!.audioPlan, version.audioPlan);
    });
  } finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename; syncBuiltinESMExports(); f.root.cleanup(); }
});
