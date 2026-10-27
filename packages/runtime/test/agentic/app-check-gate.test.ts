import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { QualityGateContextSchema, SpecificationSchema, TestStrategySchema, type ArtifactReference, type JsonValue, type Specification, type TestStrategy } from "@bflow/contracts";
import { requiredGatesSatisfied } from "../../../core/src/graph.js";
import { parseAppChecks, type AppCheckSuite } from "../../src/agentic/app-check-config.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { AppCheckBrowserLeases } from "../../src/agentic/app-check-lease.js";
import { unwrap } from "../../src/agentic/outbox.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { buildAppEvidence, redactText, sanitizeAppEvidence, EVIDENCE_LIMITS } from "../../src/agentic/app-check-evidence.js";
import { splitAppCriteria } from "../../src/agentic/app-check-selection.js";
import { WorkflowProposalRejected } from "../../src/agentic/workflow-rejection.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";

const suites: AppCheckSuite[] = parseAppChecks([{
  id: "web",
  app: { executable: "/usr/bin/node", args: ["server.js"], port: 4173, dependencyRoots: [] },
  browser: { executable: "/opt/google/chrome/chrome" },
  timeoutMs: 120_000,
  checks: [
    { id: "home", kind: "ui", path: "/", viewport: { width: 1280, height: 800 }, expect: { selectors: ["#app"], text: [] } },
    { id: "items-api", kind: "api", request: { method: "GET", path: "/api/items" }, expect: { status: 200, json: [{ pointer: "", type: "array" }] } }
  ]
}]);

