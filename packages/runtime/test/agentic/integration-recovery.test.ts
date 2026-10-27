import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { digest } from "../../src/agentic/journal.js";
import { WorkflowProposalRejected } from "../../src/agentic/workflow-rejection.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { cleanups, git, fixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

it.each([false, true])("recovers a refused Developer allocation through its own action while retaining accepted work and approval (legacy: %s)", async legacy => {
  const f = await fixture({ humanApproval: true });
  const preflights: string[] = [];
  f.ports.preflightRoleCapabilities = async binding => { preflights.push(binding.role); };
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  await f.approve();
  const allocate = f.panes.allocateDeveloper.bind(f.panes);
  f.panes.allocateDeveloper = async () => ({ ok: false, error: { code: "validation", retryable: false,
    message: "A Herdr socket port is required to create panes with launch env" } }) as never;
  await f.runtime.tick();
  const paused = await f.inspect();
  expect(paused).toMatchObject({ status: "escalated", pendingAction: { state: "pending", kind: "resume_coordinator",
    previousStatus: "implementing", reason: paused.error } });
  const tree = paused.tasks[0].worktrees[0].worktreePath;
  const approval = paused.decision;
  f.panes.allocateDeveloper = allocate;
  if (legacy) {
    const path = join(f.root, "journal/state.json"), state = JSON.parse(await readFile(path, "utf8"));
    const oldActionId = `next-${digest(["run-1", "old-planning-blocker"])}`;
    state.runs[0].pendingAction = { ...paused.pendingAction, actionId: oldActionId, sourceMessageId: "old-planning-blocker",
      reason: "Unrelated resolved planning blocker", state: "queued" };
    state.runs[0].resumeReceipts = [{ actionId: oldActionId, messageId: "old-requirement-revision" }];
    await writeFile(path, JSON.stringify(state));
  }
  f.restart();
  await f.runtime.initialize();
  const recovered = await f.inspect();
  expect(recovered.pendingAction).toMatchObject({ state: "pending", reason: paused.error, previousStatus: "implementing" });
  await f.runtime.resumeBlockedRun("run-1", recovered.pendingAction.actionId);
  await f.runtime.tick();
  const resumed = await f.inspect();
  expect(resumed.status).not.toBe("escalated");
  expect(resumed.decision).toEqual(approval);
  expect(resumed.tasks[0].worktrees).toHaveLength(1);
  expect(resumed.tasks[0].worktrees[0].worktreePath).toBe(tree);
  expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(1);
  expect(preflights).toContain("coordinator");
});

it("keeps a long Developer allocation diagnostic resumable across restart", async () => {
  const f = await fixture();
  f.ports.preflightRoleCapabilities = async () => {};
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  const allocate = f.panes.allocateDeveloper.bind(f.panes);
  f.panes.allocateDeveloper = async () => ({ ok: false, error: { code: "validation", retryable: false,
    message: "Provider diagnostic: " + "x".repeat(3000) } }) as never;
  await f.runtime.tick();
  const paused = await f.inspect();
  expect(paused.status).toBe("escalated");
  expect(paused.pendingAction.reason).toBe(paused.error.slice(0, 2000));
  await f.runtime.resumeBlockedRun("run-1", paused.pendingAction.actionId);
  await f.runtime.tick();
  const beforeRestart = await f.inspect();
  expect(beforeRestart.pendingAction.manualResumeAttempts).toBe(1);
  f.restart(); await f.runtime.initialize();
  expect((await f.inspect()).pendingAction).toEqual(beforeRestart.pendingAction);
  f.panes.allocateDeveloper = allocate;
  await f.runtime.resumeBlockedRun("run-1", paused.pendingAction.actionId);
  await f.runtime.tick();
  expect((await f.inspect()).tasks[0].worktrees).toEqual(paused.tasks[0].worktrees);
  expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(1);
});

it("keeps the explicit allocation resume budget when provider diagnostics change", async () => {
  const f = await fixture({ humanApproval: true });
  f.ports.preflightRoleCapabilities = async () => {};
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.approve();
  let episode = 0;
  f.panes.allocateDeveloper = async () => ({ ok: false, error: { code: "validation", retryable: false,
    message: `Launch launch-${episode++} cannot activate` } }) as never;
  await f.runtime.tick();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.runtime.resumeBlockedRun("run-1", (await f.inspect()).pendingAction.actionId);
    await f.runtime.tick();
    expect((await f.inspect()).pendingAction).toMatchObject({ state: "pending", manualResumeAttempts: attempt });
  }
  await expect(f.runtime.resumeBlockedRun("run-1", (await f.inspect()).pendingAction.actionId)).rejects.toThrow("Explicit resume budget is exhausted");
  expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(0);
});

