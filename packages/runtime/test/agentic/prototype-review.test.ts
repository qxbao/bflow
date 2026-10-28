import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, RoleMessageSchema, type PaneBinding, type QualityGate, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type PanePolicy } from "../../src/agentic/ports.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { renderConversationNotice } from "../../src/agentic/conversation-notice-render.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } });

class Panes implements PanePolicy {
  bindings: PaneBinding[] = ["conversation", "coordinator", "specifier", "architect", "planner", "reviewer", "qa", "tester"].map(role => ({
    schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role: role as PaneBinding["role"],
    paneGroup: "coordination", agentId: role, workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`,
    provider: "test", agentKind: "test", cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    session: { source: "test", kind: "id", value: `session-${role}` },
    transportState: "idle", boundAt: new Date().toISOString()
  }));
  async getManifest() { return { ok: true as const, value: { schemaVersion: 2 as const, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp", herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up" as const,
    conversationSessionId: "session-1", activeRunIds: [], panes: this.bindings, attachTarget: { role: "conversation" as const, paneId: "pane-conversation" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }; }
  async getRoleBinding(selector: string) { return { ok: true as const, value: this.bindings.find(p => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector)) ?? null }; }
  async inspectRoleHealth(selector: string) { const p = unwrap(await this.getRoleBinding(selector)); if (!p) throw new Error("No pane"); return { ok: true as const, value: { readyForPrompt: true, occupantMatches: true, paneId: p.paneId, agentId: p.agentId } }; }
  async allocateDeveloper(): Promise<never> { throw new Error("Developer allocation is not part of prototype review scenarios"); }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
}

/** Real journal, Core engine, registry, ArtifactStore and P15/P16 policies; no gate is evaluated by these scenarios. */
async function fixture(options: { humanApproval?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-prototype-review-")));
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  await writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "prototype-review" }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(); const panes = new Panes();
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: {} });
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const checkIds = ["review", "regression"];
  const gates: QualityGate[] = checkIds.map(id => ({ id, evaluate: async () => { throw new Error("Quality gates are not evaluated by prototype scenarios"); } }));
  const checks = checkIds.map(id => ({ id, name: id, evaluator: id, required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" }, configuration: {} })) as any;
  const conversationInbox: unknown[] = [];
  const ports = { engine, runStore: store, artifactStore: artifacts, registry, transport, panes, policies: undefined as unknown as Awaited<ReturnType<typeof loadAgenticPolicies>>,
    deliverToConversation: async (message: unknown) => { conversationInbox.push(message); },
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination", "repository.read"], conversation: ["conversation"], specifier: ["specification", "repository.read"],
      architect: ["architecture", "repository.read"], planner: ["planning", "repository.read"], reviewer: ["review"], qa: ["qa"], tester: ["testing"] },
    taskChecks: checks, workflowChecks: checks,
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async () => true, authenticateGateResult: async () => true,
    authorizeHuman: async (decision: { decidedBy: string }) => decision.decidedBy === "human-1",
    projectApprovalRequired: () => options.humanApproval === true };
  ports.policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates,
    loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
  let runtime: AgenticWorkflowRuntime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: repository });

  const spec: Specification = draft("documentation");
  const time = new Date().toISOString(); spec.createdAt = time; spec.updatedAt = time;
  spec.affectedPaths = ["guide.md"];
  spec.traceabilityTaskIds = ["implement"];
  (spec.metadata!.sdd as any).traceability[0].taskIds = spec.traceabilityTaskIds;
  spec.metadata!.conditionalTdd = { policyVersion: 1, taskId: "implement", taskType: "documentation",
    changeImpact: { surfaces: ["documentation"], behaviorChanged: false, deterministic: false, regressionReproducible: false, securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [{ method: "integration_test", command: "test-regression", level: "integration" }] },
    testability: { level: "automated", rationale: "Independent repeatable behavioral checks are available" }, riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } };
  delete spec.testStrategy; delete spec.tddDecision;
  const def = workflow(spec.traceabilityTaskIds); def.maxConcurrency = 1;
  def.tasks.forEach(task => { (task as any).metadata = { ownedPaths: ["guide.md"] }; });

  const request = (revision: number, criterionText?: string) => {
    const id = revision === 1 ? "intake-1" : `change-${revision}`;
    const criteria = criterionText === undefined ? spec.acceptanceCriteria : spec.acceptanceCriteria.map(criterion => ({ ...criterion, description: criterionText }));
    return { schemaVersion: 2, delegationId: `delegation-${id}`, messageId: id, correlationId: "correlation-1", sessionId: "session-1", runId: "run-1",
      requestedBy: "conversation", targetRole: "coordinator", title: spec.title, objective: spec.summary, specificationId: spec.specId, sddLevel: spec.level,
      acceptanceCriteria: criteria, inputArtifacts: [], priority: "normal", requestedAt: time, idempotencyKey: id, metadata: { revision, isRequirementChange: revision > 1 } };
  };
  const handoff = (payload: Record<string, unknown>) => RoleMessageSchema.parse({ schema_version: 2, message_id: String(payload.messageId),
    correlation_id: "correlation-1", run_id: "run-1", sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
    recipient: { role: "coordinator" }, type: "delegation.request", payload, artifact_references: [], occurred_at: time, idempotency_key: String(payload.idempotencyKey) });
  const decision = (approval: { approvalId: string; target: unknown; revision: number; generation: number }, outcome: "approved" | "rejected" | "changes_requested",
    id: string, extra: Record<string, unknown> = {}) => RoleMessageSchema.parse({
    schema_version: 2, message_id: id, correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" }, type: "approval.decision",
    payload: ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: approval.approvalId, runId: "run-1", sessionId: "session-1", target: approval.target,
      revision: approval.revision, generation: approval.generation, decision: outcome, decidedBy: "human-1", decidedAt: new Date().toISOString(),
      ...(outcome === "approved" ? {} : { reason: "Luồng thanh toán cần thêm bước xác nhận" }), feedbackArtifacts: [], idempotencyKey: `decision-${id}`, ...extra }),
    artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: `decision-${id}` });
  const state = async () => await runtime.inspect() as any;
  const run = async () => (await state()).runs.find((item: any) => item.runId === "run-1");
  const approvalRequests = async () => (await state()).outbound.filter((out: any) => out.message.type === "approval.request" && out.message.recipient.role === "conversation");
  const notices = async () => (await state()).outbound.filter((out: any) => out.message.recipient.role === "conversation").map((out: any) => out.message.payload);
  const open = async () => { const message = handoff(request(1)); await runtime.queueHerdr(message); await runtime.receiveHerdr(message); };
  return { root, repository, artifacts, get runtime() { return runtime; }, ports, transport, spec, def, request, handoff, decision, state, run, approvalRequests, notices, open, conversationInbox,
    restart: () => { runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: repository }); return runtime; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const scope = (overrides: Record<string, unknown> = {}) => ({
  purpose: "Chứng minh luồng checkout hai bước trước khi chốt thiết kế chi tiết",
  flows: [{ id: "cart", description: "Xem giỏ hàng" }, { id: "pay", description: "Thanh toán bằng dữ liệu giả" }],
  allowedPaths: ["prototype/checkout"],
  artifacts: ["Clickable HTML mock của giỏ hàng và thanh toán"],
  criteria: [{ id: "proto-cart", description: "Người duyệt thấy rõ tổng tiền", flowIds: ["cart"] },
    { id: "proto-pay", description: "Bước xác nhận thanh toán dễ hiểu", flowIds: ["pay"] }],
  disposition: "throwaway", environment: "mock", dataPolicy: "synthetic", maxRevisions: 3, ...overrides
});
const files = (pay = "<button>Pay</button>", cart = "<p>Total: 10</p>") => [
  { path: "prototype/checkout/cart.html", mediaType: "text/html", content: cart, flowIds: ["cart"] },
  { path: "prototype/checkout/pay.html", mediaType: "text/html", content: pay, flowIds: ["pay"] }
];
const submission = (scopeVersion = 1, pay?: string, cart?: string) => ({ scopeVersion, summary: "Mock checkout", files: files(pay, cart) });
async function pending(f: Fixture) {
  const prototype = (await f.run()).prototype;
  return prototype.approvals.filter((entry: any) => entry.status === "pending").map((entry: any) => entry.request);
}
async function decide(f: Fixture, message: ReturnType<Fixture["decision"]>) {
  await f.runtime.queueHerdr(message);
  return f.runtime.receiveHerdr(message);
}

describe("workflow without prototype", () => {
  it("keeps the existing design approval path and records no prototype state", async () => {
    const f = await fixture({ humanApproval: true }); await f.open();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const run = await f.run();
    expect(run).toMatchObject({ status: "awaiting_approval", approvalKind: "design", approval: { status: "pending" } });
    expect(run.prototype).toBeUndefined();
    expect(run.approval.metadata.prototype).toBeUndefined();
  });

  it("refuses retained prototype code when the run has no prototype", async () => {
    const f = await fixture(); await f.open();
    const def = { ...f.def, tasks: f.def.tasks.map(task => ({ ...task, metadata: { ...(task as any).metadata, retainsPrototype: true } })) };
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, def)).rejects.toThrow(/accepted evolvable prototype/);
  });
});

describe("accepted prototype scope", () => {
  it("accepts a lightweight mock-only scope idempotently and gates the formal design until the prototype is accepted", async () => {
    const f = await fixture(); await f.open();
    const accepted = await f.runtime.proposePrototype("run-1", scope()) as any;
    expect(accepted).toMatchObject({ status: "awaiting_artifact", scopeVersion: 1, disposition: "throwaway" });
    await f.runtime.proposePrototype("run-1", scope());
    expect((await f.run()).prototype.scopes).toHaveLength(1);
    expect((await f.run()).status).toBe("specifying");
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, f.def)).rejects.toThrow(/prototype .*accepted/i);
    expect((await f.run()).definition).toBeUndefined();
  });

  it.each([
    ["a path outside the prototype area", scope({ allowedPaths: ["src/checkout"] })],
    ["a parent traversal", scope({ allowedPaths: ["prototype/../src"] })],
    ["a deploy environment", scope({ environment: "staging" })],
    ["production data", scope({ dataPolicy: "production" })],
    ["an undeclared side effect", scope({ deploy: true })],
    ["a criterion for an unknown flow", scope({ criteria: [{ id: "proto-x", description: "x", flowIds: ["missing"] }] })],
    ["a flow without criterion", scope({ criteria: [{ id: "proto-cart", description: "x", flowIds: ["cart"] }] })]
  ])("refuses %s", async (_name, input) => {
    const f = await fixture(); await f.open();
    await expect(f.runtime.proposePrototype("run-1", input)).rejects.toThrow();
    expect((await f.run()).prototype).toBeUndefined();
  });

  it("refuses prototype criteria that reuse the delegated product acceptance criteria", async () => {
    const f = await fixture(); await f.open();
    const productId = f.spec.acceptanceCriteria[0]!.id;
    await expect(f.runtime.proposePrototype("run-1", scope({ criteria: [{ id: productId, description: "x", flowIds: ["cart", "pay"] }] })))
      .rejects.toThrow(/product acceptance criteria/i);
  });
});

describe("prototype artifact review through Conversation decisions", () => {
  it("runs several revision rounds, refuses stale approvals and keeps prototype, design and delivery approvals separate", async () => {
    const f = await fixture({ humanApproval: true }); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    expect(first).toMatchObject({ target: { type: "task", taskId: "prototype" }, revision: 1, generation: 1,
      metadata: { kind: "prototype_review", prototypeVersion: 1, reviewFlows: ["cart", "pay"], carriedFlows: [], disposition: "throwaway",
        approves: "prototype_only", provesAcceptanceCriteria: false } });
    expect(first.approvalId).toMatch(/^prototype-/);
    expect(first.evidence).toHaveLength(3);
    expect(await f.approvalRequests()).toHaveLength(1);
    expect((await f.run()).status).toBe("awaiting_approval");

    // Round 1: changes requested. Feedback becomes a prototype revision request, never an edit of accepted requirements.
    await decide(f, f.decision(first, "changes_requested", "d-1"));
    let run = await f.run();
    expect(run.prototype).toMatchObject({ status: "revision_requested", revisionsRequested: 1,
      feedback: [{ approvalId: first.approvalId, version: 1, kind: "prototype_revision", reason: "Luồng thanh toán cần thêm bước xác nhận" }] });
    expect(run).toMatchObject({ status: "specifying", delegation: { acceptanceCriteria: f.spec.acceptanceCriteria } });
    expect(run.approval).toBeUndefined(); expect(run.decision).toBeUndefined();
    await expect(decide(f, f.decision(first, "approved", "d-1b"))).rejects.toThrow(/no longer pending|changes_requested/i);
    await expect(f.runtime.submitPrototype("run-1", submission())).rejects.toThrow(/already reviewed/i);

    // Round 2: a new version is pending; a v2 replacement makes it stale before anyone answers.
    await f.runtime.submitPrototype("run-1", submission(1, "<button>Confirm</button><button>Pay</button>"));
    const [second] = await pending(f);
    // Nothing was approved in round 1, so the whole new version is under review.
    expect(second).toMatchObject({ revision: 2, metadata: { reviewFlows: ["cart", "pay"], carriedFlows: [] } });
    await f.runtime.submitPrototype("run-1", submission(1, "<button>Xác nhận</button><button>Pay</button>"));
    const [third] = await pending(f);
    expect(third.revision).toBe(3);
    expect((await f.run()).prototype.approvals.find((entry: any) => entry.request.approvalId === second.approvalId))
      .toMatchObject({ status: "superseded", closedReason: expect.stringMatching(/v3/) });
    await expect(f.runtime.queueHerdr(f.decision(second, "approved", "d-2"))).rejects.toThrow(/superseded/i);
    expect(await f.notices()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "approval_superseded", approvalIds: [second.approvalId] })]));

    // A design-shaped decision using the prototype id cannot satisfy the prototype: the target/revision must match exactly.
    await expect(decide(f, f.decision({ ...third, target: { type: "run" } }, "approved", "d-3x"))).rejects.toThrow(/mismatched/i);
    await decide(f, f.decision(third, "approved", "d-3"));
    run = await f.run();
    expect(run.prototype.status).toBe("accepted");
    expect(run.prototype.acceptance).toMatchObject({ approvalId: third.approvalId, version: 3, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeVersion: 1, decidedBy: "human-1", decidedAt: expect.any(String), approvedFlows: ["cart", "pay"], disposition: "throwaway",
      retentionAuthorized: false, provesAcceptanceCriteria: false });
    // Accepting the prototype is not design approval, delivery acceptance or evidence that product criteria passed.
    expect(run).toMatchObject({ status: "planning", coreCreated: false, tasks: [] });
    expect(run.approval).toBeUndefined(); expect(run.approvalKind).toBeUndefined(); expect(run.decision).toBeUndefined();

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    run = await f.run();
    expect(run).toMatchObject({ status: "awaiting_approval", approvalKind: "design", approval: { status: "pending",
      metadata: { prototype: { approvalId: third.approvalId, version: 3, manifestDigest: run.prototype.acceptance.manifestDigest, inputOnly: true } } } });
    expect(run.approval.approvalId).not.toBe(third.approvalId);
    // The already-used prototype decision can never be replayed as the design decision.
    await expect(decide(f, f.decision(third, "approved", "d-3"))).rejects.toThrow();
    expect((await f.run()).decision).toBeUndefined();
    await expect(f.runtime.submitPrototype("run-1", submission(1, "<button>late</button>"))).rejects.toThrow(/formal design/i);
    await decide(f, f.decision(run.approval, "approved", "d-design"));
    expect(await f.run()).toMatchObject({ status: "implementing", decision: { approvalId: run.approval.approvalId } });
  });

  it("reassesses an accepted prototype when its artifact changes: unchanged flows keep their approval, changed flows need review", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    await decide(f, f.decision(first, "approved", "d-1"));
    // Identical content is the same artifact: the approval still applies and nothing is re-requested.
    await f.runtime.submitPrototype("run-1", { ...submission(), summary: "Retry with another summary" });
    expect((await f.run()).prototype).toMatchObject({ status: "accepted", versions: [expect.objectContaining({ version: 1 })] });
    expect(await f.approvalRequests()).toHaveLength(1);
    await f.runtime.submitPrototype("run-1", submission(1, "<button>Pay now</button>"));
    const run = await f.run();
    expect(run.prototype.status).toBe("awaiting_review");
    expect(run.prototype.acceptance).toBeUndefined();
    expect(run.prototype.approvedFlows).toMatchObject({ cart: { approvalId: first.approvalId } });
    expect(run.prototype.approvedFlows.pay).toBeUndefined();
    const [second] = await pending(f);
    expect(second.metadata).toMatchObject({ reviewFlows: ["pay"], carriedFlows: ["cart"] });
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, f.def)).rejects.toThrow(/prototype .*accepted/i);
  });

  it("supersedes every prototype approval when the accepted scope is revised and refuses its late decision", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    await f.runtime.proposePrototype("run-1", scope({ purpose: "Chứng minh checkout một bước", disposition: "evolvable" }));
    const run = await f.run();
    expect(run.prototype).toMatchObject({ status: "awaiting_artifact", approvedFlows: {} });
    expect(run.prototype.scopes.map((item: any) => item.version)).toEqual([1, 2]);
    expect(run.prototype.approvals[0]).toMatchObject({ status: "superseded", closedReason: expect.stringMatching(/scope/i) });
    await expect(f.runtime.queueHerdr(f.decision(first, "approved", "late"))).rejects.toThrow(/superseded/i);
    await expect(f.runtime.submitPrototype("run-1", submission(1))).rejects.toThrow(/accepted scope is v2/i);
  });

  it("escalates after the bounded number of revision requests instead of looping", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope({ maxRevisions: 1 }));
    await f.runtime.submitPrototype("run-1", submission());
    await decide(f, f.decision((await pending(f))[0], "changes_requested", "d-1"));
    await f.runtime.submitPrototype("run-1", submission(1, "<button>v2</button>"));
    await decide(f, f.decision((await pending(f))[0], "changes_requested", "d-2"));
    expect(await f.run()).toMatchObject({ status: "escalated", prototype: { status: "escalated", revisionsRequested: 2 } });
    await expect(f.runtime.submitPrototype("run-1", submission(1, "<button>v3</button>"))).rejects.toThrow();
  });

  it("records a rejection as a refused prototype without design approval", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    await decide(f, f.decision((await pending(f))[0], "rejected", "d-1"));
    expect(await f.run()).toMatchObject({ status: "failed", prototype: { status: "rejected" } });
    expect((await f.run()).decision).toBeUndefined();
  });

  it("cancellation closes the pending prototype approval and refuses a late answer", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    await f.runtime.cancel("run-1", "Người dùng hủy");
    const run = await f.run();
    expect(run.prototype).toMatchObject({ status: "cancelled", approvals: [expect.objectContaining({ status: "cancelled" })] });
    expect(await f.runtime.pendingApprovals({ sessionId: "session-1" })).toEqual([]);
    await expect(f.runtime.queueHerdr(f.decision(first, "approved", "late"))).rejects.toThrow(/cancelled/i);
  });

  it("a requirement revision supersedes the prototype and its pending approval", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    const revised = f.handoff(f.request(2, "Revised criterion"));
    await f.runtime.queueHerdr(revised);
    const run = await f.run();
    expect(run.prototype.status).toBe("superseded");
    expect(run.supersededApprovals).toEqual(expect.arrayContaining([{ approvalId: first.approvalId, supersededByRevision: 2 }]));
    await expect(f.runtime.queueHerdr(f.decision(first, "approved", "late"))).rejects.toThrow(/superseded/i);
    // A new prototype scope may be proposed for the revised requirement.
    await f.runtime.receiveHerdr(revised);
    await f.runtime.proposePrototype("run-1", scope());
    expect((await f.run()).prototype).toMatchObject({ status: "awaiting_artifact", requirementRevision: 2 });
  });

  it("does not let a prototype of a superseded requirement block or feed the revised formal design", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope({ disposition: "evolvable" }));
    await f.runtime.submitPrototype("run-1", submission());
    await decide(f, f.decision((await pending(f))[0], "approved", "d-1"));
    const revised = f.handoff(f.request(2, "Revised criterion"));
    await f.runtime.queueHerdr(revised); await f.runtime.receiveHerdr(revised);
    expect((await f.run()).prototype).toMatchObject({ status: "superseded" });
    expect((await f.run()).prototype.acceptance).toBeUndefined();
    const draft = { ...f.spec, acceptanceCriteria: f.spec.acceptanceCriteria.map(criterion => ({ ...criterion, description: "Revised criterion" })) };
    const retaining = { ...f.def, tasks: f.def.tasks.map(task => ({ ...task, metadata: { ...(task as any).metadata, retainsPrototype: true } })) };
    await expect(f.runtime.proposeWorkflow("run-1", draft, retaining)).rejects.toThrow(/accepted evolvable prototype/);
    await f.runtime.proposeWorkflow("run-1", draft, f.def);
    expect((await f.run()).approval.metadata.prototype).toBeUndefined();
  });
});

describe("restart and retry keep one waiting approval", () => {
  it("does not re-request approval after restart or an identical retry, and accepts the decision afterwards", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    await f.runtime.flushOutbound();
    const restarted = f.restart();
    await restarted.initialize();
    await restarted.proposePrototype("run-1", scope());
    await restarted.submitPrototype("run-1", submission());
    await restarted.tick(); await restarted.flushOutbound();
    expect(await f.approvalRequests()).toHaveLength(1);
    expect(f.conversationInbox.filter((message: any) => message.type === "approval.request")).toHaveLength(1);
    const waiting = await restarted.pendingApprovals({ sessionId: "session-1" });
    expect(waiting).toHaveLength(1);
    expect(await f.run()).toMatchObject({ status: "awaiting_approval", prototype: { status: "awaiting_review" } });
    await decide(f, f.decision(waiting[0]!.request, "approved", "after-restart"));
    expect((await f.run()).prototype.status).toBe("accepted");
  });
});

describe("valid prototype content", () => {
  it("accepts SVG/XHTML namespace identifiers and loopback mock endpoints", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    const svg = '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><text>Total</text></svg>';
    await f.runtime.submitPrototype("run-1", { scopeVersion: 1, summary: "svg", files: [
      { path: "prototype/checkout/cart.svg", mediaType: "image/svg+xml", content: svg, flowIds: ["cart"] },
      { path: "prototype/checkout/pay.html", mediaType: "text/html", flowIds: ["pay"],
        content: '<html xmlns="http://www.w3.org/1999/xhtml"><form action="http://[::1]:3000/pay"></form><a href="http://127.0.0.2:8080/">x</a><a href="http://0.0.0.0:5173">y</a></html>' }] });
    expect((await f.run()).prototype.status).toBe("awaiting_review");
  });

  it("accepts placeholder and plain-word values next to credential-like labels", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission(1, [
      "<table><tr><td>Authorization:</td><td>Pending</td></tr></table><p>Authorization: Pending</p>",
      "<pre>Authorization: Bearer <token></pre><a href=\"/api?token={{token}}\">x</a>",
      '<script>const mock = {"password": "********", "api_key": "YOUR_API_KEY", "token": "Đang chờ"}</script>',
      '<input type="password" placeholder="Mật khẩu"><span data-secret="Hidden">Password: ••••••</span>',
      "<script>fetch('/mock', { headers: { Authorization: `Bearer ${token}` } })</script><p>Gói Basic 50 người dùng</p>"].join("")));
    expect((await f.run()).prototype.status).toBe("awaiting_review");
  });

  it("still rejects a real host hidden in a namespace-looking attribute value elsewhere", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await expect(f.runtime.submitPrototype("run-1", submission(1, '<img src="http://www.w3.org/logo.png">'))).rejects.toThrow(/external endpoint/);
    await expect(f.runtime.submitPrototype("run-1", submission(1, '<!DOCTYPE x [<!ENTITY e SYSTEM "http://payments.acme-bank.com/x">]><x>&e;</x>')))
      .rejects.toThrow(/external endpoint/);
  });
});

describe("bounded prototype history", () => {
  it("refuses more scope revisions than the bound with an explicit error", async () => {
    const f = await fixture(); await f.open();
    for (let i = 1; i <= 20; i++) await f.runtime.proposePrototype("run-1", scope({ purpose: `Mục đích ${i}` }));
    await expect(f.runtime.proposePrototype("run-1", scope({ purpose: "Mục đích 21" }))).rejects.toThrow(/scope revision limit/i);
    expect((await f.run()).prototype.scopes).toHaveLength(20);
  });
});

describe("faulty prototype artifacts", () => {
  it.each([
    ["a file outside the allowed area", { scopeVersion: 1, summary: "x", files: [...files(), { path: "src/app.ts", mediaType: "text/plain", content: "x", flowIds: ["cart"] }] }],
    ["an unknown flow", { scopeVersion: 1, summary: "x", files: [{ ...files()[0]!, flowIds: ["refund"] }, files()[1]] }],
    ["a flow without artifact", { scopeVersion: 1, summary: "x", files: [files()[0]] }],
    ["credential-like content", submission(1, "<script>const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'</script>")],
    ["a bearer JWT", submission(1, "<pre>Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U</pre>")],
    ["a JSON password", submission(1, '<script>const user = {"password": "hunter2"}</script>')],
    ["an API key assignment", submission(1, '<a href="/api?api_key=8f3a9c2e7b1d4a60">x</a>')],
    ["a private key", submission(1, "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----")],
    ["URL credentials", submission(1, '<a href="http://admin:s3cret@localhost:3000/">x</a>')],
    ["a letters-only Basic credential", submission(1, "<pre>Authorization: Basic dXNlcjpwYXNz</pre>")],
    ["a real external endpoint", submission(1, "<form action=\"https://payments.acme-bank.com/charge\"></form>")]
  ])("rejects %s without requesting approval", async (_name, input) => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await expect(f.runtime.submitPrototype("run-1", input)).rejects.toThrow();
    expect((await f.run()).prototype).toMatchObject({ status: "awaiting_artifact", versions: [], approvals: [] });
    expect(await f.approvalRequests()).toHaveLength(0);
  });

  it("refuses approval when the stored prototype artifact no longer matches its digest", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    const original = f.artifacts.get.bind(f.artifacts);
    (f.artifacts as any).get = async function* () { yield { ok: true, value: new TextEncoder().encode("tampered") }; };
    await expect(decide(f, f.decision(first, "approved", "d-1"))).rejects.toThrow(/integrity|mismatch/i);
    (f.artifacts as any).get = original;
    expect((await f.run()).prototype).toMatchObject({ status: "awaiting_review", approvals: [expect.objectContaining({ status: "pending" })] });
  });
});

describe("retaining prototype code", () => {
  const retaining = (f: Fixture) => ({ ...f.def, tasks: f.def.tasks.map(task => ({ ...task, metadata: { ...(task as any).metadata, retainsPrototype: true } })) });
  async function accepted(disposition: "throwaway" | "evolvable") {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope({ disposition }));
    await f.runtime.submitPrototype("run-1", submission());
    await decide(f, f.decision((await pending(f))[0], "approved", "d-1"));
    return f;
  }
  it("refuses to retain throwaway prototype code in the formal design", async () => {
    const f = await accepted("throwaway");
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, retaining(f))).rejects.toThrow(/throwaway/i);
  });
  it("allows an approved evolvable prototype to be retained only under full verification", async () => {
    const f = await accepted("evolvable");
    expect((await f.run()).prototype.acceptance).toMatchObject({ disposition: "evolvable", retentionAuthorized: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, retaining(f));
    const run = await f.run();
    expect(run.approval.metadata.prototype).toMatchObject({ disposition: "evolvable", retainedByTasks: ["implement"] });
    expect(run.fastPath.status).not.toBe("active");
  });
});

describe("Conversation and Coordinator entry points", () => {
  it("routes a trusted Conversation reply to the pending prototype approval", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    await f.runtime.flushOutbound();
    const manifest = unwrap(await f.ports.panes.getManifest());
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory: join(f.root, "conversation") });
    for (const message of f.conversationInbox) await chat.receiveRuntime(message);
    const [first] = await pending(f);
    const result = await chat.handleTrustedApproval({ sessionId: "session-1", messageId: "reply-1", content: `${first.approvalId}: approve`,
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" } }) as any;
    expect(result?.value?.approvalDecision).toMatchObject({ approvalId: first.approvalId, decision: "approved" });
    const queued = (await f.state()).outbound.find((out: any) => out.message.type === "approval.decision").message;
    await f.runtime.receiveHerdr(queued);
    expect((await f.run()).prototype.status).toBe("accepted");
  });

  const trustedReply = (chat: Awaited<ReturnType<typeof createAgenticConversationHost>>, messageId: string, content: string) => chat.handleTrustedApproval({
    sessionId: "session-1", messageId, content,
    provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" } }) as Promise<any>;
  async function chatFor(f: Fixture) {
    await f.runtime.flushOutbound();
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.ports.panes.getManifest()), contextDirectory: join(f.root, "conversation") });
    for (const message of f.conversationInbox.splice(0)) await chat.receiveRuntime(message);
    return chat;
  }
  const lastDecision = async (f: Fixture) => [...(await f.state()).outbound].reverse().find((out: any) => out.message.type === "approval.decision").message;

  it("renders a prototype-only card and maps \"cần sửa\" to a revision request and \"2 <lý do>\" to a final rejection", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    await f.runtime.flushOutbound();
    const request = (await f.approvalRequests())[0].message;
    const card = renderConversationNotice({ messageId: request.message_id, type: "approval.request", senderRole: "coordinator", runId: "run-1",
      correlationId: "correlation-1", receivedAt: request.occurred_at, runLabel: "Việc #1", summary: JSON.stringify(request.payload), truncated: false, shortId: "#1" });
    expect(card).toMatchObject({ kind: "approval", approvalId: request.payload.approvalId });
    expect(card.display).toContain("🔔 Cần bạn duyệt prototype · #1");
    expect(card.display).toContain("KHÔNG phải duyệt thiết kế chi tiết hay nghiệm thu sản phẩm");
    expect(card.display).toContain("Luồng cần xem: cart, pay");
    expect(card.display).toContain('"#1: cần sửa <góp ý>" để yêu cầu sửa prototype');
    expect(card.display).toContain('"#1: từ chối vì <lý do>" (hoặc "#1: 2 <lý do>") để từ chối hẳn');
    expect(card.display).toContain('"hủy việc #1" để hủy công việc');
    expect(card.display).toContain('"#1: đổi yêu cầu <nội dung>" nếu góp ý cần đổi yêu cầu đã chấp nhận');

    let chat = await chatFor(f);
    let result = await trustedReply(chat, "reply-1", `${request.payload.approvalId}: cần sửa thêm bước xác nhận`);
    expect(result?.value?.approvalDecision).toMatchObject({ approvalId: request.payload.approvalId, decision: "changes_requested" });
    await f.runtime.receiveHerdr(await lastDecision(f));
    expect(await f.run()).toMatchObject({ status: "specifying", prototype: { status: "revision_requested",
      feedback: [expect.objectContaining({ kind: "prototype_revision", reason: expect.stringContaining("bước xác nhận") })] } });

    await f.runtime.submitPrototype("run-1", submission(1, "<button>Xác nhận</button>"));
    const [second] = await pending(f);
    chat = await chatFor(f);
    result = await trustedReply(chat, "reply-2", `${second.approvalId}: 2 hướng này không phù hợp`);
    expect(result?.value?.approvalDecision).toMatchObject({ approvalId: second.approvalId, decision: "rejected" });
    await f.runtime.receiveHerdr(await lastDecision(f));
    expect(await f.run()).toMatchObject({ status: "failed", prototype: { status: "rejected" } });
  });

  it("records \"đổi yêu cầu\" as a specification revision proposal without editing accepted requirements", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    const before = await f.run();
    const chat = await chatFor(f);
    const result = await trustedReply(chat, "reply-1", `${first.approvalId}: đổi yêu cầu, cho phép trả góp 3 kỳ`);
    expect(result?.value?.approvalDecision).toMatchObject({ approvalId: first.approvalId, decision: "changes_requested",
      metadata: { feedbackKind: "specification_revision" } });
    await f.runtime.receiveHerdr(await lastDecision(f));
    const run = await f.run();
    expect(run).toMatchObject({ status: "specifying", prototype: { status: "revision_requested", requirementRevision: before.prototype.requirementRevision,
      feedback: [expect.objectContaining({ kind: "specification_revision_proposal", reason: expect.stringContaining("trả góp 3 kỳ") })] } });
    expect(run.delegation).toEqual(before.delegation);
    const outbound = (await f.state()).outbound.map((out: any) => out.message);
    const wake = outbound.find((message: any) => message.recipient.role === "coordinator" && message.payload.kind === "prototype_specification_revision_proposed");
    expect(wake.payload).toMatchObject({ approvalId: first.approvalId, feedback: expect.stringContaining("trả góp 3 kỳ") });
    expect(wake.payload.next).toMatch(/requirement revision/);
    expect(outbound.some((message: any) => message.recipient.role === "conversation" &&
      String(message.payload.headline).includes("đề xuất đổi yêu cầu"))).toBe(true);
  });

  it("cancels the run through the Conversation cancellation control and closes the waiting prototype approval", async () => {
    const f = await fixture(); await f.open();
    await f.runtime.proposePrototype("run-1", scope());
    await f.runtime.submitPrototype("run-1", submission());
    const [first] = await pending(f);
    const at = new Date().toISOString();
    await f.runtime.queueHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "cancel-control-1", correlation_id: "cancel-correlation-1",
      run_id: "run-1", sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
      recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" }, type: "delegation.request",
      payload: { schemaVersion: 2, delegationId: "cancel-delegation-1", messageId: "cancel-control-1", correlationId: "cancel-correlation-1", sessionId: "session-1",
        runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Cancel existing run", objective: "User requested cancellation",
        specificationId: "cancel-spec", sddLevel: "lightweight", acceptanceCriteria: [{ id: "ac-cancel", description: "Cancel", category: "functional",
          verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "critical",
        requestedAt: at, idempotencyKey: "cancel-control-1", metadata: { action: "cancel", targetRunId: "run-1", cancellationRequest: { schemaVersion: 1,
          cancellationId: "cancel-1", runId: "run-1", requestedBy: "conversation", requestedAt: at, expectedVersion: 1, reason: "User requested cancellation",
          idempotencyKey: "cancel-control-1" } } },
      artifact_references: [], occurred_at: at, idempotency_key: "cancel-control-1" }));
    expect(await f.run()).toMatchObject({ cancelled: true, prototype: { status: "cancelled", approvals: [expect.objectContaining({ status: "cancelled" })] } });
    expect((await f.approvalRequests())[0].status).toBe("cancelled");
    await expect(f.runtime.queueHerdr(f.decision(first, "approved", "late"))).rejects.toThrow(/cancelled/i);
  });

  it("exposes propose_prototype and submit_prototype as Coordinator tools", async () => {
    const f = await fixture(); await f.open();
    const tools = new CoordinatorTools(f.runtime);
    await tools.invoke("propose_prototype", { runId: "run-1", scope: scope() }, { role: "coordinator" });
    await tools.invoke("submit_prototype", { runId: "run-1", submission: submission() }, { role: "coordinator" });
    expect((await f.run()).prototype.status).toBe("awaiting_review");
    await expect(tools.invoke("submit_prototype", { runId: "run-1", submission: submission() }, { role: "developer" })).rejects.toThrow(/Only Coordinator/);
  });
});
