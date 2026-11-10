import { randomUUID } from "node:crypto";
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
import { ExecutionStore, activeExecution, backgroundToolSchema } from "../records/execution-store.ts";
import { BackgroundService } from "../runtime/background-service.ts";
import { readUsageGuide, serverInstructions } from "../runtime/usage-guide.ts";
import { rejectPreflight, validateInput } from "./request-errors.ts";
import { feedbackAppliedByVersion, selectProduction } from "../runtime/production-selection.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const versionId = z.string().regex(/^v\d{3,}$/);
const text = z.string().min(1).max(30_000).refine(value => value.trim().length > 0, "内容不能仅为空白。");
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) };
const write = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...shape, operationId: operationIdSchema });
export const inputs = {
  read_usage_guide: z.strictObject({ document: z.enum(["usage", "workflow", "data"]).default("usage"), section: z.string().trim().min(1).max(120).optional() }),
  get_runtime_info: z.strictObject({}),
  get_execution: z.strictObject({ executionId: operationIdSchema }),
  cancel_execution: write({ executionId: operationIdSchema, reason: text.max(1_000).default("用户要求停止当前执行。") }),
  prepare_operation: z.strictObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  get_operation: z.strictObject({ operationId: operationIdSchema, purpose: purposeSchema.optional().describe("仅在旧区域存在相同操作编号时，用于明确查询哪一份原回执；不切换服务或任务用途。") }),
  list_works: z.strictObject({ ...page, purpose: z.enum(["production", "test", "all"]).default("production") }),
  create_work: write({ ...workInputSchema.shape,
    purpose: purposeSchema.describe("根据用户明确要求选择 test（测试制作）或 production（正式制作）；无法判断时先询问。与 sample/complete 制作阶段分别判断。") }),
  get_work: z.strictObject({ workId: id, ...page }),
  produce_version: write({ workId: id, kind: z.enum(["sample", "complete"]),
    feedbackId: text.max(100).optional(), feedbackIds: z.array(text.max(100)).max(1_000).optional().describe("明确本轮处理的反馈编号，空数组表示不处理；不能与 feedbackId 同时提供。"),
    newDirection: z.boolean().optional().describe("true 从所选基线创建备选样例；false 或省略沿用原方向，不撤销原确认。"), threadMode: z.enum(["fresh", "resume"]).default("fresh"),
    baseVersionId: versionId.optional(), baseReason: text.optional() }),
  render_version: write({ workId: id, versionId }),
  recover_work: write({ workId: id, render: z.boolean().default(true) }),
  submit_feedback: write({ workId: id, versionId, text: text.max(10_000),
    source: z.enum(["user", "external_ai", "internal_check", "system_test"]), changesDirection: z.boolean().default(false),
    supersedes: z.array(text.max(100)).max(1_000).optional().describe("本次原话明确替代或取消的旧反馈编号；保留原文，旧项不再自动进入新制作。"),
    location: feedbackLocationSchema.optional() }),
  record_review: write({ workId: id, versionId, status: z.enum(["needs_changes", "passed"]), notes: text,
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
  "search_experience", "read_experience", "learning_status", "get_comparison"]);
const descriptions: Record<ToolName, string> = {
  read_usage_guide: "开始使用前读取 usage 指南，按需读取 workflow 制作规则或 data 数据规则的明确章节。只返回项目说明及版本，不读取任意文件。按指南处理位置、用途、编号和后台查询，用户只需表达视频要求。",
  get_runtime_info: "只读核对资产总目录、正式与测试区域、共享经验位置和系统版本。同一入口服务两类任务，用途在创建任务时选择。",
  get_execution: "按 executionId 查询原后台执行阶段、实际选择及结果；succeeded 查看结果，waiting_input 需补信息，unknown 须核对恢复。timing 记录项目接收至首次最终返回，重复查询不重置。",
  cancel_execution: "按用户明确要求保存停止请求；未领取的任务可以取消，正在执行的任务须继续查询实际停止结果。停止请求已保存不等于已经停止，也不代表原任务没有产生结果。",
  prepare_operation: "为一次新写操作生成并校验请求格式，回显参数及技术默认值；不查询作品或执行业务。保存返回的 arguments 后调用目标工具，原样重试沿用原 operationId。",
  get_operation: "按原编号读取操作回执，兼容旧区域。未取得最终回执时查询原任务，不换编号重新制作。",
  list_works: "按 purpose 分页查作品：默认 production，test 查测试，all 查两类。筛选只影响列表，不改变后续任务的用途。",
  create_work: "保存原始需求，将用途绑定到新任务。用户要求测试则传 purpose=test，要求正式制作则传 production；意图不明时先询问，不根据环境或样例阶段猜用途。operationId 不随重试改变。",
  get_work: "按作品编号定位区域，分页查看版本及已合并的追加反馈，返回文件入口和当前状态；nextOffset 不为空时继续查询。处理版本与替代关系分别返回，不把收到反馈当作已应用。",
  produce_version: "核对前置条件后受理并冻结本轮输入，返回 executionId 和实际 selection，随后查询。feedbackIds=[] 不处理反馈，数组可选一条或多条；newDirection=true 仅创建备选样例。默认沿已确认方向接续，旧范围不明须明确选择；完整制作须真实方向确认，会使用模型额度。",
  render_version: "提交已有完成工程的后台渲染，返回 executionId 后查询。不会再次调用模型或覆盖已就绪版本。",
  recover_work: "提交对原任务的后台核对与补存，可继续已完成工程的渲染；返回 executionId 后查询。不会重发制作；原进程仍运行或依据不足时保留保护。",
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

export function prepareOperation(name: string, input: Record<string, unknown>) {
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
  return { name, arguments: { ...request, ...normalized, ...productionDefaults } };
}

function workView(service: WorkService, workId: string, offset = 0, limit = 20) {
  const work = service.store.read(workId), end = offset + limit;
  const active = activeExecution(service.store.dataRoot, workId);
  if (active) {
    const request = new ExecutionStore(service.store.assetRoot).read(active.operationId);
    if (request.workId !== workId || request.purpose !== service.store.purpose) throw new Error("后台占用与任务归属不一致。");
  }
  const versions = work.versions.slice(offset, end);
  const summary = service.store.summary({ ...work, versions, feedback: work.feedback.slice(offset, end),
    confirmations: work.confirmations?.slice(offset, end), learningBatches: work.learningBatches?.slice(offset, end) });
  const more = end < Math.max(work.versions.length, work.feedback.length, work.confirmations?.length ?? 0, work.learningBatches?.length ?? 0);
  const pending = service.learning.pending(work);
  return { ...summary, feedbackDirectory: service.store.resolvePath("works/" + workId + "/feedback"), feedback: summary.feedback.map(f => ({ ...f,
    supersededByFeedbackIds: work.feedback.filter(next => next.supersedes?.includes(f.id)).map(next => next.id),
    appliedInVersionIds: work.versions.filter(v => feedbackAppliedByVersion(v).includes(f.id)).map(v => v.id) })), storagePurpose: service.store.purpose,
    activeExecutionId: active?.operationId,
    coverage: more ? "partial" : "complete", nextOffset: more ? end : null,
    counts: { versions: work.versions.length, feedback: work.feedback.length, confirmations: work.confirmations?.length ?? 0 },
    learning: { ...pending, items: pending.items.map(item => ({ id: item.id, kind: item.kind, versionId: item.versionId })) } };
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
    const view = z.object({ id, versions: z.array(z.object({ operationId: operationIdSchema.optional(), production: z.string() })) }).passthrough().parse(result);
    const executionTimings: Record<string, unknown> = {};
    for (const version of view.versions) {
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
      return existing.store.replay(operationId, tool, request);
    }
  }
  let service: WorkService;
  try {
    service = "workId" in parsed ? router.forWork(parsed.workId) :
      tool === "create_work" ? router.service(inputs.create_work.parse(parsed).purpose) :
      ["create_comparison", "get_comparison", "record_comparison"].includes(tool) ? router.service("test") : router.service("production");
  } catch (error) { if (operationId) rejectPreflight(name, error); throw error; }
  if (!operationId) return perform(tool, parsed, service, router);
  try {
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
      () => new BackgroundService(router).submit(backgroundToolSchema.parse(tool), request, receivedAt), service.store.purpose, "accepted", receivedAt);
  }
  return router.operations.execute(operationId, name, parsed, () => perform(tool, parsed, service, router),
    ["save_experience", "cancel_execution"].includes(tool) ? undefined : service.store.purpose, "succeeded", receivedAt);
}

