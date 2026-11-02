import { environmentProcessRunner } from "../environment-process.js";
import { gitSafeDirectoryFlags, sanitizedGitEnv } from "../git-safe-directory.js";

/** Runs a read-only Git query with inherited repository overrides removed and optional locks off. */
export async function readOnlyGit(cwd: string, args: readonly string[]): Promise<{ ok: boolean; exitCode: number | null; stdout: string }> {
  const env = sanitizedGitEnv();
  const result = await environmentProcessRunner.run({
    executable: "git",
    args: [...gitSafeDirectoryFlags(cwd), "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    cwd,
    env,
    timeoutMs: 10_000
  });
  return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout };
}
