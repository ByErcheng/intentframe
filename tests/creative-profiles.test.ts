import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ProfileStore } from "../src/records/profile-store.ts";
import { profileHeading } from "../src/records/creative-profile.ts";
import type { ProfileRef, ProfileSnapshot } from "../src/records/creative-profile.ts";
import { WorkStore, workSchema } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { WorkRouter } from "../src/runtime/work-router.ts";
import { OperationStore } from "../src/records/operation-store.ts";
import { KnowledgeStore } from "../src/records/knowledge-store.ts";
import { executeToolInline as call } from "../src/mcp/server.ts";
import { draftSubmission, fixtureRoot, fixtureRender, fakeCodex, adoptedDesign, fixtureProfile } from "./helpers.ts";
import { backgroundFixture } from "./background-helpers.ts";
import { assignExistingWorks } from "../scripts/assign-work-profile.ts";

const direction = { name: "账号 A", summary: "生活里的小善意", markdown: "# 大体方向\n关注日常善意，表现方式由每条视频决定。", instruction: "合成用户要求：保存方向。" };
function draft(profile: ProfileSnapshot, positioning = "用递花表达感谢") {
  return `${profileHeading(profile)}\n档案方向摘要：${profile.profile.summary}\n本条视频定位：${positioning}\n\n# 具体内容\n角色收到帮助后递花表达谢意。\n`;
}
async function create(service: WorkService, profile: ProfileSnapshot, operationId = "create") {
  const brief = draft(profile);
  return workSchema.parse(await call("create_work", { operationId, title: "合成作品", brief, profileRef: profile.ref,
    purpose: service.store.purpose, submission: draftSubmission(brief) }, service));
}

test("档案版本逐字保存、可读停用历史；并发基线、路径和篡改均明确拒绝", () => {
  const root = fixtureRoot();
  try {
    const profiles = new ProfileStore(root.path), request = { profile: direction, operationId: "save-a" };
    const first = profiles.save(request), location = profiles.read(first.ref).location;
    assert.equal(readFileSync(location, "utf8"), direction.markdown);
    const second = profiles.save({ id: first.ref.id, expectedRevision: 1, operationId: "update-a", profile: { ...direction, summary: "新的大体方向" } });
    assert.deepEqual(profiles.save(request), first, "旧操作重放不得退回当前指针");
    assert.equal(profiles.current(first.ref.id).ref.revision, 2);
    assert.throws(() => profiles.save({ id: first.ref.id, expectedRevision: 1, operationId: "stale", profile: direction }), /版本已变化/);
    const lock = join(profiles.root, first.ref.id, ".write-lock"); mkdirSync(lock);
    assert.throws(() => profiles.save({ id: first.ref.id, expectedRevision: 2, operationId: "concurrent", profile: direction }), /正在写入/); rmSync(lock, { recursive: true });
    profiles.save({ id: first.ref.id, expectedRevision: 2, operationId: "stop", profile: { ...direction, status: "inactive" } });
    assert.throws(() => profiles.select(second.ref), /已停用/);
    assert.equal(profiles.read(first.ref).profile.markdown, direction.markdown);
    assert(!profiles.list().some(item => item.id === first.ref.id)); assert(profiles.list(true).some(item => item.id === first.ref.id));
    assert.throws(() => profiles.current("../escape"));
    writeFileSync(location, "被修改的旧正文"); assert.throws(() => profiles.read(first.ref), /不一致/);
  } finally { root.cleanup(); }
});

test("正文已保存但当前指针失败时可沿原请求恢复，其他写入不能越过待办", () => {
  const root = fixtureRoot();
  class InterruptedProfiles extends ProfileStore {
    protected override commitHead(_path: string, _ref: ProfileRef) { throw new Error("合成指针保存失败"); }
  }
  try {
    const request = { profile: direction, operationId: "partial-save" };
    assert.throws(() => new InterruptedProfiles(root.path).save(request), /指针保存失败/);
    const profiles = new ProfileStore(root.path), pending = profiles.list().find(item => item.state === "needs_recovery")!;
    assert(pending);
    assert.throws(() => profiles.save({ ...request, id: pending.id, operationId: "different" }), /未完成保存/);
    const recovered = profiles.save(request);
    assert.equal(recovered.ref.revision, 1); assert.deepEqual(profiles.save(request), recovered);
    assert.equal(profiles.current(recovered.ref.id).ref.sha256, recovered.ref.sha256);
    assert(!existsSync(join(profiles.root, recovered.ref.id, "pending.json")));
    const update = { ...request, id: recovered.ref.id, expectedRevision: 1, operationId: "partial-update" };
    assert.throws(() => new InterruptedProfiles(root.path).save(update), /指针保存失败/);
    const unpublished = JSON.parse(readFileSync(join(profiles.root, recovered.ref.id, "pending.json"), "utf8"));
    assert.throws(() => profiles.select(unpublished.ref), /尚未提交完整/);
    assert.equal(profiles.current(recovered.ref.id).ref.revision, 1);
    assert.equal(profiles.save(update).ref.revision, 2);
  } finally { root.cleanup(); }
});

