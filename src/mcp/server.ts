import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { WorkService } from "../runtime/work-service.ts";
import { WorkRouter } from "../runtime/work-router.ts";
import { describeError } from "../common/errors.ts";
import { systemFingerprint } from "../runtime/context.ts";
import { operationIdSchema } from "../records/operation-store.ts";
import { experienceRefSchema, feedbackLocationSchema, purposeSchema, workInputSchema } from "../records/contracts.ts";
import { valueHash } from "../records/files.ts";
import { experienceInputSchema } from "../records/knowledge-store.ts";
import { comparisonInputSchema } from "../records/comparison-store.ts";
import { ExecutionStore, activeExecution, assertExecutionAccess, backgroundToolSchema } from "../records/execution-store.ts";
import { BackgroundService } from "../runtime/background-service.ts";
import { readUsageGuide, serverInstructions } from "../runtime/usage-guide.ts";
import { rejectPreflight, validateInput } from "./request-errors.ts";
import { selectProduction } from "../runtime/production-selection.ts";
import { documentRefSchema, markdownSchema, draftSubmissionSchema } from "../records/authoring-contracts.ts";
import { assetIdSchema, reviewCoverageSchema, validateReviewCoverage } from "../records/media-contracts.ts";
import { assetRoleSchema, voiceInfoSchema } from "../records/asset-types.ts";
import { readReviewBatch, reviewRangeSchema } from "../media/review-materials.ts";
import { fileHash } from "../common/file-hash.ts";
import { speechSegments, musicInputSchema, soundEffectInputSchema, voiceIdSchema, voiceInstructionSchema, configuredVoices } from "../media/providers.ts";
import { AssetCatalog, assetSearchSchema } from "../records/asset-catalog.ts";
import { configuration } from "../config.ts";
import { toolCapability, capabilityTable } from "../runtime/tool-capabilities.ts";
import { workSummary, workSection, workSections, currentExecution, feedbackView } from "./work-view.ts";
import { prepareProduction } from "./production-preflight.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const versionId = z.string().regex(/^v\d{3,}$/);
const text = z.string().min(1).max(30_000).refine(value => value.trim().length > 0, "内容不能仅为空白。");
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) };
const write = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...shape, operationId: operationIdSchema });
export const inputs = {
  read_usage_guide: z.strictObject({ document: z.enum(["usage", "workflow", "data"]).default("usage"), section: z.string().trim().min(1).max(120).optional(),
    view: z.enum(["summary", "full"]).default("summary") }),
  get_runtime_info: z.strictObject({}),
  get_execution: z.strictObject({ executionId: operationIdSchema }),
  cancel_execution: write({ executionId: operationIdSchema, reason: text.max(1_000).default("用户要求停止当前执行。") }),
  prepare_operation: z.strictObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  get_operation: z.strictObject({ operationId: operationIdSchema, purpose: purposeSchema.optional().describe("仅在旧区域存在相同操作编号时，用于明确查询哪一份原回执；不切换服务或任务用途。") }),
  list_works: z.strictObject({ ...page, purpose: z.enum(["production", "test", "all"]).default("production") }),
  create_work: write({ ...workInputSchema.shape, submission: draftSubmissionSchema.optional().describe("新请求必填：已向用户展示的 Markdown 文件来源、正文 SHA-256 与明确交接原话；可选仅为历史回执重放。"),
    purpose: purposeSchema.describe("根据用户明确要求选择 test（测试制作）或 production（正式制作）；无法判断时先询问。与 sample/complete 制作阶段分别判断。") }),
  get_work: z.strictObject({ workId: id, ...page, view: z.enum(["summary", "detail"]).default("summary"), section: z.enum(workSections).optional() }),
  submit_draft: write({ workId: id, markdown: markdownSchema, instruction: text, basedOn: documentRefSchema.optional(), assetIds: z.array(id).max(20).optional(),
    submission: draftSubmissionSchema.optional().describe("新提交必填；用户确认或针对原草稿检查的已有授权内纠错。") }),
  read_document: z.strictObject({ workId: id, ref: documentRefSchema }),
  revise_draft: write({ workId: id, base: documentRefSchema, instruction: text, assetIds: z.array(id).max(20).optional() }),
  handoff_draft: write({ workId: id, draft: documentRefSchema, userInstruction: text }),
  review_draft: write({ workId: id, base: documentRefSchema, instruction: text.default("结合适用经验检查本稿，返回问题依据和处理建议。") }),
  design_video: write({ workId: id, base: documentRefSchema, instruction: text, assetIds: z.array(id).max(20).optional() }),
  review_design: write({ workId: id, design: documentRefSchema, status: z.enum(["adopted", "needs_changes"]), notes: text, source: z.enum(["user", "external_ai"]) }),
  import_asset: write({ workId: id, path: text, role: assetRoleSchema, description: text, document: documentRefSchema.optional(), voice: voiceInfoSchema.optional() }),
  get_asset: z.strictObject({ workId: id, assetId: assetIdSchema }),
  search_assets: assetSearchSchema.extend({ purpose: purposeSchema.default("production") }),
  generate_image: write({ workId: id, document: documentRefSchema, prompt: text, referenceAssetIds: z.array(assetIdSchema).max(8).default([]), background: z.enum(["auto", "opaque", "transparent"]).optional(), description: text }),
  generate_music: write({ workId: id, document: documentRefSchema, ...musicInputSchema.shape, description: text }),
  generate_sound_effect: write({ workId: id, document: documentRefSchema, ...soundEffectInputSchema.shape, description: text }),
  read_speech_text: z.strictObject({ workId: id, design: documentRefSchema }),
  synthesize_speech: write({ workId: id, document: documentRefSchema, segmentIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1).max(100),
    speechRate: z.number().int().min(-50).max(100).default(0), voiceInstruction: voiceInstructionSchema.optional(), voiceId: voiceIdSchema.optional(), description: text }),
  prepare_review_materials: write({ workId: id, versionId, ranges: z.array(reviewRangeSchema).max(6).default([]),
    mode: z.enum(["materials_only", "inspect_and_repair"]).optional().describe("新请求默认 materials_only，仅补材料；inspect_and_repair 会调用模型检查并可能制作修正版。") }),
  get_review_materials: z.strictObject({ workId: id, versionId }),
  read_media_image: z.strictObject({ workId: id, source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("asset"), assetId: assetIdSchema }),
    z.strictObject({ kind: z.literal("review"), versionId, indexRef: text, imagePath: text }),
  ]) }),
  produce_version: write({ workId: id, kind: z.enum(["sample", "complete"]),
    designRef: documentRefSchema.optional(), assetIds: z.array(id).optional(),
    feedbackId: text.max(100).optional(), feedbackIds: z.array(text.max(100)).max(1_000).optional().describe("明确本轮处理的反馈编号，空数组表示不处理；不能与 feedbackId 同时提供。"),
    newDirection: z.boolean().optional().describe("true 从所选基线创建备选样例；false 或省略沿用原方向，不撤销原确认。"), threadMode: z.enum(["fresh", "resume"]).default("fresh"),
    baseVersionId: versionId.optional(), baseReason: text.optional(),
    preflightHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("prepare_operation 返回的状态与选择摘要，完整保留；状态或请求变化时拒绝制作。") }),
  render_version: write({ workId: id, versionId }),
  recover_work: write({ workId: id, render: z.boolean().optional().describe("兼容旧显式请求：true 继续、false 只补存；新请求使用 mode。"),
    mode: z.enum(["reconcile_only", "resume"]).optional().describe("新请求默认 reconcile_only，核对并补存；resume 可继续渲染、内检和必要修复，可能调用模型。两者均可能写入记录。") }),
  submit_feedback: write({ workId: id, versionId, text: text.max(10_000),
    source: z.enum(["user", "external_ai", "internal_check", "system_test"]), changesDirection: z.boolean().default(false),
    supersedes: z.array(text.max(100)).max(1_000).optional().describe("本次原话明确替代或取消的旧反馈编号；保留原文，旧项不再自动进入新制作。"),
    location: feedbackLocationSchema.optional() }),
  record_review: write({ workId: id, versionId, status: z.enum(["needs_changes", "passed"]), notes: text,
    materialIndexes: z.array(z.string()).max(100).optional(),
    coverage: reviewCoverageSchema.optional().describe("分别声明帧图、时序和实际播放的检查范围；播放器结束不等于观看。缺省保留为未记录。"),
    source: z.enum(["user", "external_ai", "internal_check"]) }),
  confirm_version: write({ workId: id, versionId, kind: z.enum(["direction", "acceptance"]),
    userConfirmation: text.max(10_000), scope: text.optional() }),
  search_experience: z.strictObject({ query: text.max(2_000), ...page }),
  read_experience: experienceRefSchema,
  save_experience: write({ experience: experienceInputSchema, id: id.optional(), expectedRevision: z.number().int().nonnegative().default(0) }),
  learning_status: z.strictObject({ workId: id }),
  organize_experience: write({ workId: id }),
  publish_test_experience: write({ workId: id }),
  create_comparison: write({ comparison: comparisonInputSchema }),
  get_comparison: z.strictObject({ comparisonId: id }),
  record_comparison: write({ comparisonId: id, beforeVersionId: versionId, afterVersionId: versionId,
    verdict: z.enum(["improved", "regressed", "mixed", "inconclusive"]), observations: text,
    source: z.enum(["user", "external_ai"]) }),
};
type ToolName = keyof typeof inputs;
const readOnly = new Set<ToolName>(["read_usage_guide", "get_runtime_info", "get_execution", "prepare_operation", "get_operation", "list_works", "get_work",
  "read_document",
  "get_asset", "search_assets", "read_speech_text", "get_review_materials",
  "read_media_image",
  "search_experience", "read_experience", "learning_status", "get_comparison"]);
