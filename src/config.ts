import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pathSchema = z.string().refine(value => value.trim().length > 0 && !/[\0\r\n]/.test(value));
// Node 的计时器超出此范围会退回约 1 ms，必须在配置边界拒绝。
const timeoutSchema = z.number().int().positive().max(2_147_483_647);
const toolSchema = z.strictObject({
  path: pathSchema, version: z.string().trim().min(1), source: z.url(),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const providersSchema = z.strictObject({
  image: z.strictObject({ apiKey: z.string().trim().min(1), model: z.string().trim().min(1),
    timeoutMs: timeoutSchema.default(300_000) }).optional(),
  speech: z.strictObject({ apiKey: z.string().trim().min(1), speaker: z.string().trim().min(1),
    resourceId: z.string().trim().min(1), model: z.string().trim().min(1).optional(),
    timeoutMs: timeoutSchema.default(120_000) }).optional(),
});
export const assetLibrarySchema = z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), path: pathSchema,
  role: z.enum(["reference", "image", "narration", "music"]) });
const settingsSchema = z.strictObject({
  dataRoot: pathSchema,
  backupRoot: pathSchema,
  tools: z.strictObject({ node: toolSchema, codex: toolSchema, restic: toolSchema }),
  runtime: z.strictObject({ requestTimeoutMs: timeoutSchema, productionTimeoutMs: timeoutSchema,
    jobTimeoutMs: timeoutSchema, stopTimeoutMs: timeoutSchema }),
  mcp: z.strictObject({ toolTimeoutMs: timeoutSchema }),
  media: z.strictObject({ concurrency: z.number().int().positive(), renderTimeoutMs: timeoutSchema, probeTimeoutMs: timeoutSchema,
    decodeTimeoutMs: timeoutSchema, previewTimeoutMs: timeoutSchema }),
  backup: z.strictObject({ commandTimeoutMs: timeoutSchema }),
  diagnostics: z.strictObject({ toolTimeoutMs: timeoutSchema }),
  providers: providersSchema.optional(),
  assetLibraries: z.array(assetLibrarySchema).max(20).default([]).refine(items => new Set(items.map(item => item.id)).size === items.length, "素材库编号须唯一"),
});

class ConfigurationError extends Error {}

function readLocalSettings(configPath: string): unknown {
  let descriptor: number | undefined;
  let source: string;
  try {
    if (!lstatSync(dirname(configPath)).isDirectory()) {
      throw new ConfigurationError("config 目录必须为真实目录，不能为符号链接。");
    }
    // 不跟随配置文件链接；非阻塞打开使 FIFO 等错误类型不会挂住启动。
    descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new ConfigurationError("config/local.json 必须为普通 JSON 文件。");
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) {
      throw new ConfigurationError("config/local.json 必须属于当前用户，权限为 0600；请按 config/README.md 检查。");
    }
    source = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    // 不转发 JSON 片段或底层错误，防止误填的敏感值进入终端和日志。
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") throw new ConfigurationError("缺少 config/local.json；首次运行请按 config/README.md 初始化。");
    if (code === "ELOOP") throw new ConfigurationError("config/local.json 不能为符号链接。");
    throw new ConfigurationError("无法读取 config/local.json，请检查配置路径和读取权限，参见 config/README.md。");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try { return JSON.parse(source); }
  catch { throw new ConfigurationError("config/local.json 不是有效 JSON；请按 config/example.json 检查格式。"); }
}

/** 固定读取本机配置；显式参数供隔离测试使用，不提供隐藏的配置文件搜索顺序。 */
export function loadConfiguration(root = repositoryRoot, environment: NodeJS.ProcessEnv = process.env) {
  const configPath = resolve(root, "config", "local.json");
  const parsed = settingsSchema.safeParse(readLocalSettings(configPath));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join(".") || "根对象"))];
    throw new Error("config/local.json 字段无效、缺失或含未知项：" + fields.join("、") + "。请对照 config/example.json 与 config/README.md。");
  }
  const settings = parsed.data;
  if (environment.INTENTFRAME_PURPOSE !== undefined) {
    throw new Error("INTENTFRAME_PURPOSE 已停用；请从启动配置中删除，创建任务时明确指定 purpose 为 test 或 production。已有任务按编号沿用原用途。");
  }
  const environmentOverrides: string[] = [];
  const location = (name: string, configured: string): string => {
    const override = environment[name];
    if (override !== undefined) {
      if (!pathSchema.safeParse(override).success) throw new Error(name + " 必须为非空路径，不能包含换行或空字符。");
      environmentOverrides.push(name);
    }
    return resolve(root, override ?? configured);
  };
  const assetRoot = location("INTENTFRAME_DATA_ROOT", settings.dataRoot);
  return {
    configPath, environmentOverrides,
    assetRoot,
    workRoots: { production: assetRoot, test: resolve(assetRoot, "testing") },
    knowledgeRoot: resolve(assetRoot, "experience", "library"),
    backupRoot: location("INTENTFRAME_BACKUP_ROOT", settings.backupRoot),
    node: location("INTENTFRAME_NODE_BIN", settings.tools.node.path),
    codex: location("INTENTFRAME_CODEX_BIN", settings.tools.codex.path),
    restic: location("INTENTFRAME_RESTIC_BIN", settings.tools.restic.path),
    tools: settings.tools, runtime: settings.runtime, mcp: settings.mcp,
    media: settings.media, backup: settings.backup, diagnostics: settings.diagnostics,
    providers: settings.providers ?? {},
    assetLibraries: settings.assetLibraries.map(item => ({ ...item, path: resolve(root, item.path) })),
  };
}

export const configuration = loadConfiguration();

/** MCP SDK 默认只继承基础环境；显式传递项目配置，不扩散无关凭据。 */
export function projectEnvironment(): Record<string, string> {
  return {
    INTENTFRAME_DATA_ROOT: configuration.assetRoot,
    INTENTFRAME_BACKUP_ROOT: configuration.backupRoot,
    INTENTFRAME_NODE_BIN: configuration.node,
    INTENTFRAME_CODEX_BIN: configuration.codex,
    INTENTFRAME_RESTIC_BIN: configuration.restic,
  };
}
