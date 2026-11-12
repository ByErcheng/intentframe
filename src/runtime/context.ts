import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { configuration, repositoryRoot } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
import { valueHash } from "../records/files.ts";
import { readPrompt } from "./prompts.ts";
import { markdownHeadings } from "../common/markdown.ts";
export { markdownHeadings, markdownSection } from "../common/markdown.ts";

/** 指纹只覆盖系统与规则，不读取本机配置、作品或凭据。 */
export function systemFingerprint(): string {
  const files: Record<string, string> = {};
  const visit = (key: string) => {
    for (const entry of readdirSync(join(repositoryRoot, key), { withFileTypes: true })) {
      const path = key + "/" + entry.name;
      if (entry.isSymbolicLink()) throw new Error("系统源码不能通过链接替换：" + path);
      if (entry.isDirectory()) visit(path);
      else files[path] = fileHash(join(repositoryRoot, path));
    }
  };
  visit("src");
  visit("prompts");
  for (const key of ["AGENTS.md", "docs/workflow.md", "docs/data.md", "package-lock.json", "tsconfig.json"]) files[key] = fileHash(join(repositoryRoot, key));
  return valueHash(files);
}

export function runtimeFingerprint(): string {
  return valueHash({ assetRoot: configuration.assetRoot, node: configuration.node, codex: configuration.codex,
    runtime: configuration.runtime, media: configuration.media, providers: configuration.providers,
    assetLibraries: configuration.assetLibraries, models: configuration.models });
}

/** 只保存影响执行的非敏感条件；配置中的版本是声明，文件摘要是本次实际依据。 */
export function executionConditions(executable = configuration.codex, timeoutMs = configuration.runtime.productionTimeoutMs) {
  return {
    runner: { executable: realpathSync(executable), sha256: fileHash(executable),
      ...(executable === configuration.codex ? { declaredVersion: configuration.tools.codex.version } : {}) },
    node: { version: process.version, platform: process.platform, architecture: process.arch },
    timeoutMs, media: configuration.media,
    dependencyLockSha256: fileHash(join(repositoryRoot, "package-lock.json")),
  };
}

export function productionRules(kind: "sample" | "complete" = "sample", localFeedback = false, feedback = false) {
  return [readPrompt("production-rules", kind === "sample" ? "样例制作" : "完整制作"),
    readPrompt("asset-acquisition"),
    ...(feedback ? [readPrompt("production-rules", "反馈处理")] : []),
    ...(localFeedback ? [readPrompt("production-rules", "局部定位")] : []),
    readPrompt("production-rules", "经验使用")];
}

/** 规则在“本轮任务”下各自成节；只重排展示标题，来源正文与摘要保持原样。 */
export function productionRuleContext(rules: ReturnType<typeof productionRules>): string {
  return rules.filter(rule => rule.section !== "经验使用").map(rule => {
    // 条件规则按二级章节选取时移除了维护标题，嵌入上下文前恢复章节边界。
    const text = rule.section ? "## " + rule.section + "\n\n" + rule.text : rule.text.trim();
    const headings = markdownHeadings(text), root = headings[0];
    if (!root || root.index !== 0) throw new Error("制作规则须以标题开始：" + rule.path);
    const lines = text.split("\n");
    for (const heading of headings) {
      const level = heading.level + 3 - root.level;
      if ((heading !== root && heading.level <= root.level) || level > 6) {
        throw new Error("制作规则标题越出所属章节或超出 Markdown 层级：" + rule.path);
      }
      lines[heading.index] = "#".repeat(level) + " " + heading.title;
    }
    return lines.join("\n");
  }).join("\n\n");
}
