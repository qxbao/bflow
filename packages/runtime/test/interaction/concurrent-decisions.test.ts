import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { FileConversationContextStore } from "@bflow/conversation";
import { WebCommandSchema } from "@bflow/contracts";
import { cleanups, unwrap } from "../helpers/agentic-integration-fixture.js";
import { structuredHostFixture } from "./structured-host-fixture.js";
import { HostStructuredCommands } from "../../src/interaction/commands.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { AgenticJournal } from "../../src/agentic/journal.js";
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("form admission reaches actual Runtime once with explicit criteria and no native/model turn", async () => {
  const f = await structuredHostFixture();
  const runId = await f.create();
  const state = await f.runtime.inspect() as any;
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]).toMatchObject({ runId, coreCreated: false, delegation: {
    acceptanceCriteria: [{ description: "Report opens", verificationMethod: "unit_test" }] } });
  expect(state.outbound.filter((out: any) => out.message.type === "delegation.request")).toHaveLength(1);
  expect(await f.receipts.conversationTurns()).toEqual([]);
  expect((await f.chat.getContext() as any).messages).toEqual([]);
});
it("native and web opposite decisions yield one durable human decision and one original outbox", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "approved" });
  await Promise.all([
    f.commands.execute(command, f.proof(command)),
    f.chat.handleTrustedApproval({ sessionId: "session-1", messageId: "native-fixture-message", content: `${decision.decisionId}: reject native`,
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" } }),
  ]);
  await f.chat.flush();
  const state = await f.runtime.inspect() as any;
  const decisions = state.outbound.filter((out: any) => out.message.type === "approval.decision");
  expect(decisions).toHaveLength(1);
  const native = await f.receipts.humanDecisions(), web = await f.store.humanDecisions("session-1");
  expect(native.length + web.length).toBe(1);
  expect(await f.ports.authorizeHuman(decisions[0].message.payload)).toBe(true);
});
it("actual cancellation reuses Runtime controls and cannot be followed by a stale approval", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  const view = await f.runView(runId), action = view.availableActions.find(action => action.kind === "cancel")!;
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "cancel", runId,
    expectedVersion: action.expectedVersion, reason: "User cancels exact run" });
  expect(unwrap(await f.commands.execute(command, f.proof(command)))).toMatchObject({ state: "applied" });
  expect(await f.runtime.inspect(runId)).toMatchObject({ cancelled: true });
  const stale = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "approved" });
  expect(await f.commands.execute(stale, f.proof(stale))).toMatchObject({ ok: false });
});
it("changes requested waits for actual Runtime effect then returns the real follow-up lineage", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "changes_requested", reason: "Refine the report" });
  expect(unwrap(await f.commands.execute(command, f.proof(command)))).toMatchObject({ state: "running" });
  const state = await f.runtime.inspect() as any;
  const out = state.outbound.find((out: any) => out.message.type === "approval.decision");
  await f.runtime.receiveHerdr(out.message);
  const recovered = new HostStructuredCommands({ ...f.port, store: new WebOperationStore(f.options) });
  expect(unwrap(await recovered.readOperation("local-user-1", command.commandId))).toMatchObject({ state: "applied", result: {
    runId, currentRunId: `${runId}-r2`, continuedAsRunId: `${runId}-r2` } });
  expect((await f.runtime.inspect() as any).runs).toHaveLength(2);
  expect(await recovered.execute(command, f.proof(command))).toMatchObject({ ok: true, value: { state: "applied" } });
  expect((await f.runtime.inspect() as any).runs).toHaveLength(2);
});
it("loss after real Conversation/Runtime outbox acceptance replays the committed operation without resubmitting", async () => {
  const f = await structuredHostFixture();
  const command = WebCommandSchema.parse({ ...f.signer.command, commandId: randomUUID() });
  const lost = new HostStructuredCommands({ ...f.port, admit: async (...args) => { await f.port.admit(...args); throw new Error("Lost acknowledgement"); } });
  expect(unwrap(await lost.execute(command, f.proof(command)))).toMatchObject({ state: "reconciliation_required" });
  const recovered = new HostStructuredCommands({ ...f.port, store: new WebOperationStore(f.options) });
  expect(unwrap(await recovered.readOperation("local-user-1", command.commandId))).toMatchObject({ state: "applied" });
  expect((await f.runtime.inspect() as any).runs).toHaveLength(1);
  expect(await recovered.execute(command, f.proof(command))).toMatchObject({ ok: true, value: { state: "applied" } });
  expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "delegation.request")).toHaveLength(1);
});
it("uncertain human-receipt crash reserves its approval against new web and native opposite commands", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  f.chat.configureStructuredInteraction({ ...f.callbacks, approval: async (...args) => {
    await f.callbacks.approval(...args); throw new Error("Crash after human receipt before outbox acceptance");
  } });
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "approved" });
  expect(unwrap(await f.commands.execute(command, f.proof(command)))).toMatchObject({ state: "reconciliation_required" });
  f.chat.configureStructuredInteraction(f.callbacks);
  const opposite = WebCommandSchema.parse({ ...command, commandId: randomUUID(), outcome: "rejected", reason: "Opposite tab" });
  await f.commands.execute(opposite, f.proof(opposite));
  await f.chat.handleTrustedApproval({ sessionId: "session-1", messageId: "native-opposite", content: `${decision.decisionId}: reject native`,
    provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" } });
  expect(await f.store.humanDecisions("session-1")).toHaveLength(1);
  expect(await f.receipts.humanDecisions()).toHaveLength(0);
  const state = await f.runtime.inspect() as any;
  expect(state.outbound.filter((out: any) => out.message.type === "approval.decision")).toHaveLength(0);
});
it("projects and answers a run-scoped clarification on the same actual run", async () => {
  const f = await structuredHostFixture(), runId = await f.create();
  const context = unwrap(await f.contextStore.load("session-1"))!;
  const workflow = Object.values(context.workflows).find(workflow => workflow.runId === runId)!;
  const pending = { correlationId: workflow.correlationId, originalRequestText: workflow.objective, accumulatedDetails: [], unresolvedQuestions: ["Which format?"],
    draft: { title: workflow.title, objective: workflow.objective, kind: "feature" as const, sddLevel: "full" as const, priority: "normal" as const,
      scopeDefined: false, isLargeTask: false, affectedPaths: [], acceptanceCriteriaDescriptions: [],
      acceptanceCriteria: [{ description: "Report opens", verificationMethod: "unit_test" as const }], isRequirementChange: true },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  unwrap(await f.contextStore.save({ ...context, pendingClarifications: { [workflow.correlationId]: pending } }));
  await f.reopenConversation();
  const view = await f.runView(runId);
  expect(view.clarifications).toHaveLength(1);
  const question = view.clarifications[0]!;
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_clarification",
    runId, questionId: question.questionId, expectedVersion: question.expectedVersion, answer: "PDF" });
  expect(unwrap(await f.commands.execute(command, f.proof(command)))).toMatchObject({ state: "applied", result: { runId } });
  const snapshot = await f.runtime.inspect() as any;
  expect(snapshot.runs).toHaveLength(1);
  expect(snapshot.runs[0].delegation.objective).toContain("PDF");
  expect(snapshot.runs[0].delegation.acceptanceCriteria[0].description).toBe("Report opens");
});
it("recovers cancellation after actual control/outbox commit before Conversation result persistence", async () => {
  const f = await structuredHostFixture(), runId = await f.create();
  const action = (await f.runView(runId)).availableActions.find(action => action.kind === "cancel")!;
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "cancel", runId,
    expectedVersion: action.expectedVersion, reason: "Cancel via form" });
  const save = FileConversationContextStore.prototype.save;
  let crash = true;
  const fault = vi.spyOn(FileConversationContextStore.prototype, "save").mockImplementation(async function(snapshot) {
    if (crash && snapshot.structuredInteractions?.[command.commandId]?.state === "applied") {
      crash = false; throw new Error("Crash after Runtime effect before Conversation result");
    }
    return save.call(this, snapshot);
  });
  try { expect(unwrap(await f.commands.execute(command, f.proof(command)))).toMatchObject({ state: "reconciliation_required" }); }
  finally { fault.mockRestore(); }
  expect(await f.runtime.inspect(runId)).toMatchObject({ cancelled: true });
  expect(await f.chat.readStructuredInteraction(command.commandId)).toBeUndefined();
  const recovered = new HostStructuredCommands({ ...f.port, store: new WebOperationStore(f.options) });
  expect(unwrap(await recovered.readOperation("local-user-1", command.commandId))).toMatchObject({ state: "applied", result: { runId } });
  expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.metadata?.action === "cancel")).toHaveLength(1);
});
it("native first keeps its exact decision when an opposite web answer arrives later", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  await f.chat.handleTrustedApproval({ sessionId: "session-1", messageId: "native-first", content: `${decision.decisionId}: reject native`,
    provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" } });
  expect(await f.receipts.humanDecisions()).toHaveLength(1);
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "approved" });
  await f.commands.execute(command, f.proof(command));
  expect(await f.store.humanDecisions("session-1")).toHaveLength(0);
  const state = await f.runtime.inspect() as any;
  const decisions = state.outbound.filter((out: any) => out.message.type === "approval.decision");
  expect(decisions).toHaveLength(1);
  expect(decisions[0].message.payload.decision).toBe("rejected");
});
it("concurrent cancel and approval leave no approval dispatch or Developer work after cancellation", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  const action = (await f.runView(runId)).availableActions.find(action => action.kind === "cancel")!;
  const cancel = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "cancel", runId,
    expectedVersion: action.expectedVersion, reason: "Cancel while review is open" });
  const answer = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "approved" });
  const [cancelResult] = await Promise.all([f.commands.execute(cancel, f.proof(cancel)), f.commands.execute(answer, f.proof(answer))]);
  expect(unwrap(cancelResult)).toMatchObject({ state: "applied" });
  const state = await f.runtime.inspect() as any;
  expect(state.runs[0]).toMatchObject({ cancelled: true, coreCreated: false });
  expect(state.outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(0);
  expect(state.outbound.filter((out: any) => out.message.type === "approval.decision" && ["queued", "sending", "accepted"].includes(out.status))).toHaveLength(0);
});
it("recovers a committed follow-up before Runtime can persist the applied inbox marker", async () => {
  const f = await structuredHostFixture(), runId = await f.create(), decision = await f.approval(runId);
  const command = WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: randomUUID(), kind: "answer_decision",
    runId, decisionId: decision.decisionId, expectedVersion: decision.expectedVersion, outcome: "changes_requested", reason: "Refine report" });
  expect(unwrap(await f.commands.execute(command, f.proof(command)))).toMatchObject({ state: "running" });
  const state = await f.runtime.inspect() as any;
  const message = state.outbound.find((out: any) => out.message.type === "approval.decision").message;
  const exclusive = AgenticJournal.prototype.exclusive;
  let crash = true;
  const fault = vi.spyOn(AgenticJournal.prototype, "exclusive").mockImplementation(function(action) {
    return exclusive.call(this, (snapshot, save) => action(snapshot, async () => {
      await save();
      if (crash && snapshot.runs.some(run => run.runId === runId && run.supersededBy) &&
        snapshot.inbox.some(inbox => inbox.message.message_id === message.message_id && inbox.status === "received")) {
        crash = false; throw new Error("Crash after follow-up commit before inbox applied");
      }
    }));
  });
  try { await expect(f.runtime.receiveHerdr(message)).rejects.toThrow(/Crash after follow-up/); }
  finally { fault.mockRestore(); }
  const recovered = new HostStructuredCommands({ ...f.port, store: new WebOperationStore(f.options) });
  expect(unwrap(await recovered.readOperation("local-user-1", command.commandId))).toMatchObject({ state: "applied",
    result: { runId, currentRunId: `${runId}-r2`, continuedAsRunId: `${runId}-r2` } });
  expect((await f.runtime.inspect() as any).runs).toHaveLength(2);
});
