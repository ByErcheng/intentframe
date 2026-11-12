import type { WorkRecord, WorkStore, WorkVersion } from "../records/work-store.ts";
import type { LearningSource } from "../records/knowledge-store.ts";
import type { ExperienceSource } from "../records/contracts.ts";
import { learningLimits } from "../records/contracts.ts";
import { sourceFingerprint } from "../records/source-snapshot.ts";
import { feedbackAppliedByVersion } from "./production-selection.ts";

/** 为独立整理关联有限的案例上下文；不改变增量待办，也不把模型声明补认为修改事实。 */
export function learningCases(store: WorkStore, work: WorkRecord, sources: LearningSource[]) {
  const versions = new Map<string, WorkVersion>(), feedbackIds = new Set<string>();
  const caseSources: Record<string, ExperienceSource[]> = {};
  const cases = sources.filter(source => source.versionId).map(source => {
    const target = work.versions.find(version => version.id === source.versionId);
    if (!target) throw new Error("经验案例的来源版本不存在：" + source.versionId);
    const relatedFeedback = source.kind === "feedback" ? work.feedback.filter(item => source.id === "feedback:" + item.id) :
      work.feedback.filter(item => target.feedbackIds?.includes(item.id) || target.feedbackId === item.id);
    const ids = new Set(relatedFeedback.map(item => item.id));
    const outcomes = source.kind === "feedback" ? work.versions.filter(version => version.feedbackIds?.some(id => ids.has(id)) ||
      (version.feedbackId && ids.has(version.feedbackId)) || feedbackAppliedByVersion(version).some(id => ids.has(id))) : [];
    const related = new Set([target.id, ...(target.basedOnVersionId ? [target.basedOnVersionId] : []),
      ...relatedFeedback.map(item => item.versionId), ...outcomes.map(version => version.id)]);
    const ordered = [...related], included = ordered.length <= learningLimits.caseVersions ? ordered :
      [...ordered.slice(0, 2), ...ordered.slice(-(learningLimits.caseVersions - 2))];
    const selected = included.map(id => {
      const version = work.versions.find(item => item.id === id);
      if (!version) throw new Error("经验案例的基线版本不存在：" + id);
      versions.set(id, version); return version;
    });
    for (const item of relatedFeedback) feedbackIds.add(item.id);
    caseSources[source.id] = selected.filter(version => version.sourceSnapshot).map(version => ({ purpose: store.purpose,
      workId: work.id, versionId: version.id, sourceFingerprint: sourceFingerprint(version.sourceSnapshot!),
      feedbackIds: relatedFeedback.filter(item => item.versionId === version.id).map(item => item.id) }));
    return { sourceId: source.id, versionIds: included, feedbackIds: [...ids], omittedVersionIds: ordered.filter(id => !included.includes(id)) };
  });
  const history = {
    cases,
    feedback: work.feedback.filter(item => feedbackIds.has(item.id)),
    versions: [...versions.values()].map(version => ({ id: version.id, basedOnVersionId: version.basedOnVersionId,
      production: version.production, designRef: version.designRef, requestedFeedbackIds: version.feedbackIds ?? (version.feedbackId ? [version.feedbackId] : []),
      appliedThisVersion: feedbackAppliedByVersion(version), inheritedAndAppliedFeedbackIds: version.appliedFeedbackIds,
      result: version.agentResult ? { status: version.agentResult.status, summary: version.agentResult.summary,
        unresolvedFeedbackIds: version.agentResult.unresolvedFeedbackIds, blockers: version.agentResult.blockers } : undefined,
      review: version.review, acceptance: version.acceptance,
      internalReview: version.reviewPreparation?.inspections.at(-1)?.result,
      source: { path: store.resolvePath(version.sourcePath), fingerprint: version.sourceSnapshot ? sourceFingerprint(version.sourceSnapshot) : undefined },
      media: { path: store.resolvePath(version.mediaPath), sha256: version.videoSha256,
        materialIndexes: version.reviewPreparation?.batches.map(item => ({ ...item, location: store.resolvePath(item.path) })) ?? [] },
    })),
    limitation: "这些是本轮冻结的历史记录与材料位置；应用记录、内检、外部审查和用户认可分别理解。未实际打开媒体不能声称已看，缺少工程快照的版本不能作为已核实的工程来源。省略的版本不属于本次案例检查范围。",
  };
  return structuredClone({ history, caseSources });
}
