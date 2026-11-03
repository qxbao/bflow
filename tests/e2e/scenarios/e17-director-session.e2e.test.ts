import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ApprovalDecisionSchema, DirectorWaitResultSchema, WebCommandSchema, type ApprovalDecision } from "@bflow/contracts";
import { webCommandFingerprint } from "@bflow/contracts/web-host";
import { createDirectorSession, documentationSpecification, singleTaskWorkflow, type DirectorSession } from "../helpers/director-session.js";

// B2a Task 10: a Director-mode session (manifest v3) end to end with fake specialists. Evidence level: source + fake runner.

const sessions: DirectorSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.cleanup(); });

const LEGACY_REFUSAL = "Run v2 chỉ đọc trong phiên Director; hủy rồi tạo lại bằng start_work";
const CRITERION = "The requested outcome is independently verifiable";
const NOW = () => new Date().toISOString();

/** The Gateway's projection token (localeCompare key order), as the Web client echoes it back. */
function token(value: unknown): string {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical)}]` : v !== null && typeof v === "object"
    ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)}}`
    : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function principalFor(command: unknown) {
  const parsed = WebCommandSchema.parse(command);
  return { schemaVersion: 1, source: "local_web", issuerId: "issuer-1", keyId: "key-1", principalId: "human-1", browserSessionId: "browser-1",
    projectId: parsed.projectId, hostSessionId: "session-1", capability: "user_interaction", commandId: parsed.commandId,
    commandDigest: webCommandFingerprint(parsed), issuedAt: NOW(), expiresAt: new Date(Date.now() + 30_000).toISOString(), nonce: randomUUID(),
    signature: { algorithm: "ed25519", value: `${"A".repeat(86)}==` } };
}

/** A user message recorded through the Director tool, then `start_work` through the real DirectorTools with the real token. */
async function startWork(session: DirectorSession, directorToken: string) {
  const noted = await session.endpoint.call(directorToken, "director_note_user_message", { text: "Cập nhật hướng dẫn guide.md" }) as { seq: number };
  const started = await session.endpoint.call(directorToken, "start_work", { title: "Cập nhật hướng dẫn", objective: "Hướng dẫn guide.md phản ánh kết quả yêu cầu",
    acceptanceCriteria: [{ description: CRITERION, verificationMethod: "manual_review" }], sddLevel: "lightweight", userMessageSeq: noted.seq }) as
    { runId: string; correlationId: string; status: string };
  expect(started.status).toBe("queued");
  session.trackRun(started.runId, started.correlationId);
  return started;
}

/**
 * Answers the pending approval of `runId` through the structured gateway (`answer_decision`) exactly as the Web would, then lets
 * Runtime deliver and apply the pane-less approval.decision. Returns the ApprovalDecision the gateway built.
 */
async function answerDecision(session: DirectorSession, runId: string, authorized: ApprovalDecision[]): Promise<ApprovalDecision> {
  const waiting = await session.inspect(runId);
  expect(waiting.status).toBe("awaiting_approval");
  await session.chat.reconcileApprovals();
  const pending = (await session.chat.getContext() as any).pendingApprovals[waiting.approval.approvalId];
  expect(pending).toBeDefined();
  const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "answer_decision", runId,
    decisionId: pending.approvalId, outcome: "approved",
    expectedVersion: { revisionToken: token(pending), approvalId: pending.approvalId, target: pending.target, revision: pending.revision,
      generation: pending.generation, evidenceDigest: token(pending.evidence) } });
  const before = session.humanDecisions.length;
  const answered = await session.chat.handleStructuredInteraction(command, principalFor(command));
  expect(answered.ok).toBe(true);
  expect(session.humanDecisions).toHaveLength(before + 1);
  const decision = session.humanDecisions.at(-1)!;
  expect(decision).toMatchObject({ approvalId: waiting.approval.approvalId, runId, decision: "approved", decidedBy: "human-1" });
  await session.runtime.flushOutbound();
  // The fake human authentication accepted exactly the decision the gateway recorded (Runtime may re-check the same decision).
  const accepted = authorized.filter(item => item.approvalId === decision.approvalId);
  expect(accepted.length).toBeGreaterThan(0);
  for (const item of accepted) expect(item).toEqual(decision);
  expect((await session.inspect(runId)).decision).toMatchObject({ approvalId: decision.approvalId, decision: "approved" });
  return decision;
}

