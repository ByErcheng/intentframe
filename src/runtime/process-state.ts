/** 只用于本项目保存的进程身份。权限不足或其他错误不能证明进程已结束。 */
export function processExists(pid: number, group = false): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("缺少可信的原执行进程编号。");
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}
import { execFileSync } from "node:child_process";


/** 固定时区与语言，避免不同客户端环境让同一进程的启动时间看起来不同。 */
export function processStartedAt(pid: number): string | undefined {
  if (!processExists(pid)) return undefined;
  try {
    const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 1_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!value) throw new Error("未取得进程启动时间。");
    return value;
  } catch {
    if (!processExists(pid)) return undefined;
    throw new Error("无法核对原进程的启动身份。");
  }
}

/** false 表示原进程已离开；无法核实时返回 undefined，不能据此接管执行。 */
export function processMatches(pid: number, startedAt?: string): boolean | undefined {
  if (!processExists(pid)) return false;
  if (!startedAt) return undefined;
  try { return processStartedAt(pid) === startedAt; } catch { return undefined; }
}