test("保存成功后回执失败，通过同编号补存；不同内容不能借恢复覆盖", async () => {
  const root = fixtureRoot();
  try {
    const router = new WorkRouter(root.path), request = { profile: { ...direction, status: "active" }, expectedRevision: 0, operationId: "receipt-failure" };
    const operations = new OperationStore(root.path);
    await assert.rejects(operations.execute(request.operationId, "save_creative_profile", request, () => {
      new ProfileStore(root.path).save({ ...request, profile: direction }); throw new Error("合成回执失败");
    }), /回执失败/);
    const recovered = await call("save_creative_profile", request, router) as ProfileSnapshot;
    assert.equal(operations.read(request.operationId).state, "succeeded");
    assert.deepEqual(await call("save_creative_profile", request, new WorkRouter(root.path)), recovered);
    await assert.rejects(call("save_creative_profile", { ...request, profile: { ...direction, name: "另一个账号" } }, router), /不同内容/);
  } finally { root.cleanup(); }
});

test("新交接必须选择并展示档案；草稿保留原文，篡改定位缓存不能冒充原文", async () => {
  const root = fixtureRoot();
  try {
    const profiles = new ProfileStore(root.path), profile = profiles.save({ profile: direction, operationId: "save" });
    const store = new WorkStore(root.path), service = new WorkService(store), brief = "# 没有展示档案\n只给故事。";
    const request = { operationId: "invalid", title: "合成", brief, purpose: "production", submission: draftSubmission(brief) };
    await assert.rejects(call("create_work", request, service), /明确选择创作档案/);
    await assert.rejects(call("create_work", { ...request, profileRef: profile.ref }, service), /展示所选/);
    assert.equal(store.list().length, 0); assert(!existsSync(join(root.path, "operations", "invalid")));
    const work = await create(service, profile), original = work.authoring!.drafts[0]!;
    assert.equal(service.documents.read(work, original).markdown, draft(profile));
    assert.equal(store.profileContext(work).positioning, "用递花表达感谢");
    original.creativeBrief!.positioning = "不是真实定位"; store.save(work);
    assert.throws(() => service.documents.read(store.read(work.id), original), /定位摘要与原文不一致/);
    assert.throws(() => store.list(), /定位摘要与原文不一致/);
  } finally { root.cleanup(); }
});

test("档案更新与归属调整不改变采用依据；明确切换产生新稿并使旧设计不能继续采用", async () => {
  const root = fixtureRoot();
  try {
    const profiles = new ProfileStore(root.path), first = profiles.save({ profile: direction, operationId: "profile" });
    const store = new WorkStore(root.path), service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender, prepareReview: async () => undefined });
    const work = await create(service, first), base = work.authoring!.drafts[0]!, design = await adoptedDesign(store, work.id);
    const second = profiles.save({ id: first.ref.id, expectedRevision: 1, operationId: "change", profile: { ...direction, markdown: "# 大体方向\n关注人与自然。" } });
    const other = profiles.save({ profile: { ...direction, name: "账号 B" }, operationId: "other" });
    await store.assignProfile(work.id, other.ref.id, first.ref.id, "管理归类调整，不改变创作。", "assign");
    const made = await service.produce(work.id, "complete", undefined, "fresh", undefined, undefined, "produce", { designRef: design });
    const version = made.versions[0]!;
    assert.deepEqual(version.creativeProfile, first);
    const savedInput = readFileSync(store.resolvePath(version.inputManifestPath!), "utf8");
    assert(savedInput.includes("关注日常善意")); assert(!savedInput.includes("关注人与自然"));
    profiles.save({ id: first.ref.id, expectedRevision: 2, operationId: "stop", profile: { ...direction, status: "inactive" } });
    assert.deepEqual(service.documents.adopted(store.read(work.id), design)!.draft.creativeProfile, first, "停用不撤销旧采用");
    await assert.rejects(service.documents.submit(work.id, draft(second), "select-stopped", "切换", base, undefined, draftSubmission(draft(second)), second.ref), /已停用/);
    const changed = draft(other, "本条探索另一种表达");
    const next = await service.documents.submit(work.id, changed, "switch", "明确采用另一方向", base, undefined, draftSubmission(changed), other.ref);
    assert.notEqual(next.sha256, base.sha256);
    assert.throws(() => service.documents.adopted(store.read(work.id), design), /交接已被更新/);
    assert.equal(readFileSync(store.resolvePath(version.inputManifestPath!), "utf8"), savedInput);
    assert.equal(service.documents.read(store.read(work.id), base).markdown, draft(first));
  } finally { root.cleanup(); }
});

test("历史归类只增加管理事实；可按档案查找，不补造制作和经验依据", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), service = new WorkService(store), old = store.create("旧作品", "历史原文");
    const before = store.read(old.id), original = readFileSync(store.resolvePath(old.briefPath), "utf8");
    await call("assign_work_profile", { operationId: "assign", workId: old.id, profileId: fixtureProfile.ref.id, expectedProfileId: null, reason: "用户说明现有作品用于测试。" }, service);
    const after = store.read(old.id), { profileAssignments: _assignments, ...untouched } = after;
    assert.deepEqual(untouched, before); assert.equal(store.profileContext(after).productionProfile, null);
    assert.equal(readFileSync(store.resolvePath(old.briefPath), "utf8"), original);
    const result = await call("list_works", { profileId: fixtureProfile.ref.id, query: "旧作品" }, service) as { works: { id: string }[] };
    assert.deepEqual(result.works.map(w => w.id), [old.id]);
    await assert.rejects(store.assignProfile(old.id, fixtureProfile.ref.id, null, "过期归属", "stale"), /归属已变化/);
  } finally { root.cleanup(); }
});

