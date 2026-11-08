import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkStore } from "../src/records/work-store.ts";
import type { WorkVersion } from "../src/records/work-store.ts";
import { captureSourceSnapshot, fileHash, verifySourceSnapshot } from "../src/records/source-snapshot.ts";
import type { renderVersion } from "../src/media/render.ts";

export function fixtureRoot() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "intentframe-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function fakeCodex(root: string, mode = "completed"): string {
  const path = join(root, "codex-" + mode + ".mjs");
  const source = fileURLToPath(new URL("./fixtures/codex-server.mjs", import.meta.url));
  writeFileSync(path, "#!" + process.execPath + "\nimport {run} from " + JSON.stringify(pathToFileURL(source).href) + ";\nrun(" + JSON.stringify(mode) + ");\n");
  chmodSync(path, 0o700);
  return path;
}

export function videoSource(color = "red", fps = 10, helper = false): string {
  return 'import React from "react";import {Composition,registerRoot,AbsoluteFill} from "remotion";\n' +
    (helper ? 'import {color} from "./color";\n' : 'const color=' + JSON.stringify(color) + ';\n') +
    'const Scene=()=> <AbsoluteFill style={{backgroundColor:color}}/>;\n' +
    'registerRoot(()=> <Composition id="Video" component={Scene} durationInFrames={' + fps + '} fps={' + fps + '} width={160} height={90}/>);\n';
}

export function readyVersion(store: WorkStore, workId: string, id: string, kind: "sample" | "complete"): WorkVersion {
  const v: WorkVersion = {
    id, kind, production: "ready", sourcePath: "works/" + workId + "/versions/" + id + "/source/entry.tsx",
    mediaPath: "media/" + workId + "/" + id + "/video.mp4", createdAt: new Date().toISOString(),
    runId: "run-" + id, review: { status: "not_reviewed" }, acceptance: "pending",
  };
  mkdirSync(dirname(store.resolvePath(v.sourcePath)), { recursive: true });
  mkdirSync(dirname(store.resolvePath(v.mediaPath)), { recursive: true });
  writeFileSync(store.resolvePath(v.sourcePath), videoSource());
  // 状态规则测试只检查字节身份；真实解码与渲染由 media.test.ts 独立验证。
  writeFileSync(store.resolvePath(v.mediaPath), "合成测试产物：" + id);
  v.sourceSha256 = fileHash(store.resolvePath(v.sourcePath));
  v.videoSha256 = fileHash(store.resolvePath(v.mediaPath));
  v.sourceSnapshot = captureSourceSnapshot(store.resolvePath(v.sourcePath));
  return v;
}

export const fixtureRender: typeof renderVersion = async (entry, output, _cache, options = {}) => {
  if (options.sourceSnapshot) verifySourceSnapshot(entry, options.sourceSnapshot);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, readFileSync(entry));
  return { width: 160, height: 90, fps: 10, durationSeconds: 1, videoCodec: "fixture", audioStreams: 0,
    decoded: true, sourceSha256: fileHash(entry), videoSha256: fileHash(output), previews: [], checkedAt: new Date().toISOString() };
};
