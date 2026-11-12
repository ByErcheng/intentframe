import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { z } from "zod";
import { inside, variantSchema } from "./plan.ts";

const settingsSchema = z.strictObject({ executable: z.string().min(1), variant: variantSchema, readableRoot: z.string().min(1),
  evidencePath: z.string().min(1), generationLimit: z.number().int().nonnegative(), operation: z.string().optional() });
export type RuntimeSettings = z.infer<typeof settingsSchema>;
const generationTools = new Set(["intentframe_generate_image", "intentframe_synthesize_speech", "intentframe_generate_music", "intentframe_generate_sound_effect"]);

export function evaluationFilesystem(root: string, cwd: string, writable: boolean, operation?: string) {
  const filesystem: Record<string, string> = { ":root": "deny", ":minimal": "read", [resolve(root)]: "read" };
  if (writable) {
    filesystem[cwd] = "write";
    for (const name of [".git", ".agents", ".codex"]) filesystem[resolve(cwd,name)] = "read";
  }
  if (operation === "inspect_only" || operation === "inspect_visuals") {
    const works = resolve(root,"testing/works");
    if (existsSync(works)) for (const entry of readdirSync(works,{withFileTypes:true})) if(entry.isDirectory()) {
      for(const name of ["versions","feedback","task.json"]) filesystem[resolve(works,entry.name,name)] = "deny";
      if(operation === "inspect_visuals") for(const name of ["documents","brief.md","learning"]) filesystem[resolve(works,entry.name,name)] = "deny";
    }
  }
  return filesystem;
}