const descriptions: Record<ToolName, string> = {
  import_asset: "把用户指定的本机图片、录音、背景音乐或音效保存到作品资产目录，核对实际文件并保留来源；不修改原文件。",
  get_asset: "读取已登记素材的本机位置、用途、来源和实际媒体信息；内容变化时拒绝复用。",
  generate_music: "用户明确要求的独立音乐生成；保存描述、原始MP3和请求，不自动开始视频制作。需配置音乐服务，会使用API额度。",
  generate_sound_effect: "用户明确要求的独立音效生成；保存描述、原始MP3和请求，可要求循环。需配置音效服务，会使用API额度。",
  generate_image: "用于用户明确要求的独立素材任务或诊断，通过已配置 GPT 图片 API 生成一张图片或参考编辑；保存到本机并关联稿件，不自动采用设计或开始视频制作。未配置时拒绝，不自动重试结果未知的请求。会使用 API 额度。",
  read_speech_text: "从确切设计脚本的 speech 区块提取实际人声原文；不润色，不把动作说明当台词。",
  synthesize_speech: "从已采用脚本的指定台词片段调用已有豆包音色，可通过 voiceInstruction 传递脚本中的声音要求；保存音轨、指令和服务实际返回的字词时间。凭据只读本机配置；会使用 API 额度。",
  search_assets: "只读查找配置的本机素材库和所选正式或测试区域的已有作品素材，返回候选来源与使用状态，不把检索当作查看或试听。",
  prepare_review_materials: "默认 materials_only 只保存或补充抽帧材料，不调用模型、不创建视频版本；明确 inspect_and_repair 才回看、修复并复查，可能返回新版本。仅查看已有材料用 get_review_materials。",
  get_review_materials: "返回当前视频的永久审查文件、采用脚本、项目内检及交付状态；外部 AI 实际读取后独立提交 record_review。",
  read_media_image: "通过 MCP 图像内容读取已保存素材或审查帧/拼图，同时返回来源及摘要；不重新生成、不另建云端副本。只接受本作品登记的明确文件引用。",
  submit_draft: "接收外部已确认或按原检查意见纠正的完整 Markdown，保存文件来源、差异依据与新交接。新稿须重新检查；不能以纠错代替用户对意图变更的确认。",
  read_document: "读取确切版本的草稿或视频脚本正文、来源及本机位置；内容变化时拒绝沿用旧记录。",
  revise_draft: "提交项目 AI 修改草稿的后台任务，仅按本轮指令返回新 Markdown，不自动进入设计或制作。",
  handoff_draft: "记录用户明确将最新草稿交给 AI 设计的原话。草稿保存、AI 自评或一般积极反馈不替代这次交接。",
  review_draft: "检查已交接的确切草稿与相关历史经验，返回有依据的问题及 external_ai/user 处理人，不改写原稿或开始设计。后台受理后查询 get_execution。",
  design_video: "以已交接草稿或其设计基线生成视频脚本；本轮只设计，完成后返回外部 AI 审查，不自动制作代码。",
  review_design: "外部 AI 或用户检查确切设计后记录采用或修改结论及依据；AI 采用不是用户成片认可。",
  read_usage_guide: "默认读取简短入门与章节目录；按 section 展开，view=full 取全文。usage 的工具执行契约章节由当前工具定义生成。按需查 workflow 或 data，不必首次读取全部说明。",
  get_runtime_info: "只读核对资产总目录、正式与测试区域、共享经验位置和系统版本。同一入口服务两类任务，用途在创建任务时选择。",
  get_execution: "按 executionId 查询原后台执行阶段、实际选择及结果；succeeded 查看结果，waiting_input 需补信息，unknown 须核对恢复。timing 记录项目接收至首次最终返回，重复查询不重置。",
  cancel_execution: "按用户明确要求保存停止请求；未领取的任务可以取消，正在执行的任务须继续查询实际停止结果。停止请求已保存不等于已经停止，也不代表原任务没有产生结果。",
  prepare_operation: "只读准备新请求与稳定编号。produce_version 还预检实际基线、设计、素材、反馈及阻塞，ready 才可提交；blocked 先纠正。完整保存 arguments 再调用目标工具，原样重试沿用原编号；不写业务记录、不调用模型。",
  get_operation: "按原编号读取操作回执，兼容旧区域。未取得最终回执时查询原任务，不换编号重新制作。",
  list_works: "按 purpose 分页查作品：默认 production，test 查测试，all 查两类。筛选只影响列表，不改变后续任务的用途。",
  create_work: "用户确认外部 Markdown 文件后提交完整原文及 submission，保存首稿与明确交接；随后 review_draft，通过后 design_video。测试用 purpose=test，正式用 production；不自动调用模型。",
  get_work: "默认返回当前执行、最新版本、交付状态、阻塞与下一步的简短摘要。section 按版本、反馈、稿件等独立分页；view=detail 保留旧混合详情。摘要不含历史正文，不代表历史或待处理反馈为空。",
  produce_version: "新流程须明确 designRef，受理时冻结脚本、素材、基线和反馈。制作后自动回看、必要时内部修复与复查，通过后 delivery 返回交付版本。旧任务沿原样例确认接续。feedbackIds=[] 不处理外部反馈，newDirection=true 仅备选样例。返回 executionId 后查询，会使用模型额度。",
  render_version: "提交已有完成工程的后台渲染或预览恢复，返回 executionId 后查询。只恢复既有工程产物，不调用模型或修改源码；需要项目回看时另用 prepare_review_materials 的 inspect_and_repair 模式。",
  recover_work: "默认 reconcile_only 沿原身份核对并补存已有结果，不发起新的模型轮次；明确 resume 才继续渲染、内检及必要修复。不是只读工具。兼容显式旧 render 参数；不重发未知原调用，依据不足时保留保护。",
  submit_feedback: "保留针对已登记版本的原话，可在已知排队或制作期间先保存，供下一轮接续；未知执行先核对。可附定位或 supersedes 替代关系；近似位置不能标成 verified，新增备选不自动撤销原方向。",
  record_review: "记录实际观看或检查过的明确版本及覆盖范围；技术检查不能代替内容审查或用户认可。",
  confirm_version: "仅转录用户对明确版本的真实确认。direction 确认样例方向；acceptance 认可完整版本，不授权发布。AI 自检不能代替用户确认。",
  search_experience: "按问题分页查经验索引；未命中不证明没有历史，采用前须读取正文。评价专用或已撤销内容不会返回。",
  read_experience: "按确切版本读取经验正文并核对来源。原始事实仍保存在所属作品中。",
  save_experience: "保存有来源、条件和限制的经验版本。verified 须有实际可用且复查通过的作品证据；测试未完成比较时不能发布其发现。",
  learning_status: "查看新增反馈、失败和复查的待整理范围、已保存批次及未完成事项。",
  organize_experience: "提交后台经验整理并返回 executionId，随后查询结果。同一主 AI 只读检查新增事实，保存候选后才推进进度；可无候选，会使用模型额度。",
  publish_test_experience: "比较结束后，将本任务已暂存的候选经验加入共享记录；不重新调用模型，不自动升级为已验证经验。",
  create_comparison: "建立同条件的修改前后测试任务，自动保存到测试区域，固定共同需求、工程基线和经验版本，不启动制作或切换服务。",
  get_comparison: "读取比较定义及评价。评价只供检查方使用，不能提前作为制作答案。",
  record_comparison: "记录对两份真实结果的实际评价与限制，不自动打分；保存各自系统版本和实际采用经验。",
};

