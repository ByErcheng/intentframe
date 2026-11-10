import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../config.ts";
import { markdownHeadings, markdownSection } from "../common/markdown.ts";
import { readPrompt } from "./prompts.ts";

export const serverInstructions = readPrompt("external-ai").text;

export function readUsageGuide(document: "usage" | "workflow" | "data" = "usage", section?: string) {
  const sources = { usage: "scripts/README.md", workflow: "docs/workflow.md", data: "docs/data.md" };
  const source = sources[document], full = readFileSync(join(repositoryRoot, source), "utf8");
  const content = section ? markdownSection(full, section) : full;
  return { document, source, version: createHash("sha256").update(full).digest("hex"), section,
    sections: markdownHeadings(full).map(heading => heading.title), relatedDocuments: sources, content };
}
