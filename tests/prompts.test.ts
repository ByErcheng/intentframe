import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { markdownHeadings, markdownSection } from "../src/common/markdown.ts";
import { productionRuleContext, productionRules } from "../src/runtime/context.ts";
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

test("制作规则嵌入保留内部层级与代码围栏原文，不改变来源", () => {
  const example = "````markdown\n# 示例内容\n```speech:example\n合成台词\n```\n````";
  const rules = [
    { ...readPrompt("asset-acquisition"), text: "# 合成素材\n\n## 条件\n\n" + example + "\n\n## 来源\n\n合成来源。\n" },
    { ...readPrompt("production-rules", "反馈处理"), text: "合成规则。\n\n### 附加条件\n\n" + example },
    readPrompt("production-rules", "经验使用"),
  ];
  const before = structuredClone(rules), text = productionRuleContext(rules);
  assert.deepEqual(markdownHeadings(text).map(({ level, title }) => ({ level, title })), [
    { level: 3, title: "合成素材" }, { level: 4, title: "条件" }, { level: 4, title: "来源" },
    { level: 3, title: "反馈处理" }, { level: 4, title: "附加条件" },
  ]);
  assert.equal(text.split(example).length - 1, 2, "代码围栏内容须逐字保留");
  assert(!text.includes(rules[2]!.text), "经验仍由独立位置提供");
  assert.deepEqual(rules, before);
});

test("制作规则缺少根标题、越出章节或嵌入层级过深时明确拒绝", () => {
  const source = readPrompt("asset-acquisition");
  assert.throws(() => productionRuleContext([{ ...source, text: "没有根标题。" }]), /须以标题开始/);
  assert.throws(() => productionRuleContext([{ ...source, text: "# 素材\n\n# 越界规则\n正文" }]), /越出所属章节/);
  assert.throws(() => productionRuleContext([{ ...source, text: "# 素材\n\n##### 过深标题\n正文" }]), /超出 Markdown 层级/);
  const selected = readPrompt("production-rules", "反馈处理");
  assert.throws(() => productionRuleContext([{ ...selected, text: "## 越界规则\n正文" }]), /越出所属章节/);
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

test("制作最终上下文中各条件规则独立成节，不归入素材使用声明", async () => {
  const root = fixtureRoot();
  try {
    const store = new WorkStore(root.path), work = store.create("合成规则层级", "制作静音字幕样例。");
    const service = new WorkService(store, { codexExecutable: fakeCodex(root.path), render: fixtureRender });
    const first = (await service.produce(work.id, "sample")).versions[0]!;
    const firstInputPath = store.resolvePath(first.inputManifestPath!), firstInput = readFileSync(firstInputPath);
    await store.confirm(work.id, first.id, "direction", "沿此样例制作", "合成字幕方向");
    await store.feedback(work.id, first.id, "增加标题留白", "user", false,
      { description: "开头标题", precision: "approximate" });
    const version = (await service.produce(work.id, "complete")).versions.at(-1)!;
    const input = JSON.parse(readFileSync(store.resolvePath(version.inputManifestPath!), "utf8"));
    const context: string = input.context, headings = markdownHeadings(context);
    for (const title of ["完整制作", "素材获取", "反馈处理", "局部定位"]) {
      assert.equal(headings.find(heading => heading.title === title)?.level, 3, title + " 应为本轮任务中的独立规则");
      assert(markdownSection(context, "本轮任务").includes("### " + title));
    }
    assert(context.includes(readFileSync(store.resolvePath(work.briefPath), "utf8")), "原始需求及其标题仍须逐字保留");
    assert.equal(headings.find(heading => heading.title === "本机使用声明与署名")?.level, 4);
    assert(!markdownSection(context, "素材获取").includes("supersedes"));
    assert(!markdownSection(context, "本机使用声明与署名").includes("局部定位属于原反馈版本"));
    assert(markdownSection(context, "反馈处理").includes("supersedes"));
    assert(!markdownSection(context, "反馈处理").includes("局部定位属于原反馈版本"));
    assert(markdownSection(context, "局部定位").includes("局部定位属于原反馈版本"));
    assert(!headings.some(heading => heading.title === "样例制作"));
    const sampleHeadings = markdownHeadings(JSON.parse(firstInput.toString()).context);
    assert.equal(sampleHeadings.find(heading => heading.title === "样例制作")?.level, 3);
    assert(!sampleHeadings.some(heading => ["完整制作", "反馈处理", "局部定位"].includes(heading.title)));
    assert.equal(readFileSync(join(dirname(store.resolvePath(version.sourcePath)), "context.md"), "utf8"), context);
    for (const source of productionRules("complete", true, true)) {
      assert.deepEqual(input.sources.find((item: { path: string; section?: string }) => item.path === source.path && item.section === source.section), source);
    }
    assert.deepEqual(readFileSync(firstInputPath), firstInput);
  } finally { root.cleanup(); }
});