/** 原回执按旧参数重放；新请求固定安全模式，已保存的后台输入继续沿原语义。 */
function executionInput(name: string, input: Record<string, unknown>, raw: unknown, legacy = false) {
  if (name === "prepare_review_materials") return { ...input, mode: input.mode ?? (legacy ? "inspect_and_repair" : "materials_only") };
  if (name === "recover_work") {
    const explicitRender = raw !== null && typeof raw === "object" && Object.hasOwn(raw, "render");
    const mode = input.mode ?? (legacy || explicitRender ? input.render === false ? "reconcile_only" : "resume" : "reconcile_only");
    if (input.mode && explicitRender && input.render !== (mode === "resume")) throw new Error("mode 与旧 render 参数冲突；使用一个明确模式准备请求。");
    return { ...input, mode, render: mode === "resume" };
  }
  return input;
}

export function prepareOperation(name: string, input: Record<string, unknown>, router?: WorkRouter) {
  if (!Object.hasOwn(inputs, name) || readOnly.has(name as ToolName)) throw new Error("该工具不是可准备的写操作。");
  const request = { ...input, operationId: randomUUID() };
  const normalized = validateInput(name, inputs[name as ToolName], request);
  let productionDefaults = {};
  if (name === "produce_version") {
    const args = inputs.produce_version.parse(normalized);
    if (args.feedbackId !== undefined && args.feedbackIds !== undefined) rejectPreflight(name, new Error("feedbackId 与 feedbackIds 不能同时提供。"));
    if (args.feedbackIds && new Set(args.feedbackIds).size !== args.feedbackIds.length) rejectPreflight(name, new Error("feedbackIds 不能包含重复编号。"));
    productionDefaults = { newDirection: args.newDirection ?? false };
  }
  const args = { ...executionInput(name, { ...request, ...normalized, ...productionDefaults }, input), operationId: request.operationId };
  const capability = toolCapability(name, false, args);
  if (name === "produce_version" && router) {
    const production = inputs.produce_version.parse(args);
    try { return { name, ...prepareProduction(router.forWork(production.workId), production), capability }; }
    catch (error) { return { name, arguments: args, capability, preflight: { status: "blocked", workId: production.workId,
      blockers: [describeError(error)], note: "未受理或写入记录。" } }; }
  }
  return { name, arguments: args, capability };
}

