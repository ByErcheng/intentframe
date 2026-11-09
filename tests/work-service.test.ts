import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WorkStore } from "../src/records/work-store.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { captureSourceSnapshot, fileHash } from "../src/records/source-snapshot.ts";
import { fakeCodex, fixtureRender, fixtureRoot, readyVersion, videoSource } from "./helpers.ts";

test("连续反馈延续最新修改；当前上下文保留全部原始反馈与处理状态", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("反馈顺序", "红色背景的简单图文。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
    await store.feedback(work.id, "v001", "背景改为绿色", "user");
    const record = await store.feedback(work.id, "v001", "结尾增加一个圆形", "user");
    const first = record.feedback[0]!, second = record.feedback[1]!;
    const revised = readyVersion(store, work.id, "v002", "sample");
    writeFileSync(store.resolvePath(revised.sourcePath), videoSource("green"));
    revised.sourceSha256 = fileHash(store.resolvePath(revised.sourcePath));
    revised.sourceSnapshot = captureSourceSnapshot(store.resolvePath(revised.sourcePath));
    revised.basedOnVersionId = "v001"; revised.appliedFeedbackIds = [first.id];
    record.versions.push(revised); store.save(record);
    const before = fileHash(store.resolvePath(revised.sourcePath));
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const result = await service.produce(work.id, "sample", second.id);
    const version = result.versions.at(-1)!;
    assert.equal(version.basedOnVersionId, "v002");
    assert.equal(version.production, "ready");
    assert(readFileSync(store.resolvePath(version.sourcePath), "utf8").includes('"green"'));
    assert.deepEqual(version.appliedFeedbackIds, [first.id, second.id]);
    const context = readFileSync(join(dirname(store.resolvePath(version.sourcePath)), "context.md"), "utf8");
    assert(context.includes(first.text)); assert(context.includes(second.text));
    assert.equal(fileHash(store.resolvePath(revised.sourcePath)), before);
    await assert.rejects(service.produce(work.id, "sample", second.id, "fresh", "v001"), /baseReason/);
    // 显式历史分支保留依据；不会把其他分支已处理的反馈伪装成当前已继承。
    const branch = await service.produce(work.id, "sample", second.id, "fresh", "v001", "测试明确从最初版本制作另一方案");
    assert.equal(branch.versions.at(-1)?.basedOnVersionId, "v001");
    assert.deepEqual(branch.versions.at(-1)?.appliedFeedbackIds, [second.id]);
  } finally { root.cleanup(); }
});

test("缺少信息、纯文本澄清或矛盾完成声明均不会渲染旧工程", async () => {
  const root = fixtureRoot();
  try {
    for (const mode of ["needs_input", "plain_clarification", "false_completed", "no_final", "failed"]) {
      const store = new WorkStore(join(root.path, mode)), work = store.create(mode, "按反馈修改。");
      work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
      let renders = 0;
      const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, mode),
        render: async (...args) => { renders++; return fixtureRender(...args); } });
      if (mode === "needs_input") {
        const result = await service.produce(work.id, "sample");
        assert.equal(result.execution.status, "waiting_input");
        assert.equal(result.versions.at(-1)?.production, "blocked");
        assert(result.versions.at(-1)?.agentReply?.includes("缺少参考素材"));
        await assert.rejects(service.renderExisting(work.id, "v002"), /不能直接重渲染/);
      } else {
        await assert.rejects(service.produce(work.id, "sample"));
        assert.equal(store.read(work.id).execution.status, "failed");
      }
      assert.equal(renders, 0);
      assert.equal(store.read(work.id).versions[0]?.production, "ready");
    }
  } finally { root.cleanup(); }
});

