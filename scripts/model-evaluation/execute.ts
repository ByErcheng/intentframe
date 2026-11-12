import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { configuration } from "../../src/config.ts";
import { WorkStore } from "../../src/records/work-store.ts";
import { WorkService } from "../../src/runtime/work-service.ts";
import { systemFingerprint } from "../../src/runtime/context.ts";
import { MAX_INTERNAL_REPAIRS } from "../../src/records/media-contracts.ts";
import { mediaCommand, mediaBinaries } from "../../src/media/render.ts";
import { prepareAssetPhase } from "./asset-phase.ts";
import { inspectVisualPhase } from "./visual-phase.ts";
import { buildPlan, hash, inside, readJson, readPlan, repoRoot, variantSchema, writeNew } from "./plan.ts";

const bindingSchema = z.strictObject({ caseId: z.string(), inputSha256: z.string().regex(/^[a-f0-9]{64}$/), dataRoot: z.string().min(1), workId: z.string().min(1),
  treeSha256: z.string().regex(/^[a-f0-9]{64}$/), versionId: z.string().optional(), feedbackIds: z.array(z.string()).optional(),
  verifiedBy: z.string().trim().min(1), verifiedAt: z.iso.datetime(), observations: z.string().trim().min(1) });
const originalMediaBudgets = { ...configuration.media };
/** 摘要覆盖实际文件字节；拒绝链接和特殊文件，不把目录名当作已验证材料。 */
export function treeHash(root: string): string {
  const entries: [string, string][] = [];
  function visit(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("基线中含符号链接，须先准备独立的普通文件快照");
      if (stat.isDirectory()) visit(path, relative + "/");
      else if (stat.isFile()) entries.push([relative, hash(readFileSync(path))]);
      else throw new Error("基线中含特殊文件");
    }
  }
  visit(realpathSync(root), ""); return hash(JSON.stringify(entries));
}
function compareOrSave(path: string, value: unknown) {
  if (existsSync(path)) { if (hash(JSON.stringify(readJson(path))) !== hash(JSON.stringify(value))) throw new Error("本轮共同条件已变化：" + path); }
  else writeNew(path, value);
}