function workView(service: WorkService, workId: string, offset = 0, limit = 20) {
  const work = service.store.read(workId), end = offset + limit;
  const active = currentExecution(service, workId);
  const versions = work.versions.slice(offset, end);
  const summary = service.store.summary({ ...work, versions, feedback: work.feedback.slice(offset, end),
    analysisRuns: work.analysisRuns?.slice(offset, end),
    assets: work.assets?.slice(offset, end), authoring: work.authoring ? { ...work.authoring,
      drafts: work.authoring.drafts.slice(offset, end), designs: work.authoring.designs.slice(offset, end),
      handoffs: work.authoring.handoffs.slice(offset, end), decisions: work.authoring.decisions.slice(offset, end), runs: work.authoring.runs.slice(offset, end) } : undefined,
    confirmations: work.confirmations?.slice(offset, end), learningBatches: work.learningBatches?.slice(offset, end) });
  const more = end < Math.max(work.versions.length, work.feedback.length, work.confirmations?.length ?? 0, work.learningBatches?.length ?? 0,
    work.assets?.length ?? 0, work.analysisRuns?.length ?? 0, ...Object.values(work.authoring ?? {}).map(items => items.length));
  const pending = service.learning.pending(work, false);
  return { ...summary, delivery: service.store.delivery(work), feedbackDirectory: service.store.resolvePath("works/" + workId + "/feedback"),
    feedback: feedbackView(work, summary.feedback), storagePurpose: service.store.purpose,
    activeExecutionId: active?.operationId,
    coverage: more ? "partial" : "complete", nextOffset: more ? end : null,
    counts: { versions: work.versions.length, feedback: work.feedback.length, confirmations: work.confirmations?.length ?? 0,
      analysisRuns: work.analysisRuns?.length ?? 0,
      assets: work.assets?.length ?? 0, drafts: work.authoring?.drafts.length ?? 0, designs: work.authoring?.designs.length ?? 0 },
    learning: { ...pending, items: pending.items.map(item => ({ id: item.id, kind: item.kind, versionId: item.versionId, documentRef: item.documentRef })) } };
}

