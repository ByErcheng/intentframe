import { backgroundTools, type BackgroundTool } from "../records/execution-store.ts";

/** 执行清单来自调度器；这份补充定义同时供工具描述、准备结果与指南使用。 */
const backgroundDetails: Record<BackgroundTool, { result: string; effects: string; modelUsage: string }> = {
  produce_version: { result: "result.delivery 指向最终交付版本", effects: "制作新版本，自动内检、必要修复与复查", modelUsage: "使用模型；制作中还可能调用图片或配音服务" },
  render_version: { result: "result.delivery 与版本可用性", effects: "恢复已有工程的视频或预览，不修改源码", modelUsage: "不调用模型" },
  organize_experience: { result: "result.learning", effects: "保存经验候选与整理进度", modelUsage: "有待整理内容时使用模型" },
  recover_work: { result: "result.status 及恢复对象；原执行另行查询", effects: "reconcile_only 核对并补存；resume 继续渲染、内检及必要修复，可能产生新版本", modelUsage: "仅 resume 可能发起新的模型调用；不重发未知原调用" },
  revise_draft: { result: "result.document", effects: "保存新草稿，不自动交接", modelUsage: "使用模型" },
  review_draft: { result: "result.draftReview 与 runId", effects: "保存草稿检查与经验读取依据，不改稿、不设计", modelUsage: "使用模型" },
  design_video: { result: "result.document", effects: "保存设计，不自动采用或制作", modelUsage: "使用模型" },
  generate_image: { result: "result.location", effects: "保存图片素材及来源", modelUsage: "使用图片 API 额度" },
  generate_music: { result: "result.location", effects: "保存音乐素材、生成条件和原始响应", modelUsage: "使用音乐 API 额度" },
  generate_sound_effect: { result: "result.location", effects: "保存音效素材、生成条件和原始响应", modelUsage: "使用音效 API 额度" },
  synthesize_speech: { result: "result.location", effects: "保存声音素材和字词时间", modelUsage: "使用配音 API 额度" },
  prepare_review_materials: { result: "result.batches、versionId 与 delivery", effects: "materials_only 仅保存材料；inspect_and_repair 检查并按需修复，可能产生新版本", modelUsage: "仅 inspect_and_repair 使用模型" },
  import_asset: { result: "result.location", effects: "保存本机素材副本与来源", modelUsage: "不调用模型" },
};

export function toolCapability(name: string, readOnly: boolean, args?: Record<string, unknown>) {
  const details = backgroundTools.includes(name as BackgroundTool) ? backgroundDetails[name as BackgroundTool] : undefined;
  const mode = args?.mode;
  return { name, execution: details ? "background" : "synchronous", readOnly,
    initialResult: details ? 'status:"accepted", executionId' : "本次调用返回结果",
    queryTool: details ? "get_execution" : null,
    result: details?.result ?? "工具返回的当前结果",
    effects: details?.effects ?? (readOnly ? "查询或准备请求，不启动业务执行" : "保存该工具对应的本机记录"),
    modelUsage: (name === "prepare_review_materials" && mode === "materials_only") || (name === "recover_work" && mode === "reconcile_only")
      ? "不发起新的模型调用" : details?.modelUsage ?? "不调用模型",
    ...(mode ? { mode } : {}) };
}

export function capabilityTable(capabilities: ReturnType<typeof toolCapability>[]) {
  return ["## 工具执行契约", "", "本表由当前工具注册表和后台执行定义生成。后台成功受理统一返回 executionId，用 get_execution 查询；额度取决于实际动作，不由工具是否只读推断。", "",
    "| 工具 | 执行 | 结果位置 | 动作范围 | 模型调用 |", "| --- | --- | --- | --- | --- |",
    ...capabilities.map(item => `| ${item.name} | ${item.execution === "background" ? "后台" : "同步"} | ${item.result} | ${item.effects} | ${item.modelUsage} |`)].join("\n");
}
