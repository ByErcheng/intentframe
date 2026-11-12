import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixtureRoot } from "./helpers.ts";
import { processExists } from "../src/runtime/process-state.ts";

for (const mode of ["success", "failure", "cancel-render", "cancel-frames", "cancel-encoding", "cancel-browser", "cancel-composition"]) {
  test("渲染资源收尾可自然退出：" + mode, { timeout: 30_000 }, async () => {
    const root = fixtureRoot();
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/render-lifecycle.ts", import.meta.url)), root.path, mode],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "", forced = false;
    child.stdout.on("data", data => { diagnostics = (diagnostics + data).slice(-3000); });
    child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-3000); });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      forced = true;
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      killTimer = setTimeout(() => { if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL"); }, 2500);
    }, 20_000);
    try {
      const code = await new Promise(resolve => child.once("close", resolve));
      assert(!forced, "子进程在20秒内未自然退出；阶段与返回标记：" + diagnostics);
      assert.equal(code, 0, diagnostics);
      const result = JSON.parse(readFileSync(join(root.path, "result.json"), "utf8"));
      if (mode === "success") { assert.equal(result.status, "completed"); assert(existsSync(join(root.path, "video.mp4"))); }
      else {
        assert.equal(result.status, "rejected", JSON.stringify(result));
        assert(!existsSync(join(root.path, "video.mp4")), "失败或取消不能发布新视频");
        if (mode.startsWith("cancel-")) { assert(result.stages.includes(mode.slice(7))); assert(result.reasonPreserved, JSON.stringify(result)); }
        else assert.match(result.error, /合成帧渲染失败/);
      }
      assert(!processExists(child.pid!, true), "本次渲染进程组仍有成员存活");
    } finally { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); root.cleanup(); }
  });
}
