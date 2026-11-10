import { existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { atomicJson, ownedPath, readJson, valueHash } from "./files.ts";
import { purposeSchema } from "./contracts.ts";
import type { WorkPurpose } from "./contracts.ts";

export const operationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const recoverableOperations: readonly string[] = ["produce_version", "prepare_review_materials", "revise_draft", "design_video", "generate_image", "synthesize_speech"];
const operationSchema = z.object({
  schemaVersion: z.literal(1), id: operationIdSchema, name: z.string(), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["unresolved", "accepted", "succeeded", "failed"]), createdAt: z.string(),
  workId: z.string().optional(), result: z.unknown().optional(), error: z.string().optional(),
  recoveredAt: z.string().optional(),
  purpose: purposeSchema.optional(),
  receivedAt: z.iso.datetime().optional(),
}).refine(record => !["accepted", "succeeded"].includes(record.state) || record.result !== undefined, "成功回执缺少原结果。");

/** 持久原请求回执。未保存终态的操作只供核对，绝不凭重试重新执行。 */
export class OperationStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  exists(id: string): boolean {
    // 目录已占用但回执未写完整时，也必须阻止新请求覆盖现场。
    return existsSync(ownedPath(this.root, "operations/" + operationIdSchema.parse(id)));
  }

  read(id: string) {
    const parsed = operationIdSchema.parse(id);
    const path = ownedPath(this.root, "operations/" + parsed + "/request.json");
    try {
      const record = operationSchema.parse(readJson(path));
      if (record.id !== parsed) throw new Error("操作回执与编号不一致。");
      return record;
    } catch (error) { throw new Error("无法核对原操作回执；保留原编号，不得改号重发：" + (error instanceof Error ? error.message : String(error))); }
  }

  completeRecovery(id: string, workId: string, result: unknown): void {
    const original = this.read(id);
    if (!recoverableOperations.includes(original.name) || original.workId !== workId) throw new Error("恢复结果不能写入其他操作的回执。");
    if (original.state === "succeeded" || original.state === "accepted") return;
    atomicJson(ownedPath(this.root, "operations/" + original.id + "/request.json"), {
      ...original, state: "succeeded", result, recoveredAt: new Date().toISOString(),
    });
  }

  replay(id: string, name: string, input: unknown): unknown {
    const previous = this.read(id);
    if (previous.name !== name || previous.inputHash !== valueHash(input)) throw new Error("同一操作编号已用于不同内容或目标。");
    if (previous.state === "succeeded" || previous.state === "accepted") return previous.result;
    if (previous.state === "failed") throw new Error(previous.error);
    throw new Error("原操作尚无确定回执，请查询原任务或核对恢复；不能重复执行。");
  }

  async execute(id: string, name: string, input: unknown, action: () => Promise<unknown> | unknown, purpose?: WorkPurpose,
    responseState: "succeeded" | "accepted" = "succeeded", receivedAt?: string) {
    const parsed = operationIdSchema.parse(id), inputHash = valueHash(input);
    const directory = ownedPath(this.root, "operations/" + parsed);
    mkdirSync(ownedPath(this.root, "operations"), { recursive: true });
    try { mkdirSync(directory); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return this.replay(parsed, name, input);
    }
    const workId = input && typeof input === "object" && "workId" in input && typeof input.workId === "string" ? input.workId : undefined;
    const record = { schemaVersion: 1 as const, id: parsed, name, inputHash, state: "unresolved" as const,
      createdAt: new Date().toISOString(), receivedAt, ...(workId ? { workId } : {}), ...(purpose ? { purpose } : {}) };
    const path = ownedPath(this.root, "operations/" + parsed + "/request.json");
    atomicJson(path, record);
    let result: unknown;
    try { result = await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 回执记录的是调用返回错误；任务是否未知仍以原任务的执行状态为准。
      atomicJson(path, { ...record, state: "failed", error: message });
      throw error;
    }
    // 若保存失败，原unresolved记录继续阻止重发；不能把已发生的副作用当成未执行。
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error("写操作没有返回可保存的结果，须核对原现场。");
    const savedResult: unknown = JSON.parse(serialized);
    atomicJson(path, { ...record, state: responseState, result: savedResult });
    // 首次返回与跨进程重试使用同一 JSON 形态，不能携带仅存在于内存的空字段。
    return savedResult;
  }
}
