import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeCodex, fixtureRoot } from "./helpers.ts";
import { prepareRound, readPlan } from "../scripts/model-evaluation/plan.ts";
import { executeRun } from "../scripts/model-evaluation/execute.ts";

function config(model="fixture-a",effort="medium",caseId="draft-basic") { return {id:"runtime-test",variants:[{id:"candidate",model,effort}],caseIds:[caseId],repetitions:1,
  limits:{modelTurnMs:10000,operationMs:30000,generationCalls:0},providerKinds:[],assetLibraries:[],repeatRule:"合成",choicePolicy:"合成"}; }
function calls(root:string) { return readFileSync(join(root,"native-fixture/calls.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)); }

test("实际服务经过测试运行器，模型与强度贯穿线程和轮次，输入范围受限且结果可追溯",async()=>{
  const root=fixtureRoot();
  try {
    const directory=join(root.path,"round");prepareRound(config(),directory);
    const run=readPlan(directory).runs[0]!, executable=fakeCodex(root.path);
    const result=await executeRun(directory,run.id,undefined,{executable});
    assert.equal(result.status,"completed",result.error);
    assert.equal(result.actualModel,"fixture-a");assert.equal(result.actualEffort,"medium");
    const all=calls(root.path),thread=all.find(c=>c.method==="thread/start"),turn=all.find(c=>c.method==="turn/start");
    assert.equal(thread.params.model,"fixture-a");assert.equal(thread.params.config.model_reasoning_effort,"medium");
    assert.equal(turn.params.model,"fixture-a");assert.equal(turn.params.effort,"medium");
    assert.equal(thread.params.permissions,"intentframe-evaluation-read");
    assert.deepEqual(thread.params.config["permissions.intentframe-evaluation-read"].filesystem,{":root":"deny",":minimal":"read",[join(directory,run.id,"work-data")]:"read"});
    assert.equal(turn.params.permissions,"intentframe-evaluation-read");assert.equal(turn.params.sandboxPolicy,undefined);
    assert.equal(result.configurationEvidence.length,1);assert(result.runtimeEvidence);
    await assert.rejects(executeRun(directory,run.id,undefined,{executable}),/已有执行/);
  } finally {root.cleanup();}
});

for (const [name,model,effort,mode] of [["不支持的模型","unsupported","medium","completed"],["不支持的强度","fixture-a","unsupported","completed"],
  ["实际模型不一致","fixture-a","medium","model_mismatch"],["实际强度缺失","fixture-a","medium","missing_effort"],["实际权限配置缺失","fixture-a","medium","missing_permissions"]]) {
  test(name+"在生成轮次前停止，不当作默认配置继续",async()=>{
    const root=fixtureRoot();
    try {
      const directory=join(root.path,"round");prepareRound(config(model,effort),directory);
      const run=readPlan(directory).runs[0]!,result=await executeRun(directory,run.id,undefined,{executable:fakeCodex(root.path,mode)});
      assert.notEqual(result.status,"completed");
      if(mode!=="missing_permissions")assert.equal(result.actualEffort,null);
      assert(!calls(root.path).some(c=>c.method==="turn/start"));
    } finally {root.cleanup();}
  });
}

test("没有实际审查基线时拒绝执行，不创建模型运行记录",async()=>{
  const root=fixtureRoot();
  try {
    const directory=join(root.path,"round");prepareRound(config("fixture-a","medium","review-defects"),directory);
    const run=readPlan(directory).runs[0]!;
    await assert.rejects(executeRun(directory,run.id),/实际共同基线/);
    assert(!existsSync(join(directory,run.id,"execution.json")));
  } finally {root.cleanup();}
});

test("素材调用预算在转交供应商工具前生效，拒绝仍保留原模型回复",async()=>{
  const root=fixtureRoot();
  try {
    const directory=join(root.path,"round");prepareRound(config(),directory);
    const run=readPlan(directory).runs[0]!;
    await executeRun(directory,run.id,undefined,{executable:fakeCodex(root.path,"generation_probe")});
    const evidence=readFileSync(join(directory,run.id,"runtime.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    assert(evidence.some(e=>e.kind==="generation_budget_rejected"));
    assert(!evidence.some(e=>e.kind==="generation_attempt"));
    assert(readFileSync(join(root.path,"native-fixture/history.json"),"utf8").includes("生成调用预算已用完"));
  } finally {root.cleanup();}
});

test("模型轮次失联保留 unknown 和原执行，不能用同一编号重发",async()=>{
  const root=fixtureRoot();
  try {
    const directory=join(root.path,"round");prepareRound(config(),directory);
    const run=readPlan(directory).runs[0]!,executable=fakeCodex(root.path,"disconnect");
    const result=await executeRun(directory,run.id,undefined,{executable});
    assert.equal(result.status,"unknown");
    await assert.rejects(executeRun(directory,run.id,undefined,{executable}),/已有执行/);
    assert.equal(calls(root.path).filter(c=>c.method==="turn/start").length,1);
  } finally {root.cleanup();}
});

test("共同基线根链接和目录重叠在复制前拒绝，原件保持不变",async()=>{
  const root=fixtureRoot();
  try {
    const directory=join(root.path,"round");prepareRound(config("fixture-a","medium","review-defects"),directory);
    const plan=readPlan(directory),run=plan.runs[0]!;
    const source=join(root.path,"source");mkdirSync(source);writeFileSync(join(source,"keep.txt"),"原件");
    const link=join(root.path,"linked-source");symlinkSync(source,link);
    const bindingPath=join(root.path,"binding.json");
    const binding={caseId:run.caseId,inputSha256:plan.cases[0]!.inputSha256,dataRoot:link,workId:"fixture",versionId:"v001",treeSha256:"0".repeat(64),verifiedBy:"fixture",verifiedAt:new Date().toISOString(),observations:"合成核验"};
    writeFileSync(bindingPath,JSON.stringify(binding));
    await assert.rejects(executeRun(directory,run.id,bindingPath),/符号链接/);
    writeFileSync(bindingPath,JSON.stringify({...binding,dataRoot:root.path}));
    await assert.rejects(executeRun(directory,run.id,bindingPath),/不能重叠/);
    assert.equal(readFileSync(join(source,"keep.txt"),"utf8"),"原件");
    assert(!existsSync(join(directory,run.id,"execution.json")));
  } finally {root.cleanup();}
});

test("独立审查禁止读取源码和原任务反馈，保留实际帧图与采用设计的读取",async()=>{
  const {evaluationFilesystem}=await import('../scripts/model-evaluation/runtime.ts');
  const root=fixtureRoot();
  try{
    const work=join(root.path,'testing/works/work-fixture');mkdirSync(work,{recursive:true});
    const cwd=join(work,'runs/inspection-fixture');mkdirSync(cwd,{recursive:true});
    const policy=evaluationFilesystem(root.path,cwd,false,'inspect_only');
    assert.equal(policy[root.path],'read');assert.equal(policy[join(work,'versions')],'deny');assert.equal(policy[join(work,'feedback')],'deny');assert.equal(policy[join(work,'task.json')],'deny');
    assert.equal(policy[join(root.path,'testing/media')],undefined);assert.equal(policy[join(work,'documents')],undefined);
    assert(!Object.values(policy).includes('write'));
  }finally{root.cleanup();}
});
