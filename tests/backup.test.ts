import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configuration } from "../src/config.ts";
import { backupLocal } from "../src/records/local-backup.ts";
import { fixtureRoot } from "./helpers.ts";

function setup(root: string) {
  const options = { systemRoot: join(root, "system"), dataRoot: join(root, "data"),
    backupRoot: join(root, "backup"), executable: configuration.restic };
  mkdirSync(options.systemRoot); mkdirSync(options.dataRoot);
  writeFileSync(join(options.systemRoot, "system.txt"), "测试系统文件");
  writeFileSync(join(options.dataRoot, "task.txt"), "测试任务文件");
  return options;
}

test("真实 Restic 恢复核对完整清单，报告只写本机数据目录", { timeout: 60_000 }, () => {
  const root = fixtureRoot();
  try {
    const options = setup(root.path), report = backupLocal(options);
    assert.equal(report.result, "passed"); assert.equal(report.verifiedFiles, 2);
    assert(existsSync(join(options.dataRoot, "validation/system/local-backup", report.snapshotId.slice(0, 8) + ".json")));
    assert(!existsSync(join(options.systemRoot, "tests/evidence")));
    assert.equal(statSync(join(options.backupRoot, "access/password")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(options.dataRoot, "task.txt"), "utf8"), "测试任务文件");
  } finally { root.cleanup(); }
});

test("恢复占用未结束时，不启动备份或创建备份目录", () => {
  const root = fixtureRoot();
  try {
    const options = setup(root.path);
    mkdirSync(join(options.dataRoot, "testing/works/sample/.recovery-lock"), { recursive: true });
    assert.throws(() => backupLocal(options), /恢复占用/);
    assert(!existsSync(options.backupRoot));
  } finally { root.cleanup(); }
});

test("后台任务尚未领取时同样阻止备份，不依赖制作写锁已经存在", () => {
  const root = fixtureRoot();
  try {
    const options = setup(root.path), work = join(options.dataRoot, "testing/works/work-fixture");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "active-execution.json"), JSON.stringify({ operationId: "accepted", workId: "work-fixture" }));
    assert.throws(() => backupLocal(options), /后台任务交接/);
    assert(!existsSync(options.backupRoot));
  } finally { root.cleanup(); }
});

for (const mode of ["new-file", "active-lock", "temporary-change", "mode-change", "root-mode-change"]) {
  test("备份清点后并发变化不能报告通过：" + mode, { timeout: 60_000 }, () => {
    const root = fixtureRoot();
    try {
      const options = setup(root.path), executable = join(root.path, "restic-wrapper.mjs");
      // 用真实 Restic，只在清点之后、复制之前注入一处受控文件变化。
      const script = [
        "#!" + process.execPath,
        'import {execFileSync} from "node:child_process";',
        'import {chmodSync,mkdirSync,statSync,writeFileSync} from "node:fs";',
        "const args=process.argv.slice(2), data=" + JSON.stringify(options.dataRoot) + ";",
        'const copying=args.includes("backup");',
        "if(copying){",
        mode === "active-lock" ? 'mkdirSync(data+"/work/.write-lock",{recursive:true});writeFileSync(data+"/work/.write-lock/owner.json","{}");' :
          mode === "new-file" ? 'writeFileSync(data+"/new-task.json",JSON.stringify({status:"running"}));' :
          mode === "mode-change" ? 'chmodSync(data+"/task.txt",0o700);' :
          mode === "root-mode-change" ? 'chmodSync(data,statSync(data).mode ^ 0o010);' :
          'writeFileSync(data+"/task.txt","复制期间改变的内容");',
        "}",
        "const output=execFileSync(" + JSON.stringify(configuration.restic) + ',args,{env:process.env,encoding:"utf8"});',
        mode === "temporary-change" ? 'if(copying)writeFileSync(data+"/task.txt","测试任务文件");' : "",
        "process.stdout.write(output);",
      ].join("\n");
      writeFileSync(executable, script); chmodSync(executable, 0o700);
      assert.throws(() => backupLocal({ ...options, executable }), /一致性|清单或内容发生变化/);
      assert(!existsSync(join(options.dataRoot, "validation/system/local-backup")));
      assert(existsSync(join(options.backupRoot, "repository")), "保留失败检查对应的快照，未自动删除");
    } finally { root.cleanup(); }
  });
}
