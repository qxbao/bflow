import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { BLOCKERS, TaskBlocker, blockerOf, isResumable } from "../../src/agentic/blockers.js";
import { pinRunnerDefinitions } from "../../src/agentic/runner-provenance.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { bindRegressionProfile, bindRunnerProfile, measureBehavior, measureRegression, RegressionInfrastructureFailure, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { cleanups as fixtureCleanups, connectedPhaseFixture } from "../helpers/agentic-integration-fixture.js";

// GD4c guard #3 (docs/blocker-inventory.md): runner prepare / sandbox / invocation failures are environment blockers.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const cleanup of fixtureCleanups.splice(0).reverse()) await cleanup();
});

describe("runner_infrastructure blocker", () => {
  it("is an environment-owned, resumable code with a next action", () => {
    expect(BLOCKERS.runner_infrastructure.fixableBy).toBe("environment");
    expect(isResumable(BLOCKERS.runner_infrastructure)).toBe(true);
    expect(BLOCKERS.runner_infrastructure.nextAction).toMatch(/resume/i);
  });

  it("keeps the original cause", () => {
    const cause = new Error("bwrap: setting up uid map: Permission denied");
    const blocker = new TaskBlocker("runner_infrastructure", "Behavioral runner infrastructure failure (sandbox preparation): x", { stage: "sandbox_preparation" }, { cause });
    expect(blocker.cause).toBe(cause);
  });
});

const testName = "infrastructure fixture passes";
async function repo() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "bflow-runner-infra-")));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Infra Test"); git("config", "user.email", "infra@example.test");
  await mkdir(join(cwd, "test"), { recursive: true }); await mkdir(join(cwd, "scripts"), { recursive: true });
  await writeFile(join(cwd, "test/a.test.cjs"), `const {test}=require('node:test');\ntest(${JSON.stringify(testName)},()=>{});\n`);
  await writeFile(join(cwd, "scripts/fail.cjs"), "process.stderr.write('prepare broke\\n'); process.exit(1);\n");
  git("add", "."); git("commit", "-m", "fixture");
  return { cwd, revision: git("rev-parse", "HEAD") };
}
function profile(cwd: string, overrides: Partial<RunnerProfile> = {}): RunnerProfile {
  return { id: "node-tap", command: "detected:node-tap", executable: process.execPath, args: ["--test", "--test-reporter=tap"],
    method: "unit_test", levels: ["unit", "regression"], reporter: "node_tap", timeoutMs: 30_000,
    definitionBlobs: {}, checkoutDependencyRoots: [], dependencySource: cwd, source: "detected", ...overrides };
}
async function pinned(cwd: string, overrides: Partial<RunnerProfile> = {}) {
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd, overrides)], notes: [] });
  if (detection.status !== "detected") throw new Error(detection.reason);
  return detection.profiles[0]!;
}
async function rejection(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error; }
  throw new Error("expected a rejection");
}

describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("runner infrastructure failures in the Linux sandbox", () => {
  it("reports a failing prepare step as a runner_infrastructure blocker with the original message", async () => {
    const f = await repo();
    const command = bindRunnerProfile(await pinned(f.cwd, { prepare: { args: ["scripts/fail.cjs"], timeoutMs: 30_000 } }),
      { testNames: [testName], testPaths: ["test/a.test.cjs"] });
    const error = await rejection(measureBehavior(command, f.cwd, f.revision));
    const blocker = blockerOf(error);
    expect(blocker?.code).toBe("runner_infrastructure");
    expect(blocker?.message).toMatch(/^Behavioral runner infrastructure failure \(prepare\): exit 1 .*prepare broke/s);
    expect(blocker?.details).toEqual({ stage: "prepare", commandId: "node-tap", revision: f.revision });
  }, 120_000);

  it("reports an unusable executable during sandbox preparation as a runner_infrastructure blocker", async () => {
    const f = await repo();
    const command = { ...bindRunnerProfile(await pinned(f.cwd), { testNames: [testName], testPaths: ["test/a.test.cjs"] }), executable: "/missing/bflow-node" };
    const blocker = blockerOf(await rejection(measureBehavior(command, f.cwd, f.revision)));
    expect(blocker?.code).toBe("runner_infrastructure");
    expect(blocker?.message).toMatch(/^Behavioral runner infrastructure failure \(sandbox preparation\): /);
    expect(blocker?.details).toEqual({ stage: "sandbox_preparation", commandId: "node-tap", revision: f.revision });
    expect(blocker?.cause).toBeInstanceOf(Error);
  }, 120_000);

  it("keeps regression measurement wrapping infrastructure blockers as RegressionInfrastructureFailure", async () => {
    const f = await repo();
    const command = { ...bindRegressionProfile(await pinned(f.cwd), ["test/a.test.cjs"], 30_000), executable: "/missing/bflow-node" };
    const error = await rejection(measureRegression(command, f.cwd, f.revision));
    expect(error).toBeInstanceOf(RegressionInfrastructureFailure);
    expect((error as Error).message).toMatch(/^Behavioral runner infrastructure failure \(sandbox preparation\): /);
  }, 120_000);
});

describe("runner_infrastructure phase failure recovery", () => {
  it("escalates for an environment fix without claiming resume skips the measurement, then re-measures on resume", async () => {
    const f = await connectedPhaseFixture("node_tap");
    f.ports.preflightRoleCapabilities = async (binding, required) => {
      if (required.some(capability => !f.ports.roleCapabilities[binding.role]?.includes(capability))) throw new Error("Missing role capability");
    };
    await f.addTests();
    const { pending, head } = await f.request("red");
    const blocker = new TaskBlocker("runner_infrastructure", "Behavioral sandbox failed: bwrap: setting up uid map: Permission denied",
      { stage: "sandbox", commandId: "node-tap", revision: head });
    await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, blocker.message, false, undefined, blocker);
    const inspected = await f.inspect();
    expect(inspected.status).toBe("escalated");
    expect(inspected.error).toContain("Policy measurement blocked");
    expect(inspected.error).not.toContain("Plan mismatch");
    expect(inspected.pendingAction.reason).toContain(BLOCKERS.runner_infrastructure.nextAction);
    expect(inspected.pendingAction.reason).not.toContain("Resume sẽ không đo lại cùng revision");
    const resumed = await f.runtime.resumeBlockedRun("run-1", inspected.pendingAction.actionId) as any;
    expect(resumed.nonResumablePhaseFailures).toEqual([]);
    const state = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    const failed = state.outbound.find(out => out.message.message_id === pending.message.message_id)!;
    expect(failed.phaseFailure?.blocker).toMatchObject({ code: "runner_infrastructure", fixableBy: "environment" });
    expect(failed.phaseFailure?.retryAuthorized).toBe(true);
  }, 120_000);
});
