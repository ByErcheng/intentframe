import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { exportBaseline } from "../scripts/model-evaluation/baseline.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { executeToolInline } from "../src/mcp/server.ts";
import { DocumentStore } from "../src/records/document-store.ts";
import { draftSubmission } from "./helpers.ts";
import { adoptedDesign, confirmedDraft, fixtureRoot, readyVersion, seedProfile } from "./helpers.ts";

async function setup() {
  const root = fixtureRoot(), sourceRoot = join(root.path, "original"); seedProfile(sourceRoot);
  const store = new WorkStore(join(sourceRoot, "testing"), "test", sourceRoot), service = new WorkService(store);
  const created = await executeToolInline("create_work", { operationId: "create", ...confirmedDraft({
    title: "共同基线", brief: "合成输入，用于核对导出前后规则。", purpose: "test" }) }, service) as { id: string };
  const design = await adoptedDesign(store, created.id), work = store.read(created.id);
  work.authoring!.runs[0]!.draftReview!.summary = "不可泄露给候选的原检查答案";
  const version = readyVersion(store, work.id, "v001", "complete"); version.designRef = design;
  work.versions.push(version); store.save(work);
  return { root, sourceRoot, store, service, work, design, version, target: join(root.path, "exported") };
}

test("新流程基线保留检查前置事实，导出后可准备反馈制作且不携带原检查正文", async () => {
  const f = await setup();
  try {
    const original = readFileSync(f.store.resolvePath("works/" + f.work.id + "/task.json"), "utf8");
    f.service.documents.adopted(f.work, f.design);
    await exportBaseline(f.sourceRoot, f.work.id, f.version.id, f.target);
    const store = new WorkStore(join(f.target, "testing"), "test", f.target), service = new WorkService(store), work = store.read(f.work.id);
    assert.equal(work.authoring!.drafts[0]!.reviewRequired, true);
    assert.deepEqual(work.authoring!.runs, []);
    assert.doesNotThrow(() => service.documents.adopted(work, f.design));
    const summary = await executeToolInline("get_work", { workId: work.id }, service) as {
      authoring: { draftReview?: unknown; baselineDraftReview?: { kind: string } }; nextActions: { arguments: { name?: string } }[] };
    assert.equal(summary.authoring.draftReview, undefined, "不伪造新的模型检查");
    assert.equal(summary.authoring.baselineDraftReview?.kind, "verified_baseline_draft_review");
    assert.equal(summary.nextActions[0]!.arguments.name, "produce_version", "摘要与实际前置校验使用同一通过事实");
    const feedback = await store.feedback(work.id, f.version.id, "保持设计，调整颜色。", "user");
    const prepared = await executeToolInline("prepare_operation", { name: "produce_version", arguments: {
      workId: work.id, kind: "complete", designRef: f.design, baseVersionId: f.version.id, feedbackIds: [feedback.feedback[0]!.id],
    } }, service) as { preflight: { status: string; blockers: string[] } };
    assert.equal(prepared.preflight.status, "ready", prepared.preflight.blockers.join("\n"));
    assert(!JSON.stringify(work).includes("不可泄露给候选"));
    const checkText = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) checkText(path);
        else if (/\.(json|md|jsonl)$/.test(entry.name)) assert(!readFileSync(path, "utf8").includes("不可泄露给候选"), path);
      }
    };
    checkText(f.target);
    assert.equal(readFileSync(f.store.resolvePath("works/" + f.work.id + "/task.json"), "utf8"), original);
  } finally { f.root.cleanup(); }
});

test("基线检查依据绑定确切草稿与测试用途，新检查和新稿不能继承通过", async () => {
  const f = await setup();
  try {
    await exportBaseline(f.sourceRoot, f.work.id, f.version.id, f.target);
    const store = new WorkStore(join(f.target, "testing"), "test", f.target), documents = new DocumentStore(store);
    const work = store.read(f.work.id), draft = work.authoring!.drafts[0]!, evidence = work.authoring!.baselineDraftReviews![0]!;
    assert.doesNotThrow(() => documents.assertReviewed(work, draft));
    const bytes = readFileSync(store.resolvePath(evidence.path), "utf8");
    writeFileSync(store.resolvePath(evidence.path), "{}");
    assert.throws(() => documents.assertReviewed(work, draft), /检查依据/);
    writeFileSync(store.resolvePath(evidence.path), bytes);
    assert.throws(() => documents.assertReviewed({ ...work, purpose: "production" }, draft), /不属于本次测试/);
    const later = structuredClone(f.work.authoring!.runs[0]!); later.status = "failed";
    work.authoring!.runs.push(later);
    assert.throws(() => documents.assertReviewed(work, draft), /草稿尚未通过/);
    work.authoring!.runs = []; store.save(work);
    const markdown = documents.read(work, draft).markdown + "\n新要求：改变颜色。\n";
    const next = await documents.submit(work.id, markdown, "new-draft", "合成用户修改", draft, undefined, draftSubmission(markdown));
    assert.throws(() => documents.assertReviewed(store.read(work.id), next), /草稿尚未通过/);
  } finally { f.root.cleanup(); }
});

test("旧流程没有检查事实的基线继续兼容，但不能补造一次检查", async () => {
  const f = await setup();
  try {
    f.work.authoring!.drafts[0]!.reviewRequired = undefined;
    f.work.authoring!.runs = []; f.store.save(f.work);
    await exportBaseline(f.sourceRoot, f.work.id, f.version.id, f.target);
    const store = new WorkStore(join(f.target, "testing"), "test", f.target), work = store.read(f.work.id);
    assert.equal(work.authoring!.baselineDraftReviews, undefined);
    assert.doesNotThrow(() => new DocumentStore(store).adopted(work, f.design));
  } finally { f.root.cleanup(); }
});

test("未通过入项检查的来源不能导出为已检查基线", async () => {
  const f = await setup();
  try {
    f.work.authoring!.runs[0]!.status = "failed"; f.store.save(f.work);
    await assert.rejects(exportBaseline(f.sourceRoot, f.work.id, f.version.id, f.target), /草稿尚未通过/);
    assert(!existsSync(f.target));
  } finally { f.root.cleanup(); }
});
