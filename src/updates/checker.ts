import { existsSync, mkdirSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { configuration } from "../config.ts";
import { immutableJson, ownedPath, readJson } from "../records/files.ts";
import { describeError } from "../common/errors.ts";
import { readInventory, type Inventory, type UpdateSource } from "./catalog.ts";
import { latestVersion, newerStable, parseVersion, toolVersion } from "./sources.ts";

export const noticeIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{64}$/);
const memberSchema = z.object({ name: z.string(), current: z.string(), latest: z.string(), majorChange: z.boolean() });
const updateSchema = z.object({ id: z.string(), name: z.string(), url: z.url(), note: z.string().optional(), members: z.array(memberSchema).min(1) });
const resultSchema = z.object({ noticeId: noticeIdSchema, period: z.string(), checkedAt: z.iso.datetime(),
  status: z.enum(["current", "updates_available", "partial", "failed"]), checked: z.number().int().nonnegative(),
  updates: z.array(updateSchema), issues: z.array(z.string()) });
type CheckResult = z.infer<typeof resultSchema>;
type Settings = typeof configuration.updates;
type Options = {
  settings?: Settings; now?: () => Date; inventory?: () => Inventory;
  latest?: (source: UpdateSource, signal: AbortSignal) => Promise<string>;
  installed?: (tool: string, path: string, signal: AbortSignal) => Promise<string>;
};
const receiptSchema = z.object({ noticeId: noticeIdSchema, received: z.literal(true), receivedAt: z.iso.datetime() });

