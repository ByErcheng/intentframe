import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlan, prepareRound, readPlan, recordChoice, suiteRoot } from "../scripts/model-evaluation/plan.ts";

const configuration = () => ({ id: "custom-test", variants: [{ id: "a", model: "custom-model-a", effort: "custom-effort" }, { id: "b", model: "custom-model-b", effort: "other-effort" }],
  caseIds: ["draft-basic", "design-market"], repetitions: 2, limits: { modelTurnMs: 1000, operationMs: 2000, generationCalls: 0 },
  providerKinds: [], assetLibraries: [], repeatRule: "保留全部结果后等量复测", choicePolicy: "由用户选择" });
function temporary() { return mkdtempSync(join(realpathSync(tmpdir()), "intentframe-evaluation-")); }

test("模型和强度来自输入；阶段评价与独立案例分离，重复轮次均保留", () => {
  const plan = buildPlan(configuration());
  for (const variant of configuration().variants) {
    const runs = plan.runs.filter(r => r.variantId === variant.id);
    assert(runs.every(r => r.requestedModel === variant.model && r.requestedEffort === variant.effort && r.actualModel === null && r.actualEffort === null));
    for (const caseId of configuration().caseIds) assert.deepEqual(runs.filter(r => r.caseId === caseId).map(r => r.repetition), [1,2]);
  }
  assert.deepEqual(plan.cases.find(c => c.id === "design-market")!.evaluates, ["design", "design_assets"]);
  assert.equal(plan.runs[0]!.variantId, "a");
  assert.equal(plan.runs.find(r => r.repetition === 2)!.variantId, "b");
  const whole = buildPlan(JSON.parse(readFileSync(join(suiteRoot,"config/round-01.json"),"utf8")));
  assert.deepEqual(new Set(whole.cases.flatMap(c => c.evaluates)), new Set(["draft_review","draft_revision","design","design_assets","production","production_assets","internal_review","feedback_revision","learning"]));
  assert(whole.cases.some(c => c.id === "review-clean"));
  assert(whole.cases.some(c => c.id === "review-defects"));
});

test("未知案例、缺失配置和重复条件拒绝，不偷偷使用默认模型", () => {
  for (const changes of [{ variants: [] }, { caseIds: ["missing"] }, { variants: [configuration().variants[0], configuration().variants[0]] },
    { repetitions: 0 }, { limits: { modelTurnMs: 1000, operationMs: 1, generationCalls: 0 } }]) assert.throws(() => buildPlan({ ...configuration(), ...changes }));
  assert.throws(() => buildPlan({ id: "none" }));
});

test("冻结正文并隔离候选；准备不产生结果、不覆盖历史，也不复制评价文件", () => {
  const root = temporary();
  try {
    const target = join(root, "round"); prepareRound(configuration(), target);
    const plan = readPlan(target), first = plan.runs[0]!, second = plan.runs[1]!;
    const firstInput = join(target,first.id,"input.md"), original = readFileSync(firstInput,"utf8");
    assert.equal(original, plan.cases.find(c => c.id === first.caseId)!.inputText);
    assert.deepEqual(readdirSync(join(target,first.id)).sort(), ["input.md","run.json","work-data"]);
    writeFileSync(firstInput,"changed");
    assert.notEqual(readFileSync(join(target,second.id,"input.md"),"utf8"),"changed");
    assert.throws(() => prepareRound(configuration(),target), /已存在/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("清单不得把评价文件或链接目标作为被测输入", () => {
  const root=temporary();
  try {
    mkdirSync(join(root,"inputs")); mkdirSync(join(root,"evaluation")); writeFileSync(join(root,"evaluation","answers.md"),"答案不可见");
    const fixture = { version:2, cases:[{id:"draft-basic",operation:"review_draft",level:"control",evaluates:["draft_review"],input:"evaluation/answers.md",requires:[]}] };
    writeFileSync(join(root,"suite.json"),JSON.stringify(fixture));
    const cfg={...configuration(),caseIds:["draft-basic"]};
    assert.throws(()=>buildPlan(cfg,root), /inputs/);
    fixture.cases[0]!.input="inputs/linked.md"; symlinkSync(join(root,"evaluation/answers.md"),join(root,"inputs/linked.md"));
    writeFileSync(join(root,"suite.json"),JSON.stringify(fixture));
    assert.throws(()=>buildPlan(cfg,root),/inputs/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("选择必须来自用户输入并绑定本轮结果，允许并列或暂缓且不覆盖旧选择", () => {
  const root=temporary();
  try {
    const target=join(root,"round");prepareRound({...configuration(),caseIds:["draft-basic"],repetitions:1},target);
    const plan=readPlan(target), runs=plan.runs;
    const choice={scope:["draft_review"],verdict:"tie",variantIds:["a","b"],runIds:runs.map(r=>r.id),userQuote:"这两组目前看起来差不多，先并列。",notes:"合成用户选择，仅验证记录"};
    assert.throws(()=>recordChoice(target,choice));
    for(const run of runs) writeFileSync(join(target,run.id,"result.json"),JSON.stringify({runId:run.id,status:"completed"}));
    const path=recordChoice(target,choice), saved=JSON.parse(readFileSync(path,"utf8"));
    assert.equal(saved.userQuote,choice.userQuote); assert.equal(saved.results.length,2); assert(saved.results.every((r:{resultSha256:string})=>r.resultSha256.length===64));
    assert.throws(()=>recordChoice(target,{...choice,variantIds:["outside"]}));
    assert.throws(()=>recordChoice(target,{...choice,userQuote:""}));
    const next=recordChoice(target,{...choice,verdict:"defer",variantIds:[],userQuote:"暂缓选择"});
    assert.notEqual(next,path); assert.equal(JSON.parse(readFileSync(path,"utf8")).verdict,"tie");
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("结果报告区分未开始和缺少终态，不将执行标记当作完成",async()=>{
  const {reportRound}=await import("../scripts/model-evaluation/report.ts");
  const root=temporary();
  try {
    const target=join(root,"round");prepareRound({...configuration(),caseIds:["draft-basic"],repetitions:1},target);
    const plan=readPlan(target), first=plan.runs[0]!;
    writeFileSync(join(target,first.id,"execution.json"),"{}");
    const report=reportRound(target);
    assert(report.includes("unknown"));assert(report.includes("not_started"));
    assert(!report.includes("custom-model-a"));assert(!report.includes("custom-model-b"));
  } finally {rmSync(root,{recursive:true,force:true});}
});
