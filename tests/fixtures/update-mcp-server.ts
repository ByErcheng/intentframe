import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startMcpServer } from "../../src/mcp/server.ts";

// 此入口仅供隔离协议回归，模拟公开来源；生产代码没有来源重定向开关。
globalThis.fetch = async input => {
  const url = String(input);
  appendFileSync(process.env.UPDATE_FIXTURE_LOG!, url + "\n");
  await delay(50);
  if (process.env.UPDATE_FIXTURE_FAIL === "1") return new Response("", { status: 503 });
  const data = url.includes("nodejs.org") ? [{ version: "v999.0.0" }] :
    url.includes("api.github.com") ? { tag_name: "v999.0.0", prerelease: false, draft: false } : { version: "999.0.0" };
  return new Response(JSON.stringify(data));
};
startMcpServer();
