import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { ownedPath } from "../records/files.ts";

export const previewFractions = [0.12, 0.5, 0.86] as const;

export function previewPath(videoPath: string, index: number): string {
  return ownedPath(dirname(videoPath), "frame-" + (index + 1) + ".png");
}

/** 这里只核对当前可交付的文件和位置；不把存在性当作视觉审查。 */
export function inspectPreviews(videoPath: string, recorded: unknown) {
  const paths: string[] = [], issues: string[] = [];
  const listed = Array.isArray(recorded) ? recorded : [];
  for (const index of previewFractions.keys()) {
    try {
      const path = previewPath(videoPath, index);
      if (listed[index] !== path) { issues.push("第 " + (index + 1) + " 张预览缺少当前版本的位置记录。"); continue; }
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size === 0) issues.push("第 " + (index + 1) + " 张预览缺失、为空或不是普通文件。");
      else paths.push(path);
    } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  if (listed.length > previewFractions.length) issues.push("预览记录包含当前版本之外的额外位置。");
  return { status: !issues.length ? "available" : listed.length ? "incomplete" : "unverified", paths, issues };
}
