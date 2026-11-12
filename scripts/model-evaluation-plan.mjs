#!/usr/bin/env node
import { readJson, buildPlan, prepareRound, recordChoice } from "./model-evaluation/plan.ts";
import { reportRound } from "./model-evaluation/report.ts";
const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "plan" && args.length === 1) result = buildPlan(readJson(args[0]));
  else if (command === "prepare" && args.length === 2) result = prepareRound(readJson(args[0]), args[1]);
  else if (command === "choice" && args.length === 2) result = { path: recordChoice(args[0], readJson(args[1])) };
  else if (command === "report" && (args.length === 1 || args.length === 2)) result = reportRound(args[0],args[1]);
  else throw new Error("用法：model-evaluation-plan.mjs plan <配置.json> | prepare <配置.json> <新目录> | report <轮次目录> [案例编号] | choice <轮次目录> <用户选择.json>");
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n");
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
