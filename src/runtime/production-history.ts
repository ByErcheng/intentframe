import { z } from "zod";
import type { WorkRecord, WorkVersion } from "../records/work-store.ts";

const inputSchema = z.strictObject({
  section: z.enum(["baseline_result", "inherited_feedback"]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(20).default(20),
});

export const productionHistoryTool = {
  type: "function", name: "intentframe_read_production_history",
  description: "按需读取本轮固定基线的历史制作结果，或分页读取已继承反馈原文。历史声明不代表当前进度，已继承反馈不自动成为本轮待办。不能读取其他作品或任意路径。",
  inputSchema: z.toJSONSchema(inputSchema),
};

/** 固定本轮材料；不让制作中追加的意见或版本状态变化改写已经交接的历史依据。 */
export function productionHistory(record: WorkRecord, previous: WorkVersion | undefined, inherited: string[], feedbackReads: Set<string>) {
  const superseded = new Map<string, string[]>();
  for (const item of record.feedback) for (const id of item.supersedes ?? []) {
    superseded.set(id, [...(superseded.get(id) ?? []), item.id]);
  }
  const snapshot = structuredClone({
    baselineResult: previous ? { versionId: previous.id, agentResult: previous.agentResult ?? null,
      agentReply: previous.agentReply ?? null } : null,
    inheritedFeedback: record.feedback.filter(item => inherited.includes(item.id)).map(item => ({
      ...item, inheritedInBase: true, supersededByFeedbackIds: superseded.get(item.id) ?? [],
    })),
  });
  return {
    snapshot,
    read(input: unknown) {
      const args = inputSchema.parse(input);
      if (args.section === "baseline_result") {
        if (args.offset !== 0) throw new Error("基线结果不是分页列表，offset 必须为 0。");
        return { coverage: snapshot.baselineResult ? "complete" : "not_found", result: structuredClone(snapshot.baselineResult) };
      }
      const end = args.offset + args.limit, items = snapshot.inheritedFeedback.slice(args.offset, end);
      for (const item of items) feedbackReads.add(item.id);
      return { coverage: end < snapshot.inheritedFeedback.length ? "partial" : "complete",
        items: structuredClone(items), nextOffset: end < snapshot.inheritedFeedback.length ? end : null };
    },
  };
}