it.each([false, true, "paused"] as const)("keeps an executing run schedulable during a diagnostic specialist handoff (legacy: %s)", async legacy => {
  const f = await fixture();
  f.ports.preflightRoleCapabilities = async () => {};
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  await f.evidence("implement"); await f.submit();
  expect((await f.inspect()).coreCreated).toBe(true);
  await f.runtime.requestSpecialist("run-1", "architect", "Read-only diagnosis of a recovered execution blocker", ["repository.read"]);
  if (!legacy) expect((await f.inspect()).status).toBe("implementing");
  else {
    const path = join(f.root, "journal/state.json"), state = JSON.parse(await readFile(path, "utf8"));
    state.runs[0].status = legacy === "paused" ? "escalated" : "specifying";
    if (legacy === "paused") state.runs[0].pendingAction = { actionId: `next-${digest(["run-1", "diagnostic-pause"])}`,
      kind: "resume_coordinator", owner: "coordinator", reason: "Paused diagnostic", sourceMessageId: "diagnostic-pause",
      createdAt: new Date().toISOString(), state: "pending", previousStatus: "specifying", recovery: "manual" };
    await writeFile(path, JSON.stringify(state));
    f.restart(); await f.runtime.initialize();
    if (legacy === "paused") {
      expect((await f.inspect()).status).toBe("escalated");
      expect((await f.inspect()).pendingAction.previousStatus).toBe("implementing");
      await f.runtime.resumeBlockedRun("run-1", (await f.inspect()).pendingAction.actionId);
    } else expect((await f.inspect()).status).toBe("implementing");
  }
  await f.runtime.tick();
  expect((await f.inspect()).tasks[0].cycle).toBeDefined();
});

it.each(["task", "delivery"] as const)("recovers an actionable %s approval after a legacy diagnostic phase regression", async kind => {
  const f = await fixture();
  f.def.tasks[0]!.requiresApproval = kind === "task";
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  await f.evidence("implement"); await f.submit(); await f.runtime.tick();
  if (kind === "delivery") await f.runtime.tick();
  const pending = await f.inspect();
  expect(pending.status).toBe("awaiting_approval"); expect(pending.approvalKind).toBe(kind);
  const path = join(f.root, "journal/state.json"), state = JSON.parse(await readFile(path, "utf8"));
  state.runs[0].status = "specifying";
  await writeFile(path, JSON.stringify(state));
  f.restart(); await f.runtime.initialize();
  const recovered = await f.inspect();
  expect(recovered.status).toBe("awaiting_approval");
  expect(recovered.approval).toEqual(pending.approval);
  expect(recovered.decision).toEqual(pending.decision);
  await f.runtime.tick();
  expect((await f.inspect()).status).toBe("awaiting_approval");
  await f.approve();
  expect((await f.inspect()).decision.approvalId).toBe(pending.approval.approvalId);
  expect((await f.inspect()).status).toBe(kind === "task" ? "implementing" : "completed");
});

it.each(["task", "delivery"] as const)("retains a manual pause before explicitly restoring a pending %s approval", async kind => {
  const f = await fixture();
  f.ports.preflightRoleCapabilities = async () => {};
  f.def.tasks[0]!.requiresApproval = kind === "task";
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  await f.evidence("implement"); await f.submit(); await f.runtime.tick();
  if (kind === "delivery") await f.runtime.tick();
  const pending = await f.inspect();
  expect(pending.status).toBe("awaiting_approval"); expect(pending.approvalKind).toBe(kind);
  const path = join(f.root, "journal/state.json"), state = JSON.parse(await readFile(path, "utf8"));
  state.runs[0].status = "escalated";
  const actionId = `next-${digest(["run-1", "diagnostic-pause"])}`;
  state.runs[0].pendingAction = { actionId, kind: "resume_coordinator", owner: "coordinator",
    reason: "Paused legacy diagnosis", sourceMessageId: "diagnostic-pause", createdAt: new Date().toISOString(),
    state: "pending", previousStatus: "specifying", recovery: "manual" };
  await writeFile(path, JSON.stringify(state));
  f.restart(); await f.runtime.initialize();
  expect((await f.inspect()).status).toBe("escalated");
  expect((await f.inspect()).pendingAction.previousStatus).toBe("awaiting_approval");
  expect(await f.runtime.resumeRecoverableRuns()).toMatchObject({ resumed: 0 });
  await expect(f.runtime.resumeBlockedRun("run-1", actionId, { automatic: true })).rejects.toThrow("pending approval");
  await f.runtime.resumeBlockedRun("run-1", actionId);
  expect((await f.inspect()).approval).toEqual(pending.approval);
  expect((await f.inspect()).decision).toEqual(pending.decision);
  await f.runtime.tick();
  expect((await f.inspect()).status).toBe("awaiting_approval");
  await f.approve();
  expect((await f.inspect()).status).toBe(kind === "task" ? "implementing" : "completed");
});

