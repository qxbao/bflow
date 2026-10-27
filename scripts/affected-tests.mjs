#!/usr/bin/env node
/**
 * Selects the test files affected by the current branch and working tree, with Runtime's own
 * `verification.regressionScope: affected` policy (packages/runtime/src/agentic/regression-selection.ts):
 * docs-only changes need no tests, code changes select their GitNexus reverse-import closure, package config or
 * unanswerable files widen to their package, and root configuration widens to the full suite.
 *
 * Usage: node scripts/affected-tests.mjs [--base <ref>] [--json] [--run]
 *   --base  Committed baseline to diff against (default: merge-base of HEAD and origin/main, else HEAD).
 *   --run   Build, then run the selected unit and E2E files (the full suites when the selection is `full`).
 *
 * Index: Bflow's isolated GitNexus home (`<bflow state>/gitnexus/gitnexus-home`, overridable with GITNEXUS_HOME) and
 * Bflow's managed executable (overridable with BFLOW_GITNEXUS). Runtime's index adapter enforces freshness, the
 * storage lock and the `ALL SHORTEST` fallback. A dirty working tree is accepted only when every drifted file is
 * one of the changes being selected for: the graph at HEAD then still covers every import edge they can reach.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const runtimeDist = join(root, "packages", "runtime", "dist", "agentic");
if (!existsSync(join(runtimeDist, "regression-changes.js"))) {
  console.error("Runtime is not built; run `pnpm run build` first.");
  process.exit(2);
}
const { classifyChanges, parseNameStatus } = await import(join(runtimeDist, "regression-changes.js"));
const { createGitNexusImpactIndex } = await import(join(runtimeDist, "impact-index.js"));
const { testFilePattern } = await import(join(runtimeDist, "behavioral-runner.js"));

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const json = args.includes("--json");
const run = args.includes("--run");

const git = (...gitArgs) => execFileSync("git", ["-c", "core.quotePath=false", ...gitArgs], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const tryGit = (...gitArgs) => { try { return git(...gitArgs).trim(); } catch { return undefined; } };
const head = git("rev-parse", "HEAD").trim();
const baseRef = option("--base");
const base = baseRef ? git("rev-parse", "--verify", `${baseRef}^{commit}`).trim() : (tryGit("merge-base", "HEAD", "origin/main") ?? head);

// Committed branch changes plus uncommitted tracked edits and untracked files.
const committed = parseNameStatus(git("diff", "--name-status", "-M", "-z", base, head, "--"));
const working = parseNameStatus(git("diff", "--name-status", "-M", "-z", "HEAD", "--"));
// Git lists a nested repository or linked worktree as "dir/"; it is not part of this checkout.
const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(path => path && !path.endsWith("/"))
  .map(path => ({ path, status: "A" }));
const workingPaths = new Set([...working, ...untracked].flatMap(change => [change.path, change.previousPath].filter(Boolean)));
const byPath = new Map();
for (const change of [...committed, ...working, ...untracked]) byPath.set(change.path, change);
const changes = [...byPath.values()];

const files = [...new Set([...git("ls-files", "-z").split("\0"), ...untracked.map(change => change.path)].filter(Boolean))];
const packageRoots = new Set(files.filter(file => file.endsWith("/package.json")).map(file => file.slice(0, -"/package.json".length)));
const packageRootOf = path => {
  for (let cursor = path; cursor.includes("/");) {
    cursor = cursor.slice(0, cursor.lastIndexOf("/"));
    if (packageRoots.has(cursor)) return cursor;
  }
  return undefined;
};
const candidateTests = files.filter(file => testFilePattern.test(file) && /\.[cm]?[jt]sx?$/.test(file) && existsSync(join(root, file))).sort();
const classification = classifyChanges(changes, packageRootOf);

/**
 * Edges the import graph cannot see: string paths into another package's `dist/` (a spawned `dist/bin.js`, a
 * launcher path or `new URL(...)` asset). A source file holding such a path is added to the query seeds; a test
 * file holding one is selected directly.
 */
function distReferences(changedPackages) {
  const seeds = new Set(), tests = new Set();
  const literal = /["'`]([^"'`\n]*\/dist\/[^"'`\n]*)["'`]/g;
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.includes("/dist/") || file.includes("node_modules/")) continue;
    let source;
    try { source = readFileSync(join(root, file), "utf8"); } catch { continue; }
    for (const match of source.matchAll(literal)) {
      const value = match[1];
      const named = /(?:^|\/)((?:packages|apps)\/[^/]+)\/dist\//.exec(value)?.[1];
      const target = named ?? (value.startsWith(".") ? packageRootOf(posix.normalize(posix.join(posix.dirname(file), value.split("${")[0]))) : undefined);
      if (target === undefined || !changedPackages.has(target)) continue;
      (testFilePattern.test(file) ? tests : seeds).add(file);
    }
  }
  return { seeds: [...seeds], tests: [...tests] };
}

function bflowState() {
  if (process.env.BFLOW_HOME) return join(resolve(process.env.BFLOW_HOME), "state");
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "bflow");
}
function bflowData() {
  if (process.env.BFLOW_HOME) return join(resolve(process.env.BFLOW_HOME), "data");
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "bflow");
}

