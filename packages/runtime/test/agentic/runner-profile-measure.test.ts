import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { bindRunnerProfile, measureBehavior, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const depName = "dep resolves through the checkout", generatedName = "generated output is available";
function profile(dependencySource: string, overrides: Partial<RunnerProfile> = {}): RunnerProfile {
  return { id: "node-tap-pnpm", command: "detected:node-tap", executable: process.execPath, args: ["--test", "--test-reporter=tap"],
    method: "unit_test", levels: ["unit", "regression"], reporter: "node_tap", timeoutMs: 30_000,
    definitionBlobs: {}, checkoutDependencyRoots: ["node_modules", "pkg/node_modules"], dependencySource, source: "detected", ...overrides };
}

describe("bindRunnerProfile", () => {
  it("binds profile argv, test identities, dependency roots and prepare step", () => {
    const bound = bindRunnerProfile(profile("/repo", { prepare: { args: ["node_modules/typescript/bin/tsc", "-b"], timeoutMs: 60_000 } }),
      { testNames: ["a"], testPaths: ["pkg/test/a.test.cjs"] });
    expect(bound).toEqual({ id: "node-tap-pnpm", command: "detected:node-tap", executable: process.execPath,
      args: ["--test", "--test-reporter=tap", "--test-name-pattern=^(?:a)$", "pkg/test/a.test.cjs"], method: "unit_test", levels: ["unit", "regression"],
      testNames: ["a"], testPaths: ["pkg/test/a.test.cjs"], reporter: "node_tap", timeoutMs: 30_000,
      definitionBlobs: {}, checkoutDependencyRoots: ["node_modules", "pkg/node_modules"], dependencySource: "/repo",
      prepare: { args: ["node_modules/typescript/bin/tsc", "-b"], timeoutMs: 60_000 } });
    expect(bindRunnerProfile(profile("/repo"), { testNames: ["a"], testPaths: ["src/feature.spec.ts"] })).not.toHaveProperty("prepare");
  });
  it("rejects unsafe or non-test paths, unsafe dependency roots and duplicate identities", () => {
    for (const testPath of ["../pkg/test/a.test.cjs", "/abs/pkg/test/a.test.cjs", "pkg\\test\\a.test.cjs", "pkg:test/a.test.cjs", "pkg/test/./a.test.cjs"])
      expect(() => bindRunnerProfile(profile("/repo"), { testNames: ["a"], testPaths: [testPath] })).toThrow("unique and safe");
    expect(() => bindRunnerProfile(profile("/repo"), { testNames: ["a"], testPaths: ["pkg/src/index.cjs"] })).toThrow("committed test files");
    expect(() => bindRunnerProfile(profile("/repo", { checkoutDependencyRoots: ["../node_modules"] }), { testNames: ["a"], testPaths: ["pkg/test/a.test.cjs"] })).toThrow("Unsafe");
    expect(() => bindRunnerProfile(profile("/repo", { checkoutDependencyRoots: ["pkg/src"] }), { testNames: ["a"], testPaths: ["pkg/test/a.test.cjs"] })).toThrow("node_modules");
    expect(() => bindRunnerProfile(profile("/repo"), { testNames: ["a", "a"], testPaths: ["pkg/test/a.test.cjs"] })).toThrow("unique and safe");
    expect(() => bindRunnerProfile(profile("/repo"), { testNames: ["a"], testPaths: ["pkg/test/a.test.cjs", "pkg/test/a.test.cjs"] })).toThrow("unique and safe");
    expect(() => bindRunnerProfile(profile("/repo"), { testNames: [""], testPaths: ["pkg/test/a.test.cjs"] })).toThrow("test names");
  });
});

async function pnpmLikeRepo() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "bflow-profile-measure-")));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Profile Test"); git("config", "user.email", "profile@example.test");
  await writeFile(join(cwd, ".gitignore"), "node_modules/\nout/\n");
  for (const dir of ["pkg/test", "pkg/node_modules", "scripts", "node_modules/.store/dep"]) await mkdir(join(cwd, dir), { recursive: true });
  // Installed dependency lives in the store; the package-level link is relative, exactly as pnpm writes it.
  await writeFile(join(cwd, "node_modules/.store/dep/index.js"), "module.exports = { value: 4 };\n");
  await symlink("../../node_modules/.store/dep", join(cwd, "pkg/node_modules/dep"));
  await writeFile(join(cwd, "pkg/test/dep.test.cjs"), `const {test}=require('node:test'); const assert=require('node:assert/strict');\ntest(${JSON.stringify(depName)},()=>assert.equal(require('dep').value,4));\n`);
  await writeFile(join(cwd, "pkg/test/generated.test.cjs"), `const {test}=require('node:test'); const assert=require('node:assert/strict');\ntest(${JSON.stringify(generatedName)},()=>assert.equal(require('../../out/gen.js'),7));\n`);
  await writeFile(join(cwd, "scripts/gen.cjs"), "const fs=require('node:fs'); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/gen.js','module.exports = 7;\\n');\n");
  await writeFile(join(cwd, "scripts/tamper.cjs"), "require('node:fs').appendFileSync('pkg/test/dep.test.cjs','// tampered\\n');\n");
  await writeFile(join(cwd, "scripts/fail.cjs"), "process.stderr.write('tsc: compile failed in pkg\\n'); process.exit(1);\n");
  git("add", "."); git("commit", "-m", "pnpm-like fixture");
  return { cwd, revision: git("rev-parse", "HEAD"), git };
}

