import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { configuration } from "../../src/config.ts";
import { WorkStore } from "../../src/records/work-store.ts";
import { WorkService } from "../../src/runtime/work-service.ts";
import { readJson, readPlan, writeNew, repoRoot, hash } from "./plan.ts";

const budgetsSchema=z.strictObject({probeTimeoutMs:z.number().int().positive().max(2_147_483_647),decodeTimeoutMs:z.number().int().positive().max(2_147_483_647),previewTimeoutMs:z.number().int().positive().max(2_147_483_647)});
/** 只接续已知媒体检查失败且原成片可核验的执行；未知结果不重发，原结果/证据不覆盖。 */
export async function continueMedia(roundDirectory:string,runId:string,budgetInput:unknown,attemptId?:string){
  const plan=readPlan(roundDirectory),run=plan.runs.find(r=>r.id===runId);if(!run)throw new Error("运行编号不属于本轮");
  const variant=plan.round.variants.find(v=>v.id===run.variantId)!;const directory=resolve(roundDirectory,run.id);
  const original=z.object({runId:z.string(),status:z.literal("failed"),error:z.string(),elapsedMs:z.number(),workId:z.string(),workRootRelative:z.string().optional(),versions:z.array(z.object({id:z.string(),production:z.string()}))}).parse(readJson(resolve(directory,"result.json")));
  if(original.runId!==run.id||!/(媒体检查|补帧数量超过|审查抽帧)/.test(original.error))throw new Error("不是已知媒体处理失败，不能按本入口接续");
  if(attemptId&&!/^[a-z0-9-]{1,40}$/.test(attemptId))throw new Error("接续编号无效");
  const prefix=attemptId?"continuation-"+attemptId:"continuation";
  if(existsSync(resolve(directory,prefix+"-start.json")))throw new Error("已有该接续尝试，先核对原结果，不能重发");
  let previousElapsedMs=0;
  for(const name of readdirSync(directory).filter(n=>n.startsWith("continuation")&&n.endsWith("-start.json"))){
    const path=resolve(directory,name.replace(/-start\.json$/,"-result.json"));
    if(!existsSync(path))throw new Error("仍有未核清的接续尝试，不能发起新轮次");
    const prior=z.object({runId:z.string(),status:z.string(),elapsedMs:z.number().nonnegative()}).parse(readJson(path));
    if(prior.runId!==runId||prior.status!=="failed")throw new Error("旧接续不是明确失败，须先核对或处理原状态");
    previousElapsedMs+=prior.elapsedMs;
  }
  const budgets=budgetsSchema.parse(budgetInput);Object.assign(configuration.media,budgets);
  const dataRoot=resolve(directory,"work-data"),store=new WorkStore(resolve(dataRoot,original.workRootRelative??""),"test",dataRoot);const record=store.read(original.workId);
  if(record.execution.status!=="failed"||!/(媒体检查|补帧数量超过|审查抽帧)/.test(record.execution.error??""))throw new Error("原执行不是明确媒体失败，禁止接续");
  const version=record.versions.at(-1);if(!version||version.production!=="ready")throw new Error("原成片没有可靠就绪状态");store.assertAvailable(version);
  const oldEvidence=readdirSync(directory).filter(n=>n==="runtime.jsonl"||n.startsWith("continuation")&&n.endsWith("runtime.jsonl")).flatMap(name=>readFileSync(resolve(directory,name),"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)));
  const used=oldEvidence.filter(e=>e.kind==="generation_attempt").length;const remainder=plan.round.limits.generationCalls-used;if(remainder<0)throw new Error("原调用已超过生成预算");
  const operationRemaining=plan.round.limits.operationMs-original.elapsedMs-previousElapsedMs;if(operationRemaining<=0)throw new Error("原执行预算已用完，未发起新调用");
  const evidencePath=resolve(directory,prefix+"-runtime.jsonl"),wrapper=resolve(directory,prefix+"-codex.mjs");
  const settings={executable:configuration.codex,variant,readableRoot:dataRoot,evidencePath,generationLimit:remainder,operation:"produce_version"};
  writeFileSync(wrapper,"#!"+configuration.node+"\nimport{startRuntime}from "+JSON.stringify(pathToFileURL(resolve(repoRoot,"scripts/model-evaluation/runtime.ts")).href)+";\nawait startRuntime("+JSON.stringify(settings)+");\n",{flag:"wx",mode:0o700});
  const start=Date.now();writeNew(resolve(directory,prefix+"-start.json"),{runId,attemptId:attemptId??"initial",startedAt:new Date(start).toISOString(),variant,budgets,generationBudgetRemaining:remainder,operationRemaining,originalResultSha256:hash(readFileSync(resolve(directory,"result.json"))),reason:record.execution.error,helperSha256:hash(readFileSync(new URL(import.meta.url)))});
  const providers=Object.fromEntries(plan.round.providerKinds.map(k=>[k,configuration.providers[k]]));const selection=plan.round.assetLibraries;const libraries=selection==="configured"?configuration.assetLibraries:configuration.assetLibraries.filter(l=>selection.includes(l.id));
  const service=new WorkService(store,{codexExecutable:wrapper,timeoutMs:plan.round.limits.modelTurnMs,providerSettings:providers,assetLibraries:libraries,signal:AbortSignal.timeout(operationRemaining),
    models:{default:{model:variant.model,effort:variant.effort},stages:{}}});
  let output:unknown,error:string|undefined;
  try{output=await service.prepareMaterials(record.id,version.id,[],"media-continuation-"+runId,"inspect_and_repair");}catch(cause){error=cause instanceof Error?cause.message:String(cause);}
  const current=store.read(record.id),state=current.execution.status;const status=state==="idle"?"completed":state==="waiting_input"?"blocked":state==="running"?"unknown":state;
  const result={runId,status,error,output,elapsedMs:Date.now()-start,versions:current.versions.map(v=>({id:v.id,production:v.production,mediaPath:v.mediaPath,sourcePath:v.sourcePath,technicalCheck:v.technicalCheck})),note:"技术接续，不覆盖首稿或原失败；模型与推理强度来自原输入，不在接续中改变。"};
  writeNew(resolve(directory,prefix+"-result.json"),result);return result;
}
