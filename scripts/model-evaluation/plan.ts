import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const suiteRoot = resolve(repoRoot, "tests/model-evaluation");
const text = z.string().trim().min(1);
const id = text.regex(/^[a-zA-Z0-9_-]+$/);
export const variantSchema = z.strictObject({ id, model: text, effort: text });
export const roundSchema = z.strictObject({ id, variants: z.array(variantSchema).min(1), caseIds: z.array(id).min(1),
  media: z.strictObject({ durationSeconds: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  repetitions: z.number().int().min(1).max(20),
  limits: z.strictObject({ modelTurnMs: z.number().int().positive().max(2_147_483_647), operationMs: z.number().int().positive().max(2_147_483_647), generationCalls: z.number().int().nonnegative(),
    mediaProbeMs: z.number().int().positive().max(2_147_483_647).optional(), mediaDecodeMs: z.number().int().positive().max(2_147_483_647).optional(), mediaPreviewMs: z.number().int().positive().max(2_147_483_647).optional() }),
  providerKinds: z.array(z.enum(["image", "speech", "music", "sound_effect"])), assetLibraries: z.union([z.literal("configured"), z.array(text)]), repeatRule: text, choicePolicy: text,
}).superRefine((v, ctx) => {
  for (const [label, values] of [["候选编号", v.variants.map(x => x.id)], ["模型与强度组合", v.variants.map(x => JSON.stringify([x.model,x.effort]))], ["案例", v.caseIds]] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: label + "不能重复" });
  }
  if (v.limits.operationMs < v.limits.modelTurnMs) ctx.addIssue({ code: "custom", message: "总操作预算不能小于单轮模型预算" });
});
export type Round = z.infer<typeof roundSchema>;
const caseSchema = z.strictObject({ id, operation: z.enum(["review_draft", "revise_draft", "design_video", "produce_version", "prepare_assets", "inspect_only", "inspect_visuals", "organize_experience"]),
  level: z.enum(["control", "representative"]), evaluates: z.array(text).min(1), input: text, requires: z.array(text) });
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
export function writeNew(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
export function inside(parent: string, child: string) { const rel = relative(parent, child); return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel)); }

