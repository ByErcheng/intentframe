import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../config.ts";
import { markdownHeadings, markdownSection } from "../common/markdown.ts";
import { readPrompt } from "./prompts.ts";

export const serverInstructions = readPrompt("external-ai").text;

export function readUsageGuide(document: "usage" | "workflow" | "data" = "usage", section?: string,
  view: "summary" | "full" = "summary", toolTable?: string) {
  const sources = { usage: "scripts/README.md", workflow: "docs/workflow.md", data: "docs/data.md" };
  const source = sources[document], full = readFileSync(join(repositoryRoot, source), "utf8");
  const sections = markdownHeadings(full).map(heading => heading.title);
  if (document === "usage") sections.push("工具执行契约");
  const selectedSection = section ?? (view === "summary" && document === "usage" ? "快速开始" : undefined);
  const content = selectedSection === "工具执行契约" && document === "usage" && toolTable ? toolTable :
    selectedSection ? markdownSection(full, selectedSection) : view === "full" ? full :
      full.split(/^## /m)[0] + "\n按 sections 中的标题传 section 读取相应规则；view:full 读取全文。";
  return { document, source, version: createHash("sha256").update(full).digest("hex"), section: selectedSection,
    contentVersion: createHash("sha256").update(content).digest("hex"), coverage: view === "full" && !section ? "complete" : "partial",
    sections, relatedDocuments: sources, content };
}