/** 已领取的本机工作进程执行原动作，不再次受理或创建第二份操作回执。 */
export async function runBackgroundAction(name: string, input: unknown, router: WorkRouter): Promise<unknown> {
  const tool = backgroundToolSchema.parse(name), args = inputs[tool].parse(input);
  return perform(tool, args, router.forWork(args.workId), router);
}

async function perform(name: ToolName, input: unknown, service: WorkService, router: WorkRouter): Promise<unknown> {
  const store = service.store;
  switch (name) {
    case "read_usage_guide": { const args = inputs.read_usage_guide.parse(input); return readUsageGuide(args.document, args.section); }
    case "get_runtime_info": return { assetRoot: router.assetRoot, workRoots: router.workRoots,
      knowledgeRoot: service.knowledge.root, scopeIds: router.scopes(), systemFingerprint: systemFingerprint(),
      executionMode: "background", usageGuideTool: "read_usage_guide" };
    case "get_execution": return new BackgroundService(router).view(inputs.get_execution.parse(input).executionId);
    case "cancel_execution": { const args = inputs.cancel_execution.parse(input); return new BackgroundService(router).stop(args.executionId, args.reason); }
    case "prepare_operation": { const args = inputs.prepare_operation.parse(input); return prepareOperation(args.name, args.arguments); }
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
    case "create_work": { const args = inputs.create_work.parse(input); return store.summary(store.create(args.title, args.brief, args.operationId)); }
    case "get_work": { const args = inputs.get_work.parse(input); return workView(service, args.workId, args.offset, args.limit); }
    case "produce_version": {
      const args = inputs.produce_version.parse(input);
      await service.produce(args.workId, args.kind, args.feedbackId, args.threadMode, args.baseVersionId, args.baseReason, args.operationId, args);
      return workView(service, args.workId);
    }
    case "render_version": { const args = inputs.render_version.parse(input); await service.renderExisting(args.workId, args.versionId); return workView(service, args.workId); }
    case "recover_work": {
      const args = inputs.recover_work.parse(input), recovered = await service.recover(args.workId, args.render);
      const work = store.read(args.workId), version = work.versions.at(-1);
      if (recovered.status === "recovered" && version?.production === "ready" && version.operationId &&
          store.availability(version).status === "available") {
        const original = router.operation(version.operationId, store.purpose);
        if (!original) throw new Error("作品已恢复，但原操作回执缺失，仍需核对原编号。");
        original.store.completeRecovery(version.operationId, work.id, workView(service, work.id));
        new ExecutionStore(router.assetRoot).recordRecovery(version.operationId, work.id, workView(service, work.id));
      }
      return recovered;
    }
    case "submit_feedback": { const args = inputs.submit_feedback.parse(input); await store.feedback(args.workId, args.versionId, args.text, args.source, args.changesDirection, args.location, args.operationId, args.supersedes); return workView(service, args.workId); }
    case "record_review": { const args = inputs.record_review.parse(input); await store.review(args.workId, args.versionId, args.status, args.notes, args.source); return workView(service, args.workId); }
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
    const server = new McpServer({ name: "intentframe", version: "0.5.0" }, { instructions: serverInstructions });
    for (const name of Object.keys(inputs) as ToolName[]) {
      server.registerTool(name, { description: descriptions[name], inputSchema: inputs[name],
        annotations: { readOnlyHint: readOnly.has(name), destructiveHint: false } }, async (args: unknown) => {
        try { return { content: [{ type: "text" as const, text: JSON.stringify(await executeTool(name, args, router)) }] }; }
        catch (error) { return { isError: true, content: [{ type: "text" as const, text: describeError(error) }] }; }
      });
    }
    return server;
  }, { onerror: error => console.error(describeError(error)) });
}
