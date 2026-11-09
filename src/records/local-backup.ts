import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configuration, repositoryRoot } from "../config.ts";
import { fileHash } from "./source-snapshot.ts";

type BackupOptions = { systemRoot: string; dataRoot: string; backupRoot: string; executable: string };
const excluded = new Set(["node_modules", ".cache", ".git"]);
function shouldExclude(name: string) {
  return excluded.has(name) || name === ".env" || name.startsWith(".env.") || name.endsWith(".key") || name.endsWith(".pem");
}

/** 完整目录清单包括新增文件、空目录与符号链接；不跟随链接读取目录外内容。 */
function inventory(root: string): Map<string, string> {
  const entries = new Map<string, string>([[".", "directory:" + (lstatSync(root).mode & 0o7777).toString(8)]]);
  function visit(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      if (shouldExclude(name)) continue;
      if (name === ".write-lock") throw new Error("存在执行写锁，不能确认备份一致性。");
      const path = join(directory, name), key = prefix + name, stat = lstatSync(path);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) { entries.set(key, "directory:" + mode); visit(path, key + "/"); }
      else if (stat.isSymbolicLink()) entries.set(key, "symlink:" + readlinkSync(path));
      else if (stat.isFile()) entries.set(key, "mode:" + mode + ":sha256:" + fileHash(path));
      else throw new Error("备份包含不支持的文件类型：" + path);
    }
  }
  visit(root, "");
  return entries;
}

function compare(expected: Map<string, string>, actual: Map<string, string>, stage: string): void {
  for (const path of new Set([...expected.keys(), ...actual.keys()])) {
    if (expected.get(path) !== actual.get(path)) throw new Error(stage + "清单或内容发生变化：" + path);
  }
}

function canonicalLocation(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonicalLocation(dirname(absolute)), relative(dirname(absolute), absolute));
}

/** 同机不同文件夹备份；只有原始、恢复、结束时三份清单一致才记录通过。 */
export function backupLocal(options: BackupOptions = {
  systemRoot: repositoryRoot, dataRoot: configuration.dataRoot,
  backupRoot: configuration.backupRoot, executable: configuration.restic,
}) {
  const sources = [realpathSync(options.systemRoot), realpathSync(options.dataRoot)];
  const backupRoot = canonicalLocation(options.backupRoot);
  for (const source of sources) {
    const child = relative(source, backupRoot);
    if (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep)) {
      throw new Error("备份目录不能位于被备份目录内部。");
    }
  }
  const before = sources.map(inventory);
  const repository = join(backupRoot, "repository"), passwordFile = join(backupRoot, "access", "password");
  mkdirSync(dirname(passwordFile), { recursive: true, mode: 0o700 });
  if (!existsSync(passwordFile)) {
    if (existsSync(join(repository, "config"))) throw new Error("已有备份仓库但缺少密码文件，请恢复原密码。");
    writeFileSync(passwordFile, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  }
  const env = { ...process.env, RESTIC_PASSWORD_FILE: passwordFile, RESTIC_CACHE_DIR: join(options.systemRoot, ".cache", "restic") };
  const restic = (args: string[]) => execFileSync(options.executable, ["--repo", repository, ...args],
    { env, encoding: "utf8", timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
  if (!existsSync(join(repository, "config"))) restic(["init"]);
  const output = restic(["backup", ...sources, "--json",
    "--exclude", "node_modules", "--exclude", ".cache", "--exclude", ".git",
    "--exclude", ".env", "--exclude", ".env.*", "--exclude", "*.key", "--exclude", "*.pem"]);
  const summary = output.trim().split("\n").map(line => JSON.parse(line)).find(item => item.message_type === "summary");
  if (typeof summary?.snapshot_id !== "string") throw new Error("备份没有返回快照标识。");
  restic(["check", "--read-data"]);
  const target = join(options.systemRoot, ".cache", "restore-check", randomUUID());
  restic(["restore", summary.snapshot_id, "--target", target]);
  for (const [index, source] of sources.entries()) {
    const expected = before[index];
    if (!expected) throw new Error("缺少备份前清单。");
    compare(expected, inventory(join(target, source.replace(/^\/+/, ""))), "恢复结果");
    compare(expected, inventory(source), "备份期间源目录");
  }
  const report = {
    at: new Date().toISOString(), result: "passed", snapshotId: summary.snapshot_id,
    repository, sources, restoredTo: target,
    verifiedFiles: before.reduce((sum, list) => sum + [...list.values()].filter(value => !value.startsWith("directory:")).length, 0),
    verification: "备份前、恢复结果及结束时源目录的完整清单、权限和内容一致；包含新增、删除、内容或权限变化及执行锁检查。",
    excludes: ["node_modules", ".cache", ".git", ".env*", "*.key", "*.pem"],
    scope: "同一台 Mac 的不同文件夹；检测到并发变化则不报告通过，未自动删除快照或覆盖原文件。",
  };
  const reportDirectory = join(options.dataRoot, "validation", "system", "local-backup");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, summary.snapshot_id.slice(0, 8) + ".json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