export async function executeRun(roundDirectory: string, runId: string, bindingFile?: string, testRuntime?: { executable: string }) {
  const roundRoot = realpathSync(roundDirectory);
  if (inside(realpathSync(repoRoot), roundRoot)) throw new Error("真实比较不能在系统仓库中执行");
  const plan = readPlan(roundRoot);
  // 只调整当前测试进程的显式预算，不写本机配置，也不将上一次调用的覆盖值继承给其他轮次。
  Object.assign(configuration.media, originalMediaBudgets, {
    probeTimeoutMs: plan.round.limits.mediaProbeMs ?? originalMediaBudgets.probeTimeoutMs,
    decodeTimeoutMs: plan.round.limits.mediaDecodeMs ?? originalMediaBudgets.decodeTimeoutMs,
    previewTimeoutMs: plan.round.limits.mediaPreviewMs ?? originalMediaBudgets.previewTimeoutMs,
  });
  const run = plan.runs.find(r => r.id === runId);
  if (!run || !/^run-[a-f0-9-]+$/.test(runId)) throw new Error("找不到该运行编号");
  const item = plan.cases.find(c => c.id === run.caseId), variant = plan.round.variants.find(v => v.id === run.variantId);
  if (!item || !variant || run.requestedModel !== variant.model || run.requestedEffort !== variant.effort) throw new Error("运行与输入配置不一致");
  variantSchema.parse(variant);
  // 核对清单与输入快照；变更测试规则须另开一轮，不能沿用原身份。
  const current = buildPlan(plan.round).cases.find(c => c.id === item.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(item)) throw new Error("测试案例或执行清单已变化，须另开轮次");
  const directory = resolve(roundRoot, runId), dataRoot = resolve(directory, "work-data");
  if (realpathSync(directory) !== directory || realpathSync(dataRoot) !== dataRoot) throw new Error("候选目录不能通过链接重定向");
  const input = readFileSync(resolve(directory, "input.md"), "utf8");
  if (hash(input) !== item.inputSha256) throw new Error("冻结的输入正文已变化");
  if (existsSync(resolve(directory, "execution.json"))) throw new Error("该编号已有执行尝试；查询或恢复原任务，不能直接重跑");

  let binding: z.infer<typeof bindingSchema> | undefined;
  const feedbackCase = item.requires.includes("fixed_feedback");
  if (["inspect_only", "inspect_visuals", "organize_experience"].includes(item.operation) || feedbackCase) {
    if (!bindingFile) throw new Error("本案例须先提供实际共同基线及核验记录，未调用模型");
    binding = bindingSchema.parse(readJson(bindingFile));
    if (lstatSync(binding.dataRoot).isSymbolicLink()) throw new Error("基线根目录不能是符号链接");
    const baselineRoot = realpathSync(binding.dataRoot);
    if (inside(baselineRoot, dataRoot) || inside(dataRoot, baselineRoot)) throw new Error("共同基线与候选输出目录不能重叠");
    binding = { ...binding, dataRoot: baselineRoot };
    if (binding.caseId !== item.id || binding.inputSha256 !== item.inputSha256 || treeHash(binding.dataRoot) !== binding.treeSha256) throw new Error("共同基线或输入摘要不匹配");
    const source = new WorkStore(resolve(binding.dataRoot, "testing"), "test", binding.dataRoot), record = source.read(binding.workId);
    if (record.purpose !== "test" || source.list().length !== 1 || ["running", "unknown"].includes(record.execution.status)) throw new Error("基线必须是独立、无运行或未知任务的单作品测试快照");
    if (binding.versionId) {
      const version = source.version(record, binding.versionId); source.assertAvailable(version);
      const probe = JSON.parse(await mediaCommand(mediaBinaries().ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", source.resolvePath(version.mediaPath)], configuration.media.probeTimeoutMs));
      const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
      const duration = Number(probe.format?.duration);
      const spec = plan.round.media ?? {durationSeconds:480,width:1080,height:1920};
      if (video?.width !== spec.width || video?.height !== spec.height || !Number.isFinite(duration) || Math.abs(duration - spec.durationSeconds) > 0.15) throw new Error(`共同媒体基线必须是实际 ${spec.durationSeconds} 秒、${spec.width}×${spec.height} 视频`);
    }
    if (item.operation === "inspect_only" && (!binding.versionId || record.versions.some(v => v.reviewPreparation?.inspections.length))) throw new Error("独立审查基线须有媒体且不得带入既有模型审查答案");
    if (feedbackCase && (!binding.versionId || !binding.feedbackIds?.length)) throw new Error("修改基线须明确版本和反馈编号");
    compareOrSave(resolve(roundRoot, "baseline-" + item.id + ".json"), binding);
  } else if (bindingFile) throw new Error("该案例不接受额外基线文件");

  const providers = Object.fromEntries(plan.round.providerKinds.map(kind => [kind, configuration.providers[kind]]));
  const librarySelection = plan.round.assetLibraries;
  const libraries = librarySelection === "configured" ? configuration.assetLibraries : configuration.assetLibraries.filter(library => librarySelection.includes(library.id));
  if (librarySelection !== "configured" && libraries.length !== new Set(librarySelection).size) throw new Error("请求的素材库没有配置");
  const libraryIndex = resolve(configuration.assetRoot, "library/index.json");
  const executable = testRuntime?.executable ?? configuration.codex;
  const resourceIdentity = { systemFingerprint: systemFingerprint(), maxInternalRepairs: MAX_INTERNAL_REPAIRS, executable,
    runnerFileSha256: hash(readFileSync(realpathSync(executable))), declaredRunnerVersion: testRuntime ? null : configuration.tools.codex.version,
    nodeVersion: process.version,
    testRuntimeHashes: Object.fromEntries(["plan.ts", "execute.ts", "runtime.ts", "asset-phase.ts", "visual-phase.ts"].map(name => [name, hash(readFileSync(resolve(repoRoot, "scripts/model-evaluation", name)))])),
    providers: Object.fromEntries(Object.entries(providers).map(([key,value]) => [key, value ? JSON.parse(JSON.stringify(value, (field, content) => field === "apiKey" ? undefined : content)) : null])),
    libraries, libraryIndexSha256: libraries.length && existsSync(libraryIndex) ? hash(readFileSync(libraryIndex)) : null,
    knowledge: "仅该候选冻结快照中的经验；不接入正式经验库", limits: plan.round.limits, effectiveMedia: { ...configuration.media } };
  compareOrSave(resolve(roundRoot, "resources.json"), resourceIdentity);
  // 本轮只允许输入指定的生成服务和素材库；身份固定，实际读取的素材仍沿项目保存来源与摘要。
  const evidencePath = resolve(directory, "runtime.jsonl"), wrapper = resolve(directory, "codex-runner.mjs");
  const runtimeSettings = { executable, variant, readableRoot: dataRoot, evidencePath, generationLimit: plan.round.limits.generationCalls, operation: item.operation };
  const nodePath = configuration.node;
  if (/[\r\n]/.test(nodePath)) throw new Error("Node 路径含非法换行");
  writeFileSync(wrapper, "#!" + nodePath + "\nimport {startRuntime} from " + JSON.stringify(pathToFileURL(resolve(repoRoot, "scripts/model-evaluation/runtime.ts")).href) + ";\nawait startRuntime(" + JSON.stringify(runtimeSettings) + ");\n", { flag: "wx", mode: 0o700 });
  const start = Date.now();
  writeNew(resolve(directory, "execution.json"), { runId, caseId: item.id, variant, startedAt: new Date(start).toISOString(), inputSha256: item.inputSha256,
    system: resourceIdentity, binding: binding ?? null, fixtureAssumptions: binding ? [] : ["本轮只测指定阶段，上游交接/检查/采用为明确标识的合成测试前提，不证明用户已认可或上游模型有效"] });
  // 与正式入口的 assetRoot/testing 布局一致，确保经验来源校验能找到同一测试作品。
  const workRoot = resolve(dataRoot, "testing");
  const store = new WorkStore(workRoot, "test", dataRoot);
  const signal=AbortSignal.timeout(plan.round.limits.operationMs);
  const service = new WorkService(store, { codexExecutable: wrapper, timeoutMs: plan.round.limits.modelTurnMs,
    signal, providerSettings: providers, assetLibraries: libraries, models: { default: { model: variant.model, effort: variant.effort }, stages: {} } });
  let workId: string | undefined, output: unknown, status = "unknown", error: string | undefined;
  try {
    if (binding) {
      if (readdirSync(dataRoot).length) throw new Error("候选数据目录非空，拒绝混入其他输入");
      cpSync(binding.dataRoot, dataRoot, { recursive: true, dereference: false });
      if (lstatSync(dataRoot).isSymbolicLink() || realpathSync(dataRoot) !== dataRoot) throw new Error("基线副本目录被重定向，未开始模型执行");
      if (treeHash(dataRoot) !== binding.treeSha256) throw new Error("共同基线副本不一致");
      workId = binding.workId;
    } else {
      const work = store.create(item.id, input, "evaluation-" + runId); workId = work.id;
      service.documents.initialize(work, input, "evaluation-draft");
      const draft = store.read(workId).authoring!.drafts.at(-1)!;
      await service.documents.handoff(workId, draft, "合成测试前提：使用冻结输入检查指定阶段，不代表真实用户交接。", "evaluation-handoff");
      if (item.operation === "produce_version" || item.operation === "prepare_assets") {
        const record = store.read(workId);
        const design = service.documents.append(record, "design", input, { operationId: "evaluation-design", source: "external_ai", instruction: "所有候选共同使用的测试指定设计", assetIds: [], draft });
        store.save(record);
        await service.documents.decide(workId, { operationId: "evaluation-adopt", design, status: "adopted", source: "external_ai", notes: "合成测试前提：隔离制作能力；不作为真实作品方向或成片认可" });
      }
    }
    const record = store.read(workId);
    if (["review_draft", "revise_draft", "design_video"].includes(item.operation)) {
      output = await service.authoring.generate(workId, item.operation === "design_video" ? "design" : item.operation as "review_draft" | "revise_draft",
        record.authoring!.drafts.at(-1)!, "按冻结输入中的原始依据完成本轮指定阶段，返回结构化结果。", "evaluation-call-" + runId);
      const state = store.read(workId).authoring!.runs.at(-1)!.status;
      status = state === "completed" ? "completed" : state === "needs_input" ? "blocked" : state;
    } else if (item.operation === "prepare_assets") {
      output=await prepareAssetPhase(service,workId,input,wrapper,libraries,plan.round.limits.modelTurnMs,signal);
      const assetStatus=(output as {status:string}).status;status=assetStatus==="needs_input"?"blocked":assetStatus;
    } else if (item.operation === "inspect_visuals") {
      if (!binding?.versionId) throw new Error("视觉理解须提供实际媒体版本");
      output = await inspectVisualPhase(service,workId,binding.versionId,input,wrapper,plan.round.limits.modelTurnMs,signal);
      status = (output as {status:string}).status === "completed" ? "completed" : "blocked";
    } else if (item.operation === "inspect_only") {
      output = await store.withLock(workId, async () => {
        const fresh = store.read(workId!); return service.reviewMaterials.prepare(fresh, store.version(fresh, binding!.versionId!), undefined, true);
      });
      status = store.read(workId).versions.find(v => v.id === binding!.versionId)!.reviewPreparation?.status === "available" ? "completed" : "blocked";
    } else if (item.operation === "organize_experience") {
      if (service.learning.pending(record).pendingCount === 0) throw new Error("经验基线没有待整理的真实来源记录");
      output = await service.organize(workId); status = store.read(workId).learningError ? "blocked" : "completed";
    } else {
      const designRef = binding ? store.version(record, binding.versionId!).designRef : record.authoring!.designs.at(-1);
      if (!designRef) throw new Error("制作基线没有明确的采用设计");
      output = await service.produce(workId, "complete", undefined, "fresh", binding?.versionId, binding ? "同一反馈与同一工程的模型比较" : undefined,
        "evaluation-call-" + runId, { designRef, feedbackIds: binding?.feedbackIds ?? [] });
      const state = store.read(workId).execution.status;
      status = state === "idle" ? "completed" : state === "waiting_input" ? "blocked" : state;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    const state = workId ? store.read(workId).execution.status : undefined;
    status = state === "unknown" || state === "running" ? "unknown" : "failed";
  }
  const work = workId ? store.read(workId) : undefined;
  const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const configurations = evidence.filter(event => event.kind === "configuration");
  const confirmed = configurations.length > 0 && configurations.every(event => event.actualModel === variant.model && event.actualEffort === variant.effort);
  if (status === "completed" && !confirmed) { status = "unknown"; error = "任务已返回，但有效模型配置缺少证据，不能作为已核实比较结果。"; }
  const visible = output && typeof output === "object" ? output as Record<string, unknown> : {};
  const inspections = Array.isArray(visible.inspections) ? visible.inspections.map(item => ({ result: item.result, status: item.status })) : undefined;
  writeNew(resolve(directory, "display.json"), { caseId: item.id, status, draftReview: visible.draftReview,
    assetSummary: visible.summary, assetChoices: visible.choices, selectedAssetIds: visible.selectedAssetIds,
    document: visible.document && typeof visible.document === "object" ? (visible.document as Record<string, unknown>).markdown : undefined,
    inspections, learningBatches: work?.learningBatches, note: "此文件不添加模型身份；内容质量待独立评价。工程与视频见同候选的 work-data。" });
  const result = { runId, caseId: item.id, variantId: variant.id, status, error, output, workId, workRootRelative: "testing",
    actualModel: confirmed ? variant.model : null, actualEffort: confirmed ? variant.effort : null,
    configurationEvidence: configurations, usageEvents: evidence.filter(event => event.kind === "usage"), generationAttempts: evidence.filter(event => event.kind === "generation_attempt").length,
    elapsedMs: Date.now() - start, finishedAt: new Date().toISOString(),
    versions: work?.versions.map(v => ({ id: v.id, sourcePath: v.sourcePath, mediaPath: v.mediaPath, production: v.production, technicalCheck: v.technicalCheck, internalRepair: v.internalRepair })),
    primaryVersionId: work?.versions.find(v => v.operationId === "evaluation-call-" + runId)?.id ?? null,
    runtimeEvidence: existsSync(evidencePath) ? { path: "runtime.jsonl", sha256: hash(readFileSync(evidencePath)) } : null,
    evaluation: "pending", userChoice: null, note: "完成状态只说明任务执行；质量需独立检查，模型选择由用户决定。运行器回执证明有效配置，不推断隐藏的服务端内部路由。" };
  writeNew(resolve(directory, "result.json"), result); return result;
}