// Measurements launch the production Bubblewrap sandbox, so they need Linux and /usr/bin/bwrap.
describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("runner profile measurements in the Linux sandbox", () => {
  it("measures a pnpm-style relative-symlinked dependency tree without modifying tracked files", async () => {
    const f = await pnpmLikeRepo();
    const command = bindRunnerProfile(profile(f.cwd), { testNames: [depName], testPaths: ["pkg/test/dep.test.cjs"] });
    const measured = await measureBehavior(command, f.cwd, f.revision);
    expect(measured).toMatchObject({ tests: 1, passed: 1, failed: 0, testNames: [depName] });
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 120_000);
  it("allows a sandboxed prepare step to create only git-ignored outputs used by the tests", async () => {
    const f = await pnpmLikeRepo();
    const command = bindRunnerProfile(profile(f.cwd, { prepare: { args: ["scripts/gen.cjs"], timeoutMs: 30_000 } }),
      { testNames: [generatedName], testPaths: ["pkg/test/generated.test.cjs"] });
    expect(await measureBehavior(command, f.cwd, f.revision)).toMatchObject({ tests: 1, passed: 1, failed: 0 });
    await expect(stat(join(f.cwd, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 120_000);
  it("rejects a prepare step that modifies a tracked file", async () => {
    const f = await pnpmLikeRepo();
    const command = bindRunnerProfile(profile(f.cwd, { prepare: { args: ["scripts/tamper.cjs"], timeoutMs: 30_000 } }),
      { testNames: [depName], testPaths: ["pkg/test/dep.test.cjs"] });
    await expect(measureBehavior(command, f.cwd, f.revision)).rejects.toThrow("clean worktree");
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 120_000);
  it("reports a failing prepare step as a bounded infrastructure failure with its stderr tail", async () => {
    const f = await pnpmLikeRepo();
    const command = bindRunnerProfile(profile(f.cwd, { prepare: { args: ["scripts/fail.cjs"], timeoutMs: 30_000 } }),
      { testNames: [depName], testPaths: ["pkg/test/dep.test.cjs"] });
    await expect(measureBehavior(command, f.cwd, f.revision)).rejects.toThrow(/infrastructure failure \(prepare\): exit 1 stderr: tsc: compile failed in pkg/);
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 120_000);
  it("reports a prepare step exceeding its own deadline as an infrastructure failure", async () => {
    const f = await pnpmLikeRepo();
    const command = bindRunnerProfile(profile(f.cwd, { prepare: { args: ["scripts/gen.cjs"], timeoutMs: 1 } }),
      { testNames: [generatedName], testPaths: ["pkg/test/generated.test.cjs"] });
    await expect(measureBehavior(command, f.cwd, f.revision)).rejects.toThrow("infrastructure failure (prepare): deadline exceeded");
  }, 120_000);
});
