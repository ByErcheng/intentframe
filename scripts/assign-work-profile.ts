import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuration } from "../src/config.ts";
import { atomicJson, immutableText, ownedPath, valueHash } from "../src/records/files.ts";
import { ProfileStore } from "../src/records/profile-store.ts";
import { WorkRouter } from "../src/runtime/work-router.ts";
import { activeExecution } from "../src/records/execution-store.ts";

/** 只清点独立历史根目录，不把冻结评测副本接入当前任务路由或改写其记录。 */
function independentRoots(root: string) {
  const entries: { dataRoot: string; recordCount: number; versionCount: number }[] = [];
  const excluded = new Set(["profiles", "media", "library", "experience", "validation", "operations", "node_modules", "versions", "runs", "assets", "authoring", "analysis"]);
  let depthLimited = false;
  const visit = (directory: string, depth: number) => {
    if (depth > 10) { depthLimited = true; return; }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || excluded.has(entry.name)) continue;
      const path = ownedPath(root, join(directory.slice(root.length), entry.name).replace(/^\//, ""));
      if (entry.name !== "works") { visit(path, depth + 1); continue; }
      if (directory === root || directory === join(root, "testing")) continue;
      let recordCount = 0, versionCount = 0;
      for (const work of readdirSync(path, { withFileTypes: true })) {
        if (!work.isDirectory() || work.isSymbolicLink()) continue;
        const task = ownedPath(root, join(path.slice(root.length), work.name, "task.json").replace(/^\//, ""));
        if (!existsSync(task)) continue;
        const data = JSON.parse(readFileSync(task, "utf8"));
        recordCount++; versionCount += Array.isArray(data.versions) ? data.versions.length : 0;
      }
      entries.push({ dataRoot: directory, recordCount, versionCount });
    }
  };
  visit(root, 0);
  return { entries, depthLimited, note: "只读清点；这些独立实验根目录未归类、未搬动，不属于当前 list_works 的范围。" };
}

export async function assignExistingWorks(options: { assetRoot: string; profileId: string; reason: string; apply: boolean }) {
  if (!options.reason.trim()) throw new Error("须提供此次批量归类的用户依据。");
  const root = resolve(options.assetRoot), router = new WorkRouter(root), profiles = new ProfileStore(root);
  const profile = profiles.current(options.profileId); profiles.select(profile.ref);
  const plan = (["production", "test"] as const).flatMap(purpose => {
    const store = router.service(purpose).store;
    return store.list().map(item => ({ purpose, id: item.id, currentProfileId: item.profileId, execution: item.execution,
      active: Boolean(activeExecution(store.dataRoot, item.id)) }));
  });
  const inventory = independentRoots(root);
  if (!options.apply) return { mode: "dry_run", profile: profile.ref, plan, independentRoots: inventory };
  const reportId = valueHash({ profileId: options.profileId, reason: options.reason }).slice(0, 24);
  const directory = ownedPath(root, "validation/system/creative-profiles/" + reportId);
  const results: { id: string; purpose: string; status: string; error?: string }[] = [];
  for (const item of plan) {
    if (item.currentProfileId) { results.push({ id: item.id, purpose: item.purpose, status: item.currentProfileId === options.profileId ? "already_assigned" : "other_profile_preserved" }); continue; }
    if (item.active || ["running", "unknown"].includes(item.execution)) { results.push({ id: item.id, purpose: item.purpose, status: "blocked", error: "原执行未核清，未改动。" }); continue; }
    const store = router.service(item.purpose).store, path = store.resolvePath("works/" + item.id + "/task.json");
    const before = readFileSync(path, "utf8");
    immutableText(join(directory, "originals", item.purpose, item.id + ".json"), before);
    const original = JSON.parse(before), operationId = "profile-assignment-" + valueHash({ reportId, purpose: item.purpose, id: item.id }).slice(0, 32);
    try {
      await store.assignProfile(item.id, options.profileId, null, options.reason, operationId);
      const after = JSON.parse(readFileSync(path, "utf8")); delete after.profileAssignments;
      if (valueHash(after) !== valueHash(original)) throw new Error("归属外字段发生变化；保留原记录备份，停止本次批量操作。");
      results.push({ id: item.id, purpose: item.purpose, status: "assigned" });
    } catch (error) {
      results.push({ id: item.id, purpose: item.purpose, status: "blocked", error: error instanceof Error ? error.message : String(error) });
      atomicJson(join(directory, "report.json"), { profile: profile.ref, reason: options.reason, results, independentRoots: inventory });
      throw error;
    }
  }
  const report = { profile: profile.ref, reason: options.reason, checkedAt: new Date().toISOString(), results, independentRoots: inventory,
    preservation: "逐条保存原 task.json，归属外字段摘要一致；不写旧草稿、视频、工程、输入或经验。" };
  atomicJson(join(directory, "report.json"), report);
  return { mode: "applied", reportPath: join(directory, "report.json"), profile: profile.ref,
    counts: Object.fromEntries([...new Set(results.map(item => item.status))].map(status => [status, results.filter(item => item.status === status).length])),
    independentRootCount: inventory.entries.length, independentRecordCount: inventory.entries.reduce((n, entry) => n + entry.recordCount, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), get = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes("--profile-id") || !args.includes("--reason") || args.some((value, index) => value.startsWith("--") && !["--profile-id", "--reason", "--apply"].includes(value))) {
    throw new Error("用法：node scripts/assign-work-profile.ts --profile-id <编号> --reason <用户依据> [--apply]；默认仅清点当前配置数据根目录。");
  }
  console.log(JSON.stringify(await assignExistingWorks({ assetRoot: configuration.assetRoot, profileId: get("--profile-id")!, reason: get("--reason")!, apply: args.includes("--apply") }), null, 2));
}
