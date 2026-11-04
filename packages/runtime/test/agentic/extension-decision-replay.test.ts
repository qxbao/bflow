import { expect, it, vi } from "vitest";
import { ApprovalDecisionSchema } from "@bflow/contracts";
import { AgenticJournal, record } from "../../src/agentic/journal.js";
import { directorExtensionFixture, extensionDelegation } from "../helpers/director-extension.js";

it("supersedes an inapplicable queued receipt and still applies the following valid receipt", async () => {
  const e = await directorExtensionFixture(), host = await e.create({ admissionOrigin: "conversation" });
  await host.admit(extensionDelegation("run-native", false));
  await host.start({ kind: "analysis", runId: "run-native", intake: e.intake, packPin: e.pin }); await host.drive("run-native");
  const request = (await host.pendingApprovals())[0]!;
  const valid = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: request.runId,
    sessionId: request.sessionId, target: request.target, revision: request.revision, generation: request.generation,
    decision: "rejected", decidedBy: "owner", decidedAt: new Date().toISOString(), reason: "Need revisions", feedbackArtifacts: [],
    idempotencyKey: "valid-owner-receipt", metadata: request.metadata });
  const stale = ApprovalDecisionSchema.parse({ ...valid, approvalId: "obsolete-approval", idempotencyKey: "obsolete-receipt" });
  const journal = new AgenticJournal(e.options.journalDirectory, e.a.repo);
  await journal.exclusive(async (state, save) => {
    const payload = record(state.inbox[0]!.message.payload), route = record(payload.route);
    state.inbox[0]!.message.payload = { ...payload, route: { ...route, decisions: [{ decision: stale, state: "queued" }, { decision: valid, state: "queued" }] } } as any;
    await save();
  });
  await expect(host.drive("run-native")).resolves.toMatchObject({ extensionStatus: "needs_revision", queuedDecisions: [] });
  const receipts = await journal.exclusive(async state => record(record(state.inbox[0]!.message.payload).route).decisions);
  expect(receipts).toMatchObject([{ state: "superseded" }, { state: "applied" }]);
  const apply = vi.spyOn(e.analysis, "applyHumanDecision");
  await (await e.create({ admissionOrigin: "conversation" })).drive("run-native");
  expect(apply).not.toHaveBeenCalled();
});
