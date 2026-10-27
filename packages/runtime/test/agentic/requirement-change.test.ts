import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
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
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostConversationIntake } from "../../src/agentic/host-conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";

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
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination", "repository.read"], conversation: ["conversation"], specifier: ["specification", "repository.read"], architect: ["architecture", "repository.read"], planner: ["planning", "repository.read"], reviewer: ["review", "repository.read"], qa: ["verification", "repository.read"], tester: ["testing", "repository.read"] },
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

describe("trusted local revision admission", () => {
  it("binds revised criteria before Coordinator delivery without a synthetic inbound echo and retains the human gate after restart", async () => {
    const f = await fixture({ humanApproval: true });
    await f.runtime.queueHerdr(f.handoff(f.request(1, "Original criterion")));
    const revised = f.handoff(f.request(2, "Revised criterion"));
    await f.runtime.queueHerdr(revised);
    expect((await f.run()).delegation).toEqual(revised.payload);
    expect((await f.run()).delegationHistory).toHaveLength(1);
    f.restart();
    await f.runtime.queueHerdr(revised);
    expect((await f.run()).delegationHistory).toHaveLength(1);
    expect((await f.state()).inbox.some((entry: any) => entry.message.message_id === revised.message_id)).toBe(false);
    const draft = { ...f.spec, acceptanceCriteria: f.spec.acceptanceCriteria.map(criterion => ({ ...criterion, description: "Revised criterion" })) };
    await f.runtime.proposeWorkflow("run-1", draft, f.def);
    expect(await f.run()).toMatchObject({ status: "awaiting_approval", approvalKind: "design", approval: { status: "pending" } });
    expect(f.transport.sentRequests.some(request => request.role === "developer")).toBe(false);
  });

  it("reconciles an exact replay from an older queued-but-unbound revision without duplicate history or signed receipt", async () => {
    const f = await fixture();
    const initial = f.handoff(f.request(1, "Original criterion"));
    const revised = f.handoff(f.request(2, "Revised criterion"));
    await f.runtime.queueHerdr(initial);
    await f.runtime.queueHerdr(revised);
    // Historical state captured from the live failure: the outbox knows rev2,
    // while the run still binds rev1 and has no received transport echo.
    const path = join(f.root, "journal/state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.runs[0].delegation = initial.payload;
    delete state.runs[0].delegationHistory;
    await writeFile(path, JSON.stringify(state));
    f.restart();
    await f.runtime.queueHerdr(revised);
    await f.runtime.queueHerdr(revised);
    expect((await f.run()).delegation).toEqual(revised.payload);
    expect((await f.run()).delegationHistory).toEqual([initial.payload]);
    expect((await f.state()).inbox).toEqual([]);
  });
});

describe("raw scope correction through Conversation while an approval is pending", () => {
  it("routes the original Logs correction to Chat, admits one revision and supersedes the old question without approval", async () => {
    const f = await fixture();
    const manifest = unwrap(await f.ports.panes.getManifest());
    const binding = manifest.panes.find(pane => pane.role === "conversation")!;
    const coordinator = manifest.panes.find(pane => pane.role === "coordinator")!;
    let humanDecisions = 0;
    let chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory: join(f.root, "conversation"),
      onHumanDecision: async () => { humanDecisions++; } });
    const receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, manifest.sessionId);
    let intake = new HostConversationIntake(receipts, () => chat);
    const original = { messageId: "human-logs-initial", conversationSessionId: "session-1", userId: "human-1",
      content: "Pane Logs hiển thị realtime các bước workflow" };
    await intake.receive(binding, original);
    const initialDecision = { intent: "workflow_request", requirementDraft: { title: "Workflow Logs", objective: original.content,
      kind: "feature", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false,
      affectedPaths: [], acceptanceCriteriaDescriptions: ["Logs hiển thị realtime các bước từ Runtime, đúng thứ tự, không trùng"],
      isRequirementChange: false } };
    await intake.decide(binding, { decision: initialDecision });
    const initial = (await f.state()).outbound.find((out: any) => out.message.type === "delegation.request").message;
    const runId = initial.run_id, correlationId = initial.correlation_id;
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(initial);
    const receipt = await f.runtime.requestUserDecision(coordinator, "coordinator", { runId, taskId: "logs-flow",
      question: "Approve the realtime Logs design?", options: ["Approve design", "Request changes to the design"] }) as { approvalId: string };
    await f.runtime.flushOutbound();
    for (const message of f.conversationInbox) await chat.receiveRuntime(message);
    const correction = { ...original, messageId: "human-logs-correction",
      content: "2. Loại bỏ real time cũng được, tôi chỉ muốn pane logs in ra màn được các bước tổng quan trong màn logs thôi" };
    const received = await intake.receive(binding, correction);
    expect(received).toMatchObject({ messageId: correction.messageId, requiresConversationDecision: true,
      context: { pendingApprovals: { [receipt.approvalId]: { runId, status: "pending" } } } });
    expect(await receipts.conversationDecision(correction.messageId)).toBeUndefined();
    expect(humanDecisions).toBe(0);
    expect((await f.runtime.inspect(runId) as any).userDecisions[receipt.approvalId].status).toBe("pending");
    const decision = { intent: "workflow_request", targetRunId: runId, requirementDraft: {
      ...initialDecision.requirementDraft, objective: "Không cần realtime; chỉ in các bước tổng quan của flow trong Logs",
      acceptanceCriteriaDescriptions: ["Hiển thị các bước tổng quan từ Runtime theo thứ tự, không trùng; không yêu cầu realtime"],
      isRequirementChange: true } };
    await expect(intake.decide(binding, { decision: { ...decision, targetRunId: "run-foreign" } })).rejects.toThrow("existing unfinished workflow");
    await expect(intake.decide(binding, { decision: { intent: "approval_response", approvalInput: { decision: "approved" } } })).rejects.toThrow();
    expect(await receipts.conversationDecision(correction.messageId)).toBeUndefined();
    const changed = await intake.decide(binding, { decision });
    expect(changed).toMatchObject({ ok: true, value: { runId, correlationId, userMessage: { content: correction.content },
      delegationRequest: { metadata: { revision: 2, isRequirementChange: true } } } });
    const revisions = (await f.state()).outbound.filter((out: any) => out.message.type === "delegation.request");
    expect(revisions).toHaveLength(2);
    const revised = revisions[1].message;
    expect(revised).toMatchObject({ run_id: runId, correlation_id: correlationId, recipient: { role: "coordinator", pane_id: coordinator.paneId } });
    await f.runtime.receiveHerdr(revised);
    await f.runtime.flushOutbound();
    for (const message of f.conversationInbox) await chat.receiveRuntime(message);
    const current = await f.runtime.inspect(runId) as any;
    expect(current).toMatchObject({ coreCreated: false, delegation: { metadata: { revision: 2 } },
      userDecisions: { [receipt.approvalId]: { status: "cancelled" } } });
    expect(current.delegationHistory).toHaveLength(1);
    expect((await f.state()).outbound.some((out: any) => out.message.type === "approval.decision")).toBe(false);
    expect(await chat.getContext()).toMatchObject({ pendingApprovals: {}, pendingClarifications: {} });
    expect(humanDecisions).toBe(0);
    expect(await receipts.humanDecisions()).toEqual([]);
    // The existing Runtime log records the observed steps; it never advances business success.
    const entries = await f.runtime.activityLog.read({ runId, lines: 100, maxBytes: 100_000 });
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ role: "runtime", action: "run_admitted", runId }),
      expect.objectContaining({ role: "runtime", action: "approval.request", runId })]));
    const restarted = f.restart();
    chat = await createAgenticConversationHost({ runtime: restarted, manifest, contextDirectory: join(f.root, "conversation") });
    intake = new HostConversationIntake(receipts, () => chat);
    expect(await intake.receive(binding, correction)).toMatchObject({ requiresConversationDecision: false, result: changed });
    expect(await intake.decide(binding, { decision })).toEqual(changed);
    await restarted.receiveHerdr(revised);
    expect((await f.state()).outbound.filter((out: any) => out.message.type === "delegation.request")).toHaveLength(2);
    expect((await restarted.inspect(runId) as any).delegationHistory).toHaveLength(1);
  });
});