/** 用本地日历划分周期，不能减固定 24 小时而在夏令时切换时错一天。 */
export function updatePeriod(now: Date, dayStartHour: number): string {
  const date = new Date(now);
  if (date.getHours() < dayStartHour) date.setDate(date.getDate() - 1);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

export class ToolUpdateChecker {
  private root: string;
  private settings: Settings;
  private now: () => Date;
  private inventory: () => Inventory;
  private latest: NonNullable<Options["latest"]>;
  private installed: NonNullable<Options["installed"]>;
  constructor(assetRoot: string, options: Options = {}) {
    this.root = assetRoot; this.settings = options.settings ?? configuration.updates;
    this.now = options.now ?? (() => new Date()); this.inventory = options.inventory ?? (() => readInventory());
    this.latest = options.latest ?? latestVersion; this.installed = options.installed ?? toolVersion;
  }
  private identity() {
    const inventory = this.inventory(), period = updatePeriod(this.now(), this.settings.dayStartHour);
    const noticeId = noticeIdSchema.parse(period + "-" + inventory.fingerprint);
    return { inventory, period, noticeId, directory: "maintenance/tool-updates/" + noticeId };
  }
  private path(directory: string, file = "") { return ownedPath(this.root, directory + (file ? "/" + file : "")); }
  private readResult(directory: string, noticeId: string) {
    const result = resultSchema.parse(readJson(this.path(directory, "result.json")));
    if (result.noticeId !== noticeId) throw new Error("更新检查记录与当前周期不一致。");
    return result;
  }
  private view(result: CheckResult, directory: string) {
    const receiptPath = this.path(directory, "received.json");
    const receipt = existsSync(receiptPath) ? receiptSchema.parse(readJson(receiptPath)) : undefined;
    if (receipt && receipt.noticeId !== result.noticeId) throw new Error("更新回执与提醒不一致。");
    const pending = result.updates.length > 0 && !receipt;
    return { status: result.status, period: result.period, checkedAt: result.checkedAt, checked: result.checked,
      issues: result.issues, updateCount: result.updates.length,
      ...(pending ? { notice: { id: result.noticeId, updates: result.updates,
        instruction: "请向用户转述以下版本更新，然后调用 acknowledge_update_notice 确认收到。无需调研或安装；用户需要升级时另行使用开发 AI。" } } : {}),
      ...(receipt ? { receivedAt: receipt.receivedAt } : {}) };
  }
  /** 一个周期只查一次；跨进程通过独占目录认领，结果和回执分别发布，互不覆盖。 */
  async check() {
    if (!this.settings.enabled) return undefined;
    try {
      const { inventory, period, noticeId, directory } = this.identity();
      const start = performance.now(), resultPath = this.path(directory, "result.json");
      if (existsSync(resultPath)) return this.view(this.readResult(directory, noticeId), directory);
      mkdirSync(this.path("maintenance/tool-updates"), { recursive: true });
      let owner = false;
      try { mkdirSync(this.path(directory)); owner = true; }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
      if (owner) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
        try {
          const result = await this.collect(inventory, period, noticeId, controller.signal);
          immutableJson(resultPath, result);
        } finally { clearTimeout(timer); controller.abort(); }
      } else {
        // 只等本轮短超时；原进程被终止时返回失败，不启动第二份检查或要求 AI 轮询。
        const remaining = Math.min(this.settings.timeoutMs,
          Math.max(0, this.settings.timeoutMs - (Date.now() - statSync(this.path(directory)).mtimeMs) + 50));
        while (!existsSync(resultPath) && performance.now() - start < remaining) await delay(25);
        if (!existsSync(resultPath)) throw new Error("本周期检查尚无完整结果，可能并发超时或上次中断；后续调用可读取已完成结果，下个周期重新检查。");
      }
      return this.view(this.readResult(directory, noticeId), directory);
    } catch (error) {
      return { status: "failed" as const, issues: ["更新检查失败：" + describeError(error)] };
    }
  }
  async acknowledge(noticeId: string) {
    if (!this.settings.enabled) throw new Error("当前未启用更新检查。");
    const current = this.identity();
    if (noticeId !== current.noticeId) throw new Error("提醒已过期或工具清单已变化；请使用当前工具回复中的提醒编号。");
    const result = this.readResult(current.directory, noticeId);
    if (!result.updates.length) throw new Error("本轮没有需要确认收到的版本更新。");
    const path = this.path(current.directory, "received.json");
    const receipt = { noticeId, received: true as const, receivedAt: this.now().toISOString() };
    // 并发回执只需保存一次；noticeId 本身就是幂等键，不要求额外准备业务操作。
    if (!existsSync(path)) {
      try { immutableJson(path, receipt); }
      catch (error) { if (!existsSync(path)) throw error; }
    }
    const saved = receiptSchema.parse(readJson(path));
    if (saved.noticeId !== noticeId) throw new Error("更新回执编号不一致。");
    return saved;
  }
  private async collect(inventory: Inventory, period: string, noticeId: string, signal: AbortSignal): Promise<CheckResult> {
    const issues = [...inventory.issues], updates: CheckResult["updates"] = [];
    let checked = 0;
    const requests = new Map<string, Promise<string>>();
    const latest = (source: UpdateSource) => {
      const key = JSON.stringify(source);
      let request = requests.get(key);
      if (!request) { request = this.latest(source, signal); requests.set(key, request); }
      return request;
    };
    const aborted = () => new Error("版本检查超时。");
    const bounded = <T>(action: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(aborted()); return; }
      const abort = () => reject(aborted());
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(action).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    // 每个条目独立保留结果，一处失败不吞掉其他已查到的更新。
    const rows = await Promise.all(inventory.entries.map(async entry => {
      const members: z.infer<typeof memberSchema>[] = [], errors: string[] = [];
      const names = entry.packages ?? [entry.tool!];
      await Promise.all(names.map(async name => {
        try {
          const current = entry.tool
            ? await bounded(() => this.installed(entry.tool!, inventory.tools[entry.tool!]!.path, signal))
            : inventory.packages[name];
          if (!current) throw new Error("缺少实际安装版本。");
          parseVersion(current);
          if (entry.tool && current.replace(/^v/, "") !== inventory.tools[entry.tool]!.declaredVersion.replace(/^v/, "")) {
            errors.push(name + " 实际版本 " + current + " 与配置版本 " + inventory.tools[entry.tool]!.declaredVersion + " 不一致。");
          }
          const source: UpdateSource = entry.packages && entry.source.kind === "npm" ? { kind: "npm", package: name } : entry.source;
          const next = await bounded(() => latest(source));
          const newer = newerStable(next, current);
          checked++;
          if (newer) members.push({ name, current, latest: next, majorChange: parseVersion(next).numbers[0] !== parseVersion(current).numbers[0] });
        } catch (error) {
          const message = error instanceof z.ZodError ? "版本响应格式不符。" : describeError(error);
          errors.push(name + "：" + message);
        }
      }));
      return { entry, members: members.sort((a, b) => a.name.localeCompare(b.name)), errors: errors.sort() };
    }));
    for (const { entry, members, errors } of rows) {
      issues.push(...errors);
      if (members.length) updates.push({ id: entry.id, name: entry.name, url: entry.url, note: entry.note, members });
    }
    return { noticeId, period, checkedAt: this.now().toISOString(), checked, updates, issues,
      status: issues.length ? checked ? "partial" : "failed" : updates.length ? "updates_available" : "current" };
  }
}