describe("sanitizeAppEvidence", () => {
  it("redacts bearer, basic, keyword and provider-key secrets in console text and tails", () => {
    const text = "Authorization: Bearer abc.def-123\nBasic dXNlcjpwYXNz\npassword=hunter2 api_key: AKIA9999\nsk-AbCdEf1234567890\ntoken=xyz";
    const out = redactText(text);
    expect(out).not.toMatch(/abc\.def|dXNlcjpwYXNz|hunter2|AKIA9999|AbCdEf1234567890|xyz/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts configured env values wherever they appear in output", () => {
    expect(redactText("connecting with supersecretvalue now", ["supersecretvalue"])).toBe("connecting with [REDACTED] now");
  });

  it("removes control characters but keeps tabs and newlines", () => {
    expect(redactText("a\u001b[31mred\u0000\tb\r\nc")).toBe("a[31mred\tb\nc");
  });

  it("bounds tails to the end, messages and bodies to the start", () => {
    const longTail = "x".repeat(EVIDENCE_LIMITS.tailBytes) + "END";
    const longMessage = "m".repeat(EVIDENCE_LIMITS.messageBytes + 100);
    const longBody = "b".repeat(EVIDENCE_LIMITS.bodyBytes + 100);
    const out = sanitizeAppEvidence({ appStderrTail: longTail, message: longMessage, body: longBody }) as Record<string, string>;
    expect(out.appStderrTail).toHaveLength(EVIDENCE_LIMITS.tailBytes);
    expect(out.appStderrTail!.endsWith("END")).toBe(true);
    expect(out.message).toHaveLength(EVIDENCE_LIMITS.messageBytes);
    expect(out.body).toHaveLength(EVIDENCE_LIMITS.bodyBytes);
  });

  it("applies redaction recursively to every nested free-text field", () => {
    const out = JSON.stringify(sanitizeAppEvidence({ checks: [{ findings: [{ message: "password=leaked" }], observations: { bodyText: "Bearer tok123456" } }] }, []));
    expect(out).not.toMatch(/leaked|tok123456/);
  });
});

describe("buildAppEvidence", () => {
  it("stores env keys and a digest, never env values, and sanitizes console and stream text", () => {
    const run = {
      status: "completed" as const, passed: true, appReady: true, findings: [], selectedCheckIds: ["home"], checkoutTree: "a".repeat(40),
      command: { executable: "/usr/bin/node", args: ["server.js"] }, envKeys: ["API_BASE", "NODE_ENV"], envDigest: "d".repeat(64),
      driverSha256: "e".repeat(64), screenshots: [], startedAt: "2026-10-27T00:00:00.000Z", finishedAt: "2026-10-27T00:00:01.000Z",
      selectedCheckIds: ["home"],
      driver: { schemaVersion: 1 as const, instanceId: "11111111-1111-4111-8111-111111111111", origin: "http://127.0.0.1:4173", appReady: true,
        appStdoutTail: "ready password=hunter2", appStderrTail: "warn token=abcdef", startedAt: "2026-10-27T00:00:00.000Z",
        finishedAt: "2026-10-27T00:00:01.000Z", checks: [] }
    };
    const document = buildAppEvidence({
      suiteId: "web", gateId: "host-app-web", runId: "run-1", taskId: "task-1", attemptId: "attempt-1", scope: "task", specFingerprint: "f".repeat(64),
      candidate: { sourceRevision: "b".repeat(40), checkoutTree: "a".repeat(40) }, command: run.command, port: 4173, readyPath: "/health",
      run: run as never, envValues: ["sekrit-env-value"],
      checks: [{ identity: "app:web:home", checkId: "home", kind: "ui", definitionDigest: "c".repeat(64), criterionIds: ["ac-1"], status: "passed", findings: [],
        observations: { bodyText: "console: password=leaked" } }],
      criteria: [{ criterionId: "ac-1", identities: ["app:web:home"], passed: true }],
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      browser: { executable: "/opt/google/chrome/chrome", resourceKey: "app-check-browser" }
    });
    const text = JSON.stringify(document);
    expect(text).not.toContain("sekrit-env-value");
    expect(text).not.toMatch(/hunter2|abcdef|leaked/);
    expect(document).toMatchObject({ kind: "bflow.app-check-evidence", app: { envKeys: ["API_BASE", "NODE_ENV"], envDigest: "d".repeat(64), instanceId: "11111111-1111-4111-8111-111111111111" } });
  });
});

function specWith(criteria: { id: string; method: string; status?: string; required?: boolean }[], mappings: { criterionId: string; testNames: string[] }[],
  targetCommands: string[], tdd?: "required"): { specification: Specification; strategy: TestStrategy } {
  const base = spec(assessment("domain_logic", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } }), "unit_test");
  const specification = SpecificationSchema.parse({ ...base, acceptanceCriteria: criteria.map(criterion => ({
    id: criterion.id, description: `Behavior ${criterion.id}`, category: "functional", verificationMethod: criterion.method,
    required: criterion.required ?? true, status: criterion.status ?? "pending", evidenceArtifactIds: [],
    ...(criterion.status === "waived" ? { waiverReason: "owner accepted the gap" } : {}) })) });
  const resolved = new TestStrategyResolver().resolve(specification);
  const strategy = TestStrategySchema.parse({ ...resolved, criterionMappings: mappings, targetCommands,
    ...(tdd ? { requiredTestLevels: ["e2e"], tddDecision: { ...resolved.tddDecision, mode: "required", requiresFailingTestFirst: true } } : {}) });
  return { specification, strategy };
}

