import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// 测试协议替身：不连接模型，不复制真实会话或作品数据。
// 反馈只转成编号和源码标记，不实际完成语义修改；矛盾声明用于验证完成判定的拒绝路径。
export function run(mode = "completed") {
  const send = value => process.stdout.write(JSON.stringify(value) + "\n");
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "reject") {
      send({ id: request.id, error: { code: -32000, message: "测试：请求被明确拒绝" } }); return;
    }
    if (request.method === "initialize") {
      if (mode === "initialize_disconnect") { process.exit(0); }
      send({ id: request.id, result: {} }); return;
    }
    if (request.method === "thread/start" || request.method === "thread/resume") {
      if (request.params.threadId === "not-a-valid-codex-thread-id") {
        send({ id: request.id, error: { code: -32602, message: "invalid thread id (local fixture)" } }); return;
      }
      send({ id: request.id, result: { thread: { id: "fixture-thread" }, model: "local-fixture" } }); return;
    }
    if (request.method !== "turn/start") { send({ id: request.id, result: {} }); return; }
    send({ id: request.id, result: { turn: { id: "fixture-turn", status: "inProgress" } } });
    if (mode === "disconnect") { process.exit(0); }
    const context = existsSync("context.md") ? readFileSync("context.md", "utf8") : "";
    const match = context.match(/本次需要处理的反馈编号：([^\n]+)/);
    const requested = match ? JSON.parse(match[1]) : [];
    const needsInput = mode === "needs_input" || mode === "partial_input";
    const result = {
      status: needsInput ? "needs_input" : mode === "failed" || mode === "partial_failed" ? "failed" : "completed",
      summary: needsInput ? "缺少参考素材，没有完成制作。" : "完成测试源码。",
      appliedFeedbackIds: mode === "partial_input" ? requested.slice(0, 1) : needsInput ? [] : requested,
      unresolvedFeedbackIds: mode === "partial_input" ? requested.slice(1) : needsInput ? requested : [],
      blockers: needsInput || mode === "false_completed" ? ["请提供参考素材。"] : [],
    };
    if (mode === "completed" || mode === "partial_input" || mode === "partial_failed") {
      const source = existsSync("entry.tsx") ? readFileSync("entry.tsx", "utf8") :
        'import React from "react";import {Composition,registerRoot,AbsoluteFill} from "remotion";const Scene=()=> <AbsoluteFill style={{backgroundColor:"red"}}/>;registerRoot(()=> <Composition id="Video" component={Scene} durationInFrames={10} fps={10} width={160} height={90}/>);\n';
      writeFileSync("entry.tsx", source + "// 本次处理：" + JSON.stringify(result.appliedFeedbackIds) + "\n" +
        (mode === "partial_input" || mode === "partial_failed" ? "// 已保留的部分制作进度\n" : ""));
    }
    send({ method: "item/completed", params: { threadId: "fixture-thread", turnId: "fixture-turn",
      item: { id: "progress", type: "agentMessage", phase: "commentary", text: "测试进度说明。" } } });
    if (mode !== "no_final") send({ method: "item/completed", params: { threadId: "fixture-thread", turnId: "fixture-turn",
      item: { id: "answer", type: "agentMessage", phase: "final_answer",
        text: mode === "plain_clarification" ? "缺少素材，我没有修改源码，请补充信息。" : JSON.stringify(result) } } });
    send({ method: "turn/completed", params: { threadId: "fixture-thread", turn: { id: "fixture-turn", status: "completed" } } });
    if (mode === "completed_exit") setImmediate(() => process.exit(0));
  });
}
