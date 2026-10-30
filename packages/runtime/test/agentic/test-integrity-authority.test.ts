import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, ArtifactReferenceSchema, DelegationRequestSchema, PaneBindingSchema,
  QualityGateContextSchema, RoleMessageSchema, SpecificationSchema, type ApprovalDecision, type PaneBinding } from "@bflow/contracts";
import { draft } from "../../../specification/test/fixtures.js";
import { AgenticJournal, type JournalState, type RunRecord, type TaskRecord } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { createVerificationPlan } from "../../../verification/src/model.js";
import type { AgenticRuntimePorts, VerificationPlan } from "../../src/agentic/ports.js";

const T0 = "2026-10-18T10:00:00.000Z", T1 = "2026-10-18T10:01:00.000Z";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const binding = (): PaneBinding => PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "reviewer-binding", sessionId: "session-1",
  role: "reviewer", agentId: "reviewer-agent", paneId: "pane-reviewer", workspaceId: "workspace", tabId: "tab", provider: "claude",
  agentKind: "claude", cwd: "/tmp", readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle", boundAt: T0,
  session: { source: "herdr:claude", kind: "id", value: "native-reviewer" } });
const query = { runId: "run-1", taskId: "task-1", attemptId: "attempt-1", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40),
  specFingerprint: "c".repeat(64), scope: "task" };
const evidence = ArtifactReferenceSchema.parse({ trust: "stored", artifactId: "integrity-evidence", runId: "run-1", taskId: "task-1", kind: "test-result",
  uri: "artifact://test/integrity-evidence", mediaType: "application/json", checksum: { algorithm: "sha256", value: "d".repeat(64) }, createdAt: T0 });
const context = QualityGateContextSchema.parse({ runId: query.runId, taskId: query.taskId, attemptId: query.attemptId,
  definition: { id: "host-reviewer", name: "Independent reviewer", evaluator: "native-herdr-review", required: true,
    timeout: { executionTimeoutMs: 300000, onTimeout: "block" }, configuration: { kind: "review", method: "manual_review", criterionIds: ["ac-1"], testNames: [], role: "reviewer", levels: [] } },
  artifacts: [], input: { sourceWorktreePath: "/tmp", sourceRevision: query.candidateRevision, baseRevision: query.baseRevision, specFingerprint: query.specFingerprint, scope: query.scope } });
const exceptionInput = { messageId: "review-request", context, findingId: "TI-finding-1", reason: "A platform-specific test needs an explicitly approved temporary exception", evidence };

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-test-integrity-authority-"))); roots.push(root);
  const repository = join(root, "repo"), journalDirectory = join(root, "journal");
  let now = T0, humanAllowed = true;
  const ports = { clock: () => new Date(now), authenticateMessage: async () => true,
    authorizeHuman: async (decision: ApprovalDecision) => humanAllowed && decision.decidedBy === "owner-1"
  } as unknown as AgenticRuntimePorts;
  const journal = new AgenticJournal(journalDirectory, repository), specification = draft("api"), pane = binding();
  await journal.exclusive(async (state: JournalState, save) => {
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake", correlationId: "correlation",
      sessionId: "session-1", runId: query.runId, requestedBy: "conversation", targetRole: "coordinator", title: "Integrity exception", objective: "Review test weakening",
      specificationId: specification.specId, sddLevel: specification.level, acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: T0, idempotencyKey: "intake" });
    state.runs.push({ runId: query.runId, delegation, status: "verifying", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "review-request", correlation_id: "correlation", run_id: query.runId,
      sender: { role: "coordinator" }, recipient: { role: "reviewer", agent_id: pane.agentId, pane_id: pane.paneId }, type: "verification.requested",
      payload: context, artifact_references: [], occurred_at: T0, idempotency_key: "review-request" });
    state.outbound.push({ message, status: "released", selector: "reviewer", taskId: query.taskId, attemptId: query.attemptId, capabilities: [],
      handle: { executionId: "review-exec", requestId: "review-request", attemptId: query.attemptId, runId: query.runId, taskId: query.taskId,
        idempotencyKey: "review-request", target: { transport: "herdr", agentId: pane.agentId, paneId: pane.paneId, session: pane.session },
        correlation: { token: "review-request", provenance: "transport", verified: true }, acceptedAt: T0 } });
    await save();
  });
  return { journal, pane, ports, runtime: () => new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository }),
    setNow: (value: string) => { now = value; }, setHumanAllowed: (value: boolean) => { humanAllowed = value; } };
}
function decision(approvalId: string, overrides: Record<string, unknown> = {}) {
  return ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId, runId: query.runId, sessionId: "session-1", target: { type: "task", taskId: query.taskId },
    revision: 1, generation: 0, decision: "approved", decidedBy: "owner-1", decidedAt: T1,
    reason: "Owner accepts the documented temporary test exception at this exact revision", feedbackArtifacts: [], idempotencyKey: `answer-${approvalId}`,
    metadata: { selectedOption: "Approve test-integrity exception" }, ...overrides });
}
async function answer(runtime: AgenticWorkflowRuntime, value: ApprovalDecision) {
  return runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: `answer-${value.idempotencyKey}`, correlation_id: "correlation", run_id: query.runId,
    sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: value,
    artifact_references: [], occurred_at: value.decidedAt, idempotency_key: `answer-${value.idempotencyKey}` }));
}
async function request(f: Awaited<ReturnType<typeof fixture>>) {
  const receipt = await f.runtime().requestTestIntegrityException(f.pane, exceptionInput) as { approvalId: string; status: string };
  return receipt;
}

