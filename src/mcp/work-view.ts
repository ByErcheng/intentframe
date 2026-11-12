import type { WorkRecord } from "../records/work-store.ts";
import { activeExecution, ExecutionStore } from "../records/execution-store.ts";
import type { WorkService } from "../runtime/work-service.ts";
import { appliedFeedback, feedbackAppliedByVersion } from "../runtime/production-selection.ts";
import { configuration } from "../config.ts";
import { currentLibraryUsage } from "../records/asset-library.ts";
import type { Asset } from "../records/media-contracts.ts";

function assetUsage(asset: Asset) {
  return { id: asset.id, role: asset.role, origin: asset.origin, usage: asset.usage,
    currentLibraryUsage: currentLibraryUsage(asset.origin, configuration.assetLibraries, asset.usage) };
}

export const workSections = ["versions", "feedback", "assets", "drafts", "designs", "handoffs", "decisions", "runs", "analysisRuns", "confirmations", "learningBatches"] as const;
export type WorkSection = typeof workSections[number];

export function currentExecution(service: WorkService, workId: string) {
  const active = activeExecution(service.store.dataRoot, workId);
  if (active) {
    const request = new ExecutionStore(service.store.assetRoot).read(active.operationId);
    if (request.workId !== workId || request.purpose !== service.store.purpose) throw new Error("后台占用与任务归属不一致。");
  }
  return active;
}

function collection(work: WorkRecord, section: WorkSection): unknown[] {
  switch (section) {
    case "drafts": case "designs": case "handoffs": case "decisions": case "runs": return work.authoring?.[section] ?? [];
    default: return work[section] ?? [];
  }
}

export function feedbackView(work: WorkRecord, feedback: WorkRecord["feedback"]) {
  return feedback.map(item => ({ ...item,
    supersededByFeedbackIds: work.feedback.filter(next => next.supersedes?.includes(item.id)).map(next => next.id),
    appliedInVersionIds: work.versions.filter(version => feedbackAppliedByVersion(version).includes(item.id)).map(version => version.id) }));
}

export function workSection(service: WorkService, workId: string, section: WorkSection, offset: number, limit: number) {
  const work = service.store.read(workId), active = currentExecution(service, workId);
  const items = collection(work, section), end = offset + limit;
  const selected = section === "versions" ? service.store.summary({ ...work, versions: work.versions.slice(offset, end) }).versions :
    section === "feedback" ? feedbackView(work, work.feedback.slice(offset, end)) :
    section === "assets" ? (work.assets ?? []).slice(offset, end).map(asset => ({ ...asset, ...assetUsage(asset) })) : items.slice(offset, end);
  return { id: workId, purpose: work.purpose, storagePurpose: service.store.purpose, view: "section", section,
    items: selected, total: items.length, offset, limit, nextOffset: end < items.length ? end : null,
    coverage: offset === 0 && end >= items.length ? "complete" : "partial", activeExecutionId: active?.operationId };
}