describe("splitAppCriteria", () => {
  it("splits an active e2e criterion mapped to app identities out of the runner rules", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }, { id: "ac-2", method: "unit_test" }],
      [{ criterionId: "ac-1", testNames: ["app:web:home"] }, { criterionId: "ac-2", testNames: ["unit ac-2"] }], ["app:web", "auto:unit"]);
    const split = splitAppCriteria(specification, strategy, suites);
    expect(split.app).toMatchObject([{ suiteId: "web", checkIds: ["home"], identities: ["app:web:home"], criterion: { id: "ac-1" } }]);
    expect(split.rest.specification.acceptanceCriteria.map(criterion => criterion.id)).toEqual(["ac-2"]);
    expect(split.rest.strategy.criterionMappings.map(mapping => mapping.criterionId)).toEqual(["ac-2"]);
    expect(split.rest.strategy.targetCommands).toEqual(["auto:unit"]);
  });

  it("ignores waived criteria for app binding", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test", status: "waived" }], [{ criterionId: "ac-1", testNames: ["app:web:home"] }], ["app:web"]);
    expect(splitAppCriteria(specification, strategy, suites).app).toEqual([]);
  });

  it.each([
    ["mixed mapping", { criterionId: "ac-1", testNames: ["app:web:home", "unit ac-1"] }, "e2e_test", ["app:web"], /split UI\/API real-app checks/],
    ["unknown check", { criterionId: "ac-1", testNames: ["app:web:missing"] }, "e2e_test", ["app:web"], /unknown real-app check app:web:missing/],
    ["unknown suite", { criterionId: "ac-1", testNames: ["app:shop:home"] }, "e2e_test", ["app:shop"], /unknown real-app check app:shop:home/],
    ["missing target command", { criterionId: "ac-1", testNames: ["app:web:home"] }, "e2e_test", [], /needs app:web among the strategy targetCommands/],
    ["wrong method", { criterionId: "ac-1", testNames: ["app:web:home"] }, "unit_test", ["app:web"], /require verificationMethod e2e_test/]
  ])("rejects %s", (_label, mapping, method, targets, pattern) => {
    const { specification, strategy } = specWith([{ id: "ac-1", method }], [mapping], targets);
    expect(() => splitAppCriteria(specification, strategy, suites)).toThrow(WorkflowProposalRejected);
    expect(() => splitAppCriteria(specification, strategy, suites)).toThrow(pattern);
  });

  it("rejects a required TDD decision whose only automated criteria are real-app checks", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }], [{ criterionId: "ac-1", testNames: ["app:web:home"] }], ["app:web"], "required");
    expect(() => splitAppCriteria(specification, strategy, suites)).toThrow(/not Red-Green-Refactor evidence/);
  });
});

/* ---------- gate end-to-end (real sandbox, real fixture app, real filesystem ArtifactStore) ---------- */

const execute = promisify(execFile);
const CHROME = "/opt/google/chrome/chrome";
const FIXTURE = fileURLToPath(new URL("../fixtures/app-check/server.mjs", import.meta.url));
const GIT = ["-c", "user.name=bflow-test", "-c", "user.email=test@localhost", "-c", "commit.gpgSign=false"];
const sandboxAvailable = process.platform === "linux" && (await probeBehavioralSandbox()).status === "ready";
// Same real headless launch probe as the runner tests: Chrome must dump a DOM on this host.
const browserAvailable = sandboxAvailable && await execute(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
  "--user-data-dir=" + join(tmpdir(), `bflow-chrome-gate-probe-${process.pid}`), "--dump-dom", "about:blank"], { timeout: 30_000 })
  .then(result => result.stdout.includes("<html"), () => false);

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixtureRepo(): Promise<{ root: string; revision: string; git: (...args: string[]) => string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-gate-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", [...GIT, "-C", root, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", root]);
  await copyFile(FIXTURE, join(root, "server.mjs"));
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  return { root, revision: git("rev-parse", "HEAD"), git };
}

function gateSuite(mode: string, checks: unknown[], overrides: Record<string, unknown> = {}): AppCheckSuite {
  const hasUi = checks.some(check => (check as { kind: string }).kind === "ui");
  const [suite] = parseAppChecks([{
    id: "web",
    app: { executable: process.execPath, args: ["server.mjs"], port: 4173, readyPath: "/health", startTimeoutMs: 8000,
      env: { FIXTURE_MODE: mode, API_BASE: "https://internal.example.test/secret-env-value" }, dependencyRoots: [] },
    ...(hasUi ? { browser: { executable: CHROME, resourceKey: "app-check-browser" } } : {}),
    timeoutMs: 60_000, checks, ...overrides
  }]);
  return suite!;
}

const homeCheck = { id: "home", kind: "ui", path: "/", viewport: { width: 1280, height: 800 },
  expect: { selectors: ["[data-testid=title]"], text: ["Welcome"] }, screenshot: true, timeoutMs: 15_000 };
const itemsCheck = { id: "items-api", kind: "api", request: { method: "GET", path: "/api/items" },
  expect: { status: 200, json: [{ pointer: "/0/name", equals: "apple" }] }, timeoutMs: 5000 };

function specFor(mappings: { criterionId: string; testNames: string[] }[], criterionIds: string[], targets: string[]) {
  const built = specWith(criterionIds.map(id => ({ id, method: "e2e_test" })), mappings, targets);
  return built;
}