describe("per-candidate test-integrity owner authority", () => {
  it("keeps independent review in a fast-path plan containing the test-integrity gate", async () => {
    const f = await fixture(), state = await f.journal.exclusive(async s => s), run = state.runs[0]!;
    const original = draft("api");
    const tddDecision = { ...original.tddDecision!, mode: "recommended" as const, requiresFailingTestFirst: false };
    const strategy = { ...original.testStrategy!, tddDecision, requiredTestLevels: ["unit" as const], targetCommands: ["host:test-integrity"] };
    const specification = SpecificationSchema.parse({ ...original, status: "approved", approvedBy: "owner-1", tddDecision, testStrategy: strategy,
      artifactRef: { ...evidence, kind: "document" } });
    const task = { taskId: query.taskId, spec: { specification, strategy, request: {} }, worktrees: [], outboundIds: [] } as unknown as TaskRecord;
    task.outboundIds = ["developer-request"]; run.tasks = [task];
    state.outbound.push({ ...state.outbound[0]!, message: { ...state.outbound[0]!.message, message_id: "developer-request" },
      handle: { ...state.outbound[0]!.handle!, target: { ...state.outbound[0]!.handle!.target, agentId: "developer-agent" } } });
    run.fastPath = { status: "active", decidedAt: T0, blockers: [], reasons: [], classificationDigest: "f".repeat(64) };
    f.ports.taskChecks = [context.definition, { ...context.definition, id: "host-test-integrity", configuration: {
      kind: "deterministic", method: "unit_test", command: "host:test-integrity", criterionIds: ["ac-1"], testNames: ["example regression"], role: "quality_gate", levels: ["unit"]
    } }];
    f.ports.policies = { createVerificationPlan } as unknown as AgenticRuntimePorts["policies"];
    const internal = f.runtime() as unknown as { verificationPlan(state: JournalState, run: RunRecord, task: TaskRecord): VerificationPlan };
    const plan = internal.verificationPlan(state, run, task);
    expect(plan.reviewWaiver).toBeUndefined();
    expect(plan.checks.map(check => check.id)).toContain("host-reviewer");
    expect(run.fastPath).toMatchObject({ status: "downgraded", downgrade: { reason: "test_integrity_requires_independent_review", scope: "task" } });
  });

  it("fences pre-upgrade cached verification plans instead of accepting old review-waived evidence", async () => {
    const f=await fixture(),state=await f.journal.exclusive(async s=>s),run=state.runs[0]!;
    const legacy={runId:query.runId,taskId:query.taskId,checks:[],reviewWaiver:{kind:"deterministic_coverage",reason:"legacy"}} as unknown as VerificationPlan;
    const task={taskId:query.taskId,verificationPlan:legacy} as unknown as TaskRecord;
    f.ports.taskChecks=[{...context.definition,id:"host-test-integrity"}];f.ports.workflowChecks=f.ports.taskChecks;
    const internal=f.runtime() as unknown as {verificationPlan(state:JournalState,run:RunRecord,task?:TaskRecord):VerificationPlan};
    expect(()=>internal.verificationPlan(state,run,task)).toThrow(/predates.*test.integrity/i);
    run.workflowVerificationPlan=legacy;
    expect(()=>internal.verificationPlan(state,run)).toThrow(/predates.*test.integrity/i);
  });

  it("requires the exact independent native Reviewer and matching assigned context", async () => {
    const f = await fixture();
    await expect(f.runtime().requestTestIntegrityException({ ...f.pane, role: "developer" }, exceptionInput)).rejects.toThrow(/Reviewer/);
    await expect(f.runtime().requestTestIntegrityException({ ...f.pane, session: { ...f.pane.session!, value: "other-native" } }, exceptionInput)).rejects.toThrow(/assigned/);
    await expect(f.runtime().requestTestIntegrityException(f.pane, { ...exceptionInput, context: { ...context, input: { ...context.input as object, sourceRevision: "e".repeat(40) } } })).rejects.toThrow(/context/);
    await expect(f.runtime().requestTestIntegrityException(f.pane, { ...exceptionInput, reason: " " })).rejects.toThrow();
    await expect(f.runtime().requestTestIntegrityException(f.pane, { ...exceptionInput, evidence: { ...evidence, runId: "other-run" } })).rejects.toThrow(/evidence/);
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
  });

  it("uses existing Conversation approval routing and persists only exact authenticated owner grants across restart", async () => {
    const f = await fixture();
    const receipt = await request(f);
    expect(receipt.status).toBe("pending");
    expect(await request(f)).toEqual(receipt);
    let state = await f.journal.exclusive(async s => s);
    const requests = state.outbound.filter(out => out.message.type === "approval.request");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.message.recipient.role).toBe("conversation");
    expect(requests[0]!.message.artifact_references).toEqual([evidence]);
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
    f.setNow(T1);
    await answer(f.runtime(), decision(receipt.approvalId));
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([{ findingId: exceptionInput.findingId, approvalId: receipt.approvalId,
      reason: decision(receipt.approvalId).reason, decidedBy: "owner-1" }]);
    for (const mismatch of [{ candidateRevision: "e".repeat(40) }, { baseRevision: "e".repeat(40) }, { attemptId: "attempt-2" }, { scope: "workflow" }, { specFingerprint: "e".repeat(64) }]) {
      expect(await f.runtime().testIntegrityExceptions({ ...query, ...mismatch })).toEqual([]);
    }
    state = await f.journal.exclusive(async s => s);
    expect(state.runs[0]!.userDecisions![receipt.approvalId]!.decision).toEqual(decision(receipt.approvalId));
    expect(state.outbound.find(out => out.message.type === "task.status")!.message.recipient).toMatchObject({ role: "reviewer", pane_id: f.pane.paneId, agent_id: f.pane.agentId });
    f.setHumanAllowed(false);
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
  });

  it("does not accept an unauthenticated owner or approval without a nonempty reason", async () => {
    const f = await fixture(), receipt = await request(f); f.setNow(T1);
    await expect(answer(f.runtime(), decision(receipt.approvalId, { decidedBy: "developer", idempotencyKey: "forged" }))).rejects.toThrow(/authenticated/);
    await expect(answer(f.runtime(), decision(receipt.approvalId, { reason: undefined, idempotencyKey: "without-reason" }))).rejects.toThrow(/reason/);
    await expect(answer(f.runtime(), decision(receipt.approvalId, { metadata: { selectedOption: "Waive every test" }, idempotencyKey: "unknown-option" }))).rejects.toThrow(/option/);
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
  });

  it("records the owner's numbered reject choice without granting the exception", async () => {
    // Conversation encodes "#n: 2" as an answered decision selecting the reject option; refusing it would strand the run.
    const f = await fixture(), receipt = await request(f); f.setNow(T1);
    await answer(f.runtime(), decision(receipt.approvalId, { reason: "2", metadata: { selectedOption: "Reject test-integrity exception" } }));
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
    const entry = await f.journal.exclusive(async state => state.runs[0]!.userDecisions![receipt.approvalId]!);
    expect(entry.status).toBe("answered");
    expect(entry.answer).toMatchObject({ selectedOption: "Reject test-integrity exception" });
  });

  it("never grants a rejected request or an expired unanswered request", async () => {
    const f = await fixture(), receipt = await request(f); f.setNow(T1);
    await answer(f.runtime(), decision(receipt.approvalId, { decision: "rejected", metadata: { selectedOption: "Reject test-integrity exception" } }));
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
    const g = await fixture(), expired = await request(g); g.setNow("2026-10-20T10:00:00.000Z");
    await answer(g.runtime(), decision(expired.approvalId, { decidedAt: "2026-10-20T10:00:00.000Z" }));
    expect(await g.runtime().testIntegrityExceptions(query)).toEqual([]);
  });

  it("ignores generic user decisions even when their question mentions the same finding", async () => {
    const f = await fixture();
    const receipt = await f.runtime().requestUserDecision({ ...f.pane, role: "coordinator" }, "coordinator", { runId: query.runId, taskId: query.taskId,
      question: `Approve ${exceptionInput.findingId}`, options: ["Approve test-integrity exception", "Reject test-integrity exception"] }) as { approvalId: string };
    f.setNow(T1); await answer(f.runtime(), decision(receipt.approvalId));
    expect(await f.runtime().testIntegrityExceptions(query)).toEqual([]);
  });
});
