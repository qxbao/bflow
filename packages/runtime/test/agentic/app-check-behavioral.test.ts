import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, SpecificationSchema, TestStrategySchema, type TestStrategy } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { TestStrategyResolver, assertEvidenceComplete, recordEvidence } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { parseAppChecks } from "../../src/agentic/app-check-config.js";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { unwrap } from "../../src/agentic/outbox.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

/**
 * Real-app criteria inside the behavioral P16 flow: the Tester measures a unit test (node --test) and/or a real served app
 * on the same committed revision, and the real P16 validator (recordEvidence / assertEvidenceComplete) accepts the record.
 * Needs only the Bubblewrap sandbox (no browser): the app check is an API check.
 */
// Mirrors the real-app runner preflight: real-app checks run only on Linux with a ready behavioral sandbox (app-check-runner.ts).
const sandboxReady = process.platform === "linux" && (await probeBehavioralSandbox()).status === "ready";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const unitName = "ac-unit: Target behavior matches expected output";
const unitSource = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const value=require('../source.cjs'); test(${JSON.stringify(unitName)},()=>assert.equal(value(2),4));\n`;
const FIXTURE = fileURLToPath(new URL("../fixtures/app-check/server.mjs", import.meta.url));
const itemsApi = { id: "items-api", kind: "api", request: { method: "GET", path: "/api/items" },
  expect: { status: 200, json: [{ pointer: "/0/name", equals: "apple" }] }, timeoutMs: 5000 };
const homeUi = { id: "home", kind: "ui", path: "/", viewport: { width: 1280, height: 800 }, expect: { selectors: ["#app"], text: [] }, timeoutMs: 15000 };

async function flow(options: { required: boolean; unit: boolean; checks?: unknown[]; identity?: string; browser?: string }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-behavioral-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, "test"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  await writeFile(join(cwd, "source.cjs"), "module.exports=x=>x+1;\n");
  await writeFile(join(cwd, "test/behavior.test.cjs"), unitSource);
  await copyFile(FIXTURE, join(cwd, "server.mjs"));
  await writeFile(join(cwd, "items.json"), JSON.stringify([{ name: "pear" }]));
  const base = commit("red baseline: target behavior absent, app serves the wrong item");
  const fixImplementation = () => {
    return async (): Promise<string> => {
      await writeFile(join(cwd, "source.cjs"), "module.exports=x=>x*2;\n");
      await writeFile(join(cwd, "items.json"), JSON.stringify([{ name: "apple" }]));
      return commit("implementation: target behavior and served data");
    };
  };
  const implement = fixImplementation();

  const command = parseBehavioralCommands([{ id: "node-unit", command: "owner:test-unit", executable: process.execPath,
    args: ["--test", "--test-reporter=tap", "test/behavior.test.cjs"], method: "unit_test", levels: ["unit"], testNames: [unitName],
    testPaths: ["test/behavior.test.cjs"], timeoutMs: 15000 }])[0]!;
  const identity = options.identity ?? "app:web:items-api";
  const suites = parseAppChecks([{ id: "web",
    app: { executable: process.execPath, args: ["server.mjs"], port: 4173, readyPath: "/health", startTimeoutMs: 8000,
      env: { FIXTURE_MODE: "good", FIXTURE_ITEMS_FILE: "items.json" }, dependencyRoots: [] },
    ...(options.browser ? { browser: { executable: options.browser, resourceKey: "app-check-browser" } } : {}),
    timeoutMs: 60000, checks: options.checks ?? [itemsApi] }]);

  // A refactoring assessment without a behavior change resolves to `recommended` (no mandatory Red) and the resolver keeps that mode.
  const taskType = options.required ? "domain_logic" : "refactoring";
  const assessed = assessment(taskType, { ...(options.required ? {} : { changeImpact: { ...assessment(taskType).changeImpact, behaviorChanged: false, deterministic: false, regressionReproducible: false } }),
    infrastructure: { readiness: "ready", commands: [
    ...(options.unit ? [{ method: "unit_test", command: command.command, level: "unit" }] : []),
    { method: "e2e_test", command: "app:web", level: "e2e" }] } });
  const criteria = [
    ...(options.unit ? [{ id: "ac-unit", description: "Target behavior matches expected output", category: "functional", verificationMethod: "unit_test",
      required: true, status: "pending", evidenceArtifactIds: [] }] : []),
    { id: "ac-app", description: "The served app returns the target item", category: "functional", verificationMethod: "e2e_test",
      required: true, status: "pending", evidenceArtifactIds: [] }];
  const draft = SpecificationSchema.parse({ ...spec(assessed, "e2e_test"), acceptanceCriteria: criteria, affectedPaths: ["source.cjs", "test/behavior.test.cjs"] });
  const resolved = new TestStrategyResolver().resolve(draft);
  let strategy: TestStrategy = TestStrategySchema.parse({ ...resolved,
    criterionMappings: [...(options.unit ? [{ criterionId: "ac-unit", testNames: [unitName] }] : []), { criterionId: "ac-app", testNames: [identity] }],
    targetCommands: [...(options.unit ? [command.command] : []), "app:web"],
    ...(options.required ? { requiredTestLevels: ["unit", "e2e"], tddDecision: { ...resolved.tddDecision, mode: "required", requiresFailingTestFirst: true } } : {}) });

  const opened = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "app-behavioral-test" }));
  cleanups.push(async () => { opened.close(); });
  const bytes = Buffer.from(JSON.stringify(draft));
  const stored = unwrap(await opened.put({ options: { artifactId: "accepted-spec", runId: "run-1", taskId: "task-1", kind: "document", mediaType: "application/json",
    idempotencyKey: "accepted-spec", expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length } },
    content: (async function* () { yield bytes; })() }));
  const specification = SpecificationSchema.parse({ ...draft, status: "approved", approvedBy: "architect", artifactRef: stored });
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "tester-binding", sessionId: "session-1", role: "tester", agentId: "independent-tester",
    paneId: "tester-pane", workspaceId: "workspace", tabId: "tab", provider: "test", agentKind: "test", cwd, isolationMode: "dedicated_pane",
    readOnlyWorkspace: true, transportState: "idle", boundAt: new Date().toISOString() });
  const assignment = { message_id: "assignment", type: "task.assignment", run_id: "run-1" };
  const runtime = { inspect: async (runId?: string) => runId
    ? { baseRevision: base, tasks: [{ taskId: "task-1", spec: { specification, strategy }, worktrees: [{ baseCommitHash: base }] }] }
    : { outbound: [{ taskId: "task-1", message: assignment, handle: { target: { agentId: "developer", paneId: "developer-pane", worktreePath: cwd } } }] },
    ports: { policies: { recordEvidence } } } as unknown as AgenticWorkflowRuntime;
  const host = new HostVerification(() => runtime, () => opened, new HostReceiptJournal(join(root, "host-receipts"), cwd, "session-1"),
    [command], undefined, undefined, [], { suites, leaseDirectory: join(root, "leases") });
  return { cwd, git, commit, base, binding, host, implement, accept: (result: unknown) => { strategy = recordEvidence(strategy, result); },
    get strategy() { return strategy; }, store: opened };
}

describe.skipIf(!sandboxReady)("real-app criteria in the P16 behavioral evidence flow", () => {
  it("accepts verification evidence for a unit criterion plus a real-app criterion (not required mode)", async () => {
    const f = await flow({ required: false, unit: true });
    await f.implement();
    const verification = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" });
    f.accept(verification.result);
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
    expect(verification.result.evaluatedCriteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterionId: "ac-app", passed: true, command: "app:web", exitCode: 0 }),
      expect.objectContaining({ criterionId: "ac-unit", passed: true })]));
    expect(verification.result.metadata?.conditionalTdd).toMatchObject({ testNames: expect.arrayContaining(["app:web:items-api", unitName]) });
    const artifacts = verification.result.evidenceArtifacts;
    expect(artifacts.every(artifact => artifact.taskId === "task-1" && Date.parse(artifact.createdAt) >= Date.parse(verification.result.startedAt))).toBe(true);
    expect(new Set(artifacts.map(artifact => artifact.artifactId)).size).toBe(artifacts.length);
  }, 120_000);

  it("accepts app-only verification evidence, so the task can be submitted", async () => {
    const f = await flow({ required: false, unit: false });
    await f.implement();
    const verification = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" });
    f.accept(verification.result);
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
    expect(verification.result.evaluatedCriteria).toEqual([expect.objectContaining({ criterionId: "ac-app", passed: true, command: "app:web" })]);
  }, 120_000);

  it("records Red, Green and Refactor for unit plus real-app criteria, each accepted by the P16 validator", async () => {
    const f = await flow({ required: true, unit: true });
    const red = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });
    expect(red.result.status).toBe("failed");
    expect(red.result.metadata?.conditionalTdd).toMatchObject({ observations: expect.arrayContaining([
      expect.objectContaining({ method: "e2e_test", criterionId: "ac-app", command: "app:web", exitCode: 1 })]) });
    f.accept(red.result);
    await f.implement();
    const green = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" });
    expect(green.result.status).toBe("passed");
    f.accept(green.result);
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2; // refactored\n");
    f.commit("refactor: keep behavior, improve readability");
    const refactor = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "refactor" });
    f.accept(refactor.result);
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
    const ids = [red, green, refactor].flatMap(item => item.result.evidenceArtifacts.map(artifact => artifact.artifactId));
    expect(new Set(ids).size).toBe(ids.length);
  }, 180_000);

  it("throws a clear prerequisite error and records nothing when the real app is blocked", async () => {
    const f = await flow({ required: false, unit: true, identity: "app:web:home", checks: [homeUi], browser: "/nonexistent/chrome" });
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" }))
      .rejects.toThrow(/Real-app prerequisite missing \(app_check_browser_missing\): .*no behavioral evidence was recorded/);
    expect(f.strategy.metadata?.tddEvidence).toBeUndefined();
  }, 120_000);
});
