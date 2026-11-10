import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { markdownHeadings, markdownSection } from "../src/common/markdown.ts";
import { productionRules } from "../src/runtime/context.ts";
import { readPrompt } from "../src/runtime/prompts.ts";
import { WorkService } from "../src/runtime/work-service.ts";
import { WorkStore } from "../src/records/work-store.ts";
import { fakeCodex, fixtureRender, fixtureRoot } from "./helpers.ts";

test("章节提取保留下级内容，忽略围栏中的同名标题，缺失或重复时拒绝", () => {
  const document = "# 合成说明\n\n## 执行约束\n仅可读\n### 子项\n保留边界\n```md\n## 执行约束\n```\n\n## 启动消息\n开始\n";
  const section = markdownSection(document, "执行约束");
  assert(section.includes("保留边界")); assert(!section.includes("开始"));
  assert.deepEqual(markdownHeadings(document).map(h => h.title), ["合成说明", "执行约束", "子项", "启动消息"]);
  assert.throws(() => markdownSection(document, "不存在"), /缺失或重复/);
  assert.throws(() => markdownSection(document + "\n## 执行约束\n另一份", "执行约束"), /缺失或重复/);
  assert.throws(() => readPrompt("production", "不存在"), /缺失或重复/);
});

test("合并后阶段互斥、定位规则有条件选取，存档能区分同文件的不同章节", () => {
  for (const kind of ["sample", "complete"] as const) for (const feedback of [false, true]) for (const location of [false, true]) {
    const rules = productionRules(kind, location, feedback), sections = rules.map(r => r.section);
    assert.equal(sections.includes("样例制作"), kind === "sample");
    assert.equal(sections.includes("完整制作"), kind === "complete");
    assert.equal(sections.includes("反馈处理"), feedback);
    assert.equal(sections.includes("局部定位"), location);
    assert.equal(sections.filter(s => s === "经验使用").length, 1);
    for (const source of rules) {
      assert.equal(source.sha256, createHash("sha256").update(source.text).digest("hex"));
      assert.equal(source.sourceSha256, createHash("sha256").update(readFileSync(source.path)).digest("hex"));
    }
    if (!feedback) assert(!rules.map(r => r.text).join("\n").includes("supersedes"));
    if (!location) assert(!rules.map(r => r.text).join("\n").includes("不直接套用旧时间"));
  }
  for (const name of ["production", "learning"]) {
    const fixed = readPrompt(name, "执行约束"), start = readPrompt(name, "启动消息");
    assert.equal(fixed.path, start.path); assert.equal(fixed.sourceSha256, start.sourceSha256);
    assert.notEqual(fixed.sha256, start.sha256);
    assert(!fixed.text.includes("{{runId}}")); assert(start.text.includes("{{runId}}"));
  }
});

test("制作与独立整理按各自消息位置发送章节，后续执行不改旧输入", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("合成模板交接", "先做静音字幕样例，保留备选措辞。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const first = await service.produce(work.id, "sample"), version = first.versions[0]!;
    const inputPath = store.resolvePath(version.inputManifestPath!), before = readFileSync(inputPath);
    const input = JSON.parse(before.toString());
    assert.equal(input.developerInstructions, readPrompt("production", "执行约束").text);
    assert(!input.developerInstructions.includes("本次执行编号"));
    assert(input.turnInput.includes(version.runId));
    assert(!input.turnInput.includes("只修改本目录"));
    assert(!input.context.includes(readPrompt("production-rules", "完整制作").text));
    const native = () => JSON.parse(readFileSync(join(root.path, "native-fixture/history.json"), "utf8"));
    const thread = native().threads[version.threadId!];
    assert.equal(thread.developerInstructions, input.developerInstructions);
    assert.equal(thread.turns[0].items[0].content[0].text, input.turnInput);
    await store.feedback(work.id, version.id, "字幕保留留白", "user");
    const organized = await service.organize(work.id), run = organized.learningRun!;
    const material = JSON.parse(readFileSync(join(store.workDirectory(work.id), "learning", run.id, "context.json"), "utf8"));
    assert.equal(material.rule, readPrompt("learning", "执行约束").text);
    assert(material.turnInput.includes(run.id));
    assert.deepEqual(material.promptSources.map((s: { section: string }) => s.section), ["执行约束", "启动消息"]);
    const learningThread = native().threads[run.threadId!];
    assert.equal(learningThread.developerInstructions, material.rule);
    assert.equal(learningThread.turns[0].items[0].content[0].text, material.turnInput);
    assert.deepEqual(readFileSync(inputPath), before);
  } finally { root.cleanup(); }
});
