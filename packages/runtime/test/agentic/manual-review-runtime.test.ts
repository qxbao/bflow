import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema } from "@bflow/contracts";
import { assertEvidenceComplete } from "@bflow/test-strategy";
import { HostBehavioralFailure } from "../../src/agentic/host-verification.js";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { cleanups, fixture, automaticRunners, connectedPhaseFixture, phaseTestName } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const command = () => parseBehavioralCommands([{ id: "real-regression", command: "auto:integration", executable: process.execPath,
  args: ["--test", "--test-reporter=tap", "test/double.test.cjs"], method: "integration_test", levels: ["integration", "regression"],
  testPaths: ["test/double.test.cjs"], testNames: [phaseTestName], timeoutMs: 10_000 }])[0]!;

describe("high-risk manual policy through Runtime and authenticated approvals", () => {
  it("admits a full high-risk proposal to human design approval and rejects forged or stale decisions without Developer dispatch", async () => {
    const f = await fixture({ behavioral: command(), runners: await automaticRunners(), highRisk: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const pending = await f.inspect();
    expect(pending).toMatchObject({ status: "awaiting_approval", approvalKind: "design" });
    await expect(f.verification.inspectAlternative(f.panes.bindings.find(b => b.role === "qa")!, { runId: "run-1", taskId: "implement", phase: "verification" })).rejects.toThrow(/approved|assignment|request/i);
    for (const task of pending.tasks) expect(task.spec.strategy.metadata.conditionalTdd.requiredVerificationMethods).toContain("manual_review");
    await f.restart().tick();
    expect(f.transport.sentRequests.some(request => request.role === "developer")).toBe(false);
    const approval = (await f.inspect()).approval;
    const decide = (revision: number) => ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: approval.approvalId,
      runId: approval.runId, sessionId: approval.sessionId, target: approval.target, revision, generation: approval.generation,
      decision: "approved", decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: "untrusted-"+revision });
    await expect(f.runtime.receiveHerdr(f.envelope("approval.decision", decide(approval.revision)))).rejects.toThrow(/authenticated/i);
    await expect(f.runtime.receiveHerdr(f.envelope("approval.decision", decide(approval.revision + 1)))).rejects.toThrow(/stale|mismatch/i);
    await f.runtime.tick();
    expect((await f.inspect()).status).toBe("awaiting_approval");
    expect(f.transport.sentRequests.some(request => request.role === "developer")).toBe(false);
    await f.approve(); await f.runtime.tick();
    expect(f.transport.sentRequests.some(request => request.role === "developer")).toBe(true);
    expect((await f.inspect()).status).not.toBe("completed");
  });
  it("invalidates an authenticated old design approval when the accepted requirement and Spec revision change", async () => {
    const f = await fixture({ behavioral: command(), runners: await automaticRunners(), highRisk: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const before = await f.inspect(), request = before.approval;
    const oldDecision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: request.runId,
      sessionId: request.sessionId, target: request.target, revision: request.revision, generation: request.generation,
      decision: "approved", decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: "old-design-proof" });
    const conversation = f.panes.bindings.find(b => b.role === "conversation")!;
    await f.receipts.recordHuman(oldDecision, { origin: "UserPromptSubmit", binding: conversation, nativeSessionId: conversation.session!.value,
      conversationSessionId: "session-1", userId: "human-1", messageId: "old-physical-turn", promptDigest: createHash("sha256").update("approve").digest("hex") });
    expect(await f.receipts.authenticateHuman(oldDecision)).toBe(true);
    const criteria = before.delegation.acceptanceCriteria.map((c: any) => ({ ...c, description: "Changed requirement for the next Spec revision" }));
    const id = randomUUID();
    await f.runtime.receiveHerdr(f.envelope("delegation.request", { ...before.delegation, delegationId: id, messageId: id, idempotencyKey: id,
      requestedAt: new Date().toISOString(), acceptanceCriteria: criteria, metadata: { ...before.delegation.metadata, revision: 2, isRequirementChange: true } },
      { message_id: id, idempotency_key: id }));
    f.spec.acceptanceCriteria[0]!.description = criteria[0].description;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.inspect()).approval.approvalId).not.toBe(request.approvalId);
    await expect(f.runtime.receiveHerdr(f.envelope("approval.decision", oldDecision))).rejects.toThrow(/stale|mismatch|superseded/i);
    await f.runtime.tick();
    expect((await f.inspect()).status).toBe("awaiting_approval");
    expect(f.transport.sentRequests.some(r => r.role === "developer")).toBe(false);
  });
  it("uses the real phase assignment for Red Green Refactor and only then schedules final review", async () => {
    const f = await connectedPhaseFixture("node_tap", 3, true, { highRisk: true });
    await f.addTests(); await f.measure("red");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n");
    await f.commit("Green: implement double");
    await f.measure("green"); await f.measure("refactor");
    const accepted = await f.dossier(); expect(() => assertEvidenceComplete(accepted.strategy)).not.toThrow();
    await f.submit("implement", null);
    await f.tickWithReviews(true); await f.tickWithReviews(true);
    const run = await f.inspect();
    expect(run.tasks[0].cycle, JSON.stringify({ status: run.status, error: run.error })).toMatchObject({ status: "passed" });
    expect(run.workflowCycle.status).toBe("passed");
    expect(run).toMatchObject({ status: "awaiting_approval", approvalKind: "delivery" });
  }, 180_000);
  it("collects recommended successful verification with its independent review on partial infrastructure", async () => {
    const f = await connectedPhaseFixture("node_tap", 3, true, { highRisk: true, readiness: "partial" });
    expect((await f.dossier()).strategy.tddDecision.mode).toBe("recommended");
    await f.addTests(); await f.edit(f.sourcePath);
    await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n"); await f.commit("Implement characterized behavior");
    await f.measure("verification");
    const accepted = await f.dossier(); expect(() => assertEvidenceComplete(accepted.strategy)).not.toThrow();
  }, 60_000);  it.each([true, false])("routes automatic post-submission review passed=%s without waking a terminal Developer", async passed => {
    const f = await connectedPhaseFixture("node_tap", 3, true, { highRisk: true, readiness: "partial" });
    f.ports.automaticAlternativeEvidence = true;
    await f.addTests(); await f.edit(f.sourcePath);
    await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n"); await f.commit("Implement before automatic verification");
    await f.submit("implement", null); await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    const request = state.outbound.find((out: any) => out.message.type === "verification.requested" && out.message.payload.kind === "conditional_evidence");
    expect(request).toMatchObject({ status: "accepted", message: { payload: { phase: "verification", sourceRevision: f.currentHead(), implementationAttemptId: f.original.handle.attemptId } } });
    const args = { runId: "run-1", taskId: "implement", phase: "verification" };
    const observed = await f.verification.inspectAlternative(f.qa, args) as any;
    const judgment = { ...args, review: { observationId: observed.observationId,
      criteria: [{ criterionId: "ac-1", passed, summary: "Independently reviewed committed implementation and accepted criterion" }] } };
    if (!passed) {
      let failure: unknown; try { await f.verification.behavioralEvidence(f.qa, judgment); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HostBehavioralFailure);
      if (!(failure instanceof HostBehavioralFailure)) throw failure;
      await f.runtime.recordPhaseFailure(f.qa, request.message.message_id, failure.message, true, failure.evidence);
      expect((await f.inspect()).status).toBe("escalated");
      expect(() => assertEvidenceComplete((observed.dossier as any).strategy)).toThrow();
      return;
    }
    const result = await f.verification.behavioralEvidence(f.qa, judgment);
    await f.runtime.receiveHerdr(f.envelope("verification.result", result.result, { causation_id: request.message.message_id,
      sender: { role: "qa", agent_id: f.qa.agentId, pane_id: f.qa.paneId }, artifact_references: result.result.evidenceArtifacts }));
    const accepted = await f.dossier(); expect(() => assertEvidenceComplete(accepted.strategy)).not.toThrow();
  }, 60_000);

});