function gateFor(suite: AppCheckSuite, built: { specification: Specification; strategy: TestStrategy }, revision: string, root: string,
  store: { put: unknown; get: unknown }, criterionIds: string[], leaseDirectory: string, scopeTask = true) {
  const runtime = { inspect: async () => ({ baseRevision: revision,
    tasks: [{ taskId: "task-1", spec: { specification: built.specification, strategy: built.strategy }, worktrees: [{ baseCommitHash: revision }] }] }) };
  const host = new HostVerification(() => runtime as unknown as AgenticWorkflowRuntime, () => store as never, undefined, [], undefined, undefined, [],
    { suites: [suite], leaseDirectory });
  const definition = host.behavioralChecks().find(item => item.id === `host-app-${suite.id}`)!;
  const configured = { ...definition, configuration: { ...(definition.configuration as Record<string, JsonValue>), criterionIds } } as typeof definition;
  const gate = host.behavioralGates().find(item => item.id === `host-app-${suite.id}`)!;
  const evaluate = (taskId: string | undefined = "task-1", def = configured) => gate.evaluate(QualityGateContextSchema.parse({ runId: "run-app-1",
    ...(scopeTask && taskId ? { taskId } : {}), attemptId: "attempt-app-1", definition: def, artifacts: [],
    input: { sourceRevision: revision, sourceWorktreePath: root, specFingerprint: "a".repeat(64), scope: scopeTask ? "task" : "workflow", baseRevision: revision } }));
  return { host, configured, evaluate };
}

async function storeFor(): Promise<{ store: { put: unknown; get: unknown }; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-artifacts-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "app-check-test" }));
  return { store: store as unknown as { put: unknown; get: unknown }, root };
}

async function readArtifact(store: unknown, reference: ArtifactReference): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of (store as { get(reference: ArtifactReference): AsyncIterable<{ ok: boolean }> }).get(reference)) chunks.push(unwrap(chunk as never) as Uint8Array);
  return Buffer.concat(chunks);
}

describe.skipIf(!sandboxAvailable)("app gate: blocked prerequisites and definition binding", () => {
  it("returns blocked (never passed) when the browser executable is missing, and records nothing as a pass", async () => {
    const repo = await fixtureRepo();
    const { store, root: artifactRoot } = await storeFor();
    const suite = gateSuite("good", [homeCheck], { browser: { executable: "/nonexistent/chrome", resourceKey: "app-check-browser" } });
    const built = specFor([{ criterionId: "ac-1", testNames: ["app:web:home"] }], ["ac-1"], ["app:web"]);
    const { evaluate, configured } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-1"], join(artifactRoot, "lease-blocked"));
    const result = await evaluate();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("blocked");
    expect(result.value.findings).toEqual([expect.objectContaining({ code: "app_check_browser_missing", location: "app:web" })]);
    // The Core rule: a required gate must be exactly "passed" to satisfy a task.
    const definition = { tasks: [{ id: "task-1", qualityGates: [{ gateId: configured.id, phase: "after_result", required: true }] }] } as never;
    const task = { taskId: "task-1", generation: 1, attemptId: "attempt-app-1", status: "running" } as never;
    const gates = [{ taskId: "task-1", gateId: configured.id, phase: "after_result", generation: 1, attemptId: "attempt-app-1", status: result.value.status }] as never;
    expect(requiredGatesSatisfied(definition, task, gates, ["after_result"])).toBe(false);
    expect(requiredGatesSatisfied(definition, task, [{ ...(gates as never as object), status: "passed" }] as never, ["after_result"])).toBe(false);
  }, 60_000);

  it("blocks a busy browser lease with a retryable finding that names the holder", async () => {
    const repo = await fixtureRepo();
    const { store, root: artifactRoot } = await storeFor();
    const leaseDirectory = join(artifactRoot, "leases-busy");
    await new AppCheckBrowserLeases(leaseDirectory).acquire("app-check-browser", "someone-else", 600_000);
    const suite = gateSuite("good", [homeCheck]);
    const built = specFor([{ criterionId: "ac-1", testNames: ["app:web:home"] }], ["ac-1"], ["app:web"]);
    const { evaluate } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-1"], leaseDirectory);
    const result = await evaluate();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("blocked");
    expect(result.value.findings[0]).toMatchObject({ code: "app_check_browser_busy" });
    expect(result.value.metadata).toMatchObject({ verification: { method: "e2e_test", command: "app:web" } });
  }, 60_000);

  it("rejects a definition whose test names were tampered with", async () => {
    const repo = await fixtureRepo();
    const { store, root: artifactRoot } = await storeFor();
    const suite = gateSuite("good", [itemsCheck]);
    const built = specFor([{ criterionId: "ac-1", testNames: ["app:web:items-api"] }], ["ac-1"], ["app:web"]);
    const { evaluate, configured } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-1"], join(artifactRoot, "lease-tamper"));
    const tampered = { ...configured, configuration: { ...(configured.configuration as Record<string, JsonValue>), testNames: ["app:web:home"] } } as typeof configured;
    const result = await evaluate("task-1", tampered);
    expect(result).toMatchObject({ ok: false, error: { code: "validation", message: expect.stringMatching(/does not match owner configuration/) } });
  });

  it("rejects an evaluation when no accepted criterion selects this suite's checks", async () => {
    const repo = await fixtureRepo();
    const { store, root: artifactRoot } = await storeFor();
    const suite = gateSuite("good", [itemsCheck]);
    const built = specFor([{ criterionId: "ac-1", testNames: ["app:web:items-api"] }], ["ac-1"], ["app:web"]);
    const { evaluate } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-unknown"], join(artifactRoot, "lease-none"));
    expect(await evaluate()).toMatchObject({ ok: false, error: { code: "validation", message: expect.stringMatching(/No accepted criterion selects/) } });
  });
});

