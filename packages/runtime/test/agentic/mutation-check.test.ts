import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QualityGateContextSchema } from "@bflow/contracts";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { assessMutation, createMutatedRevision, parseMutationChecks } from "../../src/agentic/mutation-check.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const testName = "ac-1: concurrent takes grant exactly one token";
const find = "this.lock.runExclusive(";
const replace = "((fn) => fn())(";
const command = () => parseBehavioralCommands([{ id: "unit", command: "owner:test-unit", executable: process.execPath,
  args: ["--test", "--test-reporter=tap", "test/bucket.test.cjs"], method: "unit_test", levels: ["unit"], testNames: [testName],
  testPaths: ["test/bucket.test.cjs"], timeoutMs: 15_000 }]);
const check = (overrides: Record<string, unknown> = {}) => ({ id: "bucket-lock", commandId: "unit", file: "source.cjs", find, replace,
  expectFailingTests: [testName], ...overrides });

describe("parseMutationChecks", () => {
  it("accepts a valid owner mutation and returns [] when absent", () => {
    expect(parseMutationChecks([check()], command())).toEqual([check()]);
    expect(parseMutationChecks(undefined, command())).toEqual([]);
  });
  it.each([
    ["unknown key", { extra: true }, /Unknown mutation/],
    ["parent traversal", { file: "../source.cjs" }, /repository-relative/],
    ["absolute path", { file: "/source.cjs" }, /repository-relative/],
    ["backslash", { file: "a\\source.cjs" }, /repository-relative/],
    ["drive colon", { file: "C:source.cjs" }, /repository-relative/],
    ["empty find", { find: "" }, /nonempty/],
    ["oversized replace", { replace: "x".repeat(4097) }, /4096/],
    ["find equals replace", { replace: find }, /must differ/],
    ["unknown command", { commandId: "missing" }, /unknown behavioral command/],
    ["expected test not run", { expectFailingTests: ["ac-9: not configured"] }, /does not run/],
    ["empty expectation", { expectFailingTests: [] }, /nonempty list/],
    ["duplicate expectation", { expectFailingTests: [testName, testName] }, /unique/],
    ["unsafe id", { id: "../x" }, /id must be safe/]
  ])("rejects %s", (_label, overrides, pattern) => {
    expect(() => parseMutationChecks([check(overrides)], command())).toThrow(pattern);
  });
  it("rejects duplicate ids", () => {
    expect(() => parseMutationChecks([check(), check()], command())).toThrow(/Duplicate mutation check/);
  });
  it("enforces the aggregate deadline across behavioral and mutation runs", () => {
    const long = parseBehavioralCommands([{ id: "unit", command: "owner:test-unit", executable: process.execPath,
      args: ["--test", "--test-reporter=tap", "test/bucket.test.cjs"], method: "unit_test", levels: ["unit"], testNames: [testName],
      testPaths: ["test/bucket.test.cjs"], timeoutMs: 300_000 }]);
    expect(() => parseMutationChecks([check()], long)).toThrow(/budget exceeds the host deadline/);
  });
});

describe("assessMutation", () => {
  it("kills only when every expected test failed", () => {
    const expected = { expectFailingTests: ["a", "b"] };
    expect(assessMutation(expected, { testResults: [{ name: "a", passed: false }, { name: "b", passed: false }] })).toMatchObject({ killed: true, survivors: [] });
    expect(assessMutation(expected, { testResults: [{ name: "a", passed: false }, { name: "b", passed: true }] })).toMatchObject({ killed: false, survivors: ["b"] });
  });
});

async function repository(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-mutation-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git("add", "."); git("commit", "-m", "baseline");
  return { root, git, head: git("rev-parse", "HEAD") };
}

describe("createMutatedRevision", () => {
  const mutation = { id: "bucket-lock", file: "source.cjs", find, replace };

  it("builds a dangling child commit without touching HEAD, the index or any worktree", async () => {
    const repo = await repository({ "source.cjs": "take(){ return this.lock.runExclusive(async () => 1); }", "other.txt": "kept\n" });
    const before = { head: repo.git("rev-parse", "HEAD"), status: repo.git("status", "--porcelain"), worktrees: repo.git("worktree", "list"), branches: repo.git("for-each-ref") };
    const result = await createMutatedRevision(repo.root, repo.head, mutation);
    if (result.status !== "mutated") throw new Error("expected a mutated revision");
    expect(repo.git("rev-parse", `${result.revision}^`)).toBe(repo.head);
    expect(repo.git("show", `${result.revision}:source.cjs`)).toBe("take(){ return ((fn) => fn())(async () => 1); }");
    expect(repo.git("show", `${result.revision}:other.txt`)).toBe("kept");
    expect(repo.git("log", "-1", "--format=%an <%ae>|%s", result.revision)).toBe("bflow <bflow@localhost>|bflow mutation bucket-lock");
    expect({ head: repo.git("rev-parse", "HEAD"), status: repo.git("status", "--porcelain"), worktrees: repo.git("worktree", "list"), branches: repo.git("for-each-ref") }).toEqual(before);
  });

  it("reports an absent file as not applicable", async () => {
    const repo = await repository({ "other.cjs": find });
    expect(await createMutatedRevision(repo.root, repo.head, mutation)).toEqual({ status: "not_applicable", reason: "file_absent" });
  });

  it("reports an absent pattern as not applicable", async () => {
    const repo = await repository({ "source.cjs": "take(){ return this.lock.exclusive(async () => 1); }" });
    expect(await createMutatedRevision(repo.root, repo.head, mutation)).toEqual({ status: "not_applicable", reason: "pattern_absent" });
  });

  it("rejects an ambiguous pattern instead of guessing", async () => {
    const repo = await repository({ "source.cjs": `${find}a); ${find}b);` });
    await expect(createMutatedRevision(repo.root, repo.head, mutation)).rejects.toThrow(/occurs 2 times/);
  });
});

