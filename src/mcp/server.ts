import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { WorkService } from "../runtime/work-service.ts";
import { describeError } from "../runtime/codex-client.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const versionId = z.string().regex(/^v\d{3,}$/);
const text = z.string().trim().min(1).max(30_000);
const inputs = {
  get_runtime_info: z.object({}),
  list_works: z.object({}),
  create_work: z.object({ title: text.max(200), brief: text }),
  get_work: z.object({ workId: id }),
  produce_version: z.object({
    workId: id, kind: z.enum(["sample", "complete"]),
    feedbackId: z.string().optional(), threadMode: z.enum(["fresh", "resume"]).default("fresh"),
    baseVersionId: versionId.optional(), baseReason: text.optional(),
  }),
  render_version: z.object({ workId: id, versionId }),
  submit_feedback: z.object({
    workId: id, versionId, text,
    source: z.enum(["user", "external_ai", "internal_check", "system_test"]),
    changesDirection: z.boolean().default(false),
  }),
  record_review: z.object({
    workId: id, versionId, status: z.enum(["needs_changes", "passed"]), notes: text,
    source: z.enum(["user", "external_ai", "internal_check"]),
  }),
  confirm_version: z.object({
    workId: id, versionId, kind: z.enum(["direction", "acceptance"]),
    userConfirmation: text, scope: text.optional(),
  }),
};
const descriptions: Record<keyof typeof inputs, string> = {
  get_runtime_info: "只读返回服务实际使用的数据根目录，供客户端在操作前核对目标。",
  list_works: "列出本机已有作品的标识、名称和当前状态，供新会话定位任务。",
  create_work: "保存原始需求，建立本机可接续作品工程。",
  get_work: "读取真实任务状态、版本、反馈、确认及可访问的本机文件位置。",
  produce_version: "调用 Codex 制作新版本并在本机渲染，默认延续最新可用工程和有效反馈。指定历史基线时须提供 baseReason。完整制作要求用户方向确认；未知执行不能重发。会使用现有账号的模型额度。",
  render_version: "对已确认完成的源码重新尝试渲染，不再次调用模型；已就绪版本不会覆盖。",
  submit_feedback: "保留针对明确版本的原始反馈和真实来源；改变核心方向时注明 changesDirection。",
  record_review: "记录已实际观看或检查的版本及覆盖范围；技术检查或 AI 审查不能替代用户认可。",
  confirm_version: "仅转录用户对明确版本的真实确认原话。direction 确认样例方向并给出范围；acceptance 认可完整版本，不授权发布。AI 自检不能调用本工具代替用户确认。",
};
type McpTextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** CLI 与 MCP 共用同一参数校验和操作实现，避免两套入口产生不同事实。 */
export async function executeTool(name: string, input: unknown, service = new WorkService()) {
  const store = service.store;
  switch (name) {
    case "get_runtime_info": { inputs.get_runtime_info.parse(input); return { dataRoot: store.dataRoot }; }
    case "list_works": { inputs.list_works.parse(input); return { works: store.list() }; }
    case "create_work": {
      const args = inputs.create_work.parse(input);
      return store.summary(store.create(args.title, args.brief));
    }
    case "get_work": return store.summary(store.read(inputs.get_work.parse(input).workId));
    case "produce_version": {
      const args = inputs.produce_version.parse(input);
      return store.summary(await service.produce(args.workId, args.kind, args.feedbackId, args.threadMode, args.baseVersionId, args.baseReason));
    }
    case "render_version": {
      const args = inputs.render_version.parse(input);
      return store.summary(await service.renderExisting(args.workId, args.versionId));
    }
    case "submit_feedback": {
      const args = inputs.submit_feedback.parse(input);
      return store.summary(await store.feedback(args.workId, args.versionId, args.text, args.source, args.changesDirection));
    }
    case "record_review": {
      const args = inputs.record_review.parse(input);
      return store.summary(await store.review(args.workId, args.versionId, args.status, args.notes, args.source));
    }
    case "confirm_version": {
      const args = inputs.confirm_version.parse(input);
      return store.summary(await store.confirm(args.workId, args.versionId, args.kind, args.userConfirmation, args.scope));
    }
    default: throw new Error("未知工具：" + name);
  }
}

export function startMcpServer(): void {
  // 依赖库的诊断输出也必须走 stderr；stdout 仅承载 MCP 协议。
  console.log = (...args: unknown[]) => console.error(...args);
  const service = new WorkService();
  serveStdio(() => {
    const server = new McpServer({ name: "intentframe", version: "0.1.0" });
    for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
      server.registerTool(name, {
        description: descriptions[name], inputSchema: inputs[name].shape,
        annotations: { readOnlyHint: ["get_runtime_info", "get_work", "list_works"].includes(name), destructiveHint: false },
      }, async (args: unknown): Promise<McpTextResult> => {
        try {
          return { content: [{ type: "text", text: JSON.stringify(await executeTool(name, args, service)) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: describeError(error) }] };
        }
      });
    }
    return server;
  }, { onerror: error => console.error(describeError(error)) });
}