export function buildPlan(raw: unknown, base = suiteRoot) {
  const round = roundSchema.parse(raw);
  const suite = z.strictObject({ version: z.literal(2), cases: z.array(caseSchema) }).parse(readJson(resolve(base, "suite.json")));
  if (new Set(suite.cases.map(c => c.id)).size !== suite.cases.length) throw new Error("清单包含重复案例编号");
  const cases = round.caseIds.map(key => {
    const item = suite.cases.find(c => c.id === key);
    if (!item) throw new Error("未知案例：" + key);
    const path = resolve(base, item.input), inputRoot = realpathSync(resolve(base, "inputs"));
    if (!inside(inputRoot, path) || !inside(inputRoot, realpathSync(path)) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("案例输入须为 inputs 内的普通文件：" + item.input);
    const inputText = readFileSync(path, "utf8");
    return { ...item, inputText, inputSha256: hash(inputText) };
  });
  // 各重复轮次轮换候选顺序；全部结果保留，不挑选成功或最佳的一次。
  const runs = Array.from({ length: round.repetitions }, (_, repetition) => cases.flatMap(item => {
    const order = [...round.variants.slice(repetition % round.variants.length), ...round.variants.slice(0, repetition % round.variants.length)];
    return order.map(variant => ({ id: "run-" + randomUUID(), caseId: item.id, variantId: variant.id, repetition: repetition + 1,
      requestedModel: variant.model, requestedEffort: variant.effort, status: "not_started" as const,
      actualModel: null, actualEffort: null, prerequisites: item.requires }));
  })).flat();
  return { format: "intentframe-model-evaluation-plan-v2" as const, purpose: "test" as const, round, cases, runs };
}
export type Plan = ReturnType<typeof buildPlan>;
const planSchema = z.strictObject({ format: z.literal("intentframe-model-evaluation-plan-v2"), purpose: z.literal("test"), round: roundSchema,
  cases: z.array(caseSchema.extend({ inputText: z.string(), inputSha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  runs: z.array(z.strictObject({ id: id.regex(/^run-[a-f0-9-]+$/), caseId: id, variantId: id, repetition: z.number().int().positive(),
    requestedModel: text, requestedEffort: text, status: z.literal("not_started"), actualModel: z.null(), actualEffort: z.null(), prerequisites: z.array(text) })) });
export function readPlan(directory: string): Plan {
  const plan = planSchema.parse(readJson(resolve(directory, "plan.json")));
  if (new Set(plan.runs.map(r => r.id)).size !== plan.runs.length) throw new Error("运行编号重复");
  for (const item of plan.cases) if (hash(item.inputText) !== item.inputSha256) throw new Error("计划输入摘要不匹配");
  for (const run of plan.runs) {
    const variant = plan.round.variants.find(v => v.id === run.variantId);
    if (!variant || !plan.cases.some(c => c.id === run.caseId) || run.requestedModel !== variant.model || run.requestedEffort !== variant.effort) throw new Error("运行与候选或案例不匹配");
  }
  return plan;
}
export function prepareRound(raw: unknown, destination: string) {
  const plan = buildPlan(raw), parent = realpathSync(dirname(resolve(destination))), target = resolve(parent, resolve(destination).split(sep).at(-1)!);
  if (inside(realpathSync(repoRoot), target)) throw new Error("实际运行材料须保存在系统仓库外的本机测试目录");
  if (existsSync(target)) throw new Error("输出目录已存在，不能覆盖或重建原轮次");
  mkdirSync(target, { mode: 0o700 });
  writeNew(resolve(target, "plan.json"), plan);
  for (const run of plan.runs) {
    const directory = resolve(target, run.id); mkdirSync(directory, { mode: 0o700 });
    mkdirSync(resolve(directory, "work-data"), { mode: 0o700 });
    const item = plan.cases.find(c => c.id === run.caseId)!;
    writeFileSync(resolve(directory, "input.md"), item.inputText, { flag: "wx", mode: 0o600 });
    writeNew(resolve(directory, "run.json"), { ...run, operation: item.operation, evaluates: item.evaluates, inputSha256: item.inputSha256 });
  }
  return { directory: target, runCount: plan.runs.length, status: "prepared", modelCalls: 0 };
}

export const choiceSchema = z.strictObject({ scope: z.array(id).min(1), verdict: z.enum(["selected", "tie", "defer", "none_suitable"]),
  variantIds: z.array(id), runIds: z.array(id).min(1), userQuote: text, notes: z.string(),
}).superRefine((v, ctx) => {
  const n = v.variantIds.length;
  if ((v.verdict === "selected" && n !== 1) || (v.verdict === "tie" && n < 2) || (["defer", "none_suitable"].includes(v.verdict) && n !== 0)) ctx.addIssue({ code: "custom", message: "选择结论与候选数量不一致" });
  if ([v.variantIds, v.runIds, v.scope].some(values => new Set(values).size !== values.length)) ctx.addIssue({ code: "custom", message: "选择记录中不能重复引用" });
});
export function recordChoice(roundPath: string, raw: unknown) {
  const choice = choiceSchema.parse(raw), plan = readPlan(roundPath);
  // 只引用本轮真实存在的结果文件，选择原话由操作者从用户回复原样转录。
  if (plan.format !== "intentframe-model-evaluation-plan-v2") throw new Error("不支持的计划格式");
  for (const key of choice.scope) if (!plan.cases.some(c => c.evaluates.includes(key))) throw new Error("选择范围不属于本轮");
  for (const key of choice.variantIds) if (!plan.round.variants.some(v => v.id === key)) throw new Error("选择了本轮之外的模型配置");
  const results = choice.runIds.map(key => {
    const run = plan.runs.find(r => r.id === key);
    if (!run || !plan.cases.find(c => c.id === run.caseId)?.evaluates.some(stage => choice.scope.includes(stage))) throw new Error("结果不属于选择范围");
    const path = resolve(roundPath, key, "result.json"), bytes = readFileSync(path);
    const result = JSON.parse(bytes.toString());
    if (result.runId !== key || !["completed", "failed", "blocked", "unknown"].includes(result.status)) throw new Error("结果尚未形成或归属不符");
    return { runId: key, variantId: run.variantId, resultSha256: hash(bytes), status: result.status };
  });
  for (const key of choice.variantIds) if (!results.some(r => r.variantId === key)) throw new Error("选中配置须关联已展示的执行结果");
  const path = resolve(roundPath, "choice-" + randomUUID() + ".json");
  writeNew(path, { ...choice, results, recordedAt: new Date().toISOString(), source: "user", note: "模型选择不等于成片认可或发布授权" });
  return path;
}