/** 默认只提供当前决定所需的状态；历史正文通过明确类别取得。 */
export function workSummary(service: WorkService, workId: string) {
  const work = service.store.read(workId), active = currentExecution(service, workId), latest = work.versions.at(-1);
  const delivery = service.store.delivery(work);
  const inspection = latest?.reviewPreparation?.inspections.at(-1);
  const superseded = new Set(work.feedback.flatMap(item => item.supersedes ?? []));
  const inherited = new Set(appliedFeedback(service.store, work, latest));
  const pendingCount = work.feedback.filter(item => !superseded.has(item.id) && !inherited.has(item.id)).length;
  const draft = work.authoring?.drafts.at(-1), design = work.authoring?.designs.at(-1);
  const draftReview = draft && service.documents.latestDraftReview(work, draft);
  const handedOff = draft && work.authoring?.handoffs.at(-1)?.draft.sha256 === draft.sha256;
  const designMatchesDraft = design?.draft?.sha256 === draft?.sha256;
  const decision = design && work.authoring?.decisions.filter(item => item.design.id === design.id && item.design.sha256 === design.sha256).at(-1);
  const ref = (item: { id: string; sha256: string } | undefined) => item && ({ id: item.id, sha256: item.sha256 });
  const nextActions: { tool: string; arguments: Record<string, unknown>; reason: string }[] = [];
  if (active) nextActions.push({ tool: "get_execution", arguments: { executionId: active.operationId }, reason: "先核对原执行；终态与进程收尾分别查询。" });
  else if (["unknown", "running", "failed"].includes(work.execution.status)) nextActions.push({ tool: "prepare_operation",
    arguments: { name: "recover_work", arguments: { workId, mode: "reconcile_only" } }, reason: "先核对并补存原结果，是否继续执行另行决定。" });
  else if (draft?.reviewRequired && handedOff && draftReview?.draftReview?.status !== "passed") {
    if (!draftReview) nextActions.push({ tool: "prepare_operation", arguments: { name: "review_draft", arguments: { workId, base: ref(draft) } }, reason: "先检查已交接的草稿与适用经验，通过后再设计。" });
    else nextActions.push({ tool: "get_work", arguments: { workId, section: "runs" }, reason: "读取草稿检查问题；外部纠错或用户澄清后提交新版并复查，不原样重复审稿。" });
  }
  else if (draft?.reviewRequired && handedOff && !designMatchesDraft) nextActions.push({ tool: "prepare_operation",
    arguments: { name: "design_video", arguments: { workId, base: ref(draft) } }, reason: "草稿检查通过；补充设计指令后按已有授权继续。" });
  else if (design && decision?.status !== "adopted") nextActions.push({ tool: "read_document", arguments: { workId, ref: ref(design) }, reason: "读取确切设计后记录采用或修改结论。" });
  else if (work.authoring && !design && draft) nextActions.push({ tool: "read_document", arguments: { workId, ref: ref(draft) }, reason: "核对草稿与交接记录；用户明确交接后才能设计。" });
  else if (delivery.status === "ready_for_external_review" || delivery.status === "legacy_unchecked") nextActions.push({ tool: "get_review_materials",
    arguments: { workId, versionId: delivery.versionId }, reason: "查询材料并独立审查；若要修改则准备制作请求预检。" });
  else nextActions.push({ tool: "prepare_operation", arguments: { name: "produce_version", arguments: { workId, ...(design ? { designRef: ref(design) } : {}) } }, reason: "补充本轮 kind 与修改范围后预检；此处不是完整可提交请求。" });
  return { id: work.id, title: work.title, purpose: work.purpose, storagePurpose: service.store.purpose, view: "summary", coverage: "summary",
    execution: work.execution, activeExecutionId: active?.operationId,
    latestVersion: latest && { id: latest.id, kind: latest.kind, production: latest.production, operationId: latest.operationId,
      modelSelection: latest.modelSelection, model: latest.model, reasoningEffort: latest.reasoningEffort,
      basedOnVersionId: latest.basedOnVersionId, directionId: latest.directionId, designRef: latest.designRef,
      review: latest.review,
      internalReview: latest.reviewPreparation && { materialsStatus: latest.reviewPreparation.status, status: inspection?.status,
        quality: inspection?.result?.quality, notes: inspection?.result?.notes,
        limitations: inspection?.result?.limitations, sound: inspection?.result?.sound },
      technicalCheck: latest.technicalCheck && { decoded: latest.technicalCheck.decoded, frameCount: latest.technicalCheck.frameCount,
        frameTiming: latest.technicalCheck.frameTiming, checkedAt: latest.technicalCheck.checkedAt },
      checkScopeNote: "技术解码及时间戳、帧图和时序审查、实际播放观看分别按记录解释；review.coverage 缺省为未记录，passed 不代表完整播放或听音通过。",
      acceptance: latest.acceptance },
    assetUsage: latest?.assets?.map(assetUsage) ?? [],
    delivery, directionApproval: work.directionApproval && { sampleVersionId: work.directionApproval.sampleVersionId },
    authoring: work.authoring && { latestDraft: ref(draft), latestDesign: ref(design), designStatus: decision?.status ?? "not_adopted",
      draftLocation: draft && service.store.resolvePath(draft.path), draftSubmission: draft?.submission,
      draftReview: draftReview && { runId: draftReview.id, status: draftReview.status, result: draftReview.draftReview } },
    counts: Object.fromEntries(workSections.map(section => [section, collection(work, section).length])),
    pendingFeedback: { count: pendingCount, scope: "not_in_latest_lineage", note: "包括其他方向；本轮实际适用范围由制作预检确定。历史未展开不表示没有反馈。" },
    blockers: [...new Set([work.execution.error, delivery.reason].filter((item): item is string => Boolean(item)))], nextActions,
    details: { tool: "get_work", arguments: { workId }, sections: workSections, note: "传 section 独立分页；view:detail 保留原混合详情格式。" },
    taskPath: service.store.resolvePath("works/" + workId + "/task.json"), briefLocation: service.store.resolvePath(work.briefPath) };
}