describe("requirement change: revisions are admitted in order and persisted", () => {
  it.each([false, true])("invalidates rejection proof and action identity on a new requirement revision (previous admission: %s)", async admitted => {
    const f = await fixture({ humanApproval: true });
    await admit(f, f.handoff(f.request(1, "Rev1 criterion")));
    const rejected = { code: "unsupported_verification" as const, reason: "Old revision runner binding", options: ["Correct old proposal"] };
    await f.runtime.recordWorkflowRejected("run-1", rejected);
    const oldAction = (await f.run()).lastWorkflowRejection.actionId;
    if (admitted) {
      await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
      expect((await f.run()).lastWorkflowRejection).toBeUndefined();
    }
    await admit(f, f.handoff(f.request(2, "Revised criterion")));
    expect((await f.run()).lastWorkflowRejection).toBeUndefined();
    await f.runtime.recordWorkflowRejected("run-1", rejected);
    const current = await f.run();
    expect(current.lastWorkflowRejection.actionId).not.toBe(oldAction);
    f.restart();
    expect((await f.run()).lastWorkflowRejection.actionId).toBe(current.lastWorkflowRejection.actionId);
  });

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

describe('accepted execution resolution binding and side-effect fencing', () => {
  async function prepared(startupRevision?: string, watchRepository = false) {
    const f = await fixture();
    const path = join(f.root, 'owner-profile.json');
    await writeFile(path, JSON.stringify({ model: 'configured-model' }));
    const { createExecutionResolutionReader, readExecutionRepositorySnapshot } = await import('../../src/agentic/execution-binding.js');
    const { ExecutionPlanInputSchema } = await import('@bflow/contracts');
    const repository = watchRepository ? await readExecutionRepositorySnapshot(f.repository) : { revision: startupRevision ?? git(f.repository, 'rev-parse', 'HEAD') };
    const input = { schemaVersion: 3, resolverVersion: '1', policyVersion: '1', repository, mode: 'intake' };
    const sources = { schemaVersion: 3, plan: input, ...(watchRepository ? { repositoryRoot: f.repository } : {}), files: [{ component: 'owner-profile', path, format: 'json' }] };
    (f.ports as import('../../src/agentic/ports.js').AgenticRuntimePorts).readExecutionResolution = await createExecutionResolutionReader(sources);
    await admit(f, f.handoff(f.request(1, 'Original criterion')));
    await f.runtime.proposeWorkflow('run-1', f.spec, f.def);
    expect((await f.run()).executionPlan).toBeDefined();
    return { f, path, sources, ExecutionPlanInputSchema, createExecutionResolutionReader };
  }
  it.each(['head', 'index', 'dirty'] as const)('blocks real Git %s drift before worktree, launch or lease acquisition', async change => {
    const { f } = await prepared(undefined, true);
    let worktrees = 0, launches = 0, leases = 0;
    f.ports.policies.git.prepareTask = async () => { worktrees++; throw Error('unexpected worktree'); };
    f.ports.panes.allocateDeveloper = async () => { launches++; throw Error('unexpected launch'); };
    f.ports.registry.acquireLease = async () => { leases++; throw Error('unexpected lease'); };
    if (change === 'head') git(f.repository, 'commit', '--allow-empty', '-m', 'changed-base');
    else {
      await writeFile(join(f.repository, 'guide.md'), 'changed source\n');
      if (change === 'index') { git(f.repository, 'add', 'guide.md'); await writeFile(join(f.repository, 'guide.md'), 'initial\n'); }
    }
    await f.runtime.tick();
    expect({ worktrees, launches, leases }).toEqual({ worktrees: 0, launches: 0, leases: 0 });
    expect((await f.run()).executionPlanDrift.changes).toContainEqual(expect.objectContaining({ field: 'inputs.repository-snapshot' }));
  });
  it('uses the accepted worktree base revision rather than an older host startup observation', async () => {
    const { f } = await prepared('older-startup-revision');
    const accepted = await f.run();
    expect(accepted.executionPlan.snapshot.repository.revision).toBe(accepted.baseRevision);
    expect(accepted.executionPlan.snapshot.accepted.revision).toBe(accepted.baseRevision);
  });
  it('binds a new accepted run without CLI expectation and blocks drift before Git worktree/registry capacity side effects', async () => {
    const { f, path } = await prepared();
    const original = await f.run();
    let worktrees = 0, leases = 0;
    f.ports.policies.git.prepareTask = async () => { worktrees++; throw Error('unexpected worktree'); };
    f.ports.registry.acquireLease = async () => { leases++; throw Error('unexpected lease'); };
    await writeFile(path, JSON.stringify({ model: 'new-model' }));
    await f.runtime.tick();
    expect(worktrees).toBe(0); expect(leases).toBe(0);
    const blocked = await f.run();
    expect(blocked.executionPlanDrift.changed).toBe(true);
    expect(blocked.executionPlan.fingerprint).toBe(original.executionPlan.fingerprint);
    expect(blocked.approval.approvalId).toBe(original.approval.approvalId);
    expect(blocked.status).not.toBe('awaiting_approval');
  });
  it('persists private source baselines and refuses drift after host/source-reader restart', async () => {
    const { f, path, sources, createExecutionResolutionReader } = await prepared();
    const bound = JSON.parse(await readFile(join(f.root, 'journal/state.json'), 'utf8')).runs[0];
    expect(bound.executionSourceDigests).toBeDefined();
    expect((await f.run()).executionSourceDigests).toBeUndefined();
    await writeFile(path, JSON.stringify({ model: 'changed-while-daemon-off' }));
    (f.ports as import('../../src/agentic/ports.js').AgenticRuntimePorts).readExecutionResolution = await createExecutionResolutionReader(sources);
    f.restart(); let worktrees = 0;
    f.ports.policies.git.prepareTask = async () => { worktrees++; throw Error('unexpected worktree'); };
    await f.runtime.tick(); expect(worktrees).toBe(0); expect((await f.run()).executionPlanDrift.changed).toBe(true);
  });
  it('reports drift to Conversation and permits human cancellation without another approval', async () => {
    const { f, path } = await prepared();
    await writeFile(path, JSON.stringify({ model: 'drifted' }));
    await f.runtime.tick();
    const notices = (await f.state()).outbound.filter((out: any) => out.message.recipient.role === 'conversation');
    expect(notices.some((out: any) => JSON.stringify(out.message.payload).includes('Execution plan inputs changed'))).toBe(true);
    expect((await f.run()).executionSourceDigests).toBeUndefined();
    await f.runtime.cancel('run-1', 'Human cancellation');
    await f.runtime.tick();
    expect((await f.run()).status).toBe('cancelled');
  });
  it('rechecks after awaited Git preparation and prevents later pane/model launch', async () => {
    const { f, path } = await prepared(); let prepares = 0, launches = 0;
    f.ports.policies.git.prepareTask = async () => {
      prepares++; await writeFile(path, JSON.stringify({ model: 'changed-during-prepare' }));
      return { key: 'task-key', worktreePath: join(f.root, 'task-worktree'), branchName: 'task-branch', baseCommitHash: git(f.repository, 'rev-parse', 'HEAD') };
    };
    f.ports.panes.allocateDeveloper = async () => { launches++; throw Error('unexpected launch'); };
    await f.runtime.tick(); expect(prepares).toBe(1); expect(launches).toBe(0); expect((await f.run()).executionPlanDrift.changed).toBe(true);
  });
});
