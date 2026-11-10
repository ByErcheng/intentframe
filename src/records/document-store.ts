import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileHash } from "../common/file-hash.ts";
import { immutableText, valueHash } from "./files.ts";
import { AssetStore } from "./asset-store.ts";
import { authoringSchema, documentIdSchema, documentRefSchema, markdownSchema } from "./authoring-contracts.ts";
import type { AuthoringDocument, DocumentRef, DesignDecision } from "./authoring-contracts.ts";
import type { WorkRecord, WorkStore } from "./work-store.ts";

export class DocumentStore {
  readonly store: WorkStore;
  constructor(store: WorkStore) { this.store = store; }

  /** 仅在新业务入口启用；已有作品不补造历史草稿或确认。 */
  initialize(record: WorkRecord, markdown: string, operationId: string) {
    if (record.authoring?.drafts.length) return;
    record.authoring ??= authoringSchema.parse({});
    this.append(record, "draft", markdown, { operationId, source: "external_ai", instruction: "保存外部 AI 提交的原始草稿。", assetIds: [] });
    this.store.save(record);
  }

  document(record: WorkRecord, ref: DocumentRef): AuthoringDocument {
    documentRefSchema.parse(ref);
    const value = [...record.authoring?.drafts ?? [], ...record.authoring?.designs ?? []].find(item => item.id === ref.id);
    if (!value || value.sha256 !== ref.sha256) throw new Error("稿件版本不存在或内容摘要不符；请读取当前作品的准确稿件编号。");
    const expected = join("works", record.id, "documents", value.id + ".md");
    if (value.path !== expected || fileHash(this.store.resolvePath(expected)) !== value.contentSha256 ||
        valueHash({ kind: value.kind, contentSha256: value.contentSha256, assetRefs: value.assetRefs }) !== value.sha256) throw new Error("稿件内容与保存版本不一致，不能继续采用。");
    if (value.assetIds.join("|") !== value.assetRefs.map(ref => ref.id).join("|")) throw new Error("稿件附件引用已变化。");
    const assets = new AssetStore(this.store);
    for (const ref of value.assetRefs) {
      const asset = assets.get(record, ref.id);
      if (asset.sha256 !== ref.sha256 || asset.metadataSha256 !== ref.metadataSha256) throw new Error("稿件附件与当时采用的内容不符。");
    }
    return value;
  }

  read(record: WorkRecord, ref: DocumentRef) {
    const document = this.document(record, ref);
    return { ...document, markdown: readFileSync(this.store.resolvePath(document.path), "utf8"),
      location: this.store.resolvePath(document.path), attachments: document.assetIds.map(id => new AssetStore(this.store).view(record, id)) };
  }

  validateSubmission(record: WorkRecord, basedOn?: DocumentRef, assetIds?: string[]) {
    if (["running", "unknown"].includes(record.execution.status)) throw new Error("原执行正在进行或尚未核清，暂不能改动项目稿件；请保留外部草稿并先查询原执行。");
    const latest = record.authoring?.drafts.at(-1);
    if (latest && (!basedOn || basedOn.id !== latest.id || basedOn.sha256 !== latest.sha256)) throw new Error("草稿已变化；请读取最新稿，再明确修改基线，避免覆盖其他修改。");
    if (basedOn) this.document(record, basedOn);
    new AssetStore(this.store).select(record, assetIds ?? (basedOn ? this.document(record, basedOn).assetIds : []));
  }

  validateHandoff(record: WorkRecord, draft: DocumentRef) {
    if (["running", "unknown"].includes(record.execution.status)) throw new Error("原执行尚未结束或核清，不能切换交接依据。");
    if (this.document(record, draft).kind !== "draft" || record.authoring?.drafts.at(-1)?.id !== draft.id) throw new Error("须明确交接最新草稿，不能自动采用旧稿。");
  }

  validateDecision(record: WorkRecord, design: DocumentRef, status: "adopted" | "needs_changes" = "adopted") {
    if (["running", "unknown"].includes(record.execution.status)) throw new Error("原执行尚未结束或核清，不能改变设计采用记录。");
    const document = this.document(record, design);
    if (document.kind !== "design" || !document.draft) throw new Error("只能审查已保存的设计脚本。");
    if (status === "adopted") this.assertHandedOff(record, document.draft);
    const run = record.authoring!.runs.find(item => item.outputDocument?.id === document.id);
    if (status === "adopted" && run && run.status !== "completed") throw new Error("设计尚未完成，不能采用有阻塞的脚本。");
    return document;
  }

