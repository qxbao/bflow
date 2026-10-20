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
import { AdmissionRejectedError, AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type PanePolicy } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

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
  async allocateDeveloper(): Promise<never> { throw new Error("Developer allocation is not part of requirement-change scenarios"); }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
}

/** Real journal, engine, registry and policies. Quality gates are registered for policy loading only; no scenario here evaluates them. */
async function fixture(options: { humanApproval?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-requirement-change-")));
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "requirement-change" }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(); const panes = new Panes();
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: {} });
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const checkIds = ["review", "regression"];
  const gates: QualityGate[] = checkIds.map(id => ({ id, evaluate: async () => { throw new Error("Quality gates are not evaluated by requirement-change scenarios"); } }));
  const checks = checkIds.map(id => ({ id, name: id, evaluator: id, required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" }, configuration: {} })) as any;
  const conversationInbox: unknown[] = [];
  const ports = { engine, runStore: store, artifactStore: artifacts, registry, transport, panes, policies: undefined as unknown as Awaited<ReturnType<typeof loadAgenticPolicies>>,
    deliverToConversation: async (message: unknown) => { conversationInbox.push(message); },
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination"], conversation: ["conversation"], specifier: ["specification"], architect: ["architecture"], planner: ["planning"], reviewer: ["review"], qa: ["verification"], tester: ["testing"] },
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

  /** Conversation's DelegationRequest for one revision. Revision 1 opens the run with the spec's own criteria; later revisions change them. */
  const request = (revision: number, criterionText: string, overrides: Record<string, unknown> = {}) => {
    const id = revision === 1 ? "intake-1" : `change-${revision}`;
    const criteria = revision === 1 ? spec.acceptanceCriteria : spec.acceptanceCriteria.map(criterion => ({ ...criterion, description: criterionText }));
    return { schemaVersion: 2, delegationId: `delegation-${id}`, messageId: id, correlationId: "correlation-1", sessionId: "session-1", runId: "run-1",
      requestedBy: "conversation", targetRole: "coordinator", title: spec.title, objective: spec.summary, specificationId: spec.specId, sddLevel: spec.level,
      acceptanceCriteria: criteria, inputArtifacts: [], priority: "normal",
      requestedAt: time, idempotencyKey: id, metadata: { revision, isRequirementChange: revision > 1 }, ...overrides };
  };
  /** Conversation → Coordinator envelope, exactly as the Conversation bridge builds it. */
  const handoff = (payload: Record<string, unknown>, messageId = String(payload.messageId)) => RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
    correlation_id: "correlation-1", run_id: "run-1", sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
    recipient: { role: "coordinator" }, type: "delegation.request", payload: { ...payload, messageId }, artifact_references: [], occurred_at: time,
    idempotency_key: String(payload.idempotencyKey) });
  const decisionFor = (approval: { approvalId: string; target: unknown; revision: number; generation: number }, id: string) => RoleMessageSchema.parse({
    schema_version: 2, message_id: id, correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" }, type: "approval.decision",
    payload: ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: approval.approvalId, runId: "run-1", sessionId: "session-1", target: approval.target,
      revision: approval.revision, generation: approval.generation, decision: "approved", decidedBy: "human-1", decidedAt: new Date().toISOString(),
      feedbackArtifacts: [], idempotencyKey: `decision-${id}` }),
    artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: `decision-${id}` });
  const state = async () => await runtime.inspect() as any;
  const run = async () => (await state()).runs.find((item: any) => item.runId === "run-1");
  /** Conversation-bound notices, by payload kind (Runtime's own notice vocabulary). */
  const noticeKinds = async () => (await state()).outbound
    .filter((out: any) => out.message.recipient.role === "conversation").map((out: any) => out.message.payload.kind);
  return { root, repository, get runtime() { return runtime; }, ports, transport, spec, def, request, handoff, decisionFor, state, run, noticeKinds, conversationInbox,
    restart: () => { runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: repository }); return runtime; } };
}

/** Admits one Conversation handoff the way production does: queued through Runtime, then delivered to the Coordinator ingress. */
async function admit(f: Awaited<ReturnType<typeof fixture>>, message: ReturnType<typeof RoleMessageSchema.parse>) {
  await f.runtime.queueHerdr(message);
  return f.runtime.receiveHerdr(message);
}