describe("workflow proposal admission regressions", () => {
  async function proposalFixture() {
    const profiles: RunnerProfile[] = ([ ["unit", "unit_test"], ["integration", "integration_test"] ] as const).map(([level, method]) => ({
      id: `auto-${level}`, command: `auto:${level}`, method, levels: [level, "regression"], source: "detected",
      executable: process.execPath, args: ["node_modules/vitest/vitest.mjs", "run", "--reporter=json"], reporter: "vitest_json",
      timeoutMs: 180000, prepare: { args: ["node_modules/typescript/bin/tsc", "-b"], timeoutMs: 120000 },
      checkoutDependencyRoots: [], dependencySource: process.cwd()
    }));
    const runners = new TestRunnerSource([], process.cwd(), async () => ({ status: "detected", profiles, notes: [] }));
    await runners.refresh();
    const f = await fixture({ intake: false, humanApproval: true, runners });
    Object.assign(f.spec, draft("bugfix"));
    f.spec.affectedPaths = ["src/log.ts", "test/unit.test.ts", "test/integration.test.ts"];
    f.spec.acceptanceCriteria = ["unit_test", "integration_test", "unit_test"].map((method, index) => ({
      ...f.spec.acceptanceCriteria[0]!, id: `ac-${index + 1}`, description: `Logging criterion ${index + 1}`,
      verificationMethod: method as "unit_test" | "integration_test"
    }));
    f.spec.traceabilityTaskIds = ["unit", "integration"];
    const details = f.spec.metadata!.sdd as any;
    details.traceability = f.spec.acceptanceCriteria.map(c => ({ criterionId: c.id, taskIds: [c.verificationMethod === "unit_test" ? "unit" : "integration"] }));
    f.spec.metadata!.conditionalTdd = {
      policyVersion: 1, taskId: "unit", taskType: "domain_logic",
      changeImpact: { surfaces: ["domain_logic"], behaviorChanged: true, deterministic: true, regressionReproducible: true,
        securitySensitive: false, dataMigration: false, scope: "local" },
      infrastructure: { readiness: "ready", commands: [
        { method: "unit_test", command: "auto:unit", level: "unit" },
        { method: "integration_test", command: "auto:integration", level: "integration" }
      ] }, testability: { level: "automated", rationale: "Deterministic regression fixtures" },
      riskClassification: "low", conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
    };
    const split = workflow(["unit", "integration"]);
    split.tasks.forEach(task => {
      task.acceptanceCriteria = task.id === "unit" ? ["ac-1", "ac-3"] : ["ac-2"];
      (task as any).metadata = { ownedPaths: f.spec.affectedPaths };
    });
    const bundled = { ...split, tasks: [{ ...split.tasks[0]!, acceptanceCriteria: ["ac-1", "ac-2", "ac-3"] }] };
    f.ports.validateTaskCommands = (specification, strategy, owned) => f.verification.assertTaskSupported(specification, strategy, owned);
    await f.runtime.receiveHerdr(f.envelope("delegation.request", {
      schemaVersion: 2, delegationId: "delegation-proposal", messageId: "intake-proposal", correlationId: "correlation-1",
      sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: f.spec.title,
      objective: f.spec.summary, specificationId: f.spec.specId, sddLevel: f.spec.level,
      acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: new Date().toISOString(),
      idempotencyKey: "intake-proposal"
    }, { message_id: "intake-proposal", idempotency_key: "intake-proposal" }));
    return { ...f, split, bundled };
  }

  it("rejects an overbudget task promptly, keeps the journal usable, and accepts a corrected split through the human gate", async () => {
    const f = await proposalFixture();
    await expect(f.runtime.proposeWorkflow("run-1", f.spec, f.bundled)).rejects.toBeInstanceOf(WorkflowProposalRejected);
    const rejected = await f.inspect();
    expect(rejected.definition).toBeUndefined();
    expect(rejected.coreCreated).toBe(false);
    expect(rejected.lastWorkflowRejection.code).toBe("missing_test_mapping");
    expect(f.transport.sentRequests.filter(call => JSON.parse(call.instruction).type === "task.assignment")).toHaveLength(0);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.split);
    const corrected = await f.inspect();
    expect(corrected.status).toBe("awaiting_approval");
    expect(corrected.tasks).toHaveLength(2);
    expect(corrected.lastWorkflowRejection).toBeUndefined();
    expect(corrected.coreCreated).toBe(false);
    expect(corrected.workflowSpec.specification.acceptanceCriteria).toEqual(f.spec.acceptanceCriteria);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.split);
    expect((await f.inspect()).approval.approvalId).toBe(corrected.approval.approvalId);
  });
});

