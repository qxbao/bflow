import { afterEach, expect, it } from "vitest";
import { DelegationRequestSchema, RoleMessageSchema } from "@bflow/contracts";
import { fixture, cleanups } from "../helpers/agentic-integration-fixture.js";
import type { RunRecord } from "../../src/agentic/journal.js";
const reason = "Error: Transport sender binding unavailable (dropped after 5 attempts)";
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it.each(["superseded", "current", "altered_history"])("keeps ingress failure pinned to its %s requirement envelope", async kind => {
  const f = await fixture();
  const original = (await f.runtime.inspect("run-1") as unknown as RunRecord).delegation;
  const revised = DelegationRequestSchema.parse({ ...original, messageId: "revision-2", delegationId: "delegation-revision-2",
    idempotencyKey: "revision-2", metadata: { ...original.metadata, revision: 2, isRequirementChange: true } });
  const envelope = (delegation: typeof original) => RoleMessageSchema.parse({ schema_version: 2,
    message_id: delegation.messageId, correlation_id: delegation.correlationId, run_id: delegation.runId,
    sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: delegation,
    artifact_references: [], occurred_at: delegation.requestedAt, idempotency_key: delegation.idempotencyKey });
  await f.runtime.queueHerdr(envelope(revised));
  const before = await f.runtime.inspect("run-1") as unknown as RunRecord;
  expect(before.delegationHistory).toContainEqual(original);
  const failed = kind === "current" ? revised : kind === "altered_history" ? { ...original, objective: "Unadmitted content" } : original;
  await f.runtime.reportInboundFailure(envelope(failed), reason);
  const after = await f.runtime.inspect("run-1") as unknown as RunRecord;
  if (kind === "superseded") {
    expect(after.status).toBe(before.status);
    expect(after.error).toBeUndefined();
    expect(after.pendingAction).toEqual(before.pendingAction);
    expect(after.ingressDiagnostics).toContainEqual(expect.objectContaining({ messageId: original.messageId, disposition: "reported",
      reason: expect.stringContaining("Superseded requirement revision") }));
  } else expect(after).toMatchObject({ status: "escalated", error: expect.stringContaining("ingress failed") });
});
