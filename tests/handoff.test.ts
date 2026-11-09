import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { repositoryRoot } from "../src/config.ts";
import { fakeCodex, fixtureRoot } from "./helpers.ts";

// npm test 覆盖稳定脚本入口及跨进程错误交接；协议替身不证明真实模型接续能力。
test("接入验证脚本复用实际失败规则，异常入口不触发模型调用", { timeout: 30_000 }, () => {
  const root = fixtureRoot();
  let runDirectory: string | undefined;
  try {
    const result = spawnSync(process.execPath, ["scripts/test-local-handoff.ts", "--errors"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, INTENTFRAME_CODEX_BIN: fakeCodex(root.path) },
    });
    const first = result.stdout.split("\n")[0];
    if (first) {
      const candidate = JSON.parse(first).runDirectory;
      assert.equal(dirname(candidate), join(repositoryRoot, ".cache/local-handoff/runs"));
      runDirectory = candidate;
    }
    assert.equal(result.status, 0, result.stderr);
    assert(runDirectory);
    const report = JSON.parse(readFileSync(join(runDirectory, "report.json"), "utf8"));
    assert.equal(report.result, "passed");
    assert.equal(report.modelGeneration, false);
  } finally {
    if (runDirectory) rmSync(runDirectory, { recursive: true, force: true });
    root.cleanup();
  }
});
