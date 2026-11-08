import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { configuration } from "./config.ts";
import { mediaBinaries, mediaEnvironment } from "./media/render.ts";
import { executeTool, startMcpServer } from "./mcp/server.ts";
import { describeError } from "./runtime/codex-client.ts";

async function main() {
  const [command, name, file] = process.argv.slice(2);
  if (command === "mcp") { startMcpServer(); return; }
  if (command === "doctor") {
    const media = mediaBinaries();
    const tools = { node: configuration.node, codex: configuration.codex, restic: configuration.restic, ...media };
    const checked = Object.fromEntries(Object.entries(tools).map(([tool, path]) => {
      if (!existsSync(path)) return [tool, { path, available: false }];
      const args = tool === "restic" ? ["version"] : tool === "ffmpeg" || tool === "ffprobe" ? ["-version"] : ["--version"];
      try {
        return [tool, { path, available: true, version: execFileSync(path, args, {
          encoding: "utf8", timeout: 10_000, env: tool === "ffmpeg" || tool === "ffprobe" ? mediaEnvironment() : process.env,
        }).split("\n")[0] }];
      } catch (error) {
        return [tool, { path, available: false, error: describeError(error) }];
      }
    }));
    console.log(JSON.stringify({ dataRoot: configuration.dataRoot, tools: checked }, null, 2));
    if (!Object.values(checked).every(tool => tool.available)) process.exitCode = 1;
    return;
  }
  if (command === "call" && name && file) {
    const input: unknown = JSON.parse(readFileSync(file, "utf8"));
    console.log(JSON.stringify(await executeTool(name, input), null, 2));
    return;
  }
  if (!command || command === "--help") {
    console.log("用法：scripts/intentframe doctor | mcp | call <工具名> <参数 JSON 文件>");
    return;
  }
  throw new Error("命令或参数不完整，请使用 --help。");
}
await main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
