import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export const rendererDirectory = dirname(require.resolve("@remotion/renderer/package.json"));
const patches = [
  { file: "dist/esm/index.mjs", original: "3deef31b8f44a561944c25d7a99d3c776c6b46e37efce8aed2b03580b813b227",
    patched: "cd8b85baf532a8e6f47c1162d8198ebe4c3d1b9a7a8e4f97535ee2fb550684db" },
  { file: "dist/puppeteer-evaluate.js", original: "b2a0e022eaff8aa30af4d8d05b1a61393455e390635ece8f7bebdab73d092009",
    patched: "e3b0e51460656dc696a04300d01b65f36e4fcf3875fc218cd76c1546fe185d91" },
];
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

function patchPlan(directory: string) {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (metadata.name !== "@remotion/renderer" || metadata.version !== "4.0.541") throw new Error("渲染依赖版本已变化，须复查并更新或移除页面求值计时器兼容补丁。");
  return patches.map(patch => {
    const path = join(directory, patch.file), source = readFileSync(path, "utf8"), digest = hash(source);
    if (digest === patch.patched) return { path, changed: false, source };
    if (digest !== patch.original) throw new Error("渲染依赖内容与已核实版本不符，未应用兼容补丁：" + patch.file);
    const start = source.indexOf("function puppeteerEvaluateWithCatchAndTimeout("), end = source.indexOf("async function puppeteerEvaluateWithCatch(", start);
    if (start < 0 || end <= start) throw new Error("渲染依赖中无法定位已核实的页面求值函数。");
    // 上游只在 resolve 时清计时器；finally 保持原值/原异常，同时覆盖 reject。
    const updated = source.slice(start, end).replace(".then((data) => {", ".finally(() => {").replace(/^[ \t]*return data;\r?\n/m, "");
    const result = source.slice(0, start) + updated + source.slice(end);
    if (hash(result) !== patch.patched) throw new Error("渲染兼容补丁结果与预期摘要不符，未写入。");
    return { path, changed: true, source: result };
  });
}

/** 显式安装步骤；先核对全部文件，再逐文件原子替换。重复执行不写已修文件。 */
export function applyRendererPatch(directory = rendererDirectory) {
  const plan = patchPlan(directory);
  for (const item of plan.filter(item => item.changed)) {
    const temporary = item.path + "." + randomUUID() + ".tmp";
    try { writeFileSync(temporary, item.source, { flag: "wx" }); renameSync(temporary, item.path); }
    finally { rmSync(temporary, { force: true }); }
  }
  return plan.filter(item => item.changed).length;
}

export function verifyRendererPatch(directory = rendererDirectory) {
  if (patchPlan(directory).some(item => item.changed)) throw new Error("渲染依赖尚未应用计时器兼容补丁；请运行 npm run patch:renderer，再重启正在运行的 intentframe 服务。");
}

let verified = false;
export function assertRendererPatch() {
  if (!verified) { verifyRendererPatch(); verified = true; }
}
