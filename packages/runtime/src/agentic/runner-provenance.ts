import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoundBehavioralCommand, RunnerDetection } from "./behavioral-runner.js";
const execute = promisify(execFile);
/** Files controlling runner execution are authority, just like test blobs. Never re-read task branch scripts as commands. */
export const runnerDefinitionPattern = /(^|\/)(?:.*\.(?:gradle(?:\.kts)?|props|targets|cmake|mk|make)|\.gitattributes|\.gitmodules|\.lfsconfig|build\.rs|sitecustomize\.py|usercustomize\.py|Makefile|GNUmakefile|justfile|Justfile|Taskfile\.ya?ml|package\.json|composer\.json|Gemfile|Gemfile\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|pyproject\.toml|pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|setup\.cfg|setup\.py|Pipfile(?:\.lock)?|uv\.lock|poetry\.lock|requirements[^/]*\.txt|CMakeLists\.txt|CTestTestfile\.cmake|Directory\.[^/]+|global\.json|nuget\.config|.*\.(?:csproj|fsproj|vbproj|sln)|(?:vitest|vite|jest|mocha|phpunit|rspec)[^/]*|\.rspec|\.mocharc[^/]*|\.npmrc|\.yarnrc[^/]*|.*lock.*|tsconfig[^/]*|CMakePresets\.json)$|(^|\/)(?:\.github\/workflows|\.cargo|\.mvn|gradle|buildSrc|scripts|test|tests|__tests__|spec)\//i;
async function blobs(cwd: string, revision: string, extra: readonly string[] = []): Promise<Record<string, string>> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-tree", "-r", "-z", revision], { cwd, env, timeout: 30_000, maxBuffer: 4_194_304 });
  const found: Record<string, string> = {}, tracked: Record<string, string> = {};
  for (const entry of result.stdout.split("\0")) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (match) tracked[match[3]!] = match[1]!;
    if (match && (runnerDefinitionPattern.test(match[3]!) || extra.includes(match[3]!))) {
      if (match[1] === "120000") throw new Error("Runner definitions cannot be symbolic links");
      found[match[3]!] = match[2]!;
    }
  }
  const projectBase = (path: string) => {
    let directory = dirname(path);
    while (true) {
      if (["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some(name => tracked[posix.join(directory, name)])) return directory;
      const parent = dirname(directory); if (parent === directory) return dirname(path); directory = parent;
    }
  };
  const pending = Object.keys(found).map(path => ({ path, base: projectBase(path), imported: false })), visited = new Set<string>();
  while (pending.length) {
    const { path, base, imported } = pending.pop()!;
    if (visited.has(path)) continue; visited.add(path);
    if (!/\.(?:gradle(?:\.kts)?|props|targets|[cfv]sproj|cmake)$|(?:^|\/)(?:CMakeLists\.txt|Makefile|GNUmakefile)$/.test(path) && !imported) continue;
    if (visited.size > 2000) throw new Error("Execution definition dependency closure exceeds bounds");
    const source = (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "show", `${revision}:${path}`], { cwd, env, timeout: 30000, maxBuffer: 1048576 })).stdout;
    if (/\.gradle(?:\.kts)?$/.test(path) && /apply\s*(?:\(\s*from\s*=|from\s*:)\s*(?![\s"'])\S/.test(source)) throw new Error("Dynamic execution imports require a reviewed static runner setup");
    const references: { path: string; projectRelative: boolean }[] = [];
    if (/\.gradle(?:\.kts)?$/.test(path) && /apply\s*(?:\(\s*from\s*=|from\s*:)\s*["'][^"']+["']\s*\+/.test(source)) throw new Error("Concatenated execution imports require a reviewed static runner setup");
    for (const match of source.matchAll(/apply\s*(?:\(\s*from\s*=\s*|from\s*:\s*)["']([^"']+)["']/g)) references.push({ path: match[1]!, projectRelative: true });
    for (const match of source.matchAll(/<Import\b[^>]*\bProject\s*=\s*["']([^"']+)["']/gi)) references.push({ path: match[1]!.replace(/\$\((?:MSBuildThisFileDirectory|MSBuildProjectDirectory)\)[\\/]?/g, ""), projectRelative: false });
    for (const importedReference of references) {
      const reference = importedReference.path;
      if (/[\0\r\n$*?{}]/.test(reference) || isAbsolute(reference)) throw new Error("Execution definition imports must resolve to pinned repository files");
      const normalized = reference.replaceAll("\\", "/");
      const anchors = importedReference.projectRelative ? [base, dirname(path)] : [dirname(path), base];
      const candidates = [...new Set(anchors.map(anchor => posix.normalize(posix.join(anchor, normalized))))];
      const dependency = candidates.find(candidate => !candidate.startsWith("../") && tracked[candidate] !== undefined);
      if (!dependency) throw new Error("Execution definition import is not a committed repository file");
      if (tracked[dependency] === "120000") throw new Error("Execution definition imports cannot traverse symbolic links");
      const entry = (await execute("git", ["ls-tree", "-z", revision, "--", dependency], { cwd, env, timeout: 30000, maxBuffer: 65536 })).stdout;
      const hash = /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry)?.[1];
      if (!hash) throw new Error("Invalid execution definition dependency");
      found[dependency] = hash; pending.push({ path: dependency, base, imported: true });
    }
  }
  return found;
}
export async function pinRunnerDefinitions(root: string, detection: RunnerDetection): Promise<RunnerDetection> {
  if (detection.status !== "detected") return detection;
  let definitions: Record<string, string>;
  try { definitions = await blobs(root, "HEAD", detection.profiles.flatMap(profile => profile.adapter?.protectedPaths ?? [])); } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr ?? error))) return detection; // Read-only non-Git fixtures cannot be measured.
    return { status: "unsupported", agentFixable: true, reason: "Execution definition imports cannot be pinned to the committed original revision", remediation: ["Coordinator creates a reviewed runner setup task with static repository-local imports"] };
  }
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
