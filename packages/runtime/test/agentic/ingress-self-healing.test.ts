import { afterEach, describe, expect, it } from "vitest";
import { AgenticJournal, type JournalState } from "../../src/agentic/journal.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { cleanups, connectedPhaseFixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

/**
 * Live regression (2026-10-28, run-663f1379…): the host refused the QA's Red prompt ingress five times. QA had received the
 * prompt and started measuring, but the refusal escalated the run, so the measurement was rejected as "paused"; after the
 * resume the verifier request stayed released without evidence or failure and nobody re-drove Red, so the run was cancelled.
 */
const INGRESS = "Error: Inbound provider prompt is not an exact Runtime outbox delivery (message_id matched (accepted); mismatch: session) (dropped after 5 attempts)";

async function redRequested() {
  const f = await connectedPhaseFixture("node_tap");
  await f.addTests();
  const { pending } = await f.request("red");
  return { f, pending };
}
async function editJournal(f: Awaited<ReturnType<typeof connectedPhaseFixture>>, change: (state: JournalState) => void) {
  const journal = new AgenticJournal(f.runtimeOptions.journalDirectory, f.runtimeOptions.repositoryPath);
  await journal.exclusive(async (state, save) => { change(state); await save(); });
}
async function measureRed(f: Awaited<ReturnType<typeof connectedPhaseFixture>>, requestId: string) {
  const completed = await f.verification.behavioralEvidence(f.qa, { runId: "run-1", taskId: "implement", phase: "red" });
  await f.runtime.receiveHerdr(f.envelope("verification.result", completed.result, { causation_id: requestId,
    sender: { role: "qa", agent_id: f.qa.agentId, pane_id: f.qa.paneId }, artifact_references: completed.result.evidenceArtifacts }));
  return completed.result;
}

describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("ingress refusal self-healing", () => {
  it("keeps the run going when a specialist's ingress is refused while its delivery is accepted and leased, and records the diagnostic", async () => {
    const { f, pending } = await redRequested();
    await f.runtime.reportInboundFailure(pending.message, INGRESS);
    const run = await f.inspect();
    expect(run.status).toBe("implementing");
    expect(run.pendingAction).toBeUndefined();
    expect(run.ingressDiagnostics).toEqual([expect.objectContaining({ messageId: pending.message.message_id, type: "verification.requested",
      recipientRole: "qa", disposition: "continued", reason: expect.stringContaining("mismatch: session") })]);
    // The verifier measures normally: its own tools still re-check the accepted delivery, binding and lease.
    expect((await measureRed(f, pending.message.message_id)).status).toBe("failed");
    const evidence = (await f.inspect()).tasks[0].spec.strategy.metadata.tddEvidence;
    expect(evidence.map((item: any) => item.metadata.conditionalTdd.phase)).toEqual(["red"]);
  }, 120_000);

  it("still escalates when no accepted, leased delivery backs the refused ingress, and records that disposition", async () => {
    const { f } = await redRequested();
    const stray = f.envelope("verification.requested", { kind: "conditional_evidence", phase: "red" },
      { message_id: "never-delivered", recipient: { role: "qa" }, sender: { role: "coordinator" } });
    await f.runtime.reportInboundFailure(stray, INGRESS);
    const run = await f.inspect();
    expect(run.status).toBe("escalated");
    expect(run.ingressDiagnostics).toEqual([expect.objectContaining({ messageId: "never-delivered", disposition: "escalated" })]);
  }, 120_000);

  it("lets an explicit resume re-drive a verifier request that was released without evidence or a recorded failure", async () => {
    const { f, pending } = await redRequested();
    const id = pending.message.message_id;
    // The verifier turn ended without measuring (its lease expired and the request was released), after the ingress refusal escalated.
    await editJournal(f, state => {
      const out = state.outbound.find(item => item.message.message_id === id)!;
      out.lease = { ...out.lease!, acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
    });
    await f.runtime.reportInboundFailure(pending.message, INGRESS);
    expect((await f.inspect()).status).toBe("escalated");
    // Released means the verifier capacity was given back in the Registry too, exactly as the outbox release does.
    const lease = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.message_id === id).lease;
    expect((await f.ports.registry.releaseLease({ leaseId: lease.leaseId, fencingToken: lease.fencingToken, expectedVersion: lease.version,
      releasedAt: new Date().toISOString(), idempotencyKey: `test-release-${lease.leaseId}` })).ok).toBe(true);
    await editJournal(f, state => { state.outbound.find(item => item.message.message_id === id)!.status = "released"; });

    const action = (await f.inspect()).pendingAction;
    // The host proves the Coordinator's capabilities before any resume; the fixture's panes are ready.
    f.ports.preflightRoleCapabilities = async () => undefined;
    await f.runtime.resumeBlockedRun("run-1", action.actionId);
    await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    const orphan = state.outbound.find((out: any) => out.message.message_id === id);
    expect(orphan.phaseFailure).toMatchObject({ repairable: false, applied: true, retryAuthorized: true, summary: expect.stringMatching(/no measurement/i) });
    const retry = state.outbound.find((out: any) => out.message.type === "task.status" && out.message.payload.kind === "policy_phase_outcome" &&
      out.message.payload.phase === "red" && out.message.payload.status === "retry");
    expect(retry).toBeDefined();
    expect(retry.message.recipient.role).toBe("developer");

    // The Developer asks again; a fresh independent measurement of the same revision is accepted as Red.
    const again = await f.request("red");
    expect(again.pending.message.message_id).not.toBe(id);
    expect((await measureRed(f, again.pending.message.message_id)).status).toBe("failed");
    expect((await f.inspect()).tasks[0].spec.strategy.metadata.tddEvidence).toHaveLength(1);
  }, 120_000);
});
