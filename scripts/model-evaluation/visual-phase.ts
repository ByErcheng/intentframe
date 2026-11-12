import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CodexAppServerClient,codexTurnSchema,executionFailureStatus} from '../../src/runtime/codex-client.ts';
import type {WorkService} from '../../src/runtime/work-service.ts';
import {hash,writeNew} from './plan.ts';

const schema=z.strictObject({status:z.enum(['completed','insufficient_evidence']),summary:z.string(),observations:z.array(z.strictObject({image:z.string(),observation:z.string(),evidence:z.string()})),limitations:z.array(z.string())});

/** 只测图像理解；不给设计正文或答案，不触发成片质量通过、制作或修改。 */
export async function inspectVisualPhase(service:WorkService,workId:string,versionId:string,instruction:string,wrapper:string,timeoutMs:number,signal:AbortSignal){
 const store=service.store;
 return store.withLock(workId,async()=>{
  const work=store.read(workId),version=store.version(work,versionId);
  const materials=await service.reviewMaterials.prepareOnly(work,version,[]);
  const runId='visual-'+randomUUID(),directory=store.resolvePath(join('works',workId,'runs',runId));mkdirSync(directory,{recursive:true});
  // 使用确切成片的原始抽帧；同一视频/准备规则下所有强度得到相同图像，不让模型选不同截图。
  const batch=materials.batches[0];if(!batch)throw new Error('视觉材料缺失');
  const indexPath=batch.indexLocation,index=JSON.parse(readFileSync(indexPath,'utf8')) as {frames:{path:string;seconds:number}[]};
  const times=[4,12,20,30,40,48,56],images=times.map(time=>{
   const frame=index.frames.toSorted((a,b)=>Math.abs(a.seconds-time)-Math.abs(b.seconds-time))[0];
   if(!frame)throw new Error('视觉材料没有帧图');
   const path=resolve(dirname(indexPath),frame.path);return {path,seconds:frame.seconds,sha256:hash(readFileSync(path))};
  });
  writeNew(join(directory,'input.json'),{instruction,images,note:'只依据实际图像作答，文字不提供图中数据答案；无需读设计、源码或原任务。'});
  work.execution={status:'running',runId,versionId};store.save(work);
  let phase:'preparing'|'awaiting_result'|'checking_result'='preparing';
  const client=new CodexAppServerClient({cwd:directory,executable:wrapper,timeoutMs,turnTimeoutMs:timeoutMs,signal,onEvent:event=>store.appendEvent(workId,runId,event)});
  try{
   await client.initializeConnection();
   const started=z.object({thread:z.object({id:z.string()})}).parse(await client.sendRequest('thread/start',{cwd:directory,sandbox:'read-only',approvalPolicy:'never',developerInstructions:'本轮只检查图表和截图理解。读取input.json并查看给定图像，分别描述可见事实、推断和看不清的内容。不委派、不生成、不修改文件，不读取脚本或源码答案。'}));
   writeNew(join(directory,'identity.json'),{threadId:started.thread.id});phase='awaiting_result';
   const turn=z.object({turn:codexTurnSchema}).parse(await client.sendRequest('turn/start',{threadId:started.thread.id,outputSchema:z.toJSONSchema(schema),input:[{type:'text',text:instruction+'\n图像按成片时间顺序提供：'+images.map((im,i)=>`${i+1}号图 ${im.seconds}秒`).join('；')},...images.map(im=>({type:'localImage',path:im.path}))]}));
   writeNew(join(directory,'turn.json'),{threadId:started.thread.id,turnId:turn.turn.id});
   const completed=await client.waitForTurnCompletion(turn.turn.id,started.thread.id);if(completed.status!=='inProgress')phase='checking_result';if(completed.status!=='completed')throw new Error('视觉理解未取得完成终态：'+completed.status);
   const reply=client.finalReply(turn.turn.id);writeNew(join(directory,'result.json'),{threadId:started.thread.id,turnId:turn.turn.id,reply});
   const parsed=schema.parse(JSON.parse(reply));const current=store.read(workId);current.execution={status:'idle'};store.save(current);
   return {...parsed,images,receipt:join(directory,'result.json'),note:'视觉理解结果不表示成片独立审查通过或用户认可。'};
  }catch(error){const current=store.read(workId);current.execution={status:executionFailureStatus(error,phase),runId,versionId,error:error instanceof Error?error.message:String(error)};store.save(current);throw error;}finally{await client.close();}
 });
}
