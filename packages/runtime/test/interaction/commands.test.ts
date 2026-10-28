import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebCommandSchema, type WebCommand, type WebRunView, type WebOperationResult } from "@bflow/contracts";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { HostStructuredCommands, observeStructuredDecision } from "../../src/interaction/commands.js";
import { projectRun } from "../../src/interaction/views.js";
import { run, state, pending, at } from "./fixtures.js";
import { fixture, now } from "./web-command-fixtures.js";
import { fixture as runtimeFixture, cleanups } from "../helpers/agentic-integration-fixture.js";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { actionVersion } from "../../src/interaction/actions.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); for (const clean of cleanups.splice(0)) await clean(); });
async function setup() {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "web-commands-")); dirs.push(directory);
  const authority = new WebInteractionAuthority("project-1", "host-1", () => now); authority.registerOwnerKey(f.registration);
  const options = { directory, repository: "/repo", sessionId: "host-1", projectId: "project-1" };
  let ready = true, count = 0, loseAck = false;
  let view = projectRun({ state: state([run("run-1", { status: "escalated", pendingAction: pending })]),
    sessionId: "conversation-1", core: new Map(), ready: true, commandsSupported: true, observedAt: at }, "run-1");
  const results = new Map<string, WebOperationResult>();
  const store = new WebOperationStore(options);
  const port = {
    store, authority, conversationSessionId: () => "conversation-1", ready: () => ready,
    run: async () => view,
    session: async () => ({ apiVersion: 1 as const, projectId: "project-1", sessionId: "conversation-1", state: "ready" as const, pendingIntakes: [], blockers: [], updatedAt: at }),
    admit: async (command: WebCommand) => {
      count++;
      const result: WebOperationResult = command.kind === "create_request" ? { kind: "intake", intakeId: "intake-1" } : { kind: "interaction", runId: "run-1", currentRunId: "run-1" };
      results.set(command.commandId, result);
      if (loseAck) throw new Error("Connection lost after durable outbox acceptance");
      return { ok: true as const, value: result };
    },
    reconcile: async (command: WebCommand) => results.has(command.commandId) ? { ok: true as const, value: results.get(command.commandId)! } : undefined,
  };
  return { ...f, options, store, port, service: new HostStructuredCommands(port), count: () => count,
    setView: (value: WebRunView) => { view = value; }, setReady: () => { ready = false; }, loseAck: () => { loseAck = true; }, view };
}
it("no-chat command persists acceptance, calls Conversation once, and replays its exact result", async () => {
  const f = await setup();
  const first = await f.service.execute(f.command, f.proof());
  expect(first).toMatchObject({ ok: true, value: { state: "applied", result: { kind: "intake", intakeId: "intake-1" } } });
  expect(await f.service.execute(f.command, f.proof())).toEqual(first);
  expect(f.count()).toBe(1);
  const changed = WebCommandSchema.parse({ ...f.command, objective: "Different objective" });
  expect(await f.service.execute(changed, f.proof(changed))).toMatchObject({ ok: false, error: { details: { reason: "operation_conflict" } } });
});
it("rejects unauthenticated model identity and inactive host before any effect", async () => {
  const f = await setup();
  expect(await f.service.execute(f.command, { ...f.proof(), authenticatedUser: true })).toMatchObject({ ok: false });
  f.setReady();
  expect(await f.service.execute(f.command, f.proof())).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
  expect(f.count()).toBe(0);
  expect(await f.store.read("local-user-1", f.command.commandId)).toBeUndefined();
});
it.each(["wrong_action", "stale", "terminal", "disabled", "foreign_session"])("refuses %s before resume dispatch", async kind => {
  const f = await setup(), action = f.view.availableActions.find(a => a.kind === "resume")!;
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: f.command.commandId,
    kind: "resume", runId: "run-1", actionId: kind === "wrong_action" ? "wrong" : action.actionId,
    expectedVersion: kind === "stale" ? { revisionToken: "stale" } : action.expectedVersion });
  if (kind === "terminal") f.setView({ ...f.view, sdlcStatus: "completed", availableActions: [] });
  if (kind === "disabled") f.setView({ ...f.view, availableActions: [{ ...action, enabled: false, disabledReason: "delivery_reconciliation_required" }] });
  if (kind === "foreign_session") f.setView({ ...f.view, sessionId: "other" });
  expect(await f.service.execute(command, f.proof(command))).toMatchObject({ ok: false });
  expect(f.count()).toBe(0);
});
it("lost response recovers by observation after restart without another admission", async () => {
  const f = await setup(); f.loseAck();
  expect(await f.service.execute(f.command, f.proof())).toMatchObject({ ok: true, value: { state: "reconciliation_required" } });
  const recovered = new HostStructuredCommands({ ...f.port, store: new WebOperationStore(f.options) });
  expect(await recovered.readOperation("local-user-1", f.command.commandId)).toMatchObject({ ok: true, value: { state: "applied", result: { intakeId: "intake-1" } } });
  expect(await recovered.execute(f.command, f.proof())).toMatchObject({ ok: true, value: { state: "applied" } });
  expect(f.count()).toBe(1);
});
it("unresolved restart intent is never resent and does not infer failure or completion", async () => {
  const f = await setup(); await f.store.accept(f.command, f.proof(), f.port.authority);
  const recovered = new HostStructuredCommands({ ...f.port, store: new WebOperationStore(f.options) });
  expect(await recovered.execute(f.command, f.proof())).toMatchObject({ ok: true, value: { state: "reconciliation_required" } });
  expect(f.count()).toBe(0);
});
it("Runtime web resume rechecks version inside its transaction and never fabricates a physical turn", async () => {
  const f = await runtimeFixture({ intake: false });
  const actionId = `next-${digest(["run-1", pending.sourceMessageId])}`;
  const seeded = run("run-1", { status: "escalated", pendingAction: { ...pending, actionId } });
  seeded.delegation = { ...seeded.delegation, sessionId: "session-1" };
  await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => { state.runs.push(seeded); await save(); });
  f.ports.preflightRoleCapabilities = async () => undefined;
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: fixture().command.commandId,
    kind: "resume", runId: "run-1", actionId, expectedVersion: actionVersion(seeded, "resume") });
  await expect(f.runtime.resumeBlockedRun("run-1", actionId, { webCommand: { ...command, expectedVersion: { revisionToken: "stale" } } } as never)).rejects.toThrow(/version/i);
  await f.runtime.resumeBlockedRun("run-1", actionId, { webCommand: command } as never);
  const snapshot = await f.runtime.inspect() as any;
  const wake = snapshot.outbound.find((out: any) => out.message.payload.kind === "resume_run");
  expect(wake.message.payload).toMatchObject({ automatic: false, webCommandId: command.commandId });
  expect(wake.message.payload).not.toHaveProperty("conversationUserMessageId");
});
it.each(["revision", "generation", "evidence", "target", "expired", "superseded", "invalid_option", "missing_option"])("rejects %s decision review without admitting it", async kind => {
  const f = await setup();
  const version = { revisionToken: "review-1", approvalId: "approval-1", target: { type: "run" as const }, revision: 2, generation: 1, evidenceDigest: "a".repeat(64) };
  const decision = { decisionId: "approval-1", runId: "run-1", kind: "user_decision" as const, status: kind === "superseded" ? "superseded" as const : "pending" as const,
    question: "Choose", options: ["A", "B"], expectedVersion: version, evidence: [], ...(kind === "expired" ? { expiresAt: "2020-01-01T00:00:00.000Z" } : {}) };
  f.setView({ ...f.view, sdlcStatus: "awaiting_approval", decisions: [decision], availableActions: [{ kind: "answer_decision", actionId: "approval-1", enabled: true, expectedVersion: version }] });
  const expectedVersion = { ...version, ...(kind === "revision" ? { revision: 3 } : kind === "generation" ? { generation: 2 } :
    kind === "evidence" ? { evidenceDigest: "b".repeat(64) } : kind === "target" ? { target: { type: "task", taskId: "other" } } : {}) };
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: f.command.commandId,
    kind: "answer_decision", runId: "run-1", decisionId: "approval-1", expectedVersion, outcome: "approved",
    ...(kind === "missing_option" ? {} : { selectedOption: kind === "invalid_option" ? "C" : "A" }) });
  expect(await f.service.execute(command, f.proof(command))).toMatchObject({ ok: false });
  expect(f.count()).toBe(0);
});
it.each(["rejected", "changes_requested"])("requires explicit reason for %s", async outcome => {
  const f = await setup();
  expect(await f.service.execute({ apiVersion: 1, projectId: "project-1", commandId: f.command.commandId,
    kind: "answer_decision", runId: "run-1", decisionId: "approval-1", outcome,
    expectedVersion: { revisionToken: "review-1", approvalId: "approval-1", target: { type: "run" }, revision: 1, generation: 0, evidenceDigest: "a".repeat(64) } }, f.proof())).toMatchObject({ ok: false });
  expect(f.count()).toBe(0);
});
it("observes a definitive rejected decision admission even without an applied Runtime inbox", async () => {
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: fixture().command.commandId,
    kind: "answer_decision", runId: "run-1", decisionId: "approval-1", outcome: "rejected", reason: "Feedback",
    expectedVersion: { revisionToken: "review-1", approvalId: "approval-1", target: { type: "run" }, revision: 1, generation: 0, evidenceDigest: "a".repeat(64) } });
  const rejected = { ok: false as const, error: { code: "validation" as const, retryable: false as const, message: "Exact review refused" } };
  expect(await observeStructuredDecision(command as never, rejected, [], async () => { throw new Error("No effect should be queried"); })).toEqual(rejected);
});
it("observes Runtime rejection of the exact decision instead of waiting forever", async () => {
  const f = await setup(), command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: f.command.commandId,
    kind: "answer_decision", runId: "run-1", decisionId: "approval-1", outcome: "rejected", reason: "Feedback",
    expectedVersion: { revisionToken: "review-1", approvalId: "approval-1", target: { type: "run" }, revision: 1, generation: 0, evidenceDigest: "a".repeat(64) } });
  const message = { schema_version: 2, message_id: "decision-message", correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", artifact_references: [], idempotency_key: "decision-message",
    payload: { schemaVersion: 2, approvalId: "approval-1", runId: "run-1", sessionId: "conversation-1", target: { type: "run" }, revision: 1, generation: 0,
      decision: "rejected", reason: "Feedback", decidedBy: "local-user-1", decidedAt: at, feedbackArtifacts: [], idempotencyKey: `web-decision-${command.commandId}` } };
  expect(await observeStructuredDecision(command as never, undefined, [{ status: "rejected", message }], async () => f.view))
    .toMatchObject({ ok: false, error: { details: { reason: "stale_version" } } });
});
it("closes a queued decision when authoritative run cancellation prevents its effect", async () => {
  const f = await setup(), command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: f.command.commandId,
    kind: "answer_decision", runId: "run-1", decisionId: "approval-1", outcome: "approved",
    expectedVersion: { revisionToken: "review-1", approvalId: "approval-1", target: { type: "run" }, revision: 1, generation: 0, evidenceDigest: "a".repeat(64) } });
  expect(await observeStructuredDecision(command as never, undefined, [], async () => ({ ...f.view, sdlcStatus: "cancelled", availableActions: [] })))
    .toMatchObject({ ok: false, error: { details: { reason: "stale_version" } } });
});