/** CLI 与 MCP 共用校验、原操作回执和业务实现。 */
export async function executeTool(name: string, input: unknown, context?: WorkRouter | WorkService): Promise<unknown> {
  const receivedAt = new Date().toISOString();
  const target = context ?? new WorkRouter();
  const result = await execute(name, input, target, true, receivedAt);
  if (name === "get_execution" || name === "cancel_execution") {
    const router = target instanceof WorkRouter ? target : new WorkRouter(target.store.assetRoot);
    const args = z.object({ executionId: operationIdSchema }).parse(input);
    const timing = new ExecutionStore(router.assetRoot).recordReturn(args.executionId, result as { status: string; updatedAt: string });
    return { ...(result as Record<string, unknown>), timing };
  }
  if (name === "get_work") {
    const router = target instanceof WorkRouter ? target : new WorkRouter(target.store.assetRoot);
    const executions = new ExecutionStore(router.assetRoot);
    const timingVersion = z.object({ operationId: operationIdSchema.optional(), production: z.string() });
    const view = z.object({ id, versions: z.array(timingVersion).optional(), latestVersion: timingVersion.optional() }).passthrough().parse(result);
    const executionTimings: Record<string, unknown> = {};
    for (const version of view.versions ?? (view.latestVersion ? [view.latestVersion] : [])) {
      if (!version.operationId || !executions.exists(version.operationId)) continue;
      const state = executions.view(version.operationId);
      if (state.workId !== view.id) throw new Error("执行计时与查询作品不一致。");
      if (["creating", "rendering", "unknown"].includes(version.production) || (state.status === "succeeded" && version.production !== "ready")) continue;
      const timing = executions.recordReturn(version.operationId, state);
      if (timing) executionTimings[version.operationId] = timing;
    }
    return { ...(result as Record<string, unknown>), executionTimings };
  }
  return result;
}

/** 业务回归的进程内入口；对外 MCP 和 CLI 始终通过 executeTool 受理耗时工作。 */
export async function executeToolInline(name: string, input: unknown, context: WorkRouter | WorkService): Promise<unknown> {
  return execute(name, input, context, false);
}

async function execute(name: string, input: unknown, context: WorkRouter | WorkService, background: boolean, receivedAt?: string): Promise<unknown> {
  if (!Object.hasOwn(inputs, name)) throw new Error("未知工具：" + name);
  const router = context instanceof WorkRouter ? context : new WorkRouter(context.store.assetRoot,
    store => store.purpose === context.store.purpose ? context : new WorkService(store));
  const tool = name as ToolName, parsed = validateInput(name, inputs[tool], input);
  const operationId = readOnly.has(tool) ? undefined : z.object({ operationId: operationIdSchema }).parse(parsed).operationId;
  if (operationId) {
    const existing = router.operation(operationId);
    if (existing) {
      // 旧创建请求没有用途字段；明确补齐原区域后允许查询同一回执，不迁移或重做。
      let request: unknown = parsed;
      if (tool === "create_work" && !existing.record.purpose) {
        const { purpose, ...previousShape } = inputs.create_work.parse(parsed);
        if (purpose === existing.purpose && valueHash(previousShape) === existing.record.inputHash) request = previousShape;
      }
      if (tool === "recover_work") {
        const args = inputs.recover_work.parse(parsed);
        // 旧协议为省略 render 的请求补 true；仅匹配已保存的原摘要，不影响新请求的安全默认。
        if (args.mode === undefined && args.render === undefined && valueHash({ ...args, render: true }) === existing.record.inputHash) {
          request = { ...args, render: true };
        }
      }
      return existing.store.replay(operationId, tool, request);
    }
  }
  const effective = executionInput(tool, parsed, input);
  let service: WorkService;
  try {
    service = "workId" in parsed ? router.forWork(parsed.workId) :
      tool === "create_work" ? router.service(inputs.create_work.parse(parsed).purpose) :
      ["create_comparison", "get_comparison", "record_comparison"].includes(tool) ? router.service("test") : router.service("production");
  } catch (error) { if (operationId) rejectPreflight(name, error); throw error; }
  if (!operationId) return perform(tool, parsed, service, router);
  try {
    if (tool === "create_work") {
      const args = inputs.create_work.parse(parsed); service.documents.validateDraftInput(args.brief, args.submission);
    }
    if (["submit_draft", "handoff_draft", "review_design"].includes(tool)) {
      const args = z.object({ workId: id }).parse(parsed);
      assertExecutionAccess(service.store.dataRoot, args.workId);
      service.assertCanProduce(service.store.read(args.workId), "sample");
    }
    if (tool === "submit_draft") {
      const args = inputs.submit_draft.parse(parsed), record = service.store.read(args.workId);
      service.documents.validateSubmission(record, args.basedOn, args.assetIds);
      service.documents.validateDraftInput(args.markdown, args.submission, record, args.basedOn);
    }
    if (tool === "handoff_draft") {
      const args = inputs.handoff_draft.parse(parsed); service.documents.validateHandoff(service.store.read(args.workId), args.draft);
    }
    if (tool === "review_design") {
      const args = inputs.review_design.parse(parsed); service.documents.validateDecision(service.store.read(args.workId), args.design, args.status);
    }
    if (tool === "revise_draft" || tool === "review_draft" || tool === "design_video") {
      const args = inputs[tool].parse(parsed);
      service.authoring.validate(service.store.read(args.workId), tool === "design_video" ? "design" : tool, args.base);
    }
    if (tool === "generate_image") {
      const args = inputs.generate_image.parse(parsed); service.assets.validate(service.store.read(args.workId), { ...args, kind: "image" });
    }
    if (tool === "generate_music") {
      const args = inputs.generate_music.parse(parsed); service.assets.validate(service.store.read(args.workId), { ...args, kind: "music" });
    }
    if (tool === "generate_sound_effect") {
      const args = inputs.generate_sound_effect.parse(parsed); service.assets.validate(service.store.read(args.workId), { ...args, kind: "sound_effect" });
    }
    if (tool === "synthesize_speech") {
      const args = inputs.synthesize_speech.parse(parsed); service.assets.validate(service.store.read(args.workId), { ...args, kind: "speech" });
    }
    if (tool === "prepare_review_materials") {
      const args = inputs.prepare_review_materials.parse(parsed), record = service.store.read(args.workId);
      service.store.assertAvailable(service.store.version(record, args.versionId));
    }
    if (tool === "produce_version") {
      const args = inputs.produce_version.parse(parsed), record = service.store.read(args.workId);
      const active = activeExecution(service.store.dataRoot, args.workId);
      if (active) {
        const executions = new ExecutionStore(router.assetRoot), original = executions.read(active.operationId);
        if (original.workId !== args.workId || original.purpose !== service.store.purpose) throw new Error("后台占用与任务归属不一致，停止交接。");
        const outcome = executions.outcome(original);
        if (!outcome || outcome.status === "unknown") throw new Error("作品已有后台执行：" + active.operationId + "。请用 get_execution 查询原编号，核清前不能重复提交。");
      }
      selectProduction(service.store, record, args.kind, args.feedbackId, args.threadMode, args.baseVersionId, args.baseReason, args);
    }
    if (["submit_feedback", "confirm_version", "record_review", "render_version"].includes(tool)) {
      const args = z.object({ workId: id, versionId }).parse(parsed), record = service.store.read(args.workId);
      const version = service.store.version(record, args.versionId);
      if (tool === "confirm_version") {
        const confirmation = inputs.confirm_version.parse(parsed);
        if (confirmation.kind === "direction" && (!confirmation.scope?.trim() || version.kind !== "sample")) throw new Error("方向确认须关联样例版本，并提供非空 scope 与用户确认原话。");
        if (confirmation.kind === "acceptance" && version.kind !== "complete") throw new Error("成片认可须关联完整作品版本。");
      }
      if (["confirm_version", "record_review"].includes(tool)) {
        if (version.production !== "ready") throw new Error("只能确认或审查已实际生成的作品版本。");
        service.store.assertAvailable(version);
      }
      if (tool === "record_review") {
        const review = inputs.record_review.parse(parsed);
        if (review.coverage) validateReviewCoverage(review.coverage, version.technicalCheck?.durationSeconds);
      }
      if (tool === "submit_feedback") {
        service.store.validateFeedbackLocation(record, args.versionId, inputs.submit_feedback.parse(parsed).location);
        service.store.validateFeedbackReferences(record, inputs.submit_feedback.parse(parsed).supersedes);
      }
      if (tool === "render_version") {
        service.assertCanProduce(record, "sample");
        if (["unknown", "blocked", "creating"].includes(version.production) || (version.agentResult && version.agentResult.status !== "completed")) throw new Error("尚无已确认完成的源码，不能直接重渲染。");
        service.store.verifySource(version);
      }
    }
  } catch (error) { rejectPreflight(name, error); }
  if (background && backgroundToolSchema.safeParse(tool).success) {
    const request = z.object({ operationId: operationIdSchema, workId: id }).passthrough().parse(parsed);
    return router.operations.execute(operationId, name, parsed,
      () => new BackgroundService(router).submit(backgroundToolSchema.parse(tool), request, receivedAt, effective), service.store.purpose, "accepted", receivedAt);
  }
  return router.operations.execute(operationId, name, parsed, () => perform(tool, effective, service, router),
    ["save_experience", "cancel_execution"].includes(tool) ? undefined : service.store.purpose, "succeeded", receivedAt);
}