test("需求读失败不残留目录；准备阶段错误可记录并在下一次继续", async () => {
  const root = fixtureRoot();
  class FailingLogStore extends WorkStore {
    fail = false;
    override appendEvent(id: string, run: string, event: Record<string, unknown>) {
      if (this.fail) throw new Error("测试日志不可写");
      super.appendEvent(id, run, event);
    }
  }
  try {
    const store = new FailingLogStore(join(root.path, "data")), work = store.create("准备失败", "测试准备恢复。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const brief = store.resolvePath(work.briefPath); renameSync(brief, brief + ".hold");
    await assert.rejects(service.produce(work.id, "sample"), /ENOENT/);
    assert.equal(store.read(work.id).versions.length, 0);
    assert(!existsSync(join(store.workDirectory(work.id), "versions")));
    renameSync(brief + ".hold", brief);
    store.fail = true;
    await assert.rejects(service.produce(work.id, "sample"), /日志不可写/);
    assert.equal(store.read(work.id).versions[0]?.production, "failed");
    assert(!existsSync(join(store.workDirectory(work.id), ".write-lock")));
    store.fail = false;
    const result = await service.produce(work.id, "sample");
    assert.equal(result.versions.at(-1)?.id, "v002");
    assert.equal(result.execution.status, "idle");
  } finally { root.cleanup(); }
});

test("旧实现残留的未登记目录得到保留，不阻塞新制作", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("旧目录", "重新制作样例。");
    const orphan = join(store.workDirectory(work.id), "versions/v001/source");
    mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, "keep.txt"), "保留已有材料");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const result = await service.produce(work.id, "sample");
    assert.equal(result.versions[0]?.id, "v002");
    assert.equal(readFileSync(join(orphan, "keep.txt"), "utf8"), "保留已有材料");
  } finally { root.cleanup(); }
});

test("新运行失联保留未知状态，拒绝重发", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("失联", "只测试状态，不实际调用模型。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "disconnect"), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample"));
    assert.equal(store.read(work.id).execution.status, "unknown");
    await assert.rejects(service.produce(work.id, "sample"), /重复发起/);
  } finally { root.cleanup(); }
});

test("导入文件变化与缺失媒体必须识别，历史认可不被抹掉", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("完整性", "只测试身份与恢复边界。");
    const version = readyVersion(store, work.id, "v001", "complete");
    const entry = store.resolvePath(version.sourcePath), output = store.resolvePath(version.mediaPath);
    writeFileSync(entry, videoSource("red", 10, true));
    const helper = join(dirname(entry), "color.ts"); writeFileSync(helper, 'export const color="red";\n');
    version.sourceSha256 = fileHash(entry); version.sourceSnapshot = captureSourceSnapshot(entry);
    work.versions.push(version); store.save(work);
    await store.confirm(work.id, version.id, "acceptance", "测试中的明确确认");
    writeFileSync(helper, 'export const color="blue";\n');
    let renders = 0;
    const service = new WorkService(store, { render: async () => { renders++; throw new Error("测试恢复失败"); } });
    await assert.rejects(service.renderExisting(work.id, version.id), /工程或制作依赖/);
    assert.equal(renders, 0);
    writeFileSync(helper, 'export const color="red";\n'); rmSync(output);
    assert.equal(store.summary(store.read(work.id)).versions[0]?.availability.status, "missing");
    await assert.rejects(service.renderExisting(work.id, version.id), /测试恢复失败/);
    assert.equal(renders, 1);
    assert.equal(store.read(work.id).versions[0]?.acceptance, "accepted");
    assert.equal(store.read(work.id).versions[0]?.production, "ready");
    await assert.rejects(store.confirm(work.id, version.id, "acceptance", "不能再次确认不可用文件"), /缺失/);
  } finally { root.cleanup(); }
});

