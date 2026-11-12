import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, readPlan, hash, inside } from "./plan.ts";

/** 先展示匿名候选及实际产物；原始执行记录保留身份供后续核对。 */
export function reportRound(directory: string, caseId?: string) {
  const root = resolve(directory), plan = readPlan(root);
  if (caseId && !plan.cases.some(c => c.id === caseId)) throw new Error("案例不属于本轮");
  const order = [...plan.round.variants].sort((a,b)=>hash(plan.round.id+a.id).localeCompare(hash(plan.round.id+b.id)));
  const label = (id: string) => "候选 " + (order.findIndex(v=>v.id===id)+1);
  const lines = ["# 模型比较结果", "", "下表的完成状态只说明执行，不代表质量通过。先查看匿名产物，再记录评价和用户选择；打开原始 result.json 会看到模型身份。", "",
    "| 案例 | 候选 | 重复轮次 | 执行状态 | 总耗时（秒） | 实际结果 |", "| --- | --- | --- | --- | --- | --- |"];
  const displayed = plan.runs.filter(r=>!caseId || r.caseId===caseId).sort((a,b) =>
    plan.round.caseIds.indexOf(a.caseId)-plan.round.caseIds.indexOf(b.caseId) || a.repetition-b.repetition ||
    order.findIndex(v=>v.id===a.variantId)-order.findIndex(v=>v.id===b.variantId));
  for (const run of displayed) {
    const path=resolve(root,run.id,"result.json"), attempted=existsSync(resolve(root,run.id,"execution.json"));
    const result=existsSync(path) ? readJson(path) as Record<string, unknown> : undefined;
    if(result && result.runId!==run.id) throw new Error("结果归属不符");
    const links: string[]=[];
    if(result) {
      const display=resolve(root,run.id,"display.json");
      if(existsSync(display)) links.push(`[文本结果](<${display}>)`);
      const versions = Array.isArray(result.versions) ? result.versions as { id: string; mediaPath?: string; sourcePath?: string; production?: string }[] : [];
      for(const version of versions) if(version.mediaPath) {
        const dataRoot=resolve(root,run.id,"work-data"), video=resolve(dataRoot,typeof result.workRootRelative==="string"?result.workRootRelative:"",version.mediaPath);
        if(!inside(dataRoot,video)) throw new Error("媒体位置超出候选数据范围");
        if(existsSync(video)) links.push(`[${version.id}${version.id===result.primaryVersionId ? " 首稿" : " 后续版本"}${version.production!=="ready" ? "（未核验）" : ""}](<${video}>)`);
      }
    }
    lines.push(`| ${run.caseId} | ${label(run.variantId)} | ${run.repetition} | ${result?.status ?? (attempted ? "unknown" : "not_started")} | ${typeof result?.elapsedMs==="number" ? (result.elapsedMs/1000).toFixed(1) : "未取得"} | ${links.join("、") || "尚无结果"} |`);
  }
  lines.push("", "总耗时包括工具与渲染；用量、配置确认和失败详情保存在各运行的 result.json/runtime.jsonl。声音未试听、画面未完整观看的范围必须单列。失败与未完成也保留，不从比较中删除。", "");
  return lines.join("\n");
}
