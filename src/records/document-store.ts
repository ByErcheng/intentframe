import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileHash } from "../common/file-hash.ts";
import { immutableText, readJson, valueHash } from "./files.ts";
import { AssetStore } from "./asset-store.ts";
import { authoringSchema, documentIdSchema, documentRefSchema, markdownSchema, draftSubmissionSchema, baselineDraftReviewEvidenceSchema } from "./authoring-contracts.ts";
import type { AuthoringDocument, DocumentRef, DesignDecision, DraftSubmission } from "./authoring-contracts.ts";
import type { WorkRecord, WorkStore } from "./work-store.ts";
import { profileSnapshotSchema, readCreativeBrief } from "./creative-profile.ts";
import type { ProfileRef, ProfileSnapshot } from "./creative-profile.ts";
import { ProfileStore } from "./profile-store.ts";

export class DocumentStore {
  readonly store: WorkStore;
  constructor(store: WorkStore) { this.store = store; }

  /** 仅在新业务入口启用；已有作品不补造历史草稿或确认。 */
  initialize(record: WorkRecord, markdown: string, operationId: string, submission?: DraftSubmission) {
    if (record.authoring?.drafts.length) return;
    record.authoring ??= authoringSchema.parse({});
    if (submission) this.validateDraftInput(markdown, submission);
    const document = this.append(record, "draft", markdown, { operationId, source: "external_ai", instruction: "保存外部 AI 提交的原始草稿。", assetIds: [],
      ...(submission ? { submission, reviewRequired: true } : {}) });
    if (submission) this.recordSubmissionHandoff(record, document, submission, operationId);
    this.store.save(record);
  }

