import { applyRendererPatch, verifyRendererPatch } from "../src/media/renderer-patch.ts";

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) throw new Error("用法：node scripts/patch-renderer.ts [--check]");
if (process.argv[2] === "--check") verifyRendererPatch();
else console.log("渲染依赖兼容补丁：本次更新 " + applyRendererPatch() + " 个文件。已运行的服务须重启后生效。");
