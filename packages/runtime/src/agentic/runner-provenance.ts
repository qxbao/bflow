import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoundBehavioralCommand, RunnerDetection } from "./behavioral-runner.js";
const execute = promisify(execFile);
/** Files controlling runner execution are authority, just like test blobs. Never re-read task branch scripts as commands. */
export const runnerDefinitionPattern = /(^|\/)(?:\.gitattributes|\.gitmodules|\.lfsconfig|build\.rs|sitecustomize\.py|usercustomize\.py|Makefile|GNUmakefile|justfile|Justfile|Taskfile\.ya?ml|package\.json|composer\.json|Gemfile|Gemfile\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|pyproject\.toml|pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|setup\.cfg|setup\.py|Pipfile(?:\.lock)?|uv\.lock|poetry\.lock|requirements[^/]*\.txt|CMakeLists\.txt|CTestTestfile\.cmake|Directory\.[^/]+|global\.json|nuget\.config|.*\.(?:csproj|fsproj|vbproj|sln)|(?:vitest|vite|jest|mocha|phpunit|rspec)[^/]*|\.rspec|\.mocharc[^/]*|\.npmrc|\.yarnrc[^/]*|.*lock.*|tsconfig[^/]*|CMakePresets\.json)$|(^|\/)(?:\.github\/workflows|\.cargo|\.mvn|gradle|buildSrc|scripts|test|tests|__tests__|spec)\//i;
async function blobs(cwd: string, revision: string, extra: readonly string[] = []): Promise<Record<string, string>> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-tree", "-r", "-z", revision], { cwd, env, timeout: 30_000, maxBuffer: 4_194_304 });
  const found: Record<string, string> = {};
  for (const entry of result.stdout.split("\0")) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (match && (runnerDefinitionPattern.test(match[3]!) || extra.includes(match[3]!))) {
      if (match[1] === "120000") throw new Error("Runner definitions cannot be symbolic links");
      found[match[3]!] = match[2]!;
    }
  }
  return found;
}
export async function pinRunnerDefinitions(root: string, detection: RunnerDetection): Promise<RunnerDetection> {
  if (detection.status !== "detected") return detection;
  let definitions: Record<string, string>;
  try { definitions = await blobs(root, "HEAD", detection.profiles.flatMap(profile => profile.adapter?.protectedPaths ?? [])); } catch { return detection; } // Non-Git detection fixtures are still useful; production measurements require provenance below.
  try {
    for (const [path, hash] of Object.entries(definitions)) {
      const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > 4_194_304) throw new Error("Definition is not a bounded regular file");
        const bytes = await handle.readFile();
        if (bytes.length > 4_194_304 || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== hash) throw new Error("Definition differs from committed base");
      } finally { await handle.close(); }
    }
  } catch { return { status: "unsupported", agentFixable: true, reason: "Runner definitions must match the committed original revision", remediation: ["Coordinator finishes a reviewed setup task before detection"] }; }
  return { ...detection, profiles: detection.profiles.map(profile => ({ ...profile, definitionBlobs: definitions })) };
}
export async function assertRunnerProvenance(command: BoundBehavioralCommand, cwd: string, revision: string): Promise<void> {
  if (command.checkoutDependencyRoots === undefined) return; // Explicit owner commands preserve their original authority.
  if (!command.definitionBlobs) throw new Error("Automatic runner has no pinned original revision definitions");
  if (command.originalRevision) {
    if (!/^[a-f0-9]{40}$/.test(command.originalRevision)) throw new Error("Invalid original task revision");
    const original = await blobs(cwd, command.originalRevision, Object.keys(command.definitionBlobs));
    const selected = (values: Record<string, string>) => JSON.stringify(Object.entries(values).filter(([path]) => !command.testPaths.includes(path)).sort());
    if (selected(original) !== selected(command.definitionBlobs)) throw new Error("Detected runner definitions do not match the original task revision");
  }
  const current = await blobs(cwd, revision, Object.keys(command.definitionBlobs));
  for (const path of command.testPaths) delete current[path];
  if (JSON.stringify(Object.entries(current).sort()) !== JSON.stringify(Object.entries(command.definitionBlobs).filter(([path]) => !command.testPaths.includes(path)).sort()))
    throw new Error("Runner definitions differ from the original revision; a reviewed setup task must precede this task");
}
