import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactReferenceSchema, SpecificationSchema, TestStrategySchema, type Specification, type TestStrategy } from "@bflow/contracts";
import { createVerificationPlan } from "../../../verification/src/model.js";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { parseAppChecks, type AppCheckSuite } from "../../src/agentic/app-check-config.js";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { ensureAgenticHost } from "../../src/agentic/host-controller.js";
import { DEFAULT_HOST_CHECKS, HostVerification } from "../../src/agentic/host-verification.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { resolvePrivateRuntimeStateDirectory } from "../../src/private-state.js";

/**
 * (i) Plan selection through the real Runtime `verificationPlan` (called directly on a runtime-shaped object with the real
 * P17 `createVerificationPlan` port). (ii) The owner-configuration digest pin in `ensureAgenticHost`, against a persisted
 * host.json at the real private state location. No sandbox, no browser.
 */
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const suite = (checks: string[] = ["home", "items-api"]): AppCheckSuite => parseAppChecks([{ id: "web",
  app: { executable: process.execPath, args: ["server.mjs"], port: 4173 }, timeoutMs: 120_000,
  checks: checks.map(id => id === "home"
    ? { id, kind: "api", request: { method: "GET", path: "/" }, expect: { status: 200, bodyContains: ["Welcome"] } }
    : { id, kind: "api", request: { method: "GET", path: "/api/items" }, expect: { status: 200, json: [{ pointer: "/0/name", equals: "apple" }] } }) }])[0]!;

const plainCommand = parseBehavioralCommands([{ id: "unit", command: "owner:test-unit", executable: process.execPath,
  args: ["--test"], method: "unit_test", levels: ["unit"], testNames: ["unit ac-plain"], testPaths: ["test/a.test.cjs"], timeoutMs: 15000 }])[0]!;

function build(criteria: { id: string; method: string; waived?: boolean }[], mappings: { criterionId: string; testNames: string[] }[],
  targetCommands: string[], suites: AppCheckSuite[], taskChecks: unknown[] = []) {
  const assessed = assessment("refactoring", { changeImpact: { ...assessment("refactoring").changeImpact, behaviorChanged: false, deterministic: false, regressionReproducible: false },
    infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: plainCommand.command, level: "unit" }, { method: "e2e_test", command: "app:web", level: "e2e" }] } });
  const base = spec(assessed, "e2e_test");
  const specification: Specification = SpecificationSchema.parse({ ...base, acceptanceCriteria: criteria.map(criterion => ({ id: criterion.id,
    description: `Behavior ${criterion.id}`, category: "functional", verificationMethod: criterion.method, required: true,
    status: criterion.waived ? "waived" : "pending", evidenceArtifactIds: [], ...(criterion.waived ? { waiverReason: "owner accepted the gap" } : {}) })),
  status: "approved", approvedBy: "architect", artifactRef: ArtifactReferenceSchema.parse({ trust: "stored", artifactId: "accepted-spec", runId: "run-1",
    kind: "document", uri: "artifact://test/accepted-spec", mediaType: "application/json", sizeBytes: 2, checksum: { algorithm: "sha256", value: "a".repeat(64) },
    createdAt: "2026-10-27T00:00:00.000Z" }) });
  const resolved = new TestStrategyResolver().resolve(specification);
  const strategy: TestStrategy = TestStrategySchema.parse({ ...resolved, criterionMappings: mappings, targetCommands });
  const host = new HostVerification(() => { throw new Error("runtime not used by plan selection"); }, () => { throw new Error("store unused"); },
    undefined, [plainCommand], undefined, undefined, [], { suites });
  const runtime = Object.create(AgenticWorkflowRuntime.prototype) as AgenticWorkflowRuntime & Record<string, unknown>;
  // Workflow-scope plans read `workflowChecks` (the scope of this selection): the default review and integrity checks plus the owner checks.
  Object.assign(runtime, { now: () => new Date(), ports: { taskChecks: [], workflowChecks: [...DEFAULT_HOST_CHECKS, ...taskChecks],
    behavioralChecks: (s: Specification, st: TestStrategy, revision?: string) => host.behavioralChecks(s, st, revision),
    policies: { createVerificationPlan } } });
  // One implementer assignment: the planner records the implementer agents of the run's tasks.
  const run = { runId: "run-1", tasks: [{ taskId: "task-1", outboundIds: ["assign-1"] }], baseRevision: "a".repeat(40), maxIterations: 3, workflowSpec: { specification, strategy } };
  const state = { outbound: [{ message: { message_id: "assign-1", type: "task.assignment" }, handle: { target: { agentId: "developer" } } }] };
  // The private method is the production selection: checks, bindings and criterion ids come from runtime.ts itself.
  return (runtime as unknown as { verificationPlan(state: unknown, run: unknown, task?: unknown): { checks: { id: string; configuration?: unknown }[] } })
    .verificationPlan(state, run, undefined);
}

const cfg = (check: { configuration?: unknown }) => check.configuration as { criterionIds: string[]; testNames: string[] };