describe.skipIf(!browserAvailable)("app gate: passing run, binding and evidence (real Chrome in the sandbox)", () => {
  it("passes, stores bound evidence with the screenshot, and runs only the checks mapped by the selected criteria", async () => {
    const repo = await fixtureRepo();
    const { store, root } = await storeFor();
    const leaseDirectory = join(root, "leases");
    const suite = gateSuite("good", [homeCheck, itemsCheck]);
    // The criterion selects only the API check: the UI check is configured but unmapped, so it must not run.
    const built = specFor([{ criterionId: "ac-api", testNames: ["app:web:items-api"] }], ["ac-api"], ["app:web"]);
    const { evaluate } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-api"], leaseDirectory);
    const result = await evaluate();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("passed");
    expect(result.value.findings).toEqual([]);
    const reference = (result.value.metadata as Record<string, Record<string, unknown>>).appCheck!.evidence as ArtifactReference;
    const evidence = JSON.parse((await readArtifact(store, reference)).toString("utf8")) as Record<string, unknown>;
    const treeSha = repo.git("rev-parse", `${repo.revision}^{tree}`);
    const app = evidence.app as Record<string, unknown>;
    expect(evidence).toMatchObject({ kind: "bflow.app-check-evidence", suiteId: "web", candidate: { sourceRevision: repo.revision, checkoutTree: treeSha } });
    expect(app).toMatchObject({ command: { executable: process.execPath, args: ["server.mjs"] }, port: 4173, readyPath: "/health" });
    expect(app.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(app.origin).toBe("http://127.0.0.1:4173");
    expect(app.envKeys).toEqual(["API_BASE", "FIXTURE_MODE"]);
    expect(evidence.checks).toEqual([expect.objectContaining({ identity: "app:web:items-api", checkId: "items-api", status: "passed", criterionIds: ["ac-api"] })]);
    expect(evidence.criteria).toEqual([{ criterionId: "ac-api", identities: ["app:web:items-api"], passed: true }]);
    expect(JSON.stringify(evidence)).not.toContain("app:web:home");
    const driverSha = createHash("sha256").update(await readArtifactDriver()).digest("hex");
    expect(evidence.driver).toEqual({ sha256: driverSha });
    expect((evidence.browser as unknown)).toBeNull();
    expect(evidence.checks).not.toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "home" })]));
    expect(result.value.metadata).toMatchObject({ verification: { sourceRevision: repo.revision, method: "e2e_test", command: "app:web", testNames: ["app:web:items-api"], exitCode: null } });
  }, 120_000);

  it("stores env keys without values, binds the browser lease and a screenshot for a UI check", async () => {
    const repo = await fixtureRepo();
    const { store, root } = await storeFor();
    const suite = gateSuite("good", [homeCheck]);
    const built = specFor([{ criterionId: "ac-ui", testNames: ["app:web:home"] }], ["ac-ui"], ["app:web"]);
    const { evaluate } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-ui"], join(root, "leases"));
    const result = await evaluate();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("passed");
    const reference = (result.value.metadata as Record<string, Record<string, unknown>>).appCheck!.evidence as ArtifactReference;
    const raw = (await readArtifact(store, reference)).toString("utf8");
    expect(raw).not.toContain("secret-env-value");
    const evidence = JSON.parse(raw) as { browser: { version: string; resourceKey: string; lease: { fencingToken: number; leaseId: string } }; checks: { screenshotArtifactId?: string }[] };
    expect(evidence.browser).toMatchObject({ resourceKey: "app-check-browser", lease: { fencingToken: 1 } });
    expect(evidence.browser.version).toMatch(/Chrome/);
    const shot = evidence.checks[0]!.screenshotArtifactId!;
    // The stored screenshot is resolved through the store, which mints its own trusted reference.
    const shotRef = unwrap(await (store as unknown as { resolve(id: string): Promise<{ ok: true; value: ArtifactReference | null }> }).resolve(shot).then(result => result as never));
    expect(shotRef).toMatchObject({ artifactId: shot, kind: "report", mediaType: "image/png" });
    const bytes = await readArtifact(store, shotRef as ArtifactReference);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 120_000);

  it("fails with findings that point at the stored evidence for a candidate that serves wrong data", async () => {
    const repo = await fixtureRepo();
    const { store, root } = await storeFor();
    const suite = gateSuite("wrongapi", [itemsCheck]);
    const built = specFor([{ criterionId: "ac-api", testNames: ["app:web:items-api"] }], ["ac-api"], ["app:web"]);
    const { evaluate } = gateFor(suite, built, repo.revision, repo.root, store, ["ac-api"], join(root, "leases"));
    const result = await evaluate();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("failed");
    expect(result.value.findings[0]).toMatchObject({ code: "api_assertion_failed", location: "app:web:items-api" });
    const reference = (result.value.metadata as Record<string, Record<string, unknown>>).appCheck!.evidence as ArtifactReference;
    expect(result.value.findings[0]!.artifactId).toBe(reference.artifactId);
  }, 120_000);
});