/** 测试专用 stdio 适配：使用原运行器，显式指定并核对配置，保留原工具和终态协议。 */
export async function startRuntime(raw: RuntimeSettings) {
  const settings = settingsSchema.parse(raw), child = spawn(settings.executable, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const log = (kind: string, values: Record<string, unknown>) => appendFileSync(settings.evidencePath, JSON.stringify({ at: new Date().toISOString(), kind, ...values }) + "\n", { mode: 0o600 });
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const own = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const requests = new Map<string | number, { method: string; params: Record<string, unknown> }>();
  const threads = new Map<string, { cwd: string; permissions: string }>();
  let counter = 0, checked = false;
  const rpc = (method: string, params: unknown) => new Promise<unknown>((resolveRequest, reject) => {
    const id = "evaluation-check-" + (++counter);
    const timer = setTimeout(() => { own.delete(id); reject(new Error("运行器能力查询超时")); }, 30000);
    own.set(id, { resolve: resolveRequest, reject, timer }); send({ id, method, params });
  });
  async function checkCapability() {
    if (checked) return;
    let cursor: string | undefined; const cursors = new Set<string>();
    do {
      const page = z.object({ data: z.array(z.object({ model: z.string(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable().optional() })
        .parse(await rpc("model/list", { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) }));
      const entry = page.data.find(item => item.model === settings.variant.model);
      if (entry) {
        if (!entry.supportedReasoningEfforts.some(e => e.reasoningEffort === settings.variant.effort)) throw new Error("运行器未声明支持所请求的推理强度");
        checked = true; return;
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("模型目录分页重复");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100) throw new Error("模型目录分页超过检查上限");
    } while (cursor);
    throw new Error("运行器目录中没有请求的模型，未启动模型轮次");
  }
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const message = JSON.parse(line);
      const pending = own.get(message.id);
      if (pending) { clearTimeout(pending.timer); own.delete(message.id); if (message.error) pending.reject(new Error("运行器拒绝能力查询")); else pending.resolve(message.result); return; }
      const request = requests.get(message.id);
      if (request) {
        requests.delete(message.id);
        if (["thread/start", "thread/resume"].includes(request.method) && !message.error) {
          const result = z.object({ thread: z.object({ id: z.string() }), model: z.string(), reasoningEffort: z.string().nullable().optional(),
            activePermissionProfile: z.object({ id: z.string() }).nullable().optional(), instructionSources: z.array(z.string()).optional() }).parse(message.result);
          log("configuration", { threadId: result.thread.id, requestedModel: settings.variant.model, requestedEffort: settings.variant.effort,
            actualModel: result.model, actualEffort: result.reasoningEffort ?? null, instructionSources: result.instructionSources ?? null,
            requestedPermissions: request.params.permissions, actualPermissions: result.activePermissionProfile?.id ?? null });
          if (result.model !== settings.variant.model || result.reasoningEffort !== settings.variant.effort) {
            output({ id: message.id, error: { code: -32010, message: "运行器返回的模型/强度与请求不一致或不可核实，未发送模型轮次。" } }); return;
          }
          if (result.activePermissionProfile?.id !== request.params.permissions) {
            output({ id: message.id, error: { code: -32010, message: "运行器未确认本候选的受限读取权限配置，未发送模型轮次。" } }); return;
          }
          threads.set(result.thread.id, { cwd: String(request.params.cwd), permissions: String(request.params.permissions) });
        }
        if (request.method === "turn/start") log("turn_response", { threadId: request.params.threadId, turnId: message.result?.turn?.id ?? null, rejected: Boolean(message.error) });
      }
      if (message.method === "turn/completed") log("turn_completed", { threadId: message.params.threadId, turnId: message.params.turn.id, status: message.params.turn.status });
      if (message.method === "thread/tokenUsage/updated") log("usage", { threadId: message.params.threadId, turnId: message.params.turnId, tokenUsage: message.params.tokenUsage });
      if (message.method === "item/tool/call" && generationTools.has(message.params?.tool)) {
        const used = existsSync(settings.evidencePath) ? readFileSync(settings.evidencePath, "utf8").split("\n").filter(Boolean).map(x => JSON.parse(x)).filter(e => e.kind === "generation_attempt").length : 0;
        if (used >= settings.generationLimit) {
          log("generation_budget_rejected", { tool: message.params.tool });
          send({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: "本轮素材生成调用预算已用完，请保留现有结果并报告限制。" }] } }); return;
        }
        log("generation_attempt", { tool: message.params.tool, threadId: message.params.threadId, turnId: message.params.turnId });
      }
      output(message);
    } catch {
      // 无法保存或解释证据时不继续接受新的生成轮次；主流程沿已有未知结果保护恢复。
      child.kill(); process.stderr.write("模型比较运行器无法核对或保存协议证据。\n"); process.exitCode = 1;
    }
  });
  createInterface({ input: process.stdin }).on("line", line => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (message.method === "initialize") {
          message.params = { ...message.params, capabilities: { ...message.params?.capabilities, experimentalApi: true } };
        }
        if (message.method === "thread/start" || message.method === "thread/resume") {
          await checkCapability();
          const params = message.params ?? {}, cwd = resolve(String(params.cwd ?? process.cwd()));
          if (!inside(resolve(settings.readableRoot), cwd)) throw new Error("线程目录不属于该候选的隔离数据范围");
          const profile = params.sandbox === "workspace-write" ? "intentframe-evaluation-write" : "intentframe-evaluation-read";
          const filesystem = evaluationFilesystem(settings.readableRoot,cwd,params.sandbox === "workspace-write",settings.operation);
          const { sandbox: _sandbox, permissions: _permissions, ...remaining } = params;
          message.params = { ...remaining, cwd, model: settings.variant.model, permissions: profile,
            config: { ...params.config, model: settings.variant.model, model_reasoning_effort: settings.variant.effort,
              default_permissions: profile, ["permissions." + profile]: { filesystem, network: { enabled: false } } } };
        }
        if (message.method === "turn/start") {
          const params = message.params ?? {}, thread = threads.get(params.threadId);
          if (!thread) throw new Error("线程模型配置尚未经运行器确认");
          if (params.model && params.model !== settings.variant.model || params.effort && params.effort !== settings.variant.effort) throw new Error("轮次参数与本轮比较配置冲突");
          const { sandboxPolicy: _policy, permissions: _permissions, ...remaining } = params;
          message.params = { ...remaining, model: settings.variant.model, effort: settings.variant.effort, permissions: thread.permissions };
          log("turn_requested", { threadId: params.threadId, model: settings.variant.model, effort: settings.variant.effort });
        }
        if (message.method && message.id !== undefined) requests.set(message.id, { method: message.method, params: message.params ?? {} });
        send(message);
      } catch (error) {
        if (message?.id !== undefined) output({ id: message.id, error: { code: -32010, message: error instanceof Error ? error.message : "测试配置错误" } });
        else { child.kill(); process.exitCode = 1; }
      }
    })();
  }).on("close", () => child.stdin.end());
  child.on("error", () => { process.stderr.write("无法启动模型比较运行器。\n"); process.exitCode = 1; process.stdin.destroy(); });
  child.on("exit", code => {
    for (const pending of own.values()) { clearTimeout(pending.timer); pending.reject(new Error("运行器退出")); }
    own.clear(); process.stdin.destroy(); if (code) process.exitCode = code;
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
}
