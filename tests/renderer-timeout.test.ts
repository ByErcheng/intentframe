import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { applyRendererPatch, verifyRendererPatch } from "../src/media/renderer-patch.ts";

const require = createRequire(import.meta.url);
const renderer = dirname(require.resolve("@remotion/renderer/package.json"));

for (const file of ["dist/esm/index.mjs", "dist/puppeteer-evaluate.js"]) {
  test("渲染依赖页面求值在成功、失败和超时时均释放计时器：" + file, async () => {
    // 执行实际安装依赖中的函数，独立控制它的输入和时钟；不复制被测实现。
    const source = readFileSync(join(renderer, file), "utf8");
    const start = source.indexOf("function puppeteerEvaluateWithCatchAndTimeout("), end = source.indexOf("async function puppeteerEvaluateWithCatch(", start);
    assert(start >= 0 && end > start, "依赖实现已变化，须复查兼容补丁及本用例");
    for (const outcome of ["resolved", "rejected", "timed-out"]) {
      const timers = new Map<number, () => void>(), reason = new Error("合成页面求值异常"), value = { value: 42, size: 2 };
      const evaluate = new Function("puppeteerEvaluateWithCatch", "setTimeout", "clearTimeout",
        source.slice(start, end) + ";return puppeteerEvaluateWithCatchAndTimeout;")(
        () => outcome === "resolved" ? Promise.resolve(value) : outcome === "rejected" ? Promise.reject(reason) : new Promise(() => {}),
        (callback: () => void) => { timers.set(1, callback); return 1; }, (id: number) => timers.delete(id));
      const pending = evaluate({ page: {}, args: [], frame: 0, pageFunction: () => {}, timeoutInMilliseconds: 30_000 });
      if (outcome === "timed-out") timers.get(1)!();
      if (outcome === "resolved") assert.equal(await pending, value);
      else await assert.rejects(pending, outcome === "rejected" ? error => error === reason : /Timed out evaluating/);
      assert.equal(timers.size, 0, outcome + " 后不得保留计时器");
    }
  });
}

test("渲染兼容补丁可重复安装，未知依赖拒绝写入且不静默跳过", () => {
  const root = mkdtempSync(join(tmpdir(), "intentframe-renderer-patch-"));
  try {
    const metadata = readFileSync(join(renderer, "package.json"), "utf8");
    writeFileSync(join(root, "package.json"), metadata);
    for (const file of ["dist/esm/index.mjs", "dist/puppeteer-evaluate.js"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      const source = readFileSync(join(renderer, file), "utf8"), start = source.indexOf("function puppeteerEvaluateWithCatchAndTimeout("), end = source.indexOf("async function puppeteerEvaluateWithCatch(", start);
      const indent = file.endsWith(".js") ? "    " : "  ";
      const restored = source.slice(start, end).replace(".finally(() => {", ".then((data) => {")
        .replace(indent + "});\n}", indent.repeat(2) + "return data;\n" + indent + "});\n}");
      writeFileSync(join(root, file), source.slice(0, start) + restored + source.slice(end));
    }
    assert.throws(() => verifyRendererPatch(root), /npm run patch:renderer/);
    const esm = join(root, "dist/esm/index.mjs"), cjs = join(root, "dist/puppeteer-evaluate.js");
    const esmBefore = readFileSync(esm), cjsBefore = readFileSync(cjs);
    writeFileSync(cjs, Buffer.concat([cjsBefore, Buffer.from("\n// 合成未核实改动\n")]));
    assert.throws(() => applyRendererPatch(root), /内容与已核实版本不符/);
    assert.deepEqual(readFileSync(esm), esmBefore, "第二个文件不符时不能先改第一个文件");
    writeFileSync(cjs, cjsBefore);
    assert.equal(applyRendererPatch(root), 2);
    assert.equal(applyRendererPatch(root), 0);
    verifyRendererPatch(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@remotion/renderer", version: "4.0.542" }));
    assert.throws(() => applyRendererPatch(root), /版本已变化/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
