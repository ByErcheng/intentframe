import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** 分块读取，避免大体积媒体整体进入内存。 */
export function fileHash(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
