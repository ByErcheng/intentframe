import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeToolInline as call } from "../src/mcp/server.ts";
import { WorkStore, workSchema } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { KnowledgeStore } from "../src/records/knowledge-store.ts";
import { confirmedDraft, draftSubmission, fakeCodex, fixtureRoot, profiledMarkdown } from "./helpers.ts";
import { backgroundFixture } from "./background-helpers.ts";
import type { DraftSubmission } from "../src/records/authoring-contracts.ts";

async function fixture(mode = "completed") {
  const root = fixtureRoot(), store = new WorkStore(root.path);
  const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, mode), timeoutMs: 3_000 });
  const request = confirmedDraft({ operationId: "create", title: "合成草稿检查", brief: "  # 合成草稿\n\n保持用户指定台词，动作由项目设计。\n", purpose: "production" });
  request.submission.sourcePath = join(root.path, "draft-v1.md"); writeFileSync(request.submission.sourcePath, request.brief);
  const work = workSchema.parse(await call("create_work", request, service));
  return { root, store, service, request, work, draft: work.authoring!.drafts[0]! };
}

test("未确认、摘要错配与伪造首次纠错在创建任务前被拒绝，确认稿逐字保存", async () => {
  const root = fixtureRoot(), store = new WorkStore(root.path), service = new WorkService(store);
  try {
    const input = { operationId: "reject", title: "合成边界", brief: "原文\n", purpose: "production" };
    await assert.rejects(call("create_work", input, service), /明确交接/);
    await assert.rejects(call("create_work", { ...input, submission: draftSubmission("不同文字") }, service), /摘要不一致/);
    await assert.rejects(call("create_work", { ...input, submission: { ...draftSubmission(input.brief),
      authorization: { kind: "external_correction", reviewRunId: "invented", notes: "不能代替首次确认" } } }, service), /首次交接/);
    assert.equal(store.list().length, 0); assert(!existsSync(join(root.path, "operations", "reject")));
    const request = confirmedDraft(input), userInstruction = "  合成用户确认：将此版本交给项目检查和设计。\n";
    request.submission.authorization = { kind: "user", userInstruction };
    const original = await call("create_work", request, service), work = workSchema.parse(original);
    assert.equal(service.documents.read(work, work.authoring!.drafts[0]!).markdown, request.brief);
    assert.equal(work.authoring!.handoffs[0]!.userInstruction, userInstruction);
    assert.equal(work.authoring!.runs.length, 0);
    assert.deepEqual(await call("create_work", request, service), original);
  } finally { root.cleanup(); }
});

test("新草稿必须实际检索经验并检查通过才可设计，检查不改原文或生成工程", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.authoring.generate(f.work.id, "design", f.draft, "合成设计", "early"), /入项检查/);
    const reviewed = await f.service.authoring.generate(f.work.id, "review_draft", f.draft, "检查草稿", "review");
    assert.equal(reviewed.draftReview?.status, "passed"); assert.equal(reviewed.document, undefined);
    const after = f.store.read(f.work.id), run = after.authoring!.runs[0]!;
    assert.equal(after.authoring!.drafts.length, 1); assert.equal(after.authoring!.designs.length, 0);
    assert.equal(f.service.documents.read(after, f.draft).markdown, f.request.brief);
    assert(!existsSync(join(f.store.workDirectory(f.work.id), "versions")));
    const evidence = JSON.parse(readFileSync(join(f.store.resolvePath(run.inputPath), "../knowledge-evidence.json"), "utf8"));
    assert.equal(evidence.searches, 1); assert.deepEqual(evidence.reads, []);
    const designed = await f.service.authoring.generate(f.work.id, "design", f.draft, "按原意设计", "design");
    assert.equal(designed.status, "completed"); assert(designed.document);
    const input = JSON.parse(readFileSync(f.store.resolvePath(f.store.read(f.work.id).authoring!.runs.at(-1)!.inputPath), "utf8"));
    assert.equal(input.draftReview.status, "passed");
    assert.equal(f.store.read(f.work.id).authoring!.handoffs.length, 1, "检查和设计不补造用户确认");
  } finally { f.root.cleanup(); }
});

test("外部纠错沿原授权生成新稿，新版须复查且旧检查不能用于新版本", async () => {
  const f = await fixture("draft_changes");
  try {
    const review = await f.service.authoring.generate(f.work.id, "review_draft", f.draft, "合成问题", "review");
    assert.equal(review.status, "needs_input");
    const markdown = profiledMarkdown("# 合成草稿\n按已有原话修正遗漏。");
    const submission: DraftSubmission = { ...draftSubmission(markdown), authorization: {
      kind: "external_correction", reviewRunId: review.runId, notes: "依据已有原话补回漏掉的台词，意图不变。" } };
    const next = await f.service.documents.submit(f.work.id, markdown, "correct", "处理检查意见", f.draft, undefined, submission);
    const record = f.store.read(f.work.id);
    assert.equal(record.authoring!.handoffs.at(-1)!.correctionOf?.reviewRunId, review.runId);
    assert.equal(record.authoring!.handoffs.at(-1)!.userInstruction, record.authoring!.handoffs[0]!.userInstruction);
    assert.equal(f.service.documents.read(record, f.draft).markdown, f.request.brief);
    await assert.rejects(f.service.authoring.generate(f.work.id, "design", next, "设计新版", "too-early"), /入项检查/);
    await assert.rejects(f.service.authoring.generate(f.work.id, "review_draft", f.draft, "旧稿不能冒充当前稿", "stale"), /交接已被更新/);
    const passing = new WorkService(f.store, { codexExecutable: fakeCodex(f.root.path) });
    const checked = await passing.authoring.generate(f.work.id, "review_draft", next, "复查问题和影响", "recheck");
    assert.equal(checked.draftReview?.status, "passed");
    assert.equal((await passing.authoring.generate(f.work.id, "design", next, "设计", "design")).status, "completed");
  } finally { f.root.cleanup(); }
});