describe("requirement change: revisions are admitted in order and persisted", () => {
  it("accepts rev1, then rev2 and rev3, keeps history, and sends later specialist work with the rev3 criteria", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    expect((await f.run()).delegation.metadata.revision).toBe(1);
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    await admit(f, f.handoff(f.request(3, "Rev3 criterion")));
    const current = await f.run();
    expect(current.delegation.metadata.revision).toBe(3);
    expect(current.delegation.acceptanceCriteria.map((c: any) => c.description)).toEqual(["Rev3 criterion"]);
    expect(current.delegationHistory.map((item: any) => item.metadata.revision)).toEqual([1, 2]);
    expect((await f.state()).outbound.filter((out: any) => out.message.type === "delegation.accepted").map((out: any) => out.message.idempotency_key)).toHaveLength(3);
    await f.runtime.requestSpecialist("run-1", "architect", "Review rev3 design", ["architecture"]);
    const specialist = (await f.state()).outbound.find((out: any) => out.message.type === "delegation.request" && out.message.recipient.role === "architect");
    expect(specialist.message.payload.acceptanceCriteria.map((c: any) => c.description)).toEqual(["Rev3 criterion"]);
    expect(specialist.message.payload.metadata.revision).toBe(3);
  });

  it("treats a re-delivered admitted revision as applied, without an 'already belongs' failure", async () => {
    const f = await fixture();
    const rev1 = f.handoff(f.request(1, "Rev1 criterion"));
    await admit(f, rev1);
    await expect(f.runtime.receiveHerdr(rev1)).resolves.toBeDefined();
    expect((await f.run()).delegation.metadata.revision).toBe(1);
  });
});

describe("requirement change: stale, duplicate and foreign revisions are rejected with a reason", () => {
  it("rejects a stale revision at queueing, without enqueuing it to the Coordinator", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    await admit(f, f.handoff(f.request(3, "Rev3 criterion")));
    const stale = f.handoff(f.request(2, "Late rev2 criterion", { idempotencyKey: "change-2-late" }), "change-2-late");
    await expect(f.runtime.queueHerdr(stale)).rejects.toThrow("Stale requirement revision 2 (current 3)");
    expect((await f.state()).outbound.some((out: any) => out.message.message_id === "change-2-late")).toBe(false);
  });

  it("answers a repeated admitted revision idempotently and never re-enqueues it", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    const rev2 = f.handoff(f.request(2, "Rev2 criterion"));
    await admit(f, rev2);
    const before = (await f.state()).outbound.length;
    await f.runtime.queueHerdr(rev2);
    await f.runtime.receiveHerdr(rev2);
    expect((await f.state()).outbound.length).toBe(before);
  });

  it("rejects a stale revision that reaches receipt, records it as rejected in the inbox, and notifies once", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    await admit(f, f.handoff(f.request(3, "Rev3 criterion")));
    const stale = f.handoff(f.request(2, "Late rev2 criterion", { idempotencyKey: "change-2-late" }), "change-2-late");
    await expect(f.runtime.receiveHerdr(stale)).rejects.toThrow(AdmissionRejectedError);
    await expect(f.runtime.receiveHerdr(stale)).rejects.toThrow("Stale requirement revision 2 (current 3)");
    expect((await f.run()).delegation.metadata.revision).toBe(3);
    expect((await f.noticeKinds()).filter((kind: string) => kind === "delegation_rejected")).toHaveLength(1);
  });

  it("rejects a revision that does not declare itself a requirement change", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    const plain = f.handoff(f.request(2, "Rev2 criterion", { metadata: { revision: 2, isRequirementChange: false }, idempotencyKey: "plain-2" }), "plain-2");
    await expect(f.runtime.queueHerdr(plain)).rejects.toThrow("only a requirement change may revise it");
  });
});

describe("requirement change: a rejected delegation never reaches the Coordinator and is reported once", () => {
  it("does not enqueue a revision for a cancelled run and emits exactly one rejection notice", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await f.runtime.cancel("run-1", "User requested cancellation");
    const rev2 = f.handoff(f.request(2, "Rev2 criterion"));
    await expect(f.runtime.queueHerdr(rev2)).rejects.toThrow("Run is cancelled");
    await expect(f.runtime.queueHerdr(rev2)).rejects.toThrow("Run is cancelled");
    expect((await f.state()).outbound.some((out: any) => out.message.message_id === "change-2" && out.message.recipient.role === "coordinator")).toBe(false);
    expect((await f.noticeKinds()).filter((kind: string) => kind === "delegation_rejected")).toHaveLength(1);
  });

  it("a rejection that is also reported through transport or dropped-inbound paths still yields one notice", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    await admit(f, f.handoff(f.request(3, "Rev3 criterion")));
    // Stale on a live run: the pane may already hold the text, so host reconciliation reports it too.
    const stale = f.handoff(f.request(2, "Late rev2 criterion", { idempotencyKey: "change-2-late" }), "change-2-late");
    await expect(f.runtime.receiveHerdr(stale)).rejects.toThrow(AdmissionRejectedError);
    await f.runtime.reportUncertainNativeDelivery(stale, "op-late", "Native delivery acknowledgement was not observed; the message was not resent and needs reconciliation");
    await f.runtime.reportInboundFailure(stale, "AdmissionRejectedError: Stale requirement revision 2 (current 3) (dropped after 5 attempts)");
    const kinds = await f.noticeKinds();
    expect(kinds.filter((kind: string) => kind === "delegation_rejected")).toHaveLength(1);
    expect(kinds).not.toContain("delivery_failure");
  });
});

