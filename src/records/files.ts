import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 仅解析当前数据区域内的普通路径；不允许内部链接重定向记录。 */
export function ownedPath(root: string, key: string): string {
  const base = resolve(root), path = resolve(base, key), child = relative(base, path);
  if (isAbsolute(key) || child === ".." || child.startsWith(".." + sep)) throw new Error("记录路径必须位于数据根目录内。");
  let current = base;
  if (lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("数据根目录不能为符号链接。");
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("数据目录内的记录路径不能经过符号链接：" + key);
  }
  return path;
}

export function jsonText(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
function recordText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("记录必须为普通文件。");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function readJson(path: string): unknown { return JSON.parse(recordText(path)); }

/** 先保存完整内容再替换指针；失败不留下半份有效记录。 */
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, jsonText(value)); fsyncSync(fd); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function immutableJson(path: string, value: unknown): void {
  const text = jsonText(value);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, text); fsyncSync(fd);
    // 完整写入后才让正式名称可见；硬链接不会覆盖并发保存的已有回执。
    try { linkSync(temporary, path); }
    catch (error) { if (!existsSync(path) || recordText(path) !== text) throw error; }
  } finally { closeSync(fd); rmSync(temporary, { force: true }); }
}

/** 对已校验的 JSON 排序后求摘要，属性顺序不改变同一请求的含义。 */
export function valueHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
