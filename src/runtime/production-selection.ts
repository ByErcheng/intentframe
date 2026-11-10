import type { WorkRecord, WorkVersion } from "../records/work-store.ts";
import { WorkStore } from "../records/work-store.ts";

export type ProductionSelection = { feedbackIds?: string[]; newDirection?: boolean };

/** 累计应用记录含继承成果；本轮应用还须与通过回执及工程校验的模型声明对应。 */
export function feedbackAppliedByVersion(version: WorkVersion): string[] {
  return (version.agentResult?.appliedFeedbackIds ?? []).filter(id => version.appliedFeedbackIds?.includes(id));
}

export function lineage(store: WorkStore, record: WorkRecord, base?: WorkVersion): WorkVersion[] {
  const result: WorkVersion[] = [], visited = new Set<string>();
  let current = base;
  while (current) {
    if (visited.has(current.id)) throw new Error("版本基线关系存在循环。请核对原记录，不能继续制作。");
    visited.add(current.id); result.push(current);
    current = current.basedOnVersionId ? store.version(record, current.basedOnVersionId) : undefined;
  }
  return result;
}

export function appliedFeedback(store: WorkStore, record: WorkRecord, base?: WorkVersion): string[] {
  const result = new Set<string>();
  for (const version of lineage(store, record, base)) {
    for (const id of version.appliedFeedbackIds ?? []) result.add(id);
    if (!version.agentResult && version.sourceSha256 && version.feedbackId) result.add(version.feedbackId);
  }
  return [...result];
}

/** 已确认样例自身是可信起点；后续每一步都须明确保留该方向，不能跨过未知旧版本。 */
function continuesApprovedDirection(store: WorkStore, record: WorkRecord, base: WorkVersion | undefined, approved: WorkVersion): boolean {
  const chain = lineage(store, record, base), index = chain.findIndex(v => v.id === approved.id);
  return index >= 0 && chain.slice(0, index).every(v =>
    !v.newDirection && v.directionId === (approved.directionId ?? approved.id));
}

/** 在受理与实际执行前复用同一选择规则；明确空集合与省略参数含义不同。 */
export function selectProduction(store: WorkStore, record: WorkRecord, kind: "sample" | "complete",
  feedbackId?: string, threadMode: "fresh" | "resume" = "fresh", baseVersionId?: string, baseReason?: string,
  selection: ProductionSelection = {}) {
  if (["running", "unknown"].includes(record.execution.status)) throw new Error("已有执行尚未取得明确结果，不能重复发起。请查询原执行并核对恢复。");
  if (feedbackId !== undefined && selection.feedbackIds !== undefined) throw new Error("feedbackId 与 feedbackIds 不能同时提供。请选择单条编号或明确编号数组。");
  const latest = record.versions.filter(v => v.sourceSnapshot || (v.production === "ready" && v.sourceSha256)).at(-1);
  // 首个工程可以作为自己的起点；其他缺值无法证明是沿用、改向还是另建备选。
  const unknownDirections = record.versions.some((v, index) => !v.directionId && (index > 0 || Boolean(v.basedOnVersionId)));
  let previous = baseVersionId ? store.version(record, baseVersionId) : latest;
  if (!baseVersionId && record.directionApproval && !selection.newDirection) {
    const approved = store.version(record, record.directionApproval.sampleVersionId);
    if (record.versions.slice(record.versions.indexOf(approved) + 1).some(v => !v.directionId)) {
      throw new Error("历史版本缺少方向范围，不能自动确定基线。请查询 get_work 后明确提供 baseVersionId、baseReason 和 feedbackIds。");
    }
    const direction = approved.directionId ?? approved.id;
    previous = record.versions.filter(v => (v.id === approved.id || v.directionId === direction) &&
      (v.sourceSnapshot || (v.production === "ready" && v.sourceSha256))).at(-1);
  } else if (!baseVersionId) {
    if (unknownDirections) throw new Error("历史版本缺少方向范围，不能自动确定基线。请查询 get_work 后明确提供 baseVersionId、baseReason 和 feedbackIds。");
    if (new Set(record.versions.map(v => v.directionId ?? v.id)).size > 1) {
      throw new Error("存在多个方向且没有明确的本轮基线。请提供 baseVersionId 和准确的 feedbackIds。");
    }
  }
  if (baseVersionId && baseVersionId !== latest?.id && !baseReason?.trim()) throw new Error("选择历史基线须提供 baseReason，说明如何处理后续修改。");
  if (previous) store.verifySource(previous);
  if (kind === "complete") {
    if (!record.directionApproval) throw new Error("尚无用户对样例方向的明确确认，不能展开完整制作。请先取得并记录方向确认。");
    const approved = store.version(record, record.directionApproval.sampleVersionId);
    if (selection.newDirection || !continuesApprovedDirection(store, record, previous, approved)) {
      throw new Error("完整制作的基线须延续已确认方向的样例；其他方向须先更新样例并取得确认。");
    }
  }
  if (threadMode === "resume" && !previous?.threadId) throw new Error("没有可恢复的原生线程。请核对基线；新会话接续使用 threadMode=fresh。");
  const inherited = appliedFeedback(store, record, previous);
  const superseded = new Set(record.feedback.flatMap(f => f.supersedes ?? []));
  let requested = selection.feedbackIds ?? (feedbackId !== undefined ? [feedbackId] : undefined);
  if (requested !== undefined) {
    if (new Set(requested).size !== requested.length) throw new Error("feedbackIds 不能包含重复编号。");
    for (const id of requested) if (!id.trim() || !record.feedback.some(f => f.id === id)) throw new Error("反馈标识不存在或为空。请查询 get_work 后填写该作品的真实反馈编号。");
    if (requested.some(id => superseded.has(id))) throw new Error("选定反馈已被后续意见替代。请查询 supersededByFeedbackIds 并选择当前有效意见；恢复旧要求应另行保存新反馈。");
  } else {
    // 创建备选是一次性动作；回到旧基线不会重新执行已经完成的备选创建要求。
    const alternativesDone = new Set(record.versions.filter(v => v.newDirection)
      .flatMap(feedbackAppliedByVersion));
    const direction = previous?.directionId ?? previous?.id;
    const bases = new Set(lineage(store, record, previous)
      .filter(v => v.id === previous?.id || v.id === direction || v.directionId === direction).map(v => v.id));
    requested = record.feedback.filter(f => {
      if (inherited.includes(f.id) || alternativesDone.has(f.id) || superseded.has(f.id)) return false;
      const target = store.version(record, f.versionId);
      if (target.directionId && direction && target.directionId !== direction) return false;
      if (unknownDirections) throw new Error("反馈的历史方向范围无法自动核对，可能包含已完成的备选要求。请明确提供 feedbackIds；不处理反馈使用空数组 []。");
      if (bases.has(target.id) || (direction && target.directionId === direction)) return true;
      throw new Error("反馈的历史方向范围无法自动核对。请明确提供 feedbackIds；不处理反馈使用空数组 []。");
    }).map(f => f.id);
  }
  return { previous, inherited, requested, newDirection: selection.newDirection ?? false,
    baseReason: baseReason ?? (previous && previous.id !== latest?.id ? "沿用户已确认方向选择工程，其他方向保留。" : undefined) };
}
