import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { repositoryRoot } from "../config.ts";
import { markdownSection } from "../common/markdown.ts";

export function readPrompt(name: string, section?: string) {
  if (!/^[a-z-]+$/.test(name)) throw new Error("提示词名称不合法。");
  const path = "prompts/" + name + ".md", absolute = join(repositoryRoot, path);
  if (!lstatSync(join(repositoryRoot, "prompts")).isDirectory() || !lstatSync(absolute).isFile()) throw new Error("提示词必须是系统目录内的普通文件。");
  const source = readFileSync(absolute, "utf8");
  // 章节只是维护边界，不把同文件的其他指令或维护标题一起发给模型。
  const text = section === undefined ? source : markdownSection(source, section).split("\n").slice(1).join("\n").trim();
  if (!text.trim()) throw new Error("提示词正文为空：" + path + (section === undefined ? "" : "#" + section));
  return { path, title: name, ...(section === undefined ? {} : { section }), text,
    sha256: createHash("sha256").update(text).digest("hex"),
    sourceSha256: createHash("sha256").update(source).digest("hex") };
}

/** 单次占位替换；需求正文中的同形字符不再解释为模板。 */
export function fillPrompt(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const result = template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error("提示词缺少输入：" + name);
    used.add(name); return values[name]!;
  });
  if (Object.keys(values).some(key => !used.has(key))) throw new Error("提示词模板缺少必要占位，不能丢弃任务输入。");
  return result;
}