async function readArtifactDriver(): Promise<Buffer> {
  return readFile(fileURLToPath(new URL("../../dist/agentic/app-check-driver.js", import.meta.url)));
}

/* ---------- ingress through HostVerification (owner mode: one owner unit command, no detection) ---------- */

import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { WorkflowProposalRejected as Rejected } from "../../src/agentic/workflow-rejection.js";

const ownerUnit = parseBehavioralCommands([{ id: "unit", command: "owner:test-unit", executable: process.execPath,
  args: ["--test", "--test-reporter=tap", "test/bucket.test.cjs"], method: "unit_test", levels: ["unit"], testNames: ["unit ac-unit"],
  testPaths: ["test/bucket.test.cjs"], timeoutMs: 15_000 }]);

function ingress(configured: AppCheckSuite[] = suites) {
  return new HostVerification(() => ({ inspect: async () => ({}) }) as unknown as AgenticWorkflowRuntime,
    () => { throw new Error("artifact store is not used at ingress"); }, undefined, ownerUnit, undefined, undefined, [], { suites: configured });
}

describe("app criteria at ingress", () => {
  it("accepts app-only criteria without the owner-runner error that a plain e2e criterion would raise", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }], [{ criterionId: "ac-1", testNames: ["app:web:home"] }], ["app:web"]);
    expect(() => ingress().assertSupported(specification, strategy)).not.toThrow();
    expect(() => ingress().assertTaskSupported(specification, strategy, ["packages/example/src/logic.ts"])).not.toThrow();
  });

  it("keeps the owner runner rule for an unmapped e2e criterion beside app criteria", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }, { id: "ac-2", method: "e2e_test" }],
      [{ criterionId: "ac-1", testNames: ["app:web:home"] }, { criterionId: "ac-2", testNames: ["plain e2e"] }], ["app:web", "owner:test-unit"]);
    // The plain e2e criterion still needs an owner e2e runner; the app criterion does not satisfy it.
    expect(() => ingress().assertSupported(specification, strategy)).toThrow(/No owner-configured behavioral runner for e2e_test/);
  });

  it("accepts a unit criterion that the owner command runs beside an app criterion", () => {
    const { specification, strategy } = specWith([{ id: "ac-app", method: "e2e_test" }, { id: "ac-unit", method: "unit_test" }],
      [{ criterionId: "ac-app", testNames: ["app:web:home"] }, { criterionId: "ac-unit", testNames: ["unit ac-unit"] }], ["app:web", "owner:test-unit"]);
    expect(() => ingress().assertSupported(specification, strategy)).not.toThrow();
  });

  it("rejects a mixed mapping with a structured proposal rejection", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }], [{ criterionId: "ac-1", testNames: ["app:web:home", "plain e2e"] }], ["app:web"]);
    let thrown: unknown;
    try { ingress().assertSupported(specification, strategy); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Rejected);
    expect((thrown as Rejected).rejection.code).toBe("unsupported_verification");
  });

  it("rejects an app identity whose suite is not configured", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }], [{ criterionId: "ac-1", testNames: ["app:shop:home"] }], ["app:shop"]);
    expect(() => ingress([]).assertSupported(specification, strategy)).toThrow(/unknown real-app check app:shop:home/);
  });

  it("rejects a required TDD decision whose only automated criteria are real-app checks", () => {
    const { specification, strategy } = specWith([{ id: "ac-1", method: "e2e_test" }], [{ criterionId: "ac-1", testNames: ["app:web:home"] }], ["app:web"], "required");
    expect(() => ingress().assertSupported(specification, strategy)).toThrow(/not Red-Green-Refactor evidence/);
  });

  it("registers one definition and one gate per configured suite, with binding metadata", () => {
    const host = ingress();
    const definition = host.behavioralChecks().find(item => item.id === "host-app-web")!;
    expect(definition).toMatchObject({ evaluator: "host-app-check", required: true, metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true, boundRunnerIdentities: true } });
    expect(host.behavioralGates().filter(item => item.id === "host-app-web")).toHaveLength(1);
    expect(ingress([]).behavioralChecks().some(item => item.id.startsWith("host-app-"))).toBe(false);
  });
});

