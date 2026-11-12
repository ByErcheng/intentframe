import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {buildPlan,prepareRound,readPlan,suiteRoot} from '../scripts/model-evaluation/plan.ts';
import {evaluationFilesystem} from '../scripts/model-evaluation/runtime.ts';
import {inspectVisualPhase} from '../scripts/model-evaluation/visual-phase.ts';
import {WorkStore} from '../src/records/work-store.ts';
import type {WorkService} from '../src/runtime/work-service.ts';
import {rgbPng} from '../src/media/review-materials.ts';
import {fakeCodex,fixtureRoot,readyVersion} from './helpers.ts';

test('新强度输入限定四档和一分钟；旧八分钟配置仍原样可读',()=>{
 const names=['sol-authoring','astra-production','astra-review','sol-assets','sol-feedback','sol-learning','terra-visual'];
 const root=fixtureRoot();try{
  let total=0;
  for(const name of names){const raw=JSON.parse(readFileSync(join(suiteRoot,'config/effort-'+name+'.json'),'utf8')),p=buildPlan(raw);total+=p.runs.length;
   assert.deepEqual(p.round.variants.map(v=>v.effort),['medium','high','xhigh','max']);assert.equal(p.round.media?.durationSeconds,60);
   const dir=join(root.path,name);prepareRound(raw,dir);assert.deepEqual(readPlan(dir).round.media,{durationSeconds:60,width:1080,height:1920});
  }
  assert.equal(total,48);
  const old=buildPlan(JSON.parse(readFileSync(join(suiteRoot,'config/round-01.json'),'utf8')));assert.equal(old.round.media,undefined);assert.equal(old.runs.length,39);
 }finally{root.cleanup();}
});

test('纯视觉理解只准备材料并传实际图像，不偷跑成片审查或提供脚本数字',async()=>{
 const root=fixtureRoot();try{
  const store=new WorkStore(root.path,'test',root.path),work=store.create('截图理解','不可作为数字答案');const v=readyVersion(store,work.id,'v001','complete');work.versions.push(v);store.save(work);
  const indexPath=join(root.path,'media/visual/index.json');mkdirSync(dirname(indexPath),{recursive:true});writeFileSync(join(dirname(indexPath),'frame.png'),rgbPng(4,4,Buffer.alloc(48,90)));writeFileSync(indexPath,JSON.stringify({frames:[{path:'frame.png',seconds:12}]}));
  let only=0;
  const service={store,reviewMaterials:{prepareOnly:async()=>{only++;return{batches:[{indexLocation:indexPath}]};},prepare:async()=>{throw new Error('不得调用成片审查');}}} as unknown as WorkService;
  const result=await inspectVisualPhase(service,work.id,v.id,'只看截图，不猜数字',fakeCodex(root.path),10000,AbortSignal.timeout(15000));
  assert.equal(result.status,'completed');assert.equal(only,1);assert.equal(result.images.length,7);
  const history=JSON.parse(readFileSync(join(root.path,'native-fixture/history.json'),'utf8'));const threads=Object.values(history.threads) as {turns:{items:{type:string;content?:{type:string}[]}[]}[]}[];
  const input=threads[0]!.turns[0]!.items.find(i=>i.type==='userMessage')!.content!;
  assert.equal(input.filter(x=>x.type==='localImage').length,7);assert(!JSON.stringify(input).includes('不可作为数字答案'));
 }finally{root.cleanup();}
});

test('视觉图像理解额外拒绝设计与源码答案；反馈新案例按声明绑定基线',()=>{
 const root=fixtureRoot();try{
  const work=join(root.path,'testing/works/work-visual');mkdirSync(work,{recursive:true});const cwd=join(work,'runs/check');mkdirSync(cwd,{recursive:true});
  const p=evaluationFilesystem(root.path,cwd,false,'inspect_visuals');for(const name of ['documents','brief.md','versions','task.json','feedback','learning'])assert.equal(p[join(work,name)],'deny');
  const raw=JSON.parse(readFileSync(join(suiteRoot,'config/effort-sol-feedback.json'),'utf8'));assert(buildPlan(raw).cases[0]!.requires.includes('fixed_feedback'));
 }finally{root.cleanup();}
});

test('视觉理解收到轮次后失联保留未知和原身份，不伪装成已完成',async()=>{
 const root=fixtureRoot();try{
  const store=new WorkStore(root.path,'test',root.path),work=store.create('截图失联','合成输入');const version=readyVersion(store,work.id,'v001','complete');work.versions.push(version);store.save(work);
  const indexPath=join(root.path,'media/visual/index.json');mkdirSync(dirname(indexPath),{recursive:true});writeFileSync(join(dirname(indexPath),'frame.png'),rgbPng(4,4,Buffer.alloc(48,80)));writeFileSync(indexPath,JSON.stringify({frames:[{path:'frame.png',seconds:12}]}));
  const service={store,reviewMaterials:{prepareOnly:async()=>({batches:[{indexLocation:indexPath}]})}} as unknown as WorkService;
  await assert.rejects(inspectVisualPhase(service,work.id,version.id,'只看图',fakeCodex(root.path,'disconnect'),10000,AbortSignal.timeout(15000)));
  const current=store.read(work.id);assert.equal(current.execution.status,'unknown');assert(current.execution.runId?.startsWith('visual-'));assert.equal(current.execution.versionId,version.id);
 }finally{root.cleanup();}
});