  document(record: WorkRecord, ref: DocumentRef): AuthoringDocument {
    documentRefSchema.parse(ref);
    const value = [...record.authoring?.drafts ?? [], ...record.authoring?.designs ?? []].find(item => item.id === ref.id);
    if (!value || value.sha256 !== ref.sha256) throw new Error("稿件版本不存在或内容摘要不符；请读取当前作品的准确稿件编号。");
    const expected = join("works", record.id, "documents", value.id + ".md");
    if (value.path !== expected || fileHash(this.store.resolvePath(expected)) !== value.contentSha256 ||
        valueHash({ kind: value.kind, contentSha256: value.contentSha256, assetRefs: value.assetRefs, creativeProfile: value.creativeProfile?.ref }) !== value.sha256) throw new Error("稿件内容与保存版本不一致，不能继续采用。");
    if (value.creativeProfile) {
      profileSnapshotSchema.parse(value.creativeProfile);
      if (value.kind === "draft" && valueHash(readCreativeBrief(readFileSync(this.store.resolvePath(value.path), "utf8"), value.creativeProfile)) !== valueHash(value.creativeBrief)) {
        throw new Error("草稿定位摘要与原文不一致。");
      }
      if (value.draft && valueHash(this.document(record, value.draft).creativeProfile?.ref ?? null) !== valueHash(value.creativeProfile.ref)) {
        throw new Error("设计与来源草稿的创作档案依据不一致。");
      }
    }
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

  resolveProfile(markdown: string, ref?: ProfileRef, record?: WorkRecord, basedOn?: DocumentRef, required = false) {
    const inherited = record && (basedOn ? this.document(record, basedOn).creativeProfile : record.creationProfile);
    const snapshot = ref ? valueHash(ref) === valueHash(inherited?.ref ?? null) ? inherited! : new ProfileStore(this.store.assetRoot).select(ref) : inherited;
    if (!snapshot && required) throw new Error("新交接须明确选择创作档案；先列出并读取档案，将名称、版本、方向摘要和本条视频定位写入草稿。");
    if (snapshot) readCreativeBrief(markdown, snapshot);
    return snapshot;
  }

  validateDraftInput(markdown: string, raw: DraftSubmission | undefined, record?: WorkRecord, basedOn?: DocumentRef): DraftSubmission {
    if (!raw) throw new Error("先在外部维护可打开的 Markdown 文件，取得用户对该版的明确交接，再提交 submission 文件来源、正文摘要和授权依据。");
    const submission = draftSubmissionSchema.parse(raw);
    if (createHash("sha256").update(markdown).digest("hex") !== submission.contentSha256) throw new Error("提交正文与已展示草稿的摘要不一致；重新核对确切文件版本，不能改写或截断原文。");
    if (submission.authorization.kind === "external_correction") {
      if (!record || !basedOn) throw new Error("首次交接须有用户明确确认，不能以外部纠错代替。");
      this.assertHandedOff(record, basedOn);
      const run = this.latestDraftReview(record, basedOn);
      if (!run || run.id !== submission.authorization.reviewRunId || run.status !== "completed" || run.draftReview?.status !== "needs_changes") {
        throw new Error("外部纠错须对应当前草稿最近一次仅由外部 AI 处理的检查意见；意图歧义或变更须取得用户确认。");
      }
    }
    return submission;
  }

  private recordSubmissionHandoff(record: WorkRecord, document: AuthoringDocument, submission: DraftSubmission, operationId: string) {
    const authorization = submission.authorization;
    const previous = record.authoring!.handoffs.at(-1);
    if (record.authoring!.handoffs.some(item => item.operationId === operationId)) return;
    if (authorization.kind === "external_correction" && !previous) throw new Error("纠错缺少原交接记录。");
    record.authoring!.handoffs.push({ operationId, draft: { id: document.id, sha256: document.sha256 },
      userInstruction: authorization.kind === "user" ? authorization.userInstruction : previous!.userInstruction,
      ...(authorization.kind === "external_correction" ? { correctionOf: {
        operationId: previous!.operationId, reviewRunId: authorization.reviewRunId, notes: authorization.notes,
      } } : {}), createdAt: new Date().toISOString() });
  }

  latestDraftReview(record: WorkRecord, draft: DocumentRef) {
    return record.authoring?.runs.filter(run => run.kind === "review_draft" && run.base.id === draft.id && run.base.sha256 === draft.sha256).at(-1);
  }

  baselineReviewEvidence(record: WorkRecord, draft: DocumentRef) {
    const ref = record.authoring?.baselineDraftReviews?.find(item => valueHash(item.draft) === valueHash(documentRefSchema.parse(draft)));
    if (!ref) return undefined;
    if (this.store.purpose !== "test" || record.purpose !== "test" ||
        ref.path !== join("works", record.id, "documents", draft.id + "-review-prerequisite.json") ||
        fileHash(this.store.resolvePath(ref.path)) !== ref.sha256) throw new Error("测试基线的草稿检查依据缺失、变化或不属于本次测试。");
    const evidence = baselineDraftReviewEvidenceSchema.parse(readJson(this.store.resolvePath(ref.path)));
    if (valueHash(evidence.draft) !== valueHash(ref.draft)) throw new Error("测试基线检查依据与确切草稿不一致。");
    return evidence;
  }

  assertReviewed(record: WorkRecord, draft: DocumentRef) {
    const document = this.document(record, draft), run = this.latestDraftReview(record, draft);
    // 旧稿件继续沿当时的交接规则；新提交与已明确开始检查的旧稿都不能跳过检查。
    if (!document.reviewRequired && !run) return;
    // 新检查优先；旧基线通过事实不能掩盖后续检查失败，也不能用于新草稿或正式作品。
    if (!run && this.baselineReviewEvidence(record, draft)) return;
    if (run?.status !== "completed" || run.draftReview?.status !== "passed") throw new Error("草稿尚未通过入项检查；先调用 review_draft，按意见修改或澄清后复查确切新版本，再设计。");
  }

  validateHandoff(record: WorkRecord, draft: DocumentRef) {
    if (["running", "unknown"].includes(record.execution.status)) throw new Error("原执行尚未结束或核清，不能切换交接依据。");
    if (this.document(record, draft).kind !== "draft" || record.authoring?.drafts.at(-1)?.id !== draft.id) throw new Error("须明确交接最新草稿，不能自动采用旧稿。");
  }

  validateDecision(record: WorkRecord, design: DocumentRef, status: "adopted" | "needs_changes" = "adopted") {
    if (["running", "unknown"].includes(record.execution.status)) throw new Error("原执行尚未结束或核清，不能改变设计采用记录。");
    const document = this.document(record, design);
    if (document.kind !== "design" || !document.draft) throw new Error("只能审查已保存的设计脚本。");
    if (status === "adopted") { this.assertHandedOff(record, document.draft); this.assertReviewed(record, document.draft); }
    const run = record.authoring!.runs.find(item => item.outputDocument?.id === document.id);
    if (status === "adopted" && run && run.status !== "completed") throw new Error("设计尚未完成，不能采用有阻塞的脚本。");
    return document;
  }

  append(record: WorkRecord, kind: "draft" | "design", markdown: string,
    details: Pick<AuthoringDocument, "operationId" | "source" | "instruction" | "assetIds"> & {
      basedOn?: DocumentRef; draft?: DocumentRef; submission?: DraftSubmission; reviewRequired?: boolean; creativeProfile?: ProfileSnapshot }) {
    markdownSchema.parse(markdown);
    if (!record.authoring) throw new Error("作品尚未启用草稿设计流程，请先提交草稿。");
    if (details.basedOn) this.document(record, details.basedOn);
    if (details.draft && this.document(record, details.draft).kind !== "draft") throw new Error("设计须关联草稿版本。");
    const list = kind === "draft" ? record.authoring.drafts : record.authoring.designs;
    const contentSha256 = createHash("sha256").update(markdown).digest("hex");
    const assetRefs = new AssetStore(this.store).select(record, details.assetIds).map(asset => ({ id: asset.id, sha256: asset.sha256, metadataSha256: asset.metadataSha256 }));
    const creativeProfile = details.creativeProfile ?? (details.draft ? this.document(record, details.draft).creativeProfile :
      details.basedOn ? this.document(record, details.basedOn).creativeProfile : record.creationProfile);
    if (creativeProfile) profileSnapshotSchema.parse(creativeProfile);
    const creativeBrief = kind === "draft" && creativeProfile ? readCreativeBrief(markdown, creativeProfile) : undefined;
    const sha256 = valueHash({ kind, contentSha256, assetRefs, creativeProfile: creativeProfile?.ref });
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
      ...(creativeProfile ? { creativeProfile, creativeBrief } : {}),
      path: join("works", record.id, "documents", id + ".md"), createdAt: new Date().toISOString() };
    immutableText(this.store.resolvePath(document.path), markdown);
    list.push(document);
    return document;
  }

