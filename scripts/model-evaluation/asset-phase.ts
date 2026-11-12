import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CodexAppServerClient, codexTurnSchema, executionFailureStatus } from '../../src/runtime/codex-client.ts';
import { ProviderRequestError } from '../../src/media/providers.ts';
import { ProductionMediaTools, mediaToolDefinitions } from '../../src/runtime/production-media.ts';
import { readPrompt } from '../../src/runtime/prompts.ts';
import type { WorkService } from '../../src/runtime/work-service.ts';
import type { LibraryRoot } from '../../src/config.ts';
import { writeNew } from './plan.ts';

const resultSchema=z.strictObject({status:z.enum(['completed','needs_input','failed']),summary:z.string(),selectedAssetIds:z.array(z.string()),choices:z.array(z.strictObject({requirement:z.string(),decision:z.string(),evidence:z.string()})),limitations:z.array(z.string())});
const allowed=new Set(['intentframe_media_capabilities','intentframe_search_assets','intentframe_inspect_asset','intentframe_reuse_asset','intentframe_generate_image']);

/** 仅隔离素材职责作测试，沿用制作阶段的真实工具、作品锁、付费请求与未知保护。 */
export async function prepareAssetPhase(service:WorkService,workId:string,input:string,wrapper:string,libraries:LibraryRoot[],timeoutMs:number,signal:AbortSignal){
  const store=service.store;
  return store.withLock(workId,async()=>{
    const record=store.read(workId),design=record.authoring!.designs.at(-1)!;service.documents.adopted(record,design);
    const runId='assets-'+randomUUID(),sourcePath=join('works',workId,'versions/v001/source/entry.tsx');mkdirSync(dirname(store.resolvePath(sourcePath)),{recursive:true});
    const version={id:'v001',kind:'complete' as const,production:'creating' as const,sourcePath,mediaPath:join('media',workId,'v001/video.mp4'),createdAt:new Date().toISOString(),runId,designRef:{id:design.id,sha256:design.sha256},review:{status:'not_reviewed' as const},acceptance:'pending' as const,mediaToolsVersion:1 as const};
    record.versions.push(version);record.execution={status:'running',runId,versionId:version.id};store.save(record);
    const directory=store.resolvePath(join('works',workId,'runs',runId));mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'input.json'),JSON.stringify({runId,design:service.documents.read(record,design),instruction:input},null,2),{flag:'wx'});
    const tools=new ProductionMediaTools(store,record,runId,service.assets,version,{libraries,signal});let threadId:string|undefined,turnId:string|undefined;
    let phase:'preparing'|'awaiting_result'|'checking_result'='preparing';
    const client=new CodexAppServerClient({cwd:directory,executable:wrapper,timeoutMs,turnTimeoutMs:timeoutMs,signal,onEvent:event=>store.appendEvent(workId,runId,event),onToolCall:(name,args,identity)=>{
      if(identity.threadId!==threadId||turnId&&identity.turnId!==turnId||!allowed.has(name))throw new Error('工具不属于本轮素材准备');return tools.call(name,args);
    }});
    try{
      await client.initializeConnection();const started=z.object({thread:z.object({id:z.string()}),model:z.string().optional()}).parse(await client.sendRequest('thread/start',{cwd:directory,sandbox:'read-only',approvalPolicy:'never',dynamicTools:mediaToolDefinitions().filter(t=>allowed.has(t.name)),developerInstructions:readPrompt('asset-acquisition').text+'\n本轮只准备采用设计的素材，依据input.json完成指定目标；不写视频代码、不渲染、不试听、不委派。'}));threadId=started.thread.id;
      phase='awaiting_result';
      const turn=z.object({turn:codexTurnSchema}).parse(await client.sendRequest('turn/start',{threadId,outputSchema:z.toJSONSchema(resultSchema),input:[{type:'text',text:'读取input.json，按本轮要求检索、选择并生成一张图，实际查看后返回结构化结果。'}]}));turnId=turn.turn.id;
      const completed=await client.waitForTurnCompletion(turnId,threadId);await tools.drain();if(completed.status!=='inProgress')phase='checking_result';if(completed.status!=='completed')throw new Error('素材准备未取得完成终态：'+completed.status);
      const reply=client.finalReply(turnId);writeNew(join(directory,'result.json'),{threadId,turnId,reply});const result=resultSchema.parse(JSON.parse(reply));service.assets.assertSettled(record,version);
      if(result.selectedAssetIds.some(id=>!record.assets?.some(asset=>asset.id===id)))throw new Error('声明选择了不存在的素材');
      const generated=(record.assets??[]).filter(asset=>asset.role==='image'&&asset.origin==='openai');
      const complete=result.status==='completed'&&generated.length===1&&result.selectedAssetIds.includes(generated[0]!.id);
      const current=store.read(workId);current.versions[0]!.production='blocked';current.versions[0]!.error='本轮只准备素材，未制作或渲染视频。';current.execution={status:'idle'};store.save(current);
      return{...result,status:complete?'completed':result.status==='failed'?'failed':'needs_input',assets:current.assets,note:'素材阶段完成不等于影片完成，未进行用户认可。'};
    }catch(error){const current=store.read(workId);current.execution={status:error instanceof ProviderRequestError&&error.uncertain?'unknown':executionFailureStatus(error,phase),runId,versionId:version.id,error:error instanceof Error?error.message:String(error)};store.save(current);throw error;}finally{await client.close();}
  });
}
