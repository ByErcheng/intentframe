import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configuration, projectEnvironment, repositoryRoot } from "../src/config.ts";
import { z } from "zod";

// 使用真正的 MCP 连接验证服务；新进程从本机记录接续，不共享前次客户端内存。
const [name, inputFile, outputFile] = process.argv.slice(2);
if (!name || !inputFile) throw new Error("用法：mcp-call.ts <工具名> <输入 JSON> [输出 JSON]");
const client = new Client({ name: "intentframe-local-client", version: "0.1.0" });
try {
  await client.connect(new StdioClientTransport({
    command: "/bin/sh", args: [join(repositoryRoot, "scripts", "intentframe"), "mcp"],
    cwd: repositoryRoot,
    env: projectEnvironment(),
  }));
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === name)) throw new Error("服务未公开工具：" + name);
  // 写操作前先核对服务实际目录；连接成功不代表连接到了预期数据。
  const identity = await client.callTool({ name: "get_runtime_info", arguments: {} });
  const identityText = identity.content.find(item => item.type === "text");
  if (identity.isError || !identityText || identityText.type !== "text") throw new Error("无法核对服务数据目录。");
  const info = z.object({ dataRoot: z.string() }).parse(JSON.parse(identityText.text));
  if (info.dataRoot !== configuration.dataRoot) throw new Error("服务数据目录与请求配置不一致，已停止调用。");
  const result = await client.callTool(
    { name, arguments: JSON.parse(readFileSync(inputFile, "utf8")) },
    { timeout: 600_000 },
  );
  const content = result.content.find(item => item.type === "text");
  if (!content || content.type !== "text") throw new Error("工具没有返回文本结果。");
  if (result.isError) throw new Error(content.text);
  const parsed: unknown = JSON.parse(content.text);
  const text = JSON.stringify(parsed, null, 2) + "\n";
  if (outputFile) writeFileSync(outputFile, text);
  process.stdout.write(text);
} finally { await client.close(); }