const sandbox = await probeBehavioralSandbox();

describe.skipIf(sandbox.status !== "ready")("owner mutation gate (sandboxed node --test)", () => {
  // A promise-based mutex: the critical section awaits, so unprotected takes interleave and both are granted.
  const lockSource = (body: string) => `class Lock { constructor(){ this.tail = Promise.resolve(); }
runExclusive(fn){ const run = this.tail.then(() => fn()); this.tail = run.catch(() => undefined); return run; } }
class Bucket { constructor(){ this.lock = new Lock(); this.tokens = 1; }
${body} }
module.exports = { Bucket };
`;
  const asyncTake = `take(){ return this.lock.runExclusive(async () => { const available = this.tokens; await new Promise(resolve => setImmediate(resolve)); if (available > 0) { this.tokens = available - 1; return true; } return false; }); }`;
  const syncTake = `take(){ return this.lock.runExclusive(() => { const available = this.tokens; if (available > 0) { this.tokens = available - 1; return true; } return false; }); }`;
  // Interleaving point inside the critical section: the test can observe a lost update only when the lock is absent.
  const racingTest = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const {Bucket}=require('../source.cjs');
test(${JSON.stringify(testName)}, async () => { const bucket = new Bucket(); const results = await Promise.all([bucket.take(), bucket.take()]); assert.equal(results.filter(Boolean).length, 1); });\n`;
  // Without the interleaving point (a synchronous critical section) the same Promise.all test passes with the lock removed.
  const syncTest = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const {Bucket}=require('../source.cjs');
test(${JSON.stringify(testName)}, async () => { const bucket = new Bucket(); const results = await Promise.all([bucket.take(), bucket.take()]); assert.equal(results.filter(Boolean).length, 1); });\n`;

  async function gateFixture(source: string, testSource: string) {
    const repo = await repository({ "source.cjs": source, "test/bucket.test.cjs": testSource });
    const parsed = parseMutationChecks([check()], command());
    const host = new HostVerification(() => ({ inspect: async () => ({}) }) as unknown as AgenticWorkflowRuntime,
      () => { throw new Error("artifact store is not used by mutation checks"); }, undefined, command(), undefined, undefined, parsed);
    const definition = host.behavioralChecks().find(item => item.id === "host-mutation-bucket-lock")!;
    const gate = host.behavioralGates().find(item => item.id === "host-mutation-bucket-lock")!;
    const evaluate = (scope: "task" | "workflow", revision: string) => gate.evaluate(QualityGateContextSchema.parse({ runId: "run-1",
      taskId: scope === "task" ? "task-1" : "workflow-finalization", attemptId: `attempt-${scope}`, definition, artifacts: [],
      input: { sourceRevision: revision, sourceWorktreePath: repo.root, specFingerprint: "a".repeat(64), scope } }));
    return { repo, evaluate };
  }

  it("passes when the named test fails with the protection replaced (discriminating)", async () => {
    const { repo, evaluate } = await gateFixture(lockSource(asyncTake), racingTest);
    const before = repo.git("status", "--porcelain");
    const result = await evaluate("task", repo.head);
    expect(result.ok && result.value.status).toBe("passed");
    expect(result.ok && result.value.metadata).toMatchObject({
      verification: { sourceRevision: repo.head, scope: "task", independentExecution: true, isolated: true, executorId: "bflow-host-mutation-check" },
      mutation: { id: "bucket-lock", killed: true }
    });
    expect(repo.git("rev-parse", "HEAD")).toBe(repo.head);
    expect(repo.git("status", "--porcelain")).toBe(before);
  }, 60_000);

  it("fails with non_discriminating_test when the protection can be removed without failing the test", async () => {
    const { repo, evaluate } = await gateFixture(lockSource(syncTake), syncTest);
    const result = await evaluate("task", repo.head);
    expect(result.ok && result.value.status).toBe("failed");
    expect(result.ok && result.value.findings).toEqual([expect.objectContaining({ code: "non_discriminating_test", severity: "error" })]);
    expect(result.ok && result.value.metadata).toMatchObject({ mutation: { killed: false, survivors: [testName] } });
  }, 60_000);

  it("treats an absent pattern as not applicable at task scope but blocks at workflow scope", async () => {
    const { repo, evaluate } = await gateFixture(lockSource(asyncTake), racingTest);
    // The candidate no longer contains the protection the owner pattern names.
    await writeFile(join(repo.root, "source.cjs"), lockSource(asyncTake.replace(find, "this.lock.exclusive(")));
    repo.git("add", "."); repo.git("commit", "-m", "rename protection");
    const revision = repo.git("rev-parse", "HEAD");
    const task = await evaluate("task", revision);
    expect(task.ok && task.value.status).toBe("passed");
    expect(task.ok && task.value.metadata).toMatchObject({ verification: { sourceRevision: revision } });
    const workflow = await evaluate("workflow", revision);
    expect(workflow.ok).toBe(false);
    expect(!workflow.ok && workflow.error.message).toMatch(/not found in the integrated revision \(pattern_absent\)/);
  }, 60_000);
});