describe("Runtime task activity log integration", () => {
  it("records committed admission, assignment and status transitions without tick polling noise", async () => {
    const f = await fixture();
    const activityPath = join(f.root, "task-activity.jsonl");
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    const read = async () => (await readFile(activityPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const initial = await read();
    expect(initial.some(item => item.kind === "admission" && item.runId === "run-1")).toBe(true);
    expect(initial.some(item => item.kind === "assignment" && item.action === "task.assignment" && item.taskId === "implement")).toBe(true);
    const count = initial.length;
    await f.runtime.tick();
    const afterDeliveryReconcile = await read();
    expect(afterDeliveryReconcile.length).toBeLessThanOrEqual(count + 2);
    await f.runtime.tick();
    const afterQuietTick = await read();
    expect(afterQuietTick.map((item: any) => item.action).slice(afterDeliveryReconcile.length)).toEqual([]);
    const dispatched = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.type === "task.assignment");
    expect(dispatched.status).toBe("accepted");
  });

  it("provides native tool diagnostic assignment context without acquiring Runtime.inspect", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const assigned = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.type === "task.assignment");
    const developer = f.panes.bindings.find(binding => binding.paneId === assigned.handle.target.paneId)!;
    const inspect = vi.spyOn(f.runtime, "inspect");
    expect(f.runtime.taskLogAssignmentContext(developer)).toMatchObject({ runId: "run-1", taskId: "implement", attemptId: assigned.attemptId });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("records accepted task specifications and newly accepted conditional TDD evidence phases", async () => {
    const f = await fixture({ tdd: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const read = async () => (await readFile(join(f.root, "task-activity.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    expect(await read()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "specification", action: "task_specification_accepted", runId: "run-1", taskId: "implement", outcome: expect.stringContaining("required") })
    ]));
    await f.runtime.tick();
    await f.evidence("implement", "red"); await f.evidence("implement", "green"); await f.evidence("implement", "refactor");
    const entries = await read();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tdd", action: "tdd_evidence_accepted:red", runId: "run-1", taskId: "implement" }),
      expect.objectContaining({ kind: "tdd", action: "tdd_evidence_accepted:green", runId: "run-1", taskId: "implement" }),
      expect.objectContaining({ kind: "tdd", action: "tdd_evidence_accepted:refactor", runId: "run-1", taskId: "implement" })
    ]));
    expect(JSON.stringify(entries.filter((item: any) => item.kind === "tdd"))).not.toContain("verificationId");
    expect(JSON.stringify(entries.filter((item: any) => item.kind === "tdd"))).not.toContain("evidenceArtifacts");
  });
});

