import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolSchema = z.object({ path: z.string(), version: z.string(), source: z.string() });
const settings = z.object({
  dataRoot: z.string(),
  backupRoot: z.string(),
  tools: z.object({ node: toolSchema, codex: toolSchema, restic: toolSchema }),
}).parse(JSON.parse(readFileSync(resolve(repositoryRoot, "toolchain.json"), "utf8")));

// 本机位置集中解析；测试可用独立数据根目录，不改写正式创作记录。
export const configuration = {
  dataRoot: resolve(repositoryRoot, process.env.INTENTFRAME_DATA_ROOT ?? settings.dataRoot),
  backupRoot: resolve(repositoryRoot, process.env.INTENTFRAME_BACKUP_ROOT ?? settings.backupRoot),
  node: resolve(repositoryRoot, process.env.INTENTFRAME_NODE_BIN ?? settings.tools.node.path),
  codex: resolve(repositoryRoot, process.env.INTENTFRAME_CODEX_BIN ?? settings.tools.codex.path),
  restic: resolve(repositoryRoot, process.env.INTENTFRAME_RESTIC_BIN ?? settings.tools.restic.path),
  tools: settings.tools,
};

/** MCP SDK 默认只继承基础环境；显式传递项目配置，不扩散无关凭据。 */
export function projectEnvironment(): Record<string, string> {
  return {
    INTENTFRAME_DATA_ROOT: configuration.dataRoot,
    INTENTFRAME_BACKUP_ROOT: configuration.backupRoot,
    INTENTFRAME_NODE_BIN: configuration.node,
    INTENTFRAME_CODEX_BIN: configuration.codex,
    INTENTFRAME_RESTIC_BIN: configuration.restic,
  };
}
