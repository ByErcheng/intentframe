import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkStore } from "../src/records/work-store.ts";
import type { WorkVersion } from "../src/records/work-store.ts";
import { captureSourceSnapshot, fileHash, verifySourceSnapshot } from "../src/records/source-snapshot.ts";
import type { renderVersion } from "../src/media/render.ts";
import { DocumentStore } from "../src/records/document-store.ts";
import { createHash } from "node:crypto";
import type { DraftSubmission } from "../src/records/authoring-contracts.ts";

/** 调用方提供的合成文件来源与确认声明；不代表真实用户确认或真实素材。 */
export function draftSubmission(markdown: string): DraftSubmission {
  return { sourcePath: "/synthetic/user-reviewed-draft.md", contentSha256: createHash("sha256").update(markdown).digest("hex"),
    authorization: { kind: "user", userInstruction: "合成用户确认：将此版本交给项目检查和设计。" } };
}

export function confirmedDraft<T extends { brief: string }>(input: T) { return { ...input, submission: draftSubmission(input.brief) }; }

/** 合成已交接、已采用设计，供非模型设计能力测试复用；真实接入另测完整交接。 */
export async function adoptedDesign(store: WorkStore, workId: string, markdown = "# 合成设计\n显示测试色块，检查交接。\n") {
  const documents = new DocumentStore(store), record = store.read(workId);
  if (!record.authoring) documents.initialize(record, "合成草稿，只验证系统行为。", "fixture-draft");
  const draft = store.read(workId).authoring!.drafts.at(-1)!;
  await documents.handoff(workId, draft, "合成用户指令：按本稿开始设计。", "fixture-handoff");
  const current = store.read(workId);
  if (draft.reviewRequired) current.authoring!.runs.push({ id: "fixture-review", operationId: "fixture-review", kind: "review_draft", base: draft,
    instruction: "合成通过，仅用于隔离其他模块测试。", assetIds: [], sendState: "acknowledged", status: "completed", inputPath: "fixture", inputSha256: "fixture", blockers: [],
    draftReview: { status: "passed", summary: "合成检查", issues: [], usedExperienceRefs: [], limitations: ["不代表实际检查。"] } });
  const design = documents.append(current, "design", markdown, {
    operationId: "fixture-design", source: "project_ai", instruction: "合成设计夹具。", assetIds: [], draft,
  });
  store.save(current);
  const ref = { id: design.id, sha256: design.sha256 };
  await documents.decide(workId, { operationId: "fixture-decision", design: ref, status: "adopted", source: "external_ai", notes: "合成采用，不代表真实用户评价。" });
  return ref;
}

export function fixtureRoot() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "intentframe-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function fakeCodex(root: string, mode = "completed", completionDelayMs = 1_000): string {
  const path = join(root, "codex-" + mode + ".mjs");
  const source = fileURLToPath(new URL("./fixtures/codex-server.mjs", import.meta.url));
  writeFileSync(path, "#!" + process.execPath + "\nimport {run} from " + JSON.stringify(pathToFileURL(source).href) + ";\nrun(" + JSON.stringify(mode) + "," + JSON.stringify(join(root, "native-fixture")) + "," + completionDelayMs + ");\n");
  chmodSync(path, 0o700);
  return path;
}

export function videoSource(color = "red", fps = 10, helper = false): string {
  return 'import React from "react";import {Composition,registerRoot,AbsoluteFill} from "remotion";\n' +
    (helper ? 'import {color} from "./color";\n' : 'const color=' + JSON.stringify(color) + ';\n') +
    'const Scene=()=> <AbsoluteFill style={{backgroundColor:color}}/>;\n' +
    'registerRoot(()=> <Composition id="Video" component={Scene} durationInFrames={' + fps + '} fps={' + fps + '} width={160} height={90}/>);\n';
}

function fixturePreviews(output: string) {
  // 状态测试只需要可定位的合成预览；真实抽帧与解码另由媒体回归验证。
  return [1, 2, 3].map(index => {
    const path = join(dirname(output), "frame-" + index + ".png");
    writeFileSync(path, "合成预览：" + index);
    return path;
  });
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
  v.technicalCheck = { previews: fixturePreviews(store.resolvePath(v.mediaPath)) };
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
    frameCount: 10, frameTiming: { checked: true, monotonic: true, expectedStepSeconds: 0.1 },
    decoded: true, sourceSha256: fileHash(entry), videoSha256: fileHash(output), previews: fixturePreviews(output), checkedAt: new Date().toISOString() };
};