test("旧记录按已有证据读取，不补造完整快照或改写认可", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("旧记录兼容", "单文件旧工程。");
    const version = readyVersion(store, work.id, "v001", "complete");
    version.sourceSnapshot = undefined;
    version.acceptance = "accepted"; version.userConfirmation = "历史确认原文";
    work.versions.push(version); store.save(work);
    const path = join(store.workDirectory(work.id), "task.json"), before = readFileSync(path, "utf8");
    const viewed = store.summary(store.read(work.id)).versions[0]!;
    assert.equal(viewed.availability.status, "available");
    assert.equal(viewed.availability.sourceCoverage, "legacy_entry_only");
    const service = new WorkService(store);
    await service.renderExisting(work.id, version.id);
    assert.equal(readFileSync(path, "utf8"), before);
    writeFileSync(join(dirname(store.resolvePath(version.sourcePath)), "unknown.ts"), "export const x=1;");
    await assert.rejects(service.renderExisting(work.id, version.id), /缺少完整工程清单/);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { root.cleanup(); }
});

test("部分完成后等待输入，新会话延续草稿与阻塞依据但不能提前渲染", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("部分完成", "保留已完成修改。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample")); store.save(work);
    await store.feedback(work.id, "v001", "修改标题", "user");
    const requested = await store.feedback(work.id, "v001", "补充参考图片", "user");
    const partial = new WorkService(store, { codexExecutable: fakeCodex(root.path, "partial_input"), render: fixtureRender });
    const blocked = await partial.produce(work.id, "sample");
    const draft = blocked.versions.at(-1)!;
    assert.equal(draft.production, "blocked");
    assert(draft.sourceSnapshot, "部分完成的工程必须可核对并接续");
    assert.deepEqual(draft.appliedFeedbackIds, [requested.feedback[0]!.id]);
    await assert.rejects(partial.renderExisting(work.id, draft.id), /不能直接重渲染/);
    const completed = await new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender }).produce(work.id, "sample");
    const next = completed.versions.at(-1)!;
    assert.equal(next.basedOnVersionId, draft.id);
    assert.deepEqual(next.feedbackIds, [requested.feedback[1]!.id]);
    assert(readFileSync(store.resolvePath(next.sourcePath), "utf8").includes("已保留的部分制作进度"));
    assert(readFileSync(join(dirname(store.resolvePath(next.sourcePath)), "context.md"), "utf8").includes("请提供参考素材"));
  } finally { root.cleanup(); }
});

test("制作请求发送前断线是明确准备失败，可以重新发起", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("准备断线", "不调用真实模型。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "initialize_disconnect"), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample"));
    assert.equal(store.read(work.id).execution.status, "failed");
    const result = await new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender }).produce(work.id, "sample");
    assert.equal(result.execution.status, "idle");
  } finally { root.cleanup(); }
});

test("确认新方向后，完整制作不能绕回未延续该样例的历史基线", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("方向与基线", "已确认第二个方向。");
    work.versions.push(readyVersion(store, work.id, "v001", "sample"), readyVersion(store, work.id, "v002", "sample"));
    work.versions[1]!.basedOnVersionId = "v001"; store.save(work);
    await store.confirm(work.id, "v002", "direction", "确认第二版样例", "第二个方向");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "complete", undefined, "fresh", "v001", "从最早的工程开始"), /已确认.*样例|方向/);
    assert.equal(store.read(work.id).versions.length, 2);
    const complete = await service.produce(work.id, "complete");
    assert.equal(complete.versions.at(-1)?.basedOnVersionId, "v002");
  } finally { root.cleanup(); }
});

test("明确失败留下的草稿可接续编辑，但不会被当作完成工程渲染", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(join(root.path, "data")), work = store.create("失败草稿", "保留部分成果，不伪造完成。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path, "partial_failed"), render: fixtureRender });
    await assert.rejects(service.produce(work.id, "sample"));
    const draft = store.read(work.id).versions[0]!;
    assert.equal(draft.production, "failed");
    assert(draft.sourceSnapshot);
    await assert.rejects(service.renderExisting(work.id, draft.id), /不能直接重渲染/);
    const continued = await new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender }).produce(work.id, "sample");
    assert.equal(continued.versions.at(-1)?.basedOnVersionId, draft.id);
    assert(readFileSync(store.resolvePath(continued.versions.at(-1)!.sourcePath), "utf8").includes("已保留的部分制作进度"));
  } finally { root.cleanup(); }
});
