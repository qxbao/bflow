import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { environmentProcessRunner, type EnvironmentProcessRunner } from "./environment-process.js";

export interface RepositoryIdentity {
  readonly root: string;
  readonly gitDir: string;
  readonly id: string;
  readonly sessionName: string;
}

export async function identifyRepository(cwd: string, runner: EnvironmentProcessRunner = environmentProcessRunner): Promise<RepositoryIdentity> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const query = async (flag: string) => {
    const result = await runner.run({ executable: "git", args: ["rev-parse", flag], cwd, env, timeoutMs: 5000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(`Not a Git working repository: '${cwd}'. Run git init or select a repository.`);
    return realpath(result.stdout.trim());
  };
  const root = await query("--show-toplevel");
  const gitDir = await query("--absolute-git-dir");
  const id = createHash("sha256").update(root).update("\0").update(gitDir).digest("hex");
  return { root, gitDir, id, sessionName: `bf-${id.slice(0, 20)}` };
}