// This recovery path acquires AgenticJournal.exclusive, which uses POSIX flock.
it.skipIf(process.platform === "win32")("recovers the exact failed phase after a crash following lease release without duplicating repair notices", async () => {
  const f = await fixture({ tdd: true });
  f.ports.roleCapabilities.qa = ["verification", "testing", "repository.read"];
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  const state = await f.runtime.inspect() as any;
  const assignment = state.outbound.find((out: any) => out.message.type === "task.assignment");
  const binding = f.panes.bindings.find(item => item.paneId === assignment.handle.target.paneId)!;
  const revision = git(assignment.handle.target.worktreePath, "rev-parse", "HEAD");
  const queued = await f.runtime.requestPhaseVerification(binding, "run-1", "implement", "red", revision) as any;
  await f.runtime.flushOutbound();
  const request = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === queued.messageId);
  const qa = f.panes.bindings.find(item => item.paneId === request.handle.target.paneId)!;
  const journal = (f.runtime as any).journal, exclusive = journal.exclusive.bind(journal);
  const spy = vi.spyOn(journal, "exclusive").mockImplementation((action: any) => exclusive(async (current: any, save: any) => action(current, async () => {
    await save();
    if (current.outbound.find((out: any) => out.message.message_id === queued.messageId)?.status === "released")
      throw new Error("crash after released checkpoint");
  })));
  await expect(f.runtime.recordPhaseFailure(qa, queued.messageId, "Actual assertion failure", true)).rejects.toThrow("crash after released checkpoint");
  spy.mockRestore();
  const reopened = f.restart(), beforeRecovery = await reopened.inspect() as any;
  expect(beforeRecovery.outbound.find((out: any) => out.message.message_id === queued.messageId).phaseFailure.applied).toBe(false);
  await reopened.recoverMissingCoordinatorWakeups();
  const restored = await reopened.inspect() as any;
  const failed = restored.outbound.find((out: any) => out.message.message_id === queued.messageId);
  expect(failed).toMatchObject({ status: "released", error: "policy_phase_failed:Actual assertion failure", phaseFailure: { applied: true } });
  expect(restored.outbound.filter((out: any) => out.parentAssignmentId === assignment.message.message_id)).toHaveLength(1);
  expect(await reopened.recordPhaseFailure(qa, queued.messageId, "Actual assertion failure", true)).toMatchObject({ alreadyRecorded: true });
  await expect(reopened.requestPhaseVerification(binding, "run-1", "implement", "red", revision)).rejects.toThrow("already failed");
  const again = await reopened.inspect() as any;
  expect(again.outbound.filter((out: any) => out.parentAssignmentId === assignment.message.message_id)).toHaveLength(1);
  await expect(reopened.recordPhaseFailure(qa, queued.messageId, "Different result", true)).rejects.toThrow("Conflicting");
});

it("resumes the existing Developer after accepted Red was paused by a stale blocker, without reassigning or replacing evidence", async () => {
  const f = await fixture({ tdd: true });
  f.ports.preflightRoleCapabilities = async () => undefined;
  (f.ports.roleCapabilities.coordinator as string[]).push("repository.read");
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  await f.evidence("implement", "red");
  const before = await f.runtime.inspect() as any;
  const parent = before.outbound.find((out: any) => out.message.type === "task.assignment");
  const coordinator = f.panes.bindings.find(pane => pane.role === "coordinator")!;
  await f.runtime.observeCoordinatorOutcome(f.envelope("task.status", { status: "blocked", summary: "Stale verification blocker" }, {
    recipient: { role: "conversation" }, sender: { role: "coordinator", agent_id: coordinator.agentId, pane_id: coordinator.paneId }
  }));
  const paused = await f.runtime.inspect("run-1") as any;
  await f.runtime.resumeBlockedRun("run-1", paused.pendingAction.actionId);
  expect((await f.runtime.inspect() as any).outbound.some((out: any) => out.message.payload.kind === "policy_phase_outcome" && out.message.payload.summary.includes("resumed"))).toBe(false);
  // Recover a continuation that an earlier successful resume receipt did not send.
  const currentPause = paused;
  await f.runtime.resumeBlockedRun("run-1", currentPause.pendingAction.actionId, { conversationUserMessageId: "physical-resume" });
  const after = await f.runtime.inspect() as any;
  const notice = after.outbound.find((out: any) => out.message.payload.kind === "policy_phase_outcome" && out.message.payload.summary.includes("resumed"));
  expect(notice).toMatchObject({ parentAssignmentId: parent.message.message_id, message: { recipient: { agent_id: parent.handle.target.agentId, pane_id: parent.handle.target.paneId }, payload: { phase: "red", status: "passed" } } });
  expect(after.outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(1);
  expect(after.runs[0].tasks[0].spec.strategy.metadata.tddEvidence).toEqual(before.runs[0].tasks[0].spec.strategy.metadata.tddEvidence);
  await f.runtime.resumeBlockedRun("run-1", currentPause.pendingAction.actionId, { conversationUserMessageId: "physical-resume" });
  expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.message_id === notice.message.message_id)).toHaveLength(1);
}, 60_000);
