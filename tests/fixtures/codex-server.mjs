import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 协议与故障替身：仅在用例自己的目录保存原线程和回执，不连接模型。
// 生成源码标记只验证数据交接，不能证明真实语义修改或经验改善效果。
export function run(mode = "completed", home, completionDelayMs = 1_000) {
  if (home) mkdirSync(home, { recursive: true });
  const historyPath = home ? join(home, "history.json") : undefined;
  const history = historyPath && existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : { threads: {} };
  const send = value => process.stdout.write(JSON.stringify(value) + "\n");
  const save = () => {
    if (!historyPath) return;
    const temporary = historyPath + "." + process.pid;
    writeFileSync(temporary, JSON.stringify(history));
    renameSync(temporary, historyPath);
  };
  const callbacks = new Map();
  const runningTurns = new Map();
  let callId = 0;
  const callTool = (threadId, turnId, tool, args, callback) => {
    const id = "tool-" + (++callId);
    callbacks.set(id, callback);
    send({ id, method: "item/tool/call", params: { callId: id, threadId, turnId, tool, arguments: args } });
  };
  const makeThread = requested => {
    const count = Object.keys(history.threads).length;
    const id = requested ?? (count ? "fixture-thread-" + (count + 1) : "fixture-thread");
    return history.threads[id] ??= { id, cwd: process.cwd(), historyMode: "paginated", turns: [] };
  };
  const proposal = sourceIds => ({
    title: "主体附近字幕留出空间", problem: "字幕可能遮挡主体", method: "检查字幕与主体区域，按画面调整字幕位置后复查。",
    conditions: "字幕与主体区域接近的画面", limitations: "仅有本例技术记录，实际观看效果仍须核验。",
    keywords: ["字幕", "主体", "布局"], sourceIds: sourceIds.slice(0, 1),
  });
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === undefined) {
      const callback = callbacks.get(request.id);
      if (callback) { callbacks.delete(request.id); callback(request.result); }
      return;
    }
    if (home) appendFileSync(join(home, "calls.jsonl"), JSON.stringify({ method: request.method, cwd: process.cwd(), pid: process.pid }) + "\n");
    if (request.id === undefined) return;
    if (request.method === "reject") { send({ id: request.id, error: { code: -32000, message: "测试：请求被明确拒绝" } }); return; }
    if (request.method === "initialize") {
      if (mode === "initialize_wait") return;
      if (mode === "initialize_disconnect") process.exit(0);
      send({ id: request.id, result: {} }); return;
    }
    if (request.method === "thread/read") {
      const thread = history.threads[request.params.threadId];
      if (!thread) { send({ id: request.id, error: { code: -32602, message: "原线程不存在" } }); return; }
      send({ id: request.id, result: { thread: { ...thread,
        id: mode === "wrong_thread" ? "wrong-thread" : thread.id,
        turns: request.params.includeTurns ? thread.turns : [] } } }); return;
    }
    if (request.method === "thread/turns/list") {
      const thread = history.threads[request.params.threadId];
      const offset = Number(request.params.cursor ?? 0), turns = [...(thread?.turns ?? [])].reverse();
      const next = offset + request.params.limit;
      send({ id: request.id, result: { data: turns.slice(offset, next), nextCursor: next < turns.length ? String(next) : null } }); return;
    }
    if (request.method === "thread/start" || request.method === "thread/resume") {
      if (request.params.threadId === "not-a-valid-codex-thread-id") {
        send({ id: request.id, error: { code: -32602, message: "invalid thread id (local fixture)" } }); return;
      }
      const thread = makeThread(request.params.threadId);
      thread.developerInstructions = request.params.developerInstructions;
      thread.cwd = request.params.cwd ?? process.cwd(); save();
      send({ id: request.id, result: { thread: { id: thread.id }, model: "local-fixture" } }); return;
    }
    if (request.method === "turn/interrupt") {
      send({ id: request.id, result: {} });
      const active = runningTurns.get(request.params.turnId);
      if (active && mode !== "ignore_interrupt") {
        clearTimeout(active.timer); active.turn.status = "interrupted"; save();
        runningTurns.delete(request.params.turnId);
        send({ method: "turn/completed", params: { threadId: active.thread.id, turn: { id: active.turn.id, status: "interrupted" } } });
      }
      return;
    }
    if (request.method !== "turn/start") { send({ id: request.id, result: {} }); return; }
    if (mode === "read_only") { send({ id: request.id, error: { code: -32000, message: "恢复测试禁止新制作" } }); return; }
    const thread = makeThread(request.params.threadId);
    const turnId = thread.turns.length ? "fixture-turn-" + (thread.turns.length + 1) : "fixture-turn";
    const turn = { id: turnId, status: "inProgress", itemsView: "full", items: [{ id: "user", type: "userMessage", content: request.params.input ?? [] }] };
    thread.turns.push(turn); save();
    send({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (mode === "disconnect") process.exit(0);
    const organizing = Boolean(request.params.outputSchema?.properties?.checkedSourceIds);
    const context = existsSync("context.md") ? readFileSync("context.md", "utf8") : "";
    const readList = pattern => { const match = context.match(pattern); return match ? JSON.parse(match[1]) : []; };
    const requested = readList(/本次需要处理的反馈编号：([^\n]+)/);
    const sourceIds = organizing ? JSON.parse(readFileSync("context.json", "utf8")).sources.map(item => item.id) :
      readList(/本次可检查的来源编号：([^\n]+)/);
    const finish = (used = []) => {
      runningTurns.delete(turnId);
      const learning = {
        checkedSourceIds: mode === "partial_learning" ? sourceIds.slice(0, 1) : sourceIds,
        notes: "合成协议测试的来源检查，不代表真实经验效果。",
        proposals: (mode === "learn_method" || mode === "partial_learning") && sourceIds.length ? [proposal(sourceIds)] : [],
      };
      const needsInput = mode === "needs_input" || mode === "partial_input";
      const result = organizing ? learning : {
        status: needsInput ? "needs_input" : mode === "failed" || mode === "partial_failed" ? "failed" : "completed",
        summary: needsInput ? "缺少参考素材，没有完成制作。" : "完成测试源码。",
        appliedFeedbackIds: mode === "partial_input" ? requested.slice(0, 1) : needsInput ? [] : requested,
        unresolvedFeedbackIds: mode === "partial_input" ? requested.slice(1) : needsInput ? requested : [],
        blockers: needsInput || mode === "false_completed" ? ["请提供参考素材。"] : [],
        usedExperienceRefs: used, learning,
      };
      if (!organizing && ["completed", "completed_exit", "partial_input", "partial_failed", "learn_method", "use_experience", "read_feedback", "disconnect_after_result", "slow_completed", "slow_render"].includes(mode)) {
        const source = existsSync("entry.tsx") ? readFileSync("entry.tsx", "utf8") :
          'import React from "react";import {Composition,registerRoot,AbsoluteFill} from "remotion";const Scene=()=> <AbsoluteFill style={{backgroundColor:"red"}}/>;registerRoot(()=> <Composition id="Video" component={Scene} durationInFrames={10} fps={10} width={160} height={90}/>);\n';
        writeFileSync("entry.tsx", source + (mode === "slow_render" ? '\nimport {delayRender,continueRender} from "remotion";const pending=delayRender("合成停止窗口");setTimeout(()=>continueRender(pending),3000);\n' : "") + "// 本次处理：" + JSON.stringify(result.appliedFeedbackIds) + "\n" +
          (mode === "partial_input" || mode === "partial_failed" ? "// 已保留的部分制作进度\n" : "") +
          (used.length ? "// 采用经验：" + JSON.stringify(used) + "\n" : ""));
      }
      if (mode === "missing_source") rmSync("entry.tsx", { force: true });
      const progress = { id: "progress", type: "agentMessage", phase: "commentary", text: "测试进度说明。" };
      send({ method: "item/completed", params: { threadId: thread.id, turnId, item: progress } });
      turn.items.push(progress);
      if (mode !== "no_final") {
        const answer = { id: "answer", type: "agentMessage", phase: "final_answer",
          text: mode === "plain_clarification" ? "缺少素材，我没有修改源码，请补充信息。" : JSON.stringify(result) };
        turn.items.push(answer);
        send({ method: "item/completed", params: { threadId: thread.id, turnId, item: answer } });
      }
      turn.status = "completed"; save();
      if (mode === "disconnect_after_result") process.exit(0);
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { id: turnId, status: "completed" } } });
      if (mode === "completed_exit") setImmediate(() => process.exit(0));
    };
    if (["slow_completed", "interruptible", "ignore_interrupt"].includes(mode)) {
      const timer = setTimeout(() => finish(), mode === "slow_completed" ? completionDelayMs : 30_000);
      runningTurns.set(turnId, { timer, thread, turn });
    } else if (mode === "read_feedback") {
      callTool(thread.id, turnId, "intentframe_read_feedback", { ids: requested }, () => finish());
    } else if (mode === "read_history") {
      callTool(thread.id, turnId, "intentframe_read_production_history", { section: "baseline_result" }, response => {
        const baseline = response?.success ? JSON.parse(response.contentItems[0].text) : null;
        callTool(thread.id, turnId, "intentframe_read_production_history", { section: "inherited_feedback", limit: 1 }, answer => {
          const inherited = answer?.success ? JSON.parse(answer.contentItems[0].text) : null;
          writeFileSync("history-read.json", JSON.stringify({ baseline, inherited }));
          finish();
        });
      });
    } else if (mode === "use_experience") {
      callTool(thread.id, turnId, "intentframe_search_experience", { query: "字幕", offset: 0, limit: 20 }, response => {
        const data = response?.success ? JSON.parse(response.contentItems[0].text) : undefined;
        const ref = data?.items?.[0]?.ref;
        if (!ref) { finish(); return; }
        callTool(thread.id, turnId, "intentframe_read_experience", ref, answer => finish(answer?.success ? [ref] : []));
      });
    } else finish();
  });
}
