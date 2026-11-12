import { z } from "zod";
import type { CodexAppServerClient } from "./codex-client.ts";
import type { ModelSelection } from "../records/model-settings.ts";

export const modelThreadSchema = z.object({ thread: z.object({ id: z.string() }), model: z.string(),
  reasoningEffort: z.string().nullable().optional() });

/** 由现成运行器核对可用模型/强度，不建模型名单、不静默降级。只用于新推理，恢复原结果不调用。 */
export async function checkModel(client: CodexAppServerClient, selection: ModelSelection) {
  const visited = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = z.object({ data: z.array(z.object({ model: z.string(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable().optional() })
      .parse(await client.sendRequest("model/list", { ...(cursor ? { cursor } : {}), limit: 100, includeHidden: true }));
    const model = result.data.find(item => item.model === selection.model);
    if (model) {
      if (!model.supportedReasoningEfforts.some(item => item.reasoningEffort === selection.effort)) {
        throw new Error(`环节 ${selection.stage} 的模型不支持配置的推理强度 ${selection.effort}，未发送任务。`);
      }
      return;
    }
    if (!result.nextCursor) throw new Error(`环节 ${selection.stage} 的模型 ${selection.model} 不在当前运行器可用目录中，未发送任务。`);
    if (visited.has(result.nextCursor)) break;
    visited.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error("模型目录未完整取得，未发送任务。");
}

export function modelThreadParameters(selection: ModelSelection, config: Record<string, unknown> = {}) {
  return { model: selection.model, config: { ...config, model_reasoning_effort: selection.effort } };
}
export function modelTurnParameters(selection: ModelSelection) { return { model: selection.model, effort: selection.effort }; }

export function verifyModelThread(selection: ModelSelection, response: z.infer<typeof modelThreadSchema>) {
  if (response.model !== selection.model || response.reasoningEffort !== selection.effort) {
    throw new Error(`环节 ${selection.stage} 的运行器返回模型或强度与请求不符，未发送任务。`);
  }
}