async function importers(seedFiles) {
  const stateRoot = join(bflowState(), "gitnexus");
  const home = process.env.GITNEXUS_HOME ?? join(stateRoot, "gitnexus-home");
  const managed = join(bflowData(), "tools", "gitnexus", "node_modules", ".bin", "gitnexus");
  const executable = process.env.BFLOW_GITNEXUS ?? (existsSync(managed) ? managed : "gitnexus");
  const storageLockPath = join(stateRoot, `gitnexus-storage-${createHash("sha256").update(root).digest("hex")}.lock`);
  const runCommand = (file, commandArgs, options) => {
    const result = spawnSync(file, commandArgs, { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let stdout = result.stdout ?? "";
    if (commandArgs[0] === "status" && result.status === 0) {
      const status = JSON.parse(stdout.slice(stdout.indexOf("{")));
      const drift = status.contentDrift;
      const drifted = drift?.status === "drifted" ? [...(drift.changed ?? []), ...(drift.added ?? []), ...(drift.deleted ?? [])] : [];
      const truncated = Object.values(drift?.truncated ?? {}).some(Boolean);
      if (drifted.length > 0 && !truncated && status.index?.commit === head && drifted.every(path => workingPaths.has(path))) {
        stdout = JSON.stringify({ ...status, status: "up-to-date", contentDrift: { status: "current" } });
      }
    }
    return { exitCode: result.error ? null : result.status, stdout, stderr: result.stderr ?? String(result.error ?? "") };
  };
  const index = createGitNexusImpactIndex({ executable, home, storageLockPath, run: async (...input) => runCommand(...input) });
  return index.importersOf({ repositoryRoot: root, base: head, files: seedFiles });
}

let scope = classification.tier;
const widening = [...classification.widening];
const selectedPackages = new Set(classification.packageRoots);
const selected = new Set(classification.changedTests.filter(file => candidateTests.includes(file)));
let indexReport = { notQueried: true };
let extra = { seeds: [], tests: [] };

if (scope !== "none" && scope !== "full" && classification.graphFiles.length > 0) {
  const changedPackages = new Set(classification.graphFiles.map(packageRootOf).filter(Boolean));
  extra = distReferences(changedPackages);
  const seeds = [...new Set([...classification.graphFiles, ...extra.seeds])];
  const result = await importers(seeds);
  if (result.status === "ok") {
    indexReport = { commit: result.indexCommit };
    for (const file of result.files) if (candidateTests.includes(file)) selected.add(file);
    for (const file of extra.tests) selected.add(file);
  } else {
    indexReport = { unavailable: result.code, detail: result.detail };
    for (const file of classification.graphFiles) {
      const pkg = packageRootOf(file);
      widening.push({ path: file, tier: pkg ? "package" : "full", reason: `index_unavailable:${result.code}`, ...(pkg ? { packageRoot: pkg } : {}) });
      if (pkg) { selectedPackages.add(pkg); if (scope === "graph") scope = "package"; } else scope = "full";
    }
  }
}
if (scope === "full") candidateTests.forEach(file => selected.add(file));
else for (const pkg of selectedPackages) candidateTests.filter(file => file.startsWith(`${pkg}/`)).forEach(file => selected.add(file));

const tests = [...selected].sort();
const e2e = tests.filter(file => file.startsWith("tests/e2e/"));
const unit = tests.filter(file => !file.startsWith("tests/e2e/"));
const report = { scope, base, head, changedFiles: changes.map(change => change.path).sort(), widening, index: indexReport,
  distReferenceSeeds: extra.seeds, unit, e2e };

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`scope: ${scope}  base: ${base.slice(0, 12)}  head: ${head.slice(0, 12)}  changed: ${report.changedFiles.length}`);
  console.log(`index: ${"commit" in indexReport ? `ok at ${indexReport.commit.slice(0, 12)}` : "unavailable" in indexReport ? `unavailable (${indexReport.unavailable}) ${indexReport.detail}` : "not queried"}`);
  for (const item of widening) console.log(`widened ${item.path} -> ${item.tier}${item.packageRoot ? ` (${item.packageRoot})` : ""}: ${item.reason}`);
  if (extra.seeds.length) console.log(`dist-reference seeds: ${extra.seeds.join(" ")}`);
  console.log(`unit tests: ${unit.length}  e2e tests: ${e2e.length}`);
  for (const file of tests) console.log(`  ${file}`);
}

if (run) {
  const step = (command, commandArgs) => {
    console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
    const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (scope === "none") process.exit(0);
  step("pnpm", ["run", "build"]);
  if (scope === "full") {
    step("pnpm", ["exec", "vitest", "run"]);
    step("pnpm", ["exec", "vitest", "run", "--config", "tests/e2e/vitest.config.ts"]);
  } else {
    if (unit.length) step("pnpm", ["exec", "vitest", "run", ...unit]);
    if (e2e.length) step("pnpm", ["exec", "vitest", "run", "--config", "tests/e2e/vitest.config.ts", ...e2e]);
  }
}