  async submit(workId: string, markdown: string, operationId: string, instruction: string, basedOn?: DocumentRef, assetIds?: string[], submission?: DraftSubmission, profileRef?: ProfileRef) {
    return this.store.withLock(workId, () => {
      const record = this.store.read(workId);
      if (!record.authoring) record.authoring = authoringSchema.parse({});
      this.validateSubmission(record, basedOn, assetIds);
      if (submission) this.validateDraftInput(markdown, submission, record, basedOn);
      const creativeProfile = this.resolveProfile(markdown, profileRef, record, basedOn);
      if (submission?.authorization.kind === "external_correction" && valueHash(creativeProfile?.ref ?? null) !== valueHash(basedOn ? this.document(record, basedOn).creativeProfile?.ref ?? null : null)) {
        throw new Error("外部纠错不能切换创作档案依据；须按用户明确指令交接新版。");
      }
      const document = this.append(record, "draft", markdown, { operationId, instruction, source: "external_ai", basedOn,
        creativeProfile,
        assetIds: assetIds ?? (basedOn ? this.document(record, basedOn).assetIds : []),
        ...(submission ? { submission, reviewRequired: true } : {}) });
      if (submission) this.recordSubmissionHandoff(record, document, submission, operationId);
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
    this.assertReviewed(record, document.draft);
    if (record.feedback.some(item => item.changesDirection && !decision.feedbackAcknowledgedIds.includes(item.id))) throw new Error("采用设计后出现方向变更意见，须更新设计并重新审查采用。");
    return { document, decision, markdown: this.read(record, document).markdown, draft: this.read(record, document.draft) };
  }
}
