import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { ResolvedToolGrantSchema, type ArtifactStore, type ResolvedToolGrant, type RunStore } from "@bflow/contracts";
import {
  QA_BROWSER_TOOL_ID, QA_HTTP_TOOL_ID, QaScopeDenied, QaWorkflowRejected, QaWorkflowRuntime, createHttpQaTool, planQaWorkflow, verifyQaDesign,
  type QaAssignment, type QaBrowserTool, type QaHttpTool, type QaIntakeInput, type QaReconciliation, type QaRolePort, type QaTestDesign
} from "../../src/index.js";
import { QaIntakeSchema } from "../../src/qa/model.js";
import { AppCheckBrowserLeases } from "../../src/agentic/app-check-lease.js";

const SERVER = fileURLToPath(new URL("../fixtures/qa-app/server.mjs", import.meta.url));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

interface App { origin: string; process: ChildProcess; stats(): Promise<{ requests: string[]; deletes: number; carts: { id: string; label: string }[] }>; stop(): Promise<void> }
const apps: App[] = [];
async function startApp(env: Record<string, string> = { QA_APP_BUILD_ID: "fixture-1.4.2" }): Promise<App> {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    child.stdout!.on("data", chunk => { text += chunk; const match = /LISTENING (\d+)/.exec(text); if (match) resolve(Number(match[1])); });
    child.once("exit", code => reject(new Error(`fixture exited ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const app: App = { origin, process: child,
    stats: async () => await (await fetch(`${origin}/__stats`)).json() as Awaited<ReturnType<App["stats"]>>,
    stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", () => resolve()); child.kill("SIGTERM"); }) };
  apps.push(app);
  return app;
}

function intake(origin: string, overrides: Partial<QaIntakeInput> = {}): QaIntakeInput {
  return {
    schemaVersion: 1, requestId: "shop-qa", sessionId: "session-1", title: "Shop pricing and cart QA",
    userStatements: [{ id: "U-1", text: "Test the shop fixture: product lookup, bulk discount and cart lifecycle. Do not change the product." }],
    target: { environmentId: "shop-fixture", kind: "fixture", origins: [origin], readinessPath: "/health",
      buildIdentity: { path: "/__build", pointer: "/build" } },
    criteria: [
      { id: "AC-1", description: "GET /api/products/p1 returns the Widget priced 100" },
      { id: "AC-2", description: "A quote for 10 or more items applies a 10% bulk discount" },
      { id: "AC-3", description: "A cart can be created with a label and deleted" }
    ],
    allowedActions: ["http_read", "http_mutate"],
    accountPolicy: { accounts: [{ id: "fixture-buyer", kind: "isolated_fixture", description: "Throwaway buyer of the fixture" }] },
    dataPolicy: { fixturePrefix: "qa-shop", redactKeys: ["token"] },
    cleanup: { required: true },
    workspace: { assetRoot: "qa" },
    protectedPaths: ["app"],
    ...overrides
  };
}

function design(origin: string, extra: QaTestDesign["cases"] = [], options: { drop?: string[] } = {}): QaTestDesign {
  const cases: QaTestDesign["cases"] = [
    { id: "TC-1", title: "Product lookup", criterionIds: ["AC-1"], sideEffect: "none", expected: "Widget priced 100",
      steps: [{ kind: "http", method: "GET", url: "/api/products/p1", expect: { status: 200, json: [{ pointer: "/price", equals: 100 }] } }], cleanup: [] },
    { id: "TC-2", title: "Bulk discount at exactly 10 items", criterionIds: ["AC-2"], sideEffect: "none", expected: "total 900 for 10 x 100 with 10% off",
      steps: [{ kind: "http", method: "GET", url: `${origin}/api/quote?productId=p1&qty=10`, expect: { status: 200, json: [{ pointer: "/total", equals: 900 }] } }], cleanup: [] },
    { id: "TC-3", title: "Cart lifecycle", criterionIds: ["AC-3"], sideEffect: "mutating", account: "fixture-buyer", expected: "cart is created with its label",
      steps: [{ kind: "http", method: "POST", url: "/api/carts", body: { label: "${fixturePrefix}-cart" }, capture: { cartId: "/id" },
        expect: { status: 201, json: [{ pointer: "/label", equals: "${fixturePrefix}-cart" }] } }],
      cleanup: [{ kind: "http", method: "DELETE", url: "/api/carts/${cartId}", expect: { status: 204 } }] },
    { id: "TC-4", title: "Product name", criterionIds: ["AC-1"], sideEffect: "none", expected: "product name is Gadget",
      steps: [{ kind: "http", method: "GET", url: "/api/products/p1", expect: { status: 200, json: [{ pointer: "/name", equals: "Gadget" }] } }], cleanup: [] },
    ...extra
  ].filter(item => !options.drop?.includes(item.id));
  const coverage = new Map<string, string[]>();
  for (const item of cases) for (const criterion of item.criterionIds) coverage.set(criterion, [...coverage.get(criterion) ?? [], item.id]);
  return { schemaVersion: 1, title: "Shop QA design", cases, criteriaCoverage: [...coverage].map(([criterionId, caseIds]) => ({ criterionId, caseIds })) };
}

type Behaviour = Partial<Record<QaAssignment["taskId"], (assignment: QaAssignment, call: number) => { agentId?: string; output: unknown } | undefined>>;
class FixtureRoles implements QaRolePort {
  readonly calls: QaAssignment[] = [];
  constructor(private readonly origin: () => string, private readonly behaviour: Behaviour = {}, private readonly completed = new Map<string, QaReconciliation>()) {}
  async dispatch(assignment: QaAssignment) {
    this.calls.push(structuredClone(assignment));
    const call = this.calls.filter(item => item.taskId === assignment.taskId).length;
    const custom = this.behaviour[assignment.taskId]?.(assignment, call);
    if (custom) return { agentId: custom.agentId ?? `${assignment.role}:pane`, output: custom.output };
    switch (assignment.taskId) {
      case "design": return { agentId: `${assignment.role}:pane`, output: { design: design(this.origin()) } };
      case "design-review": return { agentId: `${assignment.role}:pane`, output: { verdict: "approved", designDigest: assignment.context.design!.digest, findings: [] } };
      case "adjudication": return { agentId: `${assignment.role}:pane`, output: adjudicate(assignment) };
      default: throw new Error(`unexpected ${assignment.taskId}`);
    }
  }
  async reconcile(executionId: string): Promise<QaReconciliation> { return this.completed.get(executionId) ?? { status: "unknown" }; }
}
function adjudicate(assignment: QaAssignment, overrides: Record<string, string> = {}) {
  const execution = assignment.context.execution!;
  return { executionDigest: execution.digest, verdicts: execution.cases.map(item => ({ caseId: item.caseId,
    classification: overrides[item.caseId] ?? (item.status === "assertion_failed" ? item.caseId === "TC-4" ? "test_defect" : "product_failure" : item.status),
    rationale: item.caseId === "TC-4" ? "AC-1 names the product Widget; the test expected Gadget, so the test is wrong" : `Observed ${item.status}` })) };
}

let root: string, repo: string, state: string, clock: number, base: number;
const now = () => new Date(base + 1000 * clock++).toISOString();
function grants(ops: string[] = ["http_read", "http_mutate"], tool = QA_HTTP_TOOL_ID): ResolvedToolGrant[] {
  return [ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: `grant-${tool}`, policyDigest: "a".repeat(64), toolId: tool, kind: "stdio_mcp",
    requiredness: "required", role: "qa", scope: { kind: "session", machineId: "m1", repositoryId: "repo1", workspaceRoot: repo, sessionId: "session-1" },
    triggers: ["explicit"], serviceId: tool, operations: ops })];
}
async function open(roles: QaRolePort, options: { http?: QaHttpTool | null; browser?: QaBrowserTool; grants?: ResolvedToolGrant[]; leases?: AppCheckBrowserLeases; humans?: string[] } = {}) {
  const runStore = unwrap(openSqliteRunStore({ filename: join(state, "runs.db") })) as unknown as RunStore;
  const artifactStore = unwrap(await openFilesystemArtifactStore({ root: join(state, "artifacts"), storeId: "qa" })) as ArtifactStore;
  return QaWorkflowRuntime.open({ engine: new DeterministicWorkflowEngine(), runStore, artifactStore, roles, repositoryRoot: repo,
    journalPath: join(state, "qa-journal.json"), authorizeHuman: decision => (options.humans ?? ["user:anh"]).includes(decision.decidedBy), now,
    tools: { ...(options.http === null ? {} : { http: options.http ?? createHttpQaTool() }), ...(options.browser ? { browser: options.browser } : {}) },
    grants: options.grants ?? grants(),
    leases: options.leases ?? new AppCheckBrowserLeases(join(state, "leases")), leaseTtlMs: 60_000,
    accounts: { headers: async id => ({ authorization: `Bearer fixture-secret-${id}` }) } });
}
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); out[relative(repo, path)] = sha(await readFile(path)); }
  return out;
}
async function approveDesign(runtime: QaWorkflowRuntime, runId: string) {
  const status = runtime.status(runId);
  expect(status.status).toBe("awaiting_design_approval");
  return runtime.decideDesign(runId, { decision: "approved", designDigest: status.design!.digest, decidedBy: "user:anh" });
}

beforeEach(async () => {
  clock = 0; base = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-qa-")));
  repo = join(root, "repo"); state = join(root, "state");
  await mkdir(join(repo, "app"), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(repo, "app", "server.mjs"), "// product source under test; must never change\n");
  await writeFile(join(repo, "app", "deploy.json"), "{\"replicas\":1}\n");
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.stop()));
  await rm(root, { recursive: true, force: true });
});

describe("QA-only workflow on a real app fixture", () => {
  it("designs, reviews independently, executes, adjudicates and reports without touching the product", async () => {
    const app = await startApp();
    const roles = new FixtureRoles(() => app.origin);
    const runtime = await open(roles);
    const productBefore = await tree(join(repo, "app"));
    await runtime.start({ runId: "qa-1", intake: intake(app.origin) });
    expect(runtime.status("qa-1").definition.tasks.map(item => [item.id, item.role])).toEqual([
      ["design", "tester"], ["design-review", "reviewer"], ["execution", "coordinator"], ["adjudication", "qa"], ["report", "coordinator"]]);
    await runtime.drive("qa-1");
    // Nothing touched the target before the human approved the exact reviewed design.
    expect((await app.stats()).requests).toEqual([]);
    const final = await approveDesign(runtime, "qa-1");
    expect(final.status).toBe("reported");

    // Roles never receive write, command or network authority; only Runtime acts on the target.
    for (const call of roles.calls) expect(call.permissions).toEqual({ read: [], write: "none", commands: "none", network: "none" });
    expect(roles.calls.find(item => item.taskId === "design-review")!.context.design!.digest).toBe(final.design!.digest);

    expect(final.classifications).toEqual({ "TC-1": "passed", "TC-2": "product_failure", "TC-3": "passed", "TC-4": "test_defect" });
    expect(final.verdict).toBe("product_failures_found");
    expect(final.execution!.build).toEqual({ status: "identified", value: "fixture-1.4.2", source: "endpoint:/__build#/build" });
    expect(final.execution!.cases["TC-3"]!.cleanup.status).toBe("cleaned");
    expect(final.tdd).toEqual({ mode: "not_applicable", alternativeVerification: ["manual_review"] });
    const stats = await app.stats();
    expect(stats.carts).toEqual([]);
    expect(stats.requests.filter(item => item === "POST /api/carts")).toHaveLength(1);

    // Only test assets and the report are written, inside the granted workspace; the product tree is unchanged.
    expect(await tree(join(repo, "app"))).toEqual(productBefore);
    expect(Object.keys(await tree(repo)).sort()).toEqual(["app/deploy.json", "app/server.mjs", "qa/shop-qa/r1/report.md", "qa/shop-qa/r1/tests/cases.json"]);
    expect(final.execution!.productUnchanged).toBe(true);

    const report = await readFile(join(repo, "qa/shop-qa/r1/report.md"), "utf8");
    const bug = final.report!.bugs[0]!;
    expect(final.report!.bugs).toHaveLength(1);
    expect(bug).toMatchObject({ caseId: "TC-2", criterionId: "AC-2", fixAuthority: "none",
      environment: { environmentId: "shop-fixture", origin: app.origin, build: { status: "identified", value: "fixture-1.4.2" } } });
    expect(bug.expected).toContain("/total equals 900");
    expect(bug.actual).toContain("1000");
    expect(bug.reproduction.join("\n")).toContain(`GET ${app.origin}/api/quote?productId=p1&qty=10`);
    expect(bug.evidenceArtifactIds.length).toBeGreaterThan(0);
    for (const text of ["AC-2", "fixture-1.4.2", "Bug QA-BUG-1", "test_defect", "TC-4", "không cấp quyền sửa", "Phạm vi"]) expect(report).toContain(text);
    // Sanitized evidence: response secrets and cookies never reach the report or stored evidence.
    expect(report).not.toContain("secret-session-token");
    expect(report).not.toContain("abc123");
    expect(report).not.toContain("fixture-secret");
    for (const entry of await readdir(join(state, "artifacts"), { withFileTypes: true, recursive: true }))
      if (entry.isFile()) expect(await readFile(join(entry.parentPath, entry.name), "utf8")).not.toMatch(/secret-session-token|fixture-secret/);
    expect(JSON.stringify(final.execution)).not.toContain("secret-session-token");
  });

  it("refuses unauthorized targets, unsafe intakes and implementation DAGs before any access", async () => {
    const app = await startApp();
    const runtime = await open(new FixtureRoles(() => app.origin));
    expect(() => QaIntakeSchema.parse(intake(app.origin, { target: { environmentId: "prod", kind: "production", origins: [app.origin] } })))
      .toThrow(/Production targets cannot allow mutating actions/);
    expect(() => QaIntakeSchema.parse(intake(app.origin, { workspace: { assetRoot: "app/qa" } }))).toThrow(/protected/);
    expect(() => QaIntakeSchema.parse(intake(app.origin, { target: { environmentId: "x", kind: "fixture", origins: [`${app.origin}/path`] } }))).toThrow(/origin/);
    await expect(runtime.start({ runId: "qa-x", intake: intake(app.origin, { target: { environmentId: "staging", kind: "non_production", origins: [app.origin] } }) }))
      .rejects.toThrow(QaScopeDenied);
    await expect(runtime.start({ runId: "qa-y", intake: intake(app.origin, { target: { environmentId: "staging", kind: "non_production", origins: [app.origin] } }),
      access: { decidedBy: "coordinator:pane" } })).rejects.toThrow(/authenticated human/);
    const parsed = QaIntakeSchema.parse(intake(app.origin));
    const full = planQaWorkflow(parsed);
    const planned = { ...full, qualityGates: [], tasks: full.tasks.map(item => ({ ...item, qualityGates: [] })) };
    await expect(runtime.start({ runId: "qa-g", intake: intake(app.origin), definition: full })).rejects.toThrow(/Runtime-owned/);
    const developer = { ...planned, tasks: planned.tasks.map(item => item.id === "execution" ? { ...item, role: "developer" } : item) };
    await expect(runtime.start({ runId: "qa-z", intake: intake(app.origin), definition: developer })).rejects.toThrow(/role 'developer' cannot perform execution/);
    const patching = { ...planned, tasks: [...planned.tasks, { ...planned.tasks[0]!, id: "fix", metadata: { qaKind: "fix" } }] };
    await expect(runtime.start({ runId: "qa-z2", intake: intake(app.origin), definition: patching })).rejects.toThrow(QaWorkflowRejected);
    await runtime.start({ runId: "qa-ok", intake: intake(app.origin), definition: planned });
    expect(runtime.status("qa-ok").definition.tasks.every(item => item.qualityGates.length === 1)).toBe(true);
    expect((await app.stats()).requests).toEqual([]);
  });

  it("rejects designs with unapproved origins, actions, accounts or missing cleanup and retries the designer", async () => {
    const app = await startApp();
    const parsed = QaIntakeSchema.parse(intake(app.origin, { allowedActions: ["http_read"] }));
    const bad = design(app.origin, [{ id: "TC-5", title: "Exfiltrate", criterionIds: ["AC-1"], sideEffect: "none", expected: "x",
      steps: [{ kind: "http", method: "GET", url: "https://evil.example/api", expect: { status: 200 } }], cleanup: [] }]);
    const checked = verifyQaDesign(bad, parsed);
    const codes = checked.findings.map(item => `${item.code}:${item.ids.join(",")}`);
    expect(codes).toEqual(expect.arrayContaining(["origin_not_approved:TC-5", "action_not_allowed:TC-3"]));
    const noCleanup = design(app.origin);
    noCleanup.cases[2] = { ...noCleanup.cases[2]!, cleanup: [], account: undefined };
    const fixture = QaIntakeSchema.parse(intake(app.origin, { target: { environmentId: "staging", kind: "non_production", origins: [app.origin] } }));
    expect(verifyQaDesign(noCleanup, fixture).findings.map(item => item.code)).toEqual(expect.arrayContaining(["cleanup_missing", "isolated_account_missing"]));
    expect(verifyQaDesign(design(app.origin, [], { drop: ["TC-2"] }), QaIntakeSchema.parse(intake(app.origin))).findings.map(item => item.code)).toContain("criterion_uncovered");
    const leaky = design(app.origin);
    leaky.cases[0] = { ...leaky.cases[0]!, steps: [{ ...leaky.cases[0]!.steps[0]!, headers: { Authorization: "Bearer real-token" } } as QaTestDesign["cases"][number]["steps"][number]] };
    expect(verifyQaDesign(leaky, QaIntakeSchema.parse(intake(app.origin))).findings.map(item => `${item.code}:${item.ids.join(",")}`)).toContain("credential_in_design:TC-1");

    const roles = new FixtureRoles(() => app.origin, { design: (_assignment, call) => call === 1 ? { output: { design: bad } } : undefined });
    const runtime = await open(roles);
    await runtime.start({ runId: "qa-2", intake: intake(app.origin) });
    await runtime.drive("qa-2");
    expect(roles.calls.filter(item => item.taskId === "design")).toHaveLength(2);
    expect(roles.calls.filter(item => item.taskId === "design")[1]!.context.findings.map(item => item.code)).toContain("origin_not_approved");
    expect(runtime.status("qa-2").status).toBe("awaiting_design_approval");
  });

  it("denies role write/patch authority and requires an independent reviewer and an authenticated human", async () => {
    const app = await startApp();
    const roles = new FixtureRoles(() => app.origin, {
      design: (_assignment, call) => call === 1 ? { output: { design: design(app.origin), patch: "diff --git a/app/server.mjs" } } : undefined
    });
    const runtime = await open(roles);
    // A Coordinator DAG where the same qa identity designs and reviews: allowed roles, but not an independent review.
    const planned = planQaWorkflow(QaIntakeSchema.parse(intake(app.origin)));
    const sameQa = { ...planned, tasks: planned.tasks.map(item => item.id === "design" || item.id === "design-review" ? { ...item, role: "qa", qualityGates: [] } : { ...item, qualityGates: [] }),
      qualityGates: [] };
    await runtime.start({ runId: "qa-3", intake: intake(app.origin), definition: sameQa });
    const status = await runtime.drive("qa-3");
    expect(status.denials[0]!.reason).toMatch(/forbidden authority: patch/);
    // qa:pane cannot review the design written by qa:pane.
    // A failed independent review ends this run: the reviewer is not dispatched again behind the revision blocker.
    expect(roles.calls.filter(item => item.taskId === "design-review")).toHaveLength(1);
    expect((await runtime.drive("qa-3")).status).toBe("needs_revision");
    expect(roles.calls.filter(item => item.taskId === "design-review")).toHaveLength(1);
    expect(status.status).toBe("needs_revision");
    expect(status.blockers.join(" ")).toMatch(/review_not_independent/);
    expect((await app.stats()).requests).toEqual([]);

    const humanRoles = new FixtureRoles(() => app.origin);
    const runtime2 = await open(humanRoles);
    await runtime2.start({ runId: "qa-4", intake: intake(app.origin) });
    const waiting = await runtime2.drive("qa-4");
    await expect(runtime2.decideDesign("qa-4", { decision: "approved", designDigest: waiting.design!.digest, decidedBy: "coordinator:pane" })).rejects.toThrow(/authenticated human/);
    await expect(runtime2.decideDesign("qa-4", { decision: "approved", designDigest: "f".repeat(64), decidedBy: "user:anh" })).rejects.toThrow(/exact reviewed design digest/);
    expect((await app.stats()).requests).toEqual([]);
  });

  it("classifies an unavailable app as an environment failure and refuses adjudication that calls it a product bug", async () => {
    const app = await startApp();
    const roles = new FixtureRoles(() => app.origin, {
      adjudication: (assignment, call) => call === 1 ? { output: adjudicate(assignment, { "TC-1": "product_failure" }) } : undefined
    });
    const runtime = await open(roles);
    await runtime.start({ runId: "qa-5", intake: intake(app.origin) });
    await runtime.drive("qa-5");
    await app.stop();
    const final = await approveDesign(runtime, "qa-5");
    expect(final.status).toBe("reported");
    expect(final.execution!.readiness).toMatchObject({ ready: false });
    expect(Object.values(final.classifications)).toEqual(["environment_failure", "environment_failure", "environment_failure", "environment_failure"]);
    expect(final.verdict).toBe("environment_failure");
    expect(final.report!.bugs).toEqual([]);
    expect(roles.calls.filter(item => item.taskId === "adjudication")).toHaveLength(2);
    expect(roles.calls.filter(item => item.taskId === "adjudication")[1]!.context.findings.map(item => item.code)).toContain("classification_override");
    // Build identity could not be observed: the limitation is stated instead of a source revision.
    expect(final.execution!.build).toMatchObject({ status: "unknown" });
    const report = await readFile(join(repo, "qa/shop-qa/r1/report.md"), "utf8");
    expect(report).toContain("Không xác định được build identity");
  });

  it("states the build-identity limitation and blocks redirects to other origins", async () => {
    const app = await startApp({});
    const extra: QaTestDesign["cases"] = [
      { id: "TC-5", title: "Redirect away", criterionIds: ["AC-1"], sideEffect: "none", expected: "stays on origin",
        steps: [{ kind: "http", method: "GET", url: "/go-away", expect: { status: 200 } }], cleanup: [] },
      { id: "TC-6", title: "Same-origin redirect", criterionIds: ["AC-1"], sideEffect: "none", expected: "follows to the product",
        steps: [{ kind: "http", method: "GET", url: "/moved", expect: { status: 200, json: [{ pointer: "/id", equals: "p1" }] } }], cleanup: [] }
    ];
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design(app.origin, extra) } }) });
    const runtime = await open(roles);
    await runtime.start({ runId: "qa-6", intake: intake(app.origin) });
    await runtime.drive("qa-6");
    const final = await approveDesign(runtime, "qa-6");
    expect(final.execution!.build).toEqual({ status: "unknown", limitation: expect.stringMatching(/not attributed to any source revision/) });
    expect(final.execution!.cases["TC-5"]).toMatchObject({ status: "blocked", code: "origin_redirect_denied" });
    expect(final.classifications["TC-5"]).toBe("blocked");
    expect(final.classifications["TC-6"]).toBe("passed");
    expect(final.denials.map(item => item.reason).join(" ")).toMatch(/example\.invalid/);
    const report = await readFile(join(repo, "qa/shop-qa/r1/report.md"), "utf8");
    expect(report).toContain("Không xác định được build identity");
    expect(report).not.toMatch(/revision [0-9a-f]{40}/);
  });

  it("blocks without side effects while the environment lease is busy and resumes once it is free", async () => {
    const app = await startApp();
    const leases = new AppCheckBrowserLeases(join(state, "leases"));
    const other = await leases.acquire("qa-target-shop-fixture", "another-run", 60_000);
    expect(other.ok).toBe(true);
    const runtime = await open(new FixtureRoles(() => app.origin), { leases });
    await runtime.start({ runId: "qa-7", intake: intake(app.origin) });
    await runtime.drive("qa-7");
    const blocked = await approveDesign(runtime, "qa-7");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockers).toEqual([expect.stringMatching(/^lease_busy:qa-target-shop-fixture:another-run/)]);
    expect((await app.stats()).requests).toEqual([]);
    if (other.ok) await leases.release(other.lease);
    const resumed = await runtime.drive("qa-7");
    expect(resumed.status).toBe("reported");
    expect(resumed.execution!.leases[0]).toMatchObject({ resourceKey: "qa-target-shop-fixture", fencingToken: 2, released: true });
  });

  it("stops side effects when the lease expires mid-run and reports the remaining cases as blocked", async () => {
    const app = await startApp();
    let leaseNow = Date.now();
    const leases = new AppCheckBrowserLeases(join(state, "leases"), () => new Date(leaseNow));
    const real = createHttpQaTool();
    const http: QaHttpTool = { ...real, request: async request => {
      const response = await real.request(request);
      if (request.url.includes("/api/products/p1")) leaseNow += 120_000; // the lease expires right after TC-1
      return response;
    } };
    const runtime = await open(new FixtureRoles(() => app.origin), { leases, http });
    await runtime.start({ runId: "qa-8", intake: intake(app.origin) });
    await runtime.drive("qa-8");
    const final = await approveDesign(runtime, "qa-8");
    expect(final.classifications["TC-1"]).toBe("passed");
    for (const id of ["TC-2", "TC-3", "TC-4"]) expect(final.execution!.cases[id]).toMatchObject({ status: "blocked", code: "lease_expired" });
    const requests = (await app.stats()).requests.filter(item => !item.startsWith("GET /health") && !item.startsWith("GET /__build"));
    expect(requests).toEqual(["GET /api/products/p1"]);
  });

  it("fences every action: a lease that expires between two steps of one case stops the next request", async () => {
    const app = await startApp();
    let leaseNow = Date.now();
    const leases = new AppCheckBrowserLeases(join(state, "leases"), () => new Date(leaseNow));
    const real = createHttpQaTool();
    const http: QaHttpTool = { ...real, request: async request => {
      const response = await real.request(request);
      if (request.url.includes("probe=expire")) leaseNow += 120_000;
      return response;
    } };
    const extra: QaTestDesign["cases"] = [{ id: "TC-5", title: "Two reads", criterionIds: ["AC-1"], sideEffect: "none", expected: "both answer",
      steps: [{ kind: "http", method: "GET", url: "/api/products/p1?probe=expire", expect: { status: 200 } },
        { kind: "http", method: "GET", url: "/health?second=1", expect: { status: 200 } }], cleanup: [] }];
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design(app.origin, extra) } }) });
    const runtime = await open(roles, { leases, http });
    await runtime.start({ runId: "qa-15", intake: intake(app.origin) });
    await runtime.drive("qa-15");
    const final = await approveDesign(runtime, "qa-15");
    expect(final.execution!.cases["TC-5"]).toMatchObject({ status: "blocked", code: "lease_expired" });
    expect(final.execution!.cases["TC-5"]!.steps.map(item => item.outcome)).toEqual(["ok", "lease"]);
    expect((await app.stats()).requests.filter(item => item === "GET /health")).toHaveLength(1);
  });

  it("reconciles a timed-out mutation instead of replaying it and keeps cleanup failures and uncertainty in the report", async () => {
    const app = await startApp();
    const extra: QaTestDesign["cases"] = [
      { id: "TC-5", title: "Slow cart creation", criterionIds: ["AC-3"], sideEffect: "mutating", account: "fixture-buyer", expected: "cart created",
        steps: [{ kind: "http", method: "POST", url: "/api/slow-carts", body: { label: "${fixturePrefix}-slow" }, capture: { slowId: "/id" }, timeoutMs: 500,
          expect: { status: 201 } }],
        reconcile: { kind: "http", method: "GET", url: "/api/carts?label=${fixturePrefix}-slow", capture: { slowId: "/0/id" }, expect: { status: 200 } },
        cleanup: [{ kind: "http", method: "DELETE", url: "/api/carts/${slowId}", expect: { status: 204 } }] },
      { id: "TC-6", title: "Locked cart", criterionIds: ["AC-3"], sideEffect: "mutating", account: "fixture-buyer", expected: "cart created",
        steps: [{ kind: "http", method: "POST", url: "/api/carts", body: { label: "${fixturePrefix}-locked" }, capture: { lockedId: "/id" }, expect: { status: 201 } }],
        cleanup: [{ kind: "http", method: "DELETE", url: "/api/carts/${lockedId}", expect: { status: 204 } }] }
    ];
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design(app.origin, extra) } }) });
    const runtime = await open(roles);
    await runtime.start({ runId: "qa-9", intake: intake(app.origin) });
    await runtime.drive("qa-9");
    const final = await approveDesign(runtime, "qa-9");
    const slow = final.execution!.cases["TC-5"]!;
    expect(slow).toMatchObject({ status: "inconclusive", code: "mutation_uncertain", cleanup: { status: "cleaned" } });
    const mutation = final.execution!.mutations.find(item => item.caseId === "TC-5" && item.phase === "test")!;
    expect(mutation).toMatchObject({ state: "uncertain", reconciliation: "applied" });
    expect((await app.stats()).requests.filter(item => item === "POST /api/slow-carts")).toHaveLength(1);
    expect(final.classifications["TC-5"]).toBe("inconclusive");
    expect(final.execution!.cases["TC-6"]!.cleanup).toMatchObject({ status: "failed" });
    expect(final.report!.residualData).toEqual([expect.objectContaining({ caseId: "TC-6" })]);
    expect(final.report!.uncertainMutations).toEqual([expect.objectContaining({ caseId: "TC-5", reconciliation: "applied" })]);
    const report = await readFile(join(repo, "qa/shop-qa/r1/report.md"), "utf8");
    expect(report).toContain("Dữ liệu còn sót");
    expect(report).toContain("Mutation không chắc chắn");
    // Reopening after cleanup keeps the uncertain mutation record.
    const reopened = await open(new FixtureRoles(() => app.origin));
    expect(reopened.status("qa-9").execution!.mutations.find(item => item.caseId === "TC-5")).toMatchObject({ state: "uncertain", reconciliation: "applied" });
  });

  it("recovers a crash after a mutation intent by reconciling, never by resending", async () => {
    const app = await startApp();
    const real = createHttpQaTool();
    let crashed = false;
    const crashing: QaHttpTool = { ...real, request: async request => {
      if (request.method === "POST" && !crashed) { crashed = true; await real.request(request); throw new Error("host process died"); }
      return real.request(request);
    } };
    const design5 = design(app.origin);
    design5.cases[2] = { ...design5.cases[2]!, reconcile: { kind: "http", method: "GET", url: "/api/carts?label=${fixturePrefix}-cart", capture: { cartId: "/0/id" }, expect: { status: 200 } } };
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design5 } }) });
    const runtime = await open(roles, { http: crashing });
    await runtime.start({ runId: "qa-10", intake: intake(app.origin) });
    await runtime.drive("qa-10");
    const status = runtime.status("qa-10");
    await expect(runtime.decideDesign("qa-10", { decision: "approved", designDigest: status.design!.digest, decidedBy: "user:anh" })).rejects.toThrow(/host process died/);
    const journal = JSON.parse(await readFile(join(state, "qa-journal.json"), "utf8"));
    expect(journal.runs[0].execution.mutations[0]).toMatchObject({ caseId: "TC-3", state: "intent" });

    const restarted = await open(roles);
    const final = await restarted.drive("qa-10");
    expect(final.status).toBe("reported");
    expect(final.execution!.mutations.find(item => item.caseId === "TC-3" && item.phase === "test")).toMatchObject({ state: "uncertain", reconciliation: "applied" });
    expect(final.classifications["TC-3"]).toBe("inconclusive");
    expect(final.execution!.cases["TC-3"]!.cleanup.status).toBe("cleaned");
    const stats = await app.stats();
    expect(stats.requests.filter(item => item === "POST /api/carts")).toHaveLength(1);
    expect(stats.carts).toEqual([]);
  });

  it("turns missing grants and missing browser wiring into prerequisite gaps instead of bypassing them", async () => {
    const app = await startApp();
    const extra: QaTestDesign["cases"] = [{ id: "TC-5", title: "Product page", criterionIds: ["AC-1"], sideEffect: "none", expected: "Widget visible",
      steps: [{ kind: "browser", op: "navigate", url: "/api/products/p1" }, { kind: "browser", op: "assert_visible", selector: "body", text: "Widget" }], cleanup: [] }];
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design(app.origin, extra) } }) });
    const runtime = await open(roles, { grants: grants(["http_read"]) });
    await runtime.start({ runId: "qa-11", intake: intake(app.origin, { allowedActions: ["http_read", "http_mutate", "browser_navigate"] }) });
    await runtime.drive("qa-11");
    const final = await approveDesign(runtime, "qa-11");
    expect(final.execution!.cases["TC-3"]).toMatchObject({ status: "blocked", code: `prerequisite_gap:grant_unavailable:${QA_HTTP_TOOL_ID}:http_mutate` });
    expect(final.execution!.cases["TC-5"]).toMatchObject({ status: "blocked", code: `prerequisite_gap:tool_not_wired:${QA_BROWSER_TOOL_ID}` });
    expect(final.classifications["TC-1"]).toBe("passed");
    expect((await app.stats()).requests).not.toContain("POST /api/carts");
    expect(final.verdict).toBe("product_failures_found");
  });

  it("fails execution integrity when a protected product path changes during the run and publishes no report", async () => {
    const app = await startApp();
    const real = createHttpQaTool();
    const tampering: QaHttpTool = { ...real, request: async request => {
      if (request.url.includes("/api/quote")) await writeFile(join(repo, "app", "server.mjs"), "// changed during QA\n");
      return real.request(request);
    } };
    const runtime = await open(new FixtureRoles(() => app.origin), { http: tampering });
    await runtime.start({ runId: "qa-13", intake: intake(app.origin) });
    await runtime.drive("qa-13");
    const final = await approveDesign(runtime, "qa-13");
    expect(final.execution!.productUnchanged).toBe(false);
    expect(["blocked", "failed"]).toContain(final.status);
    expect(final.report).toBeUndefined();
    await expect(readFile(join(repo, "qa/shop-qa/r1/report.md"))).rejects.toThrow();
  });

  it("reconciles a role delivery lost in a host crash instead of dispatching the design again", async () => {
    const app = await startApp();
    const crashing = new FixtureRoles(() => app.origin, { design: () => { throw new Error("host crashed during delivery"); } });
    const runtime = await open(crashing);
    await runtime.start({ runId: "qa-14", intake: intake(app.origin) });
    await expect(runtime.drive("qa-14")).rejects.toThrow(/host crashed/);
    const executionId = "qa-14.design.g0.a1";
    const unknown = await open(new FixtureRoles(() => app.origin));
    await expect(unknown.drive("qa-14")).rejects.toThrow(/unknown delivery/);
    expect(unknown.status("qa-14").blockers).toEqual([`unknown_delivery:${executionId}`]);
    const settled = new FixtureRoles(() => app.origin, {}, new Map([[executionId, { status: "completed", agentId: "tester:pane", output: { design: design(app.origin) } }]]));
    const restarted = await open(settled);
    const waiting = await restarted.drive("qa-14");
    expect(waiting.status).toBe("awaiting_design_approval");
    expect(settled.calls.filter(item => item.taskId === "design")).toHaveLength(0);
  });

  it("journals browser interactions as mutations and never replays one whose outcome is uncertain", async () => {
    const app = await startApp();
    const performed: string[] = [];
    const values: (string | undefined)[] = [];
    const browser: QaBrowserTool = { toolId: QA_BROWSER_TOOL_ID, version: "test-port", perform: async step => {
      performed.push(step.op);
      values.push(step.value);
      if (step.op === "fill") return { kind: "timeout" };
      return { kind: "done", url: step.url ?? `${app.origin}/api/products/p1`, passed: true, observations: {} };
    } };
    const extra: QaTestDesign["cases"] = [{ id: "TC-5", title: "Fill a form", criterionIds: ["AC-3"], sideEffect: "mutating", account: "fixture-buyer",
      expected: "form accepted", steps: [{ kind: "browser", op: "navigate", url: "/api/products/p1" },
        { kind: "browser", op: "fill", selector: "#label", value: "${fixturePrefix}-form" }, { kind: "browser", op: "click", selector: "#save" }],
      reconcile: { kind: "http", method: "GET", url: "/api/carts?label=${fixturePrefix}-form", capture: { formId: "/0/id" }, expect: { status: 200 } },
      cleanup: [{ kind: "http", method: "DELETE", url: "/api/carts/${formId}", expect: { status: 204 } }] }];
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design(app.origin, extra) } }) });
    const runtime = await open(roles, { browser, grants: [...grants(), ...grants(["browser_navigate", "browser_interact"], QA_BROWSER_TOOL_ID)] });
    await runtime.start({ runId: "qa-16", intake: intake(app.origin, { allowedActions: ["http_read", "http_mutate", "browser_navigate", "browser_interact"] }) });
    await runtime.drive("qa-16");
    const final = await approveDesign(runtime, "qa-16");
    expect(performed).toEqual(["navigate", "fill"]);
    expect(values[1]).toBe("qa-shop-form");
    expect(final.execution!.cases["TC-5"]).toMatchObject({ status: "inconclusive", code: "mutation_uncertain" });
    // The probe found nothing: the uncertain fill is settled as not applied, so there is nothing to clean up.
    expect(final.execution!.mutations.find(item => item.caseId === "TC-5")).toMatchObject({ state: "uncertain", reconciliation: "not_applied" });
    expect(final.execution!.cases["TC-5"]!.cleanup.status).toBe("not_required");
  });

  it("reports browser cases as blocked, not as an environment failure, when the readiness probe itself has no wired tool", async () => {
    const app = await startApp();
    const browser: QaBrowserTool = { toolId: QA_BROWSER_TOOL_ID, version: "test-port",
      perform: async step => ({ kind: "done", url: step.url ?? app.origin, passed: true, observations: {} }) };
    const extra: QaTestDesign["cases"] = [{ id: "TC-5", title: "Product page", criterionIds: ["AC-1"], sideEffect: "none", expected: "Widget visible",
      steps: [{ kind: "browser", op: "navigate", url: "/api/products/p1" }], cleanup: [] }];
    const roles = new FixtureRoles(() => app.origin, { design: () => ({ output: { design: design(app.origin, extra) } }) });
    const runtime = await open(roles, { http: null, browser, grants: grants(["browser_navigate"], QA_BROWSER_TOOL_ID) });
    await runtime.start({ runId: "qa-17", intake: intake(app.origin, { allowedActions: ["http_read", "http_mutate", "browser_navigate"] }) });
    await runtime.drive("qa-17");
    const final = await approveDesign(runtime, "qa-17");
    expect(final.execution!.readiness).toMatchObject({ ready: false, reason: `prerequisite_gap:tool_not_wired:${QA_HTTP_TOOL_ID}` });
    expect(final.execution!.cases["TC-5"]).toMatchObject({ status: "blocked", code: `prerequisite_gap:tool_not_wired:${QA_HTTP_TOOL_ID}` });
    expect(Object.values(final.classifications)).not.toContain("environment_failure");
    expect(final.verdict).toBe("blocked");
  });

  it("refuses asset writes through symlinks and never overwrites existing workspace files", async () => {
    const app = await startApp();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(repo, "qa"));
    const runtime = await open(new FixtureRoles(() => app.origin));
    await runtime.start({ runId: "qa-12", intake: intake(app.origin) });
    await runtime.drive("qa-12");
    const final = await approveDesign(runtime, "qa-12");
    expect(final.status).toBe("blocked");
    expect(final.denials.map(item => item.reason).join(" ")).toMatch(/Symlinked path refused/);
    expect(await readdir(outside)).toEqual([]);
    expect((await app.stats()).requests).toEqual([]);
  });
});