/** 已领取的本机工作进程执行原动作，不再次受理或创建第二份操作回执。 */
export async function runBackgroundAction(name: string, input: unknown, router: WorkRouter): Promise<unknown> {
  const tool = backgroundToolSchema.parse(name), args = inputs[tool].parse(input);
  return perform(tool, executionInput(tool, args, input, true), router.forWork(args.workId), router);
}

async function perform(name: ToolName, input: unknown, service: WorkService, router: WorkRouter): Promise<unknown> {
  const store = service.store;
  switch (name) {
    case "read_usage_guide": { const args = inputs.read_usage_guide.parse(input);
      const capabilities = (Object.keys(inputs) as ToolName[]).map(tool => toolCapability(tool, readOnly.has(tool)));
      const guide = readUsageGuide(args.document, args.section, args.view, capabilityTable(capabilities));
      return args.document === "usage" && args.section === "工具执行契约" ? { ...guide, tools: capabilities } : guide; }
    case "get_runtime_info": return { assetRoot: router.assetRoot, workRoots: router.workRoots,
      models: configuration.models,
      mediaServices: { gptImageConfigured: Boolean(configuration.providers.image), doubaoSpeechConfigured: Boolean(configuration.providers.speech),
        musicConfigured: Boolean(configuration.providers.music), soundEffectConfigured: Boolean(configuration.providers.sound_effect) },
      voices: configuredVoices(configuration.providers),
      assetLibraries: configuration.assetLibraries,
      assetIndexPath: join(router.assetRoot, "library", "index.json"),
      audioInspection: "manual",
      knowledgeRoot: service.knowledge.root, scopeIds: router.scopes(), systemFingerprint: systemFingerprint(),
      executionMode: "background", usageGuideTool: "read_usage_guide" };
    case "get_execution": return new BackgroundService(router).view(inputs.get_execution.parse(input).executionId);
    case "cancel_execution": { const args = inputs.cancel_execution.parse(input); return new BackgroundService(router).stop(args.executionId, args.reason); }
    case "prepare_operation": { const args = inputs.prepare_operation.parse(input); return prepareOperation(args.name, args.arguments, router); }
    case "get_operation": {
      const args = inputs.get_operation.parse(input), existing = router.operation(args.operationId, args.purpose);
      if (!existing) throw new Error("未找到原操作回执；请核对编号和资产总目录，不要改号重发。");
      return existing.record;
    }
    case "list_works": {
      const args = inputs.list_works.parse(input), selected = args.purpose === "all" ? ["production", "test"] as const : [args.purpose];
      const works = selected.flatMap(purpose => router.service(purpose).store.list().map(work => ({ ...work, storagePurpose: purpose })))
        .sort((a, b) => a.id.localeCompare(b.id) || a.storagePurpose.localeCompare(b.storagePurpose));
      const end = args.offset + args.limit;
      return { works: works.slice(args.offset, end), nextOffset: end < works.length ? end : null, coverage: end < works.length ? "partial" : "complete" };
    }
    case "create_work": {
      const args = inputs.create_work.parse(input), work = store.create(args.title, args.brief, args.operationId, undefined, true);
      await store.withLock(work.id, () => service.documents.initialize(store.read(work.id), args.brief, args.operationId, args.submission));
      return workView(service, work.id);
    }
    case "submit_draft": { const args = inputs.submit_draft.parse(input); return service.documents.submit(args.workId, args.markdown, args.operationId, args.instruction, args.basedOn, args.assetIds, args.submission); }
    case "read_document": { const args = inputs.read_document.parse(input); return service.documents.read(store.read(args.workId), args.ref); }
    case "get_asset": { const args = inputs.get_asset.parse(input); return service.assets.assets.view(store.read(args.workId), args.assetId); }
    case "search_assets": { const args = inputs.search_assets.parse(input); return new AssetCatalog(router.service(args.purpose).store).search(args); }
    case "import_asset": { const args = inputs.import_asset.parse(input);
      if (args.document) service.documents.document(store.read(args.workId), args.document);
      return service.assets.assets.import(args.workId, args.path, args.role, args.description, args.operationId, args.document, service.assets.options.signal, args.voice); }
    case "generate_image": { const args = inputs.generate_image.parse(input); return service.assets.generate(args.workId, { ...args, kind: "image" }, args.operationId); }
    case "generate_music": { const args = inputs.generate_music.parse(input); return service.assets.generate(args.workId, { ...args, kind: "music" }, args.operationId); }
    case "generate_sound_effect": { const args = inputs.generate_sound_effect.parse(input); return service.assets.generate(args.workId, { ...args, kind: "sound_effect" }, args.operationId); }
    case "synthesize_speech": { const args = inputs.synthesize_speech.parse(input); return service.assets.generate(args.workId, { ...args, kind: "speech" }, args.operationId); }
    case "read_speech_text": { const args = inputs.read_speech_text.parse(input); return { design: args.design,
      segments: speechSegments(service.documents.read(store.read(args.workId), args.design).markdown) }; }
    case "get_review_materials": { const args = inputs.get_review_materials.parse(input), work = store.read(args.workId); return service.reviewMaterials.view(work, store.version(work, args.versionId)); }
    case "read_media_image": {
      const args = inputs.read_media_image.parse(input), work = store.read(args.workId);
      let path: string, sha256: string, mimeType: string;
      if (args.source.kind === "asset") {
        const asset = service.assets.assets.get(work, args.source.assetId);
        if (!asset.mimeType.startsWith("image/")) throw new Error("该素材不是图片。");
        path = asset.path; sha256 = asset.sha256; mimeType = asset.mimeType;
      } else {
        const source = args.source, version = store.version(work, source.versionId); store.assertAvailable(version);
        const ref = version.reviewPreparation?.batches.find(item => item.path === source.indexRef);
        if (!ref || fileHash(store.resolvePath(ref.path)) !== ref.sha256) throw new Error("审查索引不存在、已变化或不属于此版本。");
        const batch = readReviewBatch(dirname(store.resolvePath(ref.path)), version.videoSha256!);
        const item = [...batch.frames, ...batch.sheets].find(item => item.path === source.imagePath);
        if (!item) throw new Error("图片不在本批审查索引中。");
        path = join(dirname(ref.path), item.path); sha256 = item.sha256; mimeType = "image/png";
      }
      const bytes = readFileSync(store.resolvePath(path));
      if (bytes.length > 8 * 1024 * 1024) throw new Error("图片超过本 MCP 图像消息上限，请通过已有本机查看能力读取原文件。");
      return { workId: work.id, source: args.source, location: store.resolvePath(path), sha256, mimeType, data: bytes.toString("base64") };
    }
    case "prepare_review_materials": { const args = inputs.prepare_review_materials.parse(input);
      return service.prepareMaterials(args.workId, args.versionId, args.ranges, args.operationId, args.mode); }
    case "handoff_draft": { const args = inputs.handoff_draft.parse(input); return service.documents.handoff(args.workId, args.draft, args.userInstruction, args.operationId); }
    case "review_design": { const { workId, ...args } = inputs.review_design.parse(input); return service.documents.decide(workId, args); }
    case "revise_draft": case "review_draft": case "design_video": {
      const args = inputs[name].parse(input);
      return service.authoring.generate(args.workId, name === "design_video" ? "design" : name, args.base, args.instruction, args.operationId,
        name === "review_draft" ? undefined : inputs[name].parse(input).assetIds);
    }
    case "get_work": { const args = inputs.get_work.parse(input);
      if (args.section) return workSection(service, args.workId, args.section, args.offset, args.limit);
      return args.view === "detail" ? workView(service, args.workId, args.offset, args.limit) : workSummary(service, args.workId); }
    case "produce_version": {
      const args = inputs.produce_version.parse(input);
      await service.produce(args.workId, args.kind, args.feedbackId, args.threadMode, args.baseVersionId, args.baseReason, args.operationId, args);
      return workView(service, args.workId);
    }
    case "render_version": { const args = inputs.render_version.parse(input); await service.renderExisting(args.workId, args.versionId); return workView(service, args.workId); }
    case "recover_work": {
      const args = inputs.recover_work.parse(input), recovered = await service.recover(args.workId, args.mode === "resume");
      const work = store.read(args.workId);
      const operationId = "operationId" in recovered && typeof recovered.operationId === "string" ? recovered.operationId : undefined;
      const version = operationId ? work.versions.filter(item => (item.reviewPreparation?.operationId ?? item.operationId) === operationId).at(-1) : undefined;
      let result: unknown, status: "succeeded" | "waiting_input" | "failed" | undefined;
      if ("kind" in recovered) {
        if (recovered.kind === "authoring") {
          result = recovered.result;
          status = recovered.result.status === "completed" ? "succeeded" : recovered.result.status === "needs_input" ? "waiting_input" : "failed";
        } else if (recovered.status === "recovered") {
          result = recovered.asset; status = "succeeded";
        } else if (recovered.status === "failed") {
          result = { status: "failed", error: recovered.message }; status = "failed";
        }
      } else if (recovered.status === "recovered" && ["idle", "waiting_input"].includes(work.execution.status) && version?.production === "ready" &&
          store.availability(version).status === "available") {
        result = workView(service, work.id);
        status = work.execution.status === "waiting_input" ? "waiting_input" : "succeeded";
      }
      if (operationId && status) {
        const original = router.operation(operationId, store.purpose);
        if (!original) throw new Error("结果已恢复，但原操作回执缺失，仍需核对原编号。");
        original.store.completeRecovery(operationId, work.id, result);
        new ExecutionStore(router.assetRoot).recordRecovery(operationId, work.id, result, status, status === "failed" ? work.execution.error : undefined);
      }
      return { ...recovered, mode: args.mode };
    }
    case "submit_feedback": { const args = inputs.submit_feedback.parse(input); await store.feedback(args.workId, args.versionId, args.text, args.source, args.changesDirection, args.location, args.operationId, args.supersedes); return workView(service, args.workId); }
    case "record_review": { const args = inputs.record_review.parse(input); await store.review(args.workId, args.versionId, args.status, args.notes, args.source, args.materialIndexes, args.coverage); return workView(service, args.workId); }
    case "confirm_version": { const args = inputs.confirm_version.parse(input); await store.confirm(args.workId, args.versionId, args.kind, args.userConfirmation, args.scope); return workView(service, args.workId); }
    case "search_experience": { const args = inputs.search_experience.parse(input); return service.knowledge.search(args.query, args.offset, args.limit); }
    case "read_experience": { const ref = inputs.read_experience.parse(input); return { ref, experience: service.knowledge.read(ref) }; }
    case "save_experience": { const args = inputs.save_experience.parse(input); return service.knowledge.save(args.experience, { id: args.id, expectedRevision: args.expectedRevision }); }
    case "learning_status": { const work = store.read(inputs.learning_status.parse(input).workId); return { pending: service.learning.pending(work), batches: work.learningBatches ?? [], pendingSave: work.learningPending, error: work.learningError }; }
    case "organize_experience": { const args = inputs.organize_experience.parse(input); await service.organize(args.workId); return workView(service, args.workId); }
    case "publish_test_experience": {
      const args = inputs.publish_test_experience.parse(input);
      await store.withLock(args.workId, () => { const work = store.read(args.workId); service.learning.publishStaged(work); });
      return workView(service, args.workId);
    }
    case "create_comparison": { const args = inputs.create_comparison.parse(input); return service.comparisons.create(args.comparison, args.operationId); }
    case "get_comparison": return service.comparisons.read(inputs.get_comparison.parse(input).comparisonId);
    case "record_comparison": { const { comparisonId, operationId: _operationId, ...args } = inputs.record_comparison.parse(input); return service.comparisons.evaluate(comparisonId, args); }
  }
}