describe("verificationPlan selection of owner real-app gates", () => {
  it("includes host-app-web when targetCommands has app:web and an accepted e2e criterion maps to its identity", () => {
    const plan = build([{ id: "ac-app", method: "e2e_test" }], [{ criterionId: "ac-app", testNames: ["app:web:items-api"] }], ["app:web"], [suite()]);
    const check = plan.checks.find(item => item.id === "host-app-web");
    expect(check).toBeDefined();
    expect(cfg(check!)).toMatchObject({ criterionIds: ["ac-app"], testNames: ["app:web:home", "app:web:items-api"] });
  });

  it("creates no plan with the gate when the accepted app mapping has no app:web target command", () => {
    // The planner refuses a mapped command that no target lists; ingress (splitAppCriteria) rejects the same proposal earlier.
    expect(() => build([{ id: "ac-app", method: "e2e_test" }], [{ criterionId: "ac-app", testNames: ["app:web:items-api"] }], [], [suite()]))
      .toThrow(/Unconfigured strategy command|No complete check mapping/);
  });

  it("excludes host-app-web for a waived criterion: the still-listed app:web target then has no configured check", () => {
    // Runtime drops the gate because its only criterion is waived. The planner then reports the app:web target as unconfigured,
    // so a waived real-app criterion must also drop its target command (the same rule owner commands already follow).
    expect(() => build([{ id: "ac-app", method: "e2e_test", waived: true }], [{ criterionId: "ac-app", testNames: ["app:web:items-api"] }], ["app:web"], [suite()]))
      .toThrow(/Unconfigured strategy command: app:web/);
  });

  it("never gives an automatic method-bound e2e runner the real-app identities", () => {
    // An automatic runner (no boundRunnerIdentities): it may only receive the plain e2e names of accepted criteria.
    const automatic = { id: "auto-e2e", name: "Automatic e2e", evaluator: "auto-runner", required: true,
      timeout: { executionTimeoutMs: 30000, onTimeout: "block" }, metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true },
      configuration: { kind: "deterministic", method: "e2e_test", command: "playwright:auto", criterionIds: [], testNames: [], role: "tester", levels: ["e2e"] } };
    const plan = build([{ id: "ac-app", method: "e2e_test" }, { id: "ac-plain", method: "e2e_test" }],
      [{ criterionId: "ac-app", testNames: ["app:web:items-api"] }, { criterionId: "ac-plain", testNames: ["plain e2e journey"] }],
      ["app:web", "playwright:auto"], [suite()], [automatic]);
    const check = plan.checks.find(item => item.id === "auto-e2e");
    expect(check).toBeDefined();
    expect(cfg(check!)).toMatchObject({ criterionIds: ["ac-plain"], testNames: ["plain e2e journey"] });
    expect(cfg(check!).testNames.some(name => name.startsWith("app:"))).toBe(false);
  });
});

describe("owner real-app configuration pin", () => {
  async function persisted(appChecks: unknown[]): Promise<{ root: string; sessionId: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-pin-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sessionId = "session-app-pin";
    const stateRoot = resolvePrivateRuntimeStateDirectory(root);
    cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
    const directory = resolve(stateRoot, "host", sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "host.json"), JSON.stringify({ repositoryPath: root, sessionId, directory, socketPath: join(directory, "h.sock"),
      token: "t".repeat(64), behavioralCommands: [], mutationChecks: [], appChecks }), { mode: 0o600 });
    return { root, sessionId };
  }
  const original = { id: "web", app: { executable: process.execPath, args: ["server.mjs"], port: 4173 }, timeoutMs: 120000,
    checks: [{ id: "items-api", kind: "api", request: { method: "GET", path: "/api/items" }, expect: { status: 200, json: [{ pointer: "", type: "array" }] } }] };

  it("rejects a changed app suite against the persisted configuration before starting the host", async () => {
    const { root, sessionId } = await persisted([original]);
    const changed = { ...original, checks: [{ ...original.checks[0], request: { method: "GET", path: "/api/other" } }] };
    await expect(ensureAgenticHost({ repositoryPath: root, sessionId, behavioralCommands: [], mutationChecks: [],
      appChecks: parseAppChecks([changed]) })).rejects.toThrow(/Persisted real-app checks differ from owner configuration/);
  });
});

describe("configured methods with owner real-app suites", () => {
  it("reports e2e_test as configured only when a real-app suite is configured", () => {
    const withApp = new HostVerification(() => { throw new Error("unused"); }, () => { throw new Error("unused"); }, undefined, [plainCommand], undefined, undefined, [], { suites: [suite()] });
    const withoutApp = new HostVerification(() => { throw new Error("unused"); }, () => { throw new Error("unused"); }, undefined, [plainCommand]);
    expect(withApp.configuredMethods()).toEqual(expect.arrayContaining(["unit_test", "e2e_test"]));
    expect(withoutApp.configuredMethods()).toEqual(["unit_test"]);
  });
});
