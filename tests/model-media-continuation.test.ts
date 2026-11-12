import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fixtureRoot} from './helpers.ts';
import {prepareRound,readPlan} from '../scripts/model-evaluation/plan.ts';
import {continueMedia} from '../scripts/model-evaluation/continue-media.ts';
import {WorkStore} from '../src/records/work-store.ts';
import {configuration} from '../src/config.ts';

for(const kind of ['unknown-result','non-media-failure','unknown-work'] as const)test('媒体接续拒绝 '+kind+'，不创建新模型尝试',async()=>{
  const root=fixtureRoot(),originalMedia={...configuration.media};
  try{
    const directory=join(root.path,'round');prepareRound({id:'guard',variants:[{id:'fixture',model:'fixture-a',effort:'medium'}],caseIds:['produce-commute'],repetitions:1,limits:{modelTurnMs:1000,operationMs:10000,generationCalls:0},providerKinds:[],assetLibraries:[],repeatRule:'合成',choicePolicy:'合成'},directory);
    const run=readPlan(directory).runs[0]!,candidate=join(directory,run.id),assetRoot=join(candidate,'work-data');
    const store=new WorkStore(join(assetRoot,'testing'),'test',assetRoot),work=store.create('guard','合成测试','guard-work');
    if(kind==='unknown-work'){work.execution={status:'unknown',runId:'fixture-running'};store.save(work);}
    writeFileSync(join(candidate,'result.json'),JSON.stringify({runId:run.id,status:kind==='unknown-result'?'unknown':'failed',error:kind==='non-media-failure'?'设计待确认':'媒体检查达到已配置的等待上限。',elapsedMs:100,workId:work.id,workRootRelative:'testing',versions:[]}));
    await assert.rejects(continueMedia(directory,run.id,{probeTimeoutMs:1000,decodeTimeoutMs:1000,previewTimeoutMs:1000}));
    assert(!existsSync(join(candidate,'continuation-start.json')));assert(!existsSync(join(candidate,'continuation-codex.mjs')));
  }finally{Object.assign(configuration.media,originalMedia);root.cleanup();}
});
