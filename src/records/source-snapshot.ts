import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { repositoryRoot } from "../config.ts";
import { fileHash } from "../common/file-hash.ts";
export { fileHash } from "../common/file-hash.ts";

export const sourceSnapshotSchema = z.object({
  files: z.record(z.string(), z.string()),
  packageLockSha256: z.string(),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

/** 全目录保存源码和本地素材的身份；依赖由系统锁文件关联，不复制 node_modules。 */
export function captureSourceSnapshot(entry: string): SourceSnapshot {
  const files: Record<string, string> = {};
  function visit(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".DS_Store") continue;
      const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("工程包含符号链接，须先将引用材料纳入版本：" + relative);
      if (name === "node_modules" || name === ".git") throw new Error("制作目录不能包含独立依赖或 Git 仓库：" + relative);
      if (stat.isDirectory()) visit(path, relative + "/");
      else if (stat.isFile()) files[relative] = fileHash(path);
      else throw new Error("工程包含不支持的文件类型：" + relative);
    }
  }
  visit(dirname(entry), "");
  if (!Object.hasOwn(files, "entry.tsx")) throw new Error("工程缺少 entry.tsx。");
  return { files, packageLockSha256: fileHash(join(repositoryRoot, "package-lock.json")) };
}

export function sourceFingerprint(snapshot: SourceSnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    packageLockSha256: snapshot.packageLockSha256,
    files: Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
}

export function verifySourceSnapshot(entry: string, expected: SourceSnapshot): void {
  if (sourceFingerprint(captureSourceSnapshot(entry)) !== sourceFingerprint(expected)) {
    throw new Error("工程或制作依赖已在记录外发生变化，请核对后创建新版本。");
  }
}

/** 旧版只记录入口哈希，不能把当前多文件工程补认成历史完整快照。 */
export function verifyLegacySource(entry: string, expectedHash: string): void {
  if (fileHash(entry) !== expectedHash) throw new Error("旧版入口源码与记录不一致。");
  const files = Object.keys(captureSourceSnapshot(entry).files);
  if (files.some(path => !["entry.tsx", "context.md"].includes(path))) {
    throw new Error("旧版缺少完整工程清单，无法核对新增引用文件；须先人工核对并创建新版本。");
  }
  // 旧版仅有单文件演示；仍拒绝绕过入口清单引用其他本地源码。
  const source = readFileSync(entry, "utf8");
  if (/(?:from\s*|import\s*\(|require\s*\()\s*["']\.{1,2}\//.test(source)) {
    throw new Error("旧版入口引用其他文件，现有校验记录不足以恢复。");
  }
}