test("经验按实际来源标档案，相关性先于同档案偏好，跨档案方法仍可检索", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), service = new WorkService(store), profiles = new ProfileStore(root.path);
    const a = profiles.save({ profile: direction, operationId: "a" }), b = profiles.save({ profile: { ...direction, name: "B" }, operationId: "b" });
    const wa = await create(service, a, "wa"), wb = await create(service, b, "wb"), knowledge = new KnowledgeStore(root.path);
    const save = (work: typeof wa, title: string, problem: string) => knowledge.save({ title, problem, method: "查看条件再采用", conditions: "有字幕时", limitations: "合成证据", keywords: [], status: "candidate", use: "reusable",
      sources: [{ kind: "document", workId: work.id, purpose: "production", documentRef: work.authoring!.drafts[0]! }] });
    const same = save(wa, "字幕", "位置"), other = save(wb, "字幕遮挡", "处理字幕遮挡");
    const result = knowledge.search("字幕 遮挡", 0, 20, undefined, { profileId: a.ref.id });
    assert.deepEqual(result.items.map(item => item.ref), [other, same]);
    assert.equal(result.items[0]!.profileRelation, "other_profile");
    await store.assignProfile(wb.id, a.ref.id, b.ref.id, "后来归类", "move");
    assert.deepEqual(knowledge.search("字幕", 0, 20, undefined, { profileId: a.ref.id, scope: "same_profile" }).items.map(item => item.ref), [same]);
  } finally { root.cleanup(); }
});

test("真实 MCP 换连接后可发现、读取档案和作品，比较双方固定同一版本", { timeout: 20_000 }, async () => {
  const fixture = backgroundFixture();
  try {
    const first = await fixture.connect();
    const profile = await fixture.call(first, "save_creative_profile", { operationId: "save-profile", profile: direction });
    const brief = draft(profile);
    const work = await fixture.call(first, "create_work", { operationId: "create-profiled", title: "档案测试", brief, purpose: "test", profileRef: profile.ref, submission: draftSubmission(brief) });
    await first.close(); const next = await fixture.connect();
    const read = await fixture.call(next, "read_creative_profile", { id: profile.ref.id, ref: profile.ref });
    assert.equal(read.profile.markdown, direction.markdown);
    const list = await fixture.call(next, "list_works", { purpose: "all", profileId: profile.ref.id });
    assert.equal(list.works[0].id, work.id); assert.equal(list.works[0].positioning, "用递花表达感谢");
    const comparison = await fixture.call(next, "create_comparison", { operationId: "compare", comparison: { title: "同条件", brief: "合成比较", kind: "creation", change: "比较系统", knowledgeRefs: [], profileRef: profile.ref } });
    for (const id of Object.values(comparison.workIds)) {
      const stored = await fixture.call(next, "get_work", { workId: id, view: "detail" });
      assert.deepEqual(stored.creationProfile.ref, profile.ref); assert.equal(stored.profileId, profile.ref.id);
    }
  } finally { await fixture.cleanup(); }
});

test("批量归类先清点，保留未知历史字段与原记录备份，不修改独立评测副本", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("历史测试", "保留原始需求");
    const path = store.resolvePath("works/" + work.id + "/task.json"), raw = JSON.parse(readFileSync(path, "utf8"));
    raw.legacyFact = { message: "旧系统保留字段" }; writeFileSync(path, JSON.stringify(raw));
    const original = readFileSync(path, "utf8"), isolated = join(root.path, "testing", "frozen-run", "works", work.id);
    mkdirSync(isolated, { recursive: true }); writeFileSync(join(isolated, "task.json"), original);
    const options = { assetRoot: root.path, profileId: fixtureProfile.ref.id, reason: "合成用户明确说明这些记录用于测试。", apply: false };
    const preview = await assignExistingWorks(options); assert.equal(preview.mode, "dry_run"); assert.equal(readFileSync(path, "utf8"), original);
    const result = await assignExistingWorks({ ...options, apply: true });
    assert.equal(result.mode, "applied"); assert("reportPath" in result);
    const report = JSON.parse(readFileSync(result.reportPath!, "utf8")); assert.equal(report.results[0].status, "assigned");
    const after = JSON.parse(readFileSync(path, "utf8")); delete after.profileAssignments; assert.deepEqual(after, raw);
    assert.equal(readFileSync(join(isolated, "task.json"), "utf8"), original);
    const repeated = await assignExistingWorks({ ...options, apply: true }); assert("counts" in repeated); assert.equal(repeated.counts!.already_assigned, 1);
  } finally { root.cleanup(); }
});