  append(record: WorkRecord, kind: "draft" | "design", markdown: string,
    details: Pick<AuthoringDocument, "operationId" | "source" | "instruction" | "assetIds"> & { basedOn?: DocumentRef; draft?: DocumentRef }) {
    markdownSchema.parse(markdown);
    if (!record.authoring) throw new Error("作品尚未启用草稿设计流程，请先提交草稿。");
    if (details.basedOn) this.document(record, details.basedOn);
    if (details.draft && this.document(record, details.draft).kind !== "draft") throw new Error("设计须关联草稿版本。");
    const list = kind === "draft" ? record.authoring.drafts : record.authoring.designs;
    const contentSha256 = createHash("sha256").update(markdown).digest("hex");
    const assetRefs = new AssetStore(this.store).select(record, details.assetIds).map(asset => ({ id: asset.id, sha256: asset.sha256, metadataSha256: asset.metadataSha256 }));
    const sha256 = valueHash({ kind, contentSha256, assetRefs });
    const previous = list.find(item => item.operationId === details.operationId);
    if (previous) {
      if (previous.sha256 !== sha256) throw new Error("原操作已保存不同稿件，不能覆盖。");
      return this.document(record, previous);
    }
    let number = Math.max(0, ...list.map(item => Number(item.id.slice(1)))) + 1;
    const prefix = kind === "draft" ? "d" : "s";
    while (existsSync(this.store.resolvePath(join("works", record.id, "documents", prefix + String(number).padStart(3, "0") + ".md")))) number++;
    const id = prefix + String(number).padStart(3, "0");
    documentIdSchema.parse(id);
    const document: AuthoringDocument = { id, kind, sha256, contentSha256, assetRefs, ...details,
      path: join("works", record.id, "documents", id + ".md"), createdAt: new Date().toISOString() };
    immutableText(this.store.resolvePath(document.path), markdown);
    list.push(document);
    return document;
  }

  async submit(workId: string, markdown: string, operationId: string, instruction: string, basedOn?: DocumentRef, assetIds?: string[]) {
    return this.store.withLock(workId, () => {
      const record = this.store.read(workId);
      if (!record.authoring) record.authoring = authoringSchema.parse({});
      this.validateSubmission(record, basedOn, assetIds);
      const document = this.append(record, "draft", markdown, { operationId, instruction, source: "external_ai", basedOn,
        assetIds: assetIds ?? (basedOn ? this.document(record, basedOn).assetIds : []) });
      this.store.save(record); return this.read(record, document);
    });
  }

  async handoff(workId: string, draft: DocumentRef, userInstruction: string, operationId: string) {
    return this.store.withLock(workId, () => {
      const record = this.store.read(workId); this.validateHandoff(record, draft);
      if (!userInstruction.trim()) throw new Error("缺少用户明确进入设计的原话。");
      record.authoring!.handoffs.push({ operationId, draft, userInstruction, createdAt: new Date().toISOString() });
      this.store.save(record); return this.read(record, draft);
    });
  }

  assertHandedOff(record: WorkRecord, draft: DocumentRef) {
    if (this.document(record, draft).kind !== "draft" || !record.authoring?.handoffs.some(item => item.draft.id === draft.id && item.draft.sha256 === draft.sha256)) {
      throw new Error("须先记录用户将这版草稿交给 AI 设计的明确指令。");
    }
    const adopted = record.authoring.handoffs.at(-1)!.draft;
    if (adopted.id !== draft.id || adopted.sha256 !== draft.sha256) throw new Error("这版草稿的交接已被更新，请使用当前交接版本。");
  }

  async decide(workId: string, decision: Omit<DesignDecision, "createdAt" | "feedbackAcknowledgedIds">) {
    return this.store.withLock(workId, () => {
      const record = this.store.read(workId), document = this.validateDecision(record, decision.design, decision.status);
      if (!decision.notes.trim()) throw new Error("须说明设计检查范围、采用依据或修改问题。");
      record.authoring!.decisions.push({ ...decision, feedbackAcknowledgedIds: record.feedback.map(item => item.id), createdAt: new Date().toISOString() });
      this.store.save(record); return this.read(record, document);
    });
  }

  adopted(record: WorkRecord, design?: DocumentRef) {
    if (!record.authoring) return undefined;
    const decision = design ? record.authoring.decisions.filter(item => item.design.id === design.id).at(-1) : record.authoring.decisions.at(-1);
    if (!decision || decision.status !== "adopted" || (design && decision.design.sha256 !== design.sha256)) throw new Error("尚无可采用的设计脚本；请由外部 AI 或用户检查并记录采用结论。");
    const document = this.document(record, decision.design);
    if (!document.draft) throw new Error("设计缺少来源草稿。");
    this.assertHandedOff(record, document.draft);
    if (record.feedback.some(item => item.changesDirection && !decision.feedbackAcknowledgedIds.includes(item.id))) throw new Error("采用设计后出现方向变更意见，须更新设计并重新审查采用。");
    return { document, decision, markdown: this.read(record, document).markdown, draft: this.read(record, document.draft) };
  }
}
