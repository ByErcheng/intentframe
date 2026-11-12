import { executeRun, treeHash } from "./model-evaluation/execute.ts";
const [command, first, second, third, ...rest] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === "snapshot-hash" && first && !second) result = { treeSha256: treeHash(first) };
  else if (command === "run" && first && second && !rest.length) result = await executeRun(first, second, third);
  else throw new Error("用法：run-model-evaluation.ts snapshot-hash <独立基线目录> | run <轮次目录> <运行编号> [基线绑定.json]；run 会调用真实模型和允许的生成服务");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
