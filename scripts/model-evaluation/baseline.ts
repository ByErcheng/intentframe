import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { WorkStore } from "../../src/records/work-store.ts";
import type { WorkRecord, WorkVersion } from "../../src/records/work-store.ts";
import { WorkService } from "../../src/runtime/work-service.ts";
import { captureSourceSnapshot, fileHash } from "../../src/records/source-snapshot.ts";
import { inside, writeNew } from "./plan.ts";

/** 导出新的测试基线，不改原件；不复制原模型审查、反馈、对话或完成声明。 */
export async function exportBaseline(sourceRoot: string, workId: string, versionId: string, destination: string) {
  // 旧的试跑采用平铺目录；仅允许导出其已验证产物，新基线统一使用标准 testing 布局。
  const originalRoot=existsSync(resolve(sourceRoot,"testing","works"))?resolve(sourceRoot,"testing"):sourceRoot;
  const original = new WorkStore(originalRoot,"test",sourceRoot), source = original.read(workId), version = original.version(source,versionId);
  original.assertAvailable(version);
  const target=resolve(destination), origin=realpathSync(sourceRoot);
  if(inside(origin,target)||inside(target,origin)||existsSync(target))throw new Error("基线输出须为不与原件重叠的新目录");
  if(!version.designRef)throw new Error("原版本缺少采用设计");
  const design=source.authoring?.designs.find(d=>d.id===version.designRef!.id&&d.sha256===version.designRef!.sha256);
  const draft=source.authoring?.drafts.find(d=>d.id===design?.draft?.id);
  if(!design||!draft)throw new Error("原版本缺少可核对的草稿或设计");
  mkdirSync(target,{recursive:true,mode:0o700});
  const store=new WorkStore(resolve(target,"testing"),"test",target),scope=store.scope(true)!;
  mkdirSync(store.workDirectory(workId),{recursive:true});
  for(const document of [draft,design]){mkdirSync(dirname(store.resolvePath(document.path)),{recursive:true});cpSync(original.resolvePath(document.path),store.resolvePath(document.path));}
  writeFileSync(store.resolvePath(source.briefPath),"# 共同测试基线\n\n"+readFileSync(original.resolvePath(draft.path),"utf8"),{flag:"wx"});
  const sourceDir=dirname(original.resolvePath(version.sourcePath)), targetDir=dirname(store.resolvePath(version.sourcePath));
  cpSync(sourceDir,targetDir,{recursive:true,dereference:false});
  // .md 是非执行说明，可能携带内检历史；只从派生副本移除，保留原始记录供评价方核对。
  const stripped:string[]=[];
  function strip(directory:string,prefix="") {for(const name of readdirSync(directory,{withFileTypes:true})){const path=resolve(directory,name.name);if(name.isDirectory())strip(path,prefix+name.name+"/");else if(extname(name.name)===".md"){stripped.push(prefix+name.name);rmSync(path);}}}
  strip(targetDir);
  const mediaSource=dirname(original.resolvePath(version.mediaPath)),mediaTarget=dirname(store.resolvePath(version.mediaPath));
  cpSync(mediaSource,mediaTarget,{recursive:true,dereference:false});
  // 帧图重新从确切视频生成，避免沿用带有准备阶段判断或补帧理由的旧索引。
  const oldReview=resolve(mediaTarget,"review");if(existsSync(oldReview))rmSync(oldReview,{recursive:true});
  const assetIds=new Set([...(version.assets??[]).map(a=>a.id),...draft.assetIds,...design.assetIds]);
  const assets=(source.assets??[]).filter(a=>assetIds.has(a.id));
  for(const asset of assets){const relative=dirname(asset.path);mkdirSync(dirname(store.resolvePath(relative)),{recursive:true});cpSync(original.resolvePath(relative),store.resolvePath(relative),{recursive:true,dereference:false});}
  const baseline:WorkVersion={id:version.id,kind:"complete",production:"ready",sourcePath:version.sourcePath,mediaPath:version.mediaPath,
    createdAt:new Date().toISOString(),runId:"baseline-export",designRef:version.designRef,assets:version.assets,
    sourceSnapshot:captureSourceSnapshot(store.resolvePath(version.sourcePath)),sourceSha256:fileHash(store.resolvePath(version.sourcePath)),videoSha256:version.videoSha256,
    technicalCheck:{...version.technicalCheck,previews:[]},review:{status:"not_reviewed"},acceptance:"pending",mediaToolsVersion:version.mediaToolsVersion,audioPlan:version.audioPlan};
  const record:WorkRecord={schemaVersion:1,id:source.id,title:source.title+"共同基线",briefPath:source.briefPath,createdAt:new Date().toISOString(),purpose:"test",scopeId:scope.id,
    creationOperationId:"baseline-export",execution:{status:"idle"},directionApproval:null,feedback:[],assets,versions:[baseline],
    authoring:{drafts:[draft],designs:[design],runs:[],handoffs:[{operationId:"baseline-handoff",draft:{id:draft.id,sha256:draft.sha256},userInstruction:"合成测试基线：固定已有输入，不代表真实用户交接。",createdAt:new Date().toISOString()}],
      decisions:[{operationId:"baseline-adopt",design:version.designRef,status:"adopted",source:"external_ai",notes:"导出测试指定的确切设计；原始准备记录不作为参赛模型的审查答案。",createdAt:new Date().toISOString(),feedbackAcknowledgedIds:[]}]}};
  store.save(record);store.assertAvailable(baseline);
  const provenance={sourceRoot:origin,workId,versionId,originalVideoSha256:version.videoSha256,originalSourceSnapshot:version.sourceSnapshot,
    exportedSourceSnapshot:baseline.sourceSnapshot,strippedNonExecutable:stripped,createdAt:new Date().toISOString(),note:"只导出派生测试基线，不修改原作品；独立核验另存。"};
  writeNew(target+"-origin.json",provenance);
  return {dataRoot:target,workId,versionId,videoSha256:baseline.videoSha256};
}

/** 修改派生工程后重新渲染，先撤销副本的旧媒体身份；原基线保持不变。 */
export async function renderDerived(root:string,workId:string,versionId:string){
  const store=new WorkStore(resolve(root,"testing"),"test",root),record=store.read(workId),version=store.version(record,versionId);
  if(["running","unknown"].includes(record.execution.status))throw new Error("原执行未核清");
  version.sourceSnapshot=captureSourceSnapshot(store.resolvePath(version.sourcePath));version.sourceSha256=fileHash(store.resolvePath(version.sourcePath));
  version.videoSha256=undefined;version.technicalCheck=undefined;version.reviewPreparation=undefined;version.production="source_ready";version.review={status:"not_reviewed"};
  const directory=dirname(store.resolvePath(version.mediaPath));rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{recursive:true});store.save(record);
  return new WorkService(store).renderExisting(workId,versionId);
}