describe("requirement change: superseded design approvals cannot be decided", () => {
  it("supersedes the pending rev1 design approval on rev2, rejects its decision, and emits one supersede notice", async () => {
    const f = await fixture({ humanApproval: true });
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const pending = (await f.run()).approval;
    expect(pending).toBeDefined();
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    const current = await f.run();
    expect(current.approval).toBeUndefined();
    expect(current.supersededApprovals).toEqual([{ approvalId: pending.approvalId, supersededByRevision: 2 }]);
    expect(current.status).toBe("intake");
    const supersedeNotices = (await f.state()).outbound.filter((out: any) => out.message.payload.kind === "approval_superseded");
    expect(supersedeNotices).toHaveLength(1);
    expect(supersedeNotices[0].message.payload.approvalIds).toEqual([pending.approvalId]);
    const decision = f.decisionFor(pending, "decision-rev1");
    await expect(f.runtime.queueHerdr(decision)).rejects.toThrow("Approval superseded by requirement revision 2");
    await expect(f.runtime.receiveHerdr(decision)).rejects.toThrow("Approval superseded by requirement revision 2");
  });
  it("gives the re-planned revision a new approval id and no repeated spec evidence", async () => {
    const f = await fixture({ humanApproval: true });
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const first = (await f.run()).approval;
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    const rev2Spec = { ...f.spec, acceptanceCriteria: f.spec.acceptanceCriteria.map(criterion => ({ ...criterion, description: "Rev2 criterion" })) };
    await f.runtime.proposeWorkflow("run-1", rev2Spec, f.def);
    const second = (await f.run()).approval;
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    // Every task covers all of the workflow's criteria here, so a per-task spec would only repeat the workflow spec.
    expect(second.evidence).toHaveLength(1);
  });
});

describe("requirement change: obsolete work is withdrawn, never recalled", () => {
  it("cancels an unsent specialist request built from the old criteria, and the next request carries the new ones", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    await f.runtime.requestSpecialist("run-1", "architect", "Review rev1 design", ["architecture"]);
    const queued = (await f.state()).outbound.find((out: any) => out.message.type === "delegation.request" && out.message.recipient.role === "architect");
    expect(queued.status).toBe("queued");
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    expect((await f.state()).outbound.find((out: any) => out.message.message_id === queued.message.message_id).status).toBe("cancelled");
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.some(request => request.instruction.includes(queued.message.message_id))).toBe(false);
    await f.runtime.requestSpecialist("run-1", "architect", "Review rev2 design", ["architecture"]);
    const next = (await f.state()).outbound.find((out: any) => out.message.type === "delegation.request" && out.message.recipient.role === "architect" &&
      out.message.payload.objective === "Review rev2 design");
    expect(next.message.payload.acceptanceCriteria.map((c: any) => c.description)).toEqual(["Rev2 criterion"]);
  });

  it("resumes an asker whose pending user decision is superseded, instead of leaving it waiting", async () => {
    const f = await fixture();
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    const coordinator = f.ports.panes.bindings.find(pane => pane.role === "coordinator")!;
    await f.runtime.requestUserDecision(coordinator, "coordinator", { runId: "run-1", taskId: "implement", question: "Which option?", options: ["A", "B"] });
    const [approvalId] = Object.keys((await f.run()).userDecisions);
    await admit(f, f.handoff(f.request(2, "Rev2 criterion")));
    expect((await f.run()).userDecisions[approvalId!].status).toBe("cancelled");
    const resumed = (await f.state()).outbound.find((out: any) => out.message.payload.kind === "user_decision_answer" && out.message.payload.approvalId === approvalId);
    expect(resumed).toMatchObject({ message: { recipient: { role: "coordinator" }, payload: { outcome: "cancelled" } } });
  });
});