describe("Scenario E17 — Director session (manifest v3, fake runner)", () => {
  it("runs Director start_work → propose_workflow → human approvals → Developer → Reviewer → mailbox wake → completed", async () => {
    const authorized: ApprovalDecision[] = [];
    const session = await createDirectorSession({ humanApproval: true, authorizeHuman: async decision => {
      // Fake human authentication: only a decision the structured gateway recorded for a human, byte-for-byte.
      const parsed = ApprovalDecisionSchema.parse(decision);
      const exact = session.humanDecisions.some(recorded => isDeepStrictEqual(ApprovalDecisionSchema.parse(recorded), parsed));
      if (exact) authorized.push(decision);
      return exact;
    } });
    sessions.push(session);

    // Manifest v3: no Conversation/Coordinator pane, a running progress pane is the attach target.
    const manifest = session.panes.manifest();
    expect(manifest.schemaVersion).toBe(3);
    if (manifest.schemaVersion !== 3) throw new Error("unreachable");
    expect(manifest.progressPane).toMatchObject({ phase: "running", paneId: "pane-progress" });
    expect(manifest.attachTarget).toMatchObject({ role: "progress", paneId: "pane-progress" });
    expect(manifest.panes.some(pane => ["conversation", "coordinator"].includes(pane.role))).toBe(false);

    const registered = await session.endpoint.register({ provider: "claude" });
    expect(registered.token).toMatch(/^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{16,256}$/);
    const { runId } = await startWork(session, registered.token);
    expect(await session.inspect(runId)).toMatchObject({ status: "intake", delegation: { requestedBy: "director" } });

    // propose_workflow under the Director principal (the endpoint's Coordinator port).
    const specificationId = (await session.inspect(runId)).delegation.specificationId as string;
    await session.endpoint.call(registered.token, "propose_workflow", { runId, specification: documentationSpecification(runId, specificationId),
      definition: singleTaskWorkflow() });
    expect((await session.inspect(runId)).status).toBe("awaiting_approval");
    await session.runtime.flushOutbound();

    // The design-approval card reached the mailbox for the user audience with its #n code.
    const designApproval = (await session.inspect(runId)).approval;
    const userItems = await session.endpoint.readMailbox({ audience: "user" });
    const card = userItems.find(item => item.type === "approval.request" && item.runId === runId);
    expect(card).toMatchObject({ audience: "user", code: expect.stringMatching(/^#[1-9]\d*$/) });
    expect((await session.receipts.noticeAliases()).approvalShortIds[card!.code!]).toBe(designApproval.approvalId);

    await answerDecision(session, runId, authorized);
    expect((await session.inspect(runId)).status).toBe("implementing");

    // Developer fake submits (with the Tester's independent evidence); the Reviewer fake answers every independent review the
    // task and workflow verification send it over the transport, until the run waits for the delivery approval.
    await session.runtime.tick();
    await session.evidence(runId);
    await session.submit(runId);
    await session.runtime.flushOutbound();
    let reviews = 0;
    for (let pass = 0; pass < 4 && (await session.inspect(runId)).status !== "awaiting_approval"; pass++) reviews += await session.tickWithReviewer();
    expect(reviews).toBeGreaterThan(0);
    const verified = await session.inspect(runId);
    expect(verified).toMatchObject({ status: "awaiting_approval", approvalKind: "delivery", tasks: [{ cycle: { status: "passed" } }] });

    // The Director asks the Reviewer to look at the delivered change; the Reviewer fake's verdict wakes the Director through
    // its mailbox (a gate verdict is consumed by the waiting gate and wakes no one), and director_wait returns that wake.
    const asked = await session.endpoint.call(registered.token, "request_specialist", { runId, role: "reviewer",
      objective: "Xem lại thay đổi đã giao cho guide.md và cho biết có đạt tiêu chí không", requiredCapabilities: ["review"] }) as { message_id: string };
    await session.runtime.flushOutbound();
    await session.reviewerReplies(runId, asked.message_id, { status: "completed", summary: "Đạt: guide.md đã cập nhật đúng tiêu chí ac-1" });
    await session.runtime.flushOutbound();
    const waited = DirectorWaitResultSchema.parse(await session.endpoint.call(registered.token, "director_wait", { cursor: registered.cursor, timeoutMs: 1000 }));
    expect(waited.timedOut).toBe(false);
    expect((waited.mailbox ?? []).some(item => item.kind === "specialist_result_ready" && item.runId === runId && item.audience === "director" &&
      item.fromRole === "runtime")).toBe(true);
    // director_wait only returns the Director audience; the user cards stay in the user audience.
    expect((waited.mailbox ?? []).every(item => item.audience === "director")).toBe(true);

    // Delivery approval, then the run completes.
    await answerDecision(session, runId, authorized);
    await session.runtime.tick();
    expect((await session.inspect(runId)).status).toBe("completed");

    // No Herdr submission was ever addressed to the replaced Coordinator or Conversation roles.
    expect(session.transport.sentRequests.length).toBeGreaterThan(0);
    expect(session.transport.sentRequests.some(request => ["coordinator", "conversation"].includes(request.role))).toBe(false);
    expect(session.transport.messages().some(message => ["coordinator", "conversation"].includes(message.recipient.role))).toBe(false);
    expect(session.transport.messages().some(message => message.recipient.role === "reviewer" && message.type === "verification.requested")).toBe(true);
    expect(session.director.deliveries.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(session.journalDirectory, "state.json"), "utf8")).version).toBe(8);
  }, 120_000);

  it("does not auto-resume a Director run while the Director is absent and resumes it once present", async () => {
    const session = await createDirectorSession();
    sessions.push(session);
    const registered = await session.endpoint.register({ provider: "claude" });
    const { runId } = await startWork(session, registered.token);
    await session.runtime.reportRunStalled(runId, "episode-1");
    expect(await session.inspect(runId)).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", recovery: "auto_resume" } });
    session.advanceClock(31_000);

    await session.endpoint.revoke();
    expect(await session.director.present()).toBe(false);
    expect(await session.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await session.inspect(runId)).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator" } });

    const again = await session.endpoint.register({ provider: "claude" });
    expect(await session.director.present()).toBe(true);
    expect(await session.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    await session.runtime.flushOutbound();
    const waited = DirectorWaitResultSchema.parse(await session.endpoint.call(again.token, "director_wait", { timeoutMs: 1000 }));
    expect((waited.mailbox ?? []).some(item => item.kind === "resume_run" && item.runId === runId)).toBe(true);
    expect(session.transport.sentRequests).toEqual([]);
  }, 60_000);

  it("opens a real v7 journal with an implementing v2 run read-only: inspect works, propose_workflow is refused, cancel works", async () => {
    const raw = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../packages/runtime/test/fixtures/journal-v7-real.json"), "utf8"));
    expect(raw.version).toBe(7);
    const legacy = raw.runs[0];
    expect(legacy.delegation.requestedBy).toBe("conversation");
    // The recorded v2 run as it stood while implementing: the workflow-level integration, verification and delivery-approval
    // fields it gained after implementing are not there yet; everything else is the real v7 record. The fixture holds the journal
    // only: its Git worktree records point at the recording machine's Git orchestrator state, which is not part of it, so they are
    // dropped (the session helper seeds the RunStore from the run's own definition).
    const { integrationKey: _i, workflowChange: _c, workflowCycle: _y, workflowVerificationPlan: _p, workflowVerificationPending: _v,
      approval: _a, approvalKind: _k, decision: _d, ...implementing } = legacy;
    expect(_k).toBe("delivery");
    const journal = { ...raw, runs: [{ ...implementing, status: "implementing", tasks: legacy.tasks.map((task: object) => ({ ...task, worktrees: [] })) }] };
    const session = await createDirectorSession({ journal });
    sessions.push(session);
    const registered = await session.endpoint.register({ provider: "claude" });
    const runId = legacy.runId as string;

    expect(await session.endpoint.call(registered.token, "inspect", { runId })).toMatchObject({ runId, status: "implementing" });
    await expect(session.endpoint.call(registered.token, "propose_workflow", { runId, specification: documentationSpecification(runId, legacy.delegation.specificationId),
      definition: singleTaskWorkflow() })).rejects.toThrow(LEGACY_REFUSAL);
    expect((await session.inspect(runId)).status).toBe("implementing");
    await session.endpoint.call(registered.token, "cancel", { runId, reason: "Tạo lại bằng start_work" });
    expect(await session.inspect(runId)).toMatchObject({ cancelled: true });
  }, 60_000);
});
