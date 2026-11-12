import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {WorkStore} from '../src/records/work-store.ts';
import {WorkService} from '../src/runtime/work-service.ts';
import {rgbPng} from '../src/media/review-materials.ts';
import {prepareAssetPhase} from '../scripts/model-evaluation/asset-phase.ts';
import {adoptedDesign,fakeCodex,fixtureRoot} from './helpers.ts';

for(const mode of ['generated','no-image','uncertain']as const)test('素材阶段 '+mode+' 不冒充影片完成或吞掉未知生成',async()=>{
  const root=fixtureRoot();let providerCalls=0;
  try{
    const store=new WorkStore(root.path,'test',root.path),work=store.create('合成素材阶段','按采用设计准备一个参考图');await adoptedDesign(store,work.id,'# 合成设计\n仅准备图像，不渲染视频。');
    const image=rgbPng(8,8,Buffer.alloc(8*8*3,120));
    const service=new WorkService(store,{providerSettings:{image:{apiKey:'fixture',model:'fixture-image',timeoutMs:1000}},providerFetch:async()=>{providerCalls++;if(mode==='uncertain')throw new Error('合成网络结果未知');return new Response(JSON.stringify({data:[{b64_json:image.toString('base64')}]}),{headers:{'content-type':'application/json'}});}});
    const action=prepareAssetPhase(service,work.id,'合成目标',fakeCodex(root.path,mode==='no-image'?'asset_phase_no_image':'asset_phase'),[],10000,AbortSignal.timeout(15000));
    if(mode==='uncertain'){await assert.rejects(action);assert.equal(store.read(work.id).execution.status,'unknown');}
    else{const result=await action;assert.equal(result.status,mode==='generated'?'completed':'needs_input');assert.equal(store.read(work.id).versions[0]!.production,'blocked');assert(!existsSync(store.resolvePath(store.read(work.id).versions[0]!.mediaPath)));}
    assert.equal(providerCalls,mode==='no-image'?0:1);
  }finally{root.cleanup();}
});
