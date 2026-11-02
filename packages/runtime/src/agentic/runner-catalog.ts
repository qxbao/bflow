import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RunnerDetection, RunnerProfile } from "./behavioral-runner.js";
import type { AdapterContext, RunnerAdapter } from "./runner-adapter.js";
import { declaredRunnerAdapter } from "./declared-runner-adapter.js";
import { javascriptAdapter } from "./javascript-adapter.js";
import { nativeAdapters } from "./runner-adapters/native.js";
import { managedAdapters } from "./runner-adapters/managed.js";
import { pinRunnerDefinitions } from "./runner-provenance.js";
const ignored = new Set([".git", ".bflow", "node_modules", ".venv", "venv", "dist", "coverage", "target", "build", "vendor", ".gradle", ".idea", ".next", "__pycache__"]);
/** Deterministic bounded inventory, never follows directory or manifest symlinks. */
export async function runnerInventory(root: string): Promise<string[]> {
  const files: string[] = [], pending = [root]; let visits = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visits > 30_000) throw new Error("Runner inventory exceeds bounds");
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith(".claude") && !entry.name.startsWith(".codex")) pending.push(path);
      else if (entry.isFile()) files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files.sort();
}
// Resolved lazily: runner-detection <-> runner-catalog <-> javascript-adapter import each other, so module-load evaluation would see an undefined adapter.
export const runnerAdapters = (): readonly RunnerAdapter[] => [javascriptAdapter, ...nativeAdapters, ...managedAdapters, declaredRunnerAdapter];
export async function detectRunnerCatalog(root: string, javascript: RunnerDetection, adapters: readonly RunnerAdapter[] = runnerAdapters(), javascriptDependencySource?: string): Promise<RunnerDetection> {
  root = await realpath(root);
  const context: AdapterContext = { root, files: await runnerInventory(root), ...(javascriptDependencySource ? { dependencySource: javascriptDependencySource } : {}) };
  const profiles: RunnerProfile[] = javascript.status === "detected" ? [...javascript.profiles] : [];
  const notes = javascript.status === "detected" ? [...javascript.notes] : [];
  for (const adapter of adapters) {
    try {
      const result = await adapter.detect(context); notes.push(...result.notes);
      for (const candidate of result.runners) {
        if (javascript.status === "detected" && candidate.projectDirectory === "." && ["vitest", "node"].includes(candidate.adapterId)) continue;
        const duplicate = result.runners.filter(item => item.adapterId === candidate.adapterId && item.projectDirectory === candidate.projectDirectory).length > 1;
        if (duplicate) { notes.push(`${candidate.adapterId}: runner_identity_unselectable: multiple test projects share one directory`); continue; }
        const directorySuffix = candidate.projectDirectory === "." ? "" : ":" + candidate.projectDirectory.replace(/[^A-Za-z0-9._-]/g, "-").slice(0,48) + "-" + createHash("sha256").update(candidate.projectDirectory).digest("hex").slice(0,12);
        const source = javascriptDependencySource && ["jest", "mocha"].includes(candidate.adapterId) && candidate.projectDirectory === "." ? javascriptDependencySource : root;
        const roots: string[] = [];
        for (const file of context.files.filter(file => /(^|\/)package\.json$/.test(file))) {
          const rel = file === "package.json" ? "node_modules" : file.slice(0, -"package.json".length) + "node_modules";
          try { if ((await lstat(join(source, rel))).isDirectory() && await realpath(join(source, rel)) === join(source, rel)) roots.push(rel); } catch { /* no dependency tree */ }
        }
        for (const [level, method] of [["unit", "unit_test"], ["integration", "integration_test"], ["e2e", "e2e_test"]] as const) profiles.push({
          id: `auto-${level}-${candidate.adapterId}${directorySuffix.replace(/:/g, "-")}`, command: `auto:${level}:${candidate.adapterId}${directorySuffix}`,
          executable: candidate.executable, args: [], method, levels: [level, "regression"], reporter: candidate.format === "vitest_json" ? "vitest_json" : "node_tap", timeoutMs: 180_000, maxOutputBytes: 4_194_304,
          checkoutDependencyRoots: roots, dependencySource: source, source: "detected", adapter: candidate
        });
      }
    } catch (error) { notes.push(`${adapter.id}: runner setup required: ${String(error)}`); }
  }
  if (javascript.status === "detected") {
    const unit = javascript.profiles[0]!;
    profiles.push({ ...unit, id: "auto-e2e", command: "auto:e2e", method: "e2e_test", levels: ["e2e", "regression"] });
    for (const profile of [...profiles].filter(profile => !profile.adapter)) profiles.push({ ...profile, id: profile.id + "-javascript", command: profile.command + ":javascript" });
  }
  return profiles.length ? pinRunnerDefinitions(root, { status: "detected", profiles, notes }) : { status: "unsupported", reason: [javascript.status === "unsupported" ? javascript.reason : "", ...notes].filter(Boolean).join("; ") || "No supported runner detected", agentFixable: context.files.some(file => /(^|\/)(?:CMakeLists\.txt|CTestTestfile\.cmake|package\.json|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle.*|Gemfile|composer\.json|Makefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py)$/.test(file) || /\.(?:cs|fs|vb)proj$/.test(file)), remediation: ["Coordinator creates a reviewed runner setup task, then retries detection"] };
}
