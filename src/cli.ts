import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configuration } from "./config.ts";
import { mediaBinaries, mediaEnvironment } from "./media/render.ts";
import { executeTool, prepareOperation, startMcpServer } from "./mcp/server.ts";
import { z } from "zod";
import { describeError } from "./common/errors.ts";
import { rebuildLibraryIndex } from "./records/asset-library.ts";
import { WorkRouter } from "./runtime/work-router.ts";

async function main() {
  const [command, name, file, output] = process.argv.slice(2);
  if (command === "mcp") { startMcpServer(); return; }
  if (command === "index-assets") {
    if (name) throw new Error("index-assets 不接收额外参数，使用本机已配置的素材库。");
    console.log(JSON.stringify(rebuildLibraryIndex(configuration.assetRoot, configuration.assetLibraries), null, 2));
    return;
  }
  if (command === "doctor") {
    const media = mediaBinaries();
    const tools = { node: configuration.node, codex: configuration.codex, restic: configuration.restic, ...media };
    const checked = Object.fromEntries(Object.entries(tools).map(([tool, path]) => {
      if (!existsSync(path)) return [tool, { path, available: false }];
      const args = tool === "restic" ? ["version"] : tool === "ffmpeg" || tool === "ffprobe" ? ["-version"] : ["--version"];
      try {
        return [tool, { path, available: true, version: execFileSync(path, args, {
          encoding: "utf8", timeout: configuration.diagnostics.toolTimeoutMs,
          env: tool === "ffmpeg" || tool === "ffprobe" ? mediaEnvironment() : process.env,
        }).split("\n")[0] }];
      } catch (error) {
        return [tool, { path, available: false, error: describeError(error) }];
      }
    }));
    console.log(JSON.stringify({ configPath: configuration.configPath,
      environmentOverrides: configuration.environmentOverrides,
      assetRoot: configuration.assetRoot, workRoots: configuration.workRoots, knowledgeRoot: configuration.knowledgeRoot,
      backupRoot: configuration.backupRoot, models: configuration.models, tools: checked }, null, 2));
    if (!Object.values(checked).every(tool => tool.available)) process.exitCode = 1;
    return;
  }
  if (command === "prepare" && name && file && output) {
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, "utf8")));
    const request = prepareOperation(name, input, new WorkRouter());
    if ("preflight" in request && request.preflight?.status === "blocked") {
      console.log(JSON.stringify(request, null, 2)); process.exitCode = 1; return;
    }
    writeFileSync(output, JSON.stringify(request.arguments, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ tool: name, operationId: request.arguments.operationId, requestFile: output,
      capability: request.capability, ...("preflight" in request ? { preflight: request.preflight } : {}) }, null, 2));
    return;
  }
  if (command === "call" && name && file) {
    const input: unknown = JSON.parse(readFileSync(file, "utf8"));
    console.log(JSON.stringify(await executeTool(name, input), null, 2));
    return;
  }
  if (!command || command === "--help") {
    console.log("用法：scripts/intentframe doctor | mcp | index-assets | prepare <工具名> <参数 JSON> <新请求 JSON> | call <工具名> <请求 JSON>");
    return;
  }
  throw new Error("命令或参数不完整，请使用 --help。");
}
await main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
