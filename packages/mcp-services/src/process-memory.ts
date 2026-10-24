import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Private macOS backend. Leaf services do not import Gateway implementation code.
 * Fixed executable/argv and a numeric PID, no shell, environment inheritance or process mutation. */
export async function readDarwinProcessRssBytes(pid: number): Promise<number> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process identity for RSS measurement");
  const { stdout } = await promisify(execFile)("/bin/ps", ["-o", "rss=", "-p", String(pid)],
    { timeout: 1000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  const kib = /^\s*\d+\s*$/.test(stdout) ? Number(stdout.trim()) : NaN;
  if (!Number.isSafeInteger(kib * 1024) || kib <= 0) throw new Error("Process RSS measurement is unavailable");
  return kib * 1024;
}
