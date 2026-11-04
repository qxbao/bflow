import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ApprovalDecisionSchema } from "@bflow/contracts";
import { directorExtensionFixture, extensionDelegation } from "../helpers/director-extension.js";

it("binds an unchanged plain Web receipt to the exact pending native request", async () => {
  const e = await directorExtensionFixture(), host = await e.create({ admissionOrigin: "conversation" });
  await host.admit(extensionDelegation("run-native", false));
  await host.start({ kind: "analysis", runId: "run-native", intake: e.intake, packPin: e.pin }); await host.drive("run-native");
  const request = (await host.pendingApprovals())[0]!;
  const receipt = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: request.runId,
    sessionId: request.sessionId, target: request.target, revision: request.revision, generation: request.generation,
    decision: "rejected", decidedBy: "owner", decidedAt: new Date().toISOString(), reason: "Need revisions", feedbackArtifacts: [],
    idempotencyKey: `web-decision-${randomUUID()}` });
  for (const invalid of [{ ...receipt, revision: receipt.revision + 1 }, { ...receipt, generation: receipt.generation + 1 },
    { ...receipt, target: { type: "run" } }, { ...receipt, metadata: { approvalScope: "foreign" } },
    { ...receipt, idempotencyKey: "model-approval" }]) await expect(host.decide(ApprovalDecisionSchema.parse(invalid))).rejects.toThrow();
  await expect(host.decide(receipt)).resolves.toBeUndefined();
  expect(await host.drive("run-native")).toMatchObject({ extensionStatus: "needs_revision", appliedDecisions: [receipt] });
  const events = await e.a.runStore.readEvents("run-native", { limit: 100 });
  if (!events.ok) throw new Error(events.error.message);
  expect(events.value.items.filter(event => event.type === "approval.decided").map(event => event.payload)).toEqual([receipt]);
  expect(receipt.metadata).toBeUndefined();
});