/* ---------- host configuration persistence (readHostConfiguration validates the persisted real-app checks) ---------- */

import { mkdir, writeFile as writeConfig } from "node:fs/promises";
import { readHostConfiguration } from "../../src/agentic/host-controller.js";

describe("persisted host configuration with real-app checks", () => {
  async function hostJson(config: Record<string, unknown>): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-host-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "host.json");
    await writeConfig(path, JSON.stringify({ repositoryPath: root, sessionId: "s1", directory, socketPath: join(directory, "h.sock"), token: "t", ...config }), { mode: 0o600 });
    return path;
  }
  const suiteJson = { id: "web", app: { executable: process.execPath, args: ["server.mjs"], port: 4173 }, timeoutMs: 60000,
    checks: [{ id: "items-api", kind: "api", request: { method: "GET", path: "/api/items" }, expect: { status: 200, json: [{ pointer: "", type: "array" }] } }] };

  it("accepts valid persisted appChecks and returns them as stored (the host parses them again with defaults)", async () => {
    const configuration = await readHostConfiguration(await hostJson({ appChecks: [suiteJson] }));
    expect(configuration.appChecks).toEqual([suiteJson]);
  });

  it("rejects persisted appChecks that fail the same strict parse as owner configuration", async () => {
    await expect(readHostConfiguration(await hostJson({ appChecks: [{ ...suiteJson, checks: [{ ...suiteJson.checks[0], expect: { status: 200 } }] }] })))
      .rejects.toThrow(/behavioral assertion besides status/);
  });
});