test("草稿检查读取确切经验正文并留存依据，候选身份不被自动升级", async () => {
  const f = await fixture("draft_use_experience");
  try {
    const knowledge = new KnowledgeStore(f.root.path);
    const ref = knowledge.save({ title: "合成草稿", problem: "合成草稿遗漏既有台词", method: "对照原话核对台词。", conditions: "原话已有明确台词时",
      limitations: "仅为合成检索用例，不代表真实效果。", keywords: ["合成草稿"], status: "candidate", use: "reusable",
      sources: [{ kind: "document", purpose: "production", workId: f.work.id, documentRef: { id: f.draft.id, sha256: f.draft.sha256 } }] });
    const result = await f.service.authoring.generate(f.work.id, "review_draft", f.draft, "查阅适用经验", "review");
    assert.deepEqual(result.draftReview?.usedExperienceRefs, [ref]);
    assert.equal(knowledge.read(ref).status, "candidate");
    const run = f.store.read(f.work.id).authoring!.runs[0]!;
    const evidence = JSON.parse(readFileSync(join(f.store.resolvePath(run.inputPath), "../knowledge-evidence.json"), "utf8"));
    assert.deepEqual(evidence.reads, [ref]);
  } finally { f.root.cleanup(); }
});

test("用户意图歧义不能以外部纠错绕过，须对修订版保存新的用户指令", async () => {
  const f = await fixture("draft_confirmation");
  try {
    const review = await f.service.authoring.generate(f.work.id, "review_draft", f.draft, "合成歧义", "review");
    assert.equal(review.draftReview?.status, "needs_confirmation");
    const markdown = profiledMarkdown("用户已澄清的新稿");
    await assert.rejects(call("submit_draft", { operationId: "bypass", workId: f.work.id, basedOn: f.draft, markdown, instruction: "不能猜意图",
      submission: { ...draftSubmission(markdown), authorization: { kind: "external_correction", reviewRunId: review.runId, notes: "试图自定" } } }, f.service), /意图歧义/);
    assert.equal(f.store.read(f.work.id).authoring!.drafts.length, 1);
    const submission = draftSubmission(markdown);
    submission.authorization = { kind: "user", userInstruction: "合成用户新确认：按我澄清后的这一版继续。" };
    await f.service.documents.submit(f.work.id, markdown, "confirmed", "转录用户澄清", f.draft, undefined, submission);
    const handoff = f.store.read(f.work.id).authoring!.handoffs.at(-1)!;
    assert.equal(handoff.correctionOf, undefined); assert.equal(handoff.userInstruction, submission.authorization.userInstruction);
  } finally { f.root.cleanup(); }
});

test("矛盾结论、未读经验声明和未检索均不能记录检查通过", async t => {
  for (const mode of ["draft_contradiction", "draft_unread_experience", "draft_skip_search"]) await t.test(mode, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.service.authoring.generate(f.work.id, "review_draft", f.draft, "合成无效声明", "review"), /不一致|未读取|检索依据/);
      assert.equal(f.store.read(f.work.id).authoring!.runs[0]!.draftReview, undefined);
      await assert.rejects(f.service.authoring.generate(f.work.id, "design", f.draft, "不能绕过", "design"), /入项检查/);
    } finally { f.root.cleanup(); }
  });
});

test("草稿检查已返回但通知失联时按原结果恢复，通过和待修改不混同", { timeout: 30_000 }, async t => {
  for (const [mode, expected] of [["disconnect_after_result", "succeeded"], ["disconnect_draft_changes", "waiting_input"]] as const) await t.test(expected, async () => {
    const f = backgroundFixture(mode);
    try {
      const client = await f.connect();
      const work = await f.call(client, "create_work", confirmedDraft({ operationId: "create", title: "检查恢复", brief: "合成草稿", purpose: "test" }));
      const draft = work.authoring.drafts[0], base = { id: draft.id, sha256: draft.sha256 };
      const request = { operationId: "review", workId: work.id, base };
      const accepted = await f.call(client, "review_draft", request);
      assert.equal((await f.wait(client, "review")).status, "unknown");
      await f.call(client, "recover_work", { operationId: "recover", workId: work.id, mode: "reconcile_only" });
      const recovered = await f.wait(client, "recover");
      const result = await f.call(client, "get_execution", { executionId: "review" });
      assert.equal(result.status, expected, JSON.stringify(recovered)); assert(result.result.draftReview);
      assert.deepEqual(await f.call(client, "review_draft", request), accepted);
      await f.call(client, "recover_work", { operationId: "recover-again", workId: work.id, mode: "reconcile_only" });
      await f.wait(client, "recover-again");
      assert.equal((await f.call(client, "get_execution", { executionId: "review" })).status, expected);
      const current = await f.call(client, "get_work", { view: "detail", workId: work.id });
      assert.equal(current.authoring.designs.length, 0); assert.equal(current.versions.length, 0);
      assert.equal(f.countTurns(), 1, "恢复不重新调用模型");
    } finally { await f.cleanup(); }
  });
});
