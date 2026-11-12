import { describeError } from "../common/errors.ts";
import { ExecutionStore } from "../records/execution-store.ts";
import { selectProduction, productionPreflightHash, type ProductionRequest } from "../runtime/production-selection.ts";
import type { WorkService } from "../runtime/work-service.ts";
import { currentExecution } from "./work-view.ts";

/** 无业务写入；复用正式受理的选择规则，返回可直接提交且绑定本轮状态的参数。 */
export function prepareProduction(service: WorkService, args: ProductionRequest & { workId: string; operationId: string }) {
  try {
    const record = service.store.read(args.workId), active = currentExecution(service, args.workId);
    if (active) {
      const executions = new ExecutionStore(service.store.assetRoot), original = executions.read(active.operationId), outcome = executions.outcome(original);
      if (!outcome || outcome.status === "unknown") throw new Error("已有后台执行 " + active.operationId + "，须用 get_execution 核清原结果。");
    }
    if (service.store.lockOwner(args.workId)) throw new Error("作品仍有写入占用，请先核对原执行或恢复，不能另行制作。");
    service.assertCanProduce(record, args.kind);
    // 新准备重新读取事实，不继承上一次准备的摘要。
    const { preflightHash: _oldHash, ...request } = args;
    const chosen = selectProduction(service.store, record, args.kind, args.feedbackId, args.threadMode, args.baseVersionId, args.baseReason, request);
    const design = service.documents.adopted(record, args.designRef);
    const assetIds = [...new Set([...(design?.document.assetIds ?? []), ...(chosen.previous?.assets?.map(asset => asset.id) ?? []), ...(args.assetIds ?? [])])];
    service.assets.assets.select(record, assetIds);
    const { feedbackId: _single, ...base } = request;
    const resolved = { ...base, feedbackIds: chosen.requested, baseVersionId: chosen.previous?.id,
      baseReason: chosen.baseReason, newDirection: chosen.newDirection, assetIds };
    const selected = new Set(chosen.requested), inherited = new Set(chosen.inherited);
    const superseded = new Set(record.feedback.flatMap(item => item.supersedes ?? []));
    const excluded = record.feedback.filter(item => !selected.has(item.id)).map(item => ({ id: item.id, versionId: item.versionId,
      reason: superseded.has(item.id) ? "已被后续意见替代" : inherited.has(item.id) ? "已由基线继承" : "未选入本轮，保留原记录" }));
    return { arguments: { ...resolved, preflightHash: productionPreflightHash(record, resolved) },
      preflight: { status: "ready", workId: record.id, purpose: record.purpose, baseVersionId: chosen.previous?.id ?? null,
        designRef: args.designRef ?? null, assetIds, newDirection: chosen.newDirection,
        feedback: record.feedback.filter(item => selected.has(item.id)).map(item => ({ id: item.id, versionId: item.versionId,
          excerpt: item.text.slice(0, 300), truncated: item.text.length > 300 })),
        excludedFeedback: { total: excluded.length, items: excluded.slice(0, 20), coverage: excluded.length > 20 ? "partial" : "complete" },
        expectedResult: "新增制作版本；采用设计的任务会自动内检并可能另建修正版，以最终 delivery 为准。",
        blockers: [], note: "只读预检未受理、未锁定作品、未使用模型；提交时会再次核对。" } };
  } catch (error) {
    return { arguments: args, preflight: { status: "blocked", workId: args.workId, blockers: [describeError(error)],
      note: "未受理或产生业务变化；按阻塞补充信息，再准备新请求。" } };
  }
}