export function startMcpServer(): void {
  console.log = (...args: unknown[]) => console.error(...args);
  const router = new WorkRouter();
  serveStdio(() => {
    const server = new McpServer({ name: "intentframe", version: "0.6.0" }, { instructions: serverInstructions });
    for (const name of Object.keys(inputs) as ToolName[]) {
      const capability = toolCapability(name, readOnly.has(name));
      const executionDescription = capability.execution === "background" ? "后台执行：先返回 accepted/executionId，用 get_execution 查询最终结果。" : "本次调用直接返回结果。";
      server.registerTool(name, { description: executionDescription + descriptions[name] + " 模型调用：" + capability.modelUsage + "。", inputSchema: inputs[name],
        annotations: { readOnlyHint: readOnly.has(name), destructiveHint: false } }, async (args: unknown) => {
        try {
          const result = await executeTool(name, args, router);
          if (name === "read_media_image") {
            const { data, mimeType, ...metadata } = z.object({ data: z.string(), mimeType: z.string() }).passthrough().parse(result);
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...metadata, mimeType }) }, { type: "image" as const, data, mimeType }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        catch (error) { return { isError: true, content: [{ type: "text" as const, text: describeError(error) }] }; }
      });
    }
    return server;
  }, { onerror: error => console.error(describeError(error)) });
}
