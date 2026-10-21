import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalReceiptJson, DelegationRequestSchema, RoleMessageSchema } from "@bflow/contracts";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { startHerdrReceiptIngress } from "../../src/agentic/herdr-ingress.js";
import { inspectNativeDelivery } from "../../src/agentic/native-delivery-status.js";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { draft } from "../../../specification/test/fixtures.js";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-native-reconcile-"))); roots.push(root);
  const directory = join(root, "receipts");
  const receipts = new HostReceiptJournal(directory, root, "session");
  const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "architect-result", correlation_id: "correlation", run_id: "run",
    causation_id: "architect-delegation", sender: { role: "architect", agent_id: "architect", pane_id: "pane-a" },
    recipient: { role: "coordinator" }, type: "spec.draft", payload: { summary: "PRIVATE_RESULT" }, artifact_references: [] });
  return { root, directory, receipts, message };
}

describe("native delivery reconciliation", () => {
  it("does not create a missing private receipt directory during inspection", async () => {
    const f = await fixture();
    expect(await inspectNativeDelivery(f.receipts, "missing", [])).toMatchObject({ delivery: "not_found" });
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps a legacy missing-key intent unknown, reports its exact invalid field, and never writes or resends", async () => {
    const f = await fixture(); await f.receipts.recordNativeIntent("operation", f.message);
    const before = await readdir(f.directory);
    const result = await inspectNativeDelivery(f.receipts, "operation", []);
    expect(result).toMatchObject({ operationId: "operation", messageId: f.message.message_id, runId: "run", causationId: "architect-delegation",
      delivery: "unknown_delivery", inbox: "absent", resendAllowed: false, nativeEnvelopeIssues: [{ path: "idempotency_key" }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RESULT");
    expect(await readdir(f.directory)).toEqual(before);
    expect((await f.receipts.nativeDelivery("operation"))?.status).toBe("unknown_delivery");
    expect(await inspectNativeDelivery(f.receipts, "missing-operation", [])).toMatchObject({ delivery: "not_found", resendAllowed: false });
  });

  it("requires exact applied inbox data or ACK, and keeps received/conflicting rows inconclusive", async () => {
    const f = await fixture(), message = { ...f.message, idempotency_key: "stable" };
    await f.receipts.recordNativeIntent("operation", message);
    expect(await inspectNativeDelivery(f.receipts, "operation", [{ message, status: "received" }])).toMatchObject({ delivery: "received", inbox: "received", resendAllowed: false });
    expect(await inspectNativeDelivery(f.receipts, "operation", [{ message: { ...message, payload: {} }, status: "applied" }]))
      .toMatchObject({ delivery: "unknown_delivery", inbox: "conflicting", resendAllowed: false });
    expect(await inspectNativeDelivery(f.receipts, "operation", [{ message, status: "applied" }])).toMatchObject({ delivery: "applied", resendAllowed: false });
    await f.receipts.recordNativeAcknowledgement(message);
    expect(await inspectNativeDelivery(f.receipts, "operation", [])).toMatchObject({ delivery: "acknowledged", resendAllowed: false });
  });

  it("does not resurrect a binding intent from a stale report after its signed replacement was durably received", async () => {
    const f = await fixture(), now = new Date().toISOString(), journalDirectory = join(f.root, "journal");
    const pair = generateKeyPairSync("ed25519");
    const receipt = createSignedBindingReceipt({ receiptId: "binding", issuerId: "host", observedAt: now,
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), correlation: { token: "assignment", provenance: "transport", verified: true },
      handle: { executionId: "execution", requestId: "request", attemptId: "attempt", runId: "run", taskId: "task", idempotencyKey: "assignment",
        target: { transport: "herdr", agentId: "developer", paneId: "developer-pane" }, correlation: { token: "assignment", provenance: "transport", verified: true }, acceptedAt: now } });
    const signed = RoleMessageSchema.parse({ ...f.message, message_id: "binding-envelope", idempotency_key: "binding-key", type: "execution.receipt",
      sender: { role: "developer", agent_id: "developer", pane_id: "developer-pane" }, causation_id: "assignment", payload: receipt });
    const placeholder = RoleMessageSchema.parse({ ...signed, payload: { ...receipt, signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } } });
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake", correlationId: "correlation", sessionId: "session",
      runId: "run", requestedBy: "conversation", targetRole: "coordinator", title: "Original work", objective: "Original scope", specificationId: "spec", sddLevel: "full",
      acceptanceCriteria: draft().acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: now, idempotencyKey: "intake" });
    const journal = new AgenticJournal(journalDirectory, f.root);
    await journal.exclusive(async (state, save) => {
      state.runs.push({ runId: "run", delegation, status: "implementing", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 });
      state.inbox.push({ message: signed, status: "applied" }); await save();
    });
    const runtime = new AgenticWorkflowRuntime({} as AgenticRuntimePorts, { journalDirectory, repositoryPath: f.root });
    await expect(runtime.recordNativeDeliveryIntent({ ...placeholder, payload: { ...receipt, receiptId: "different-binding" } }, "new-operation"))
      .rejects.toThrow(/Conflicting native delivery/);
    await runtime.reportUncertainNativeDelivery(placeholder, "binding-operation", "Stale watchdog snapshot after ACK");
    await runtime.recoverMissingCoordinatorWakeups();
    const state = await journal.exclusive(async state => structuredClone(state));
    expect(state.runs[0]!.nativeDeliveries ?? []).toEqual([]);
    expect(state.runs[0]!.pendingAction).toBeUndefined();
    expect(state.outbound).toEqual([]);
  });

  it("refuses conflicting observed refusal evidence instead of allowing it to release a mismatched intent", async () => {
    const f = await fixture(); await f.receipts.recordNativeIntent("operation", f.message);
    await f.receipts.recordNativeRejection({ ...f.message, correlation_id: "foreign" });
    await expect(inspectNativeDelivery(f.receipts, "operation", [])).rejects.toThrow(/conflict/i);
    const runtime = { recordNativeDeliveryIntent: vi.fn(), reconcileNativeDelivery: vi.fn(), recordNativeDeliveryRejection: vi.fn() };
    await expect(f.receipts.recoverNativeDeliveries(runtime)).rejects.toThrow(/conflict/i);
    expect(runtime.recordNativeDeliveryRejection).not.toHaveBeenCalled();
    expect(runtime.reconcileNativeDelivery).not.toHaveBeenCalled();
  });

  it("settles only an observed inadmissible intent in Runtime while preserving the business blocker and all IDs", async () => {
    const f = await fixture(), journalDirectory = join(f.root, "journal"), now = new Date().toISOString();
    const journal = new AgenticJournal(journalDirectory, f.root);
    const pendingAction = { actionId: `next-${digest(["run", "schema-blocker"])}`, kind: "resume_coordinator", owner: "coordinator",
      reason: "Schema blocker", sourceMessageId: "schema-blocker", createdAt: now, state: "pending", previousStatus: "specifying" } as const;
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake", correlationId: "correlation", sessionId: "session",
      runId: "run", requestedBy: "conversation", targetRole: "coordinator", title: "Original work", objective: "Original scope", specificationId: "spec",
      sddLevel: "full", acceptanceCriteria: draft().acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: now, idempotencyKey: "intake" });
    await journal.exclusive(async (state, save) => {
      state.runs.push({ runId: "run", delegation, status: "escalated", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3, pendingAction,
        nativeDeliveries: [{ operationId: "invalid-operation", message: f.message }, { operationId: "other-operation", message: { ...f.message, message_id: "other-result", idempotency_key: "other" } }] });
      await save();
    });
    const runtime = new AgenticWorkflowRuntime({} as AgenticRuntimePorts, { journalDirectory, repositoryPath: f.root });
    await f.receipts.recordNativeIntent("invalid-operation", f.message);
    await f.receipts.recordNativeRejection(f.message); // Represents only the authenticated ingress callback, not a model flag.
    await f.receipts.recoverNativeDeliveries(runtime); await f.receipts.recoverNativeDeliveries(runtime);
    const state = await journal.exclusive(async state => structuredClone(state));
    expect(state.runs[0]).toMatchObject({ status: "escalated", delegation, pendingAction, tasks: [] });
    expect(state.runs[0]!.nativeDeliveries).toHaveLength(1);
    expect(state.runs[0]!.nativeDeliveries![0]!.operationId).toBe("other-operation");
    await expect(runtime.recordNativeDeliveryRejection({ code: "native_envelope_rejected", message: { ...f.message, idempotency_key: "valid" }, issues: [{ path: "idempotency_key", code: "invalid_type", message: "Required" }] })).rejects.toThrow();
    expect(state.outbound).toEqual([]); expect(state.inbox).toEqual([]);
  });

  it("records a signature-verified key refusal before Runtime receive and distinguishes post-admission failures", async () => {
    const f = await fixture(); await f.receipts.recordNativeIntent("operation", f.message);
    const pair = generateKeyPairSync("ed25519"); let received = 0, rejected = 0;
    const socketPath = join(f.root, "native.sock");
    const ingress = await startHerdrReceiptIngress({ socketPath, publicKeys: { host: pair.publicKey.export({ type: "spki", format: "pem" }).toString() },
      receive: async () => { received++; throw new Error("runtime failed after admission"); },
      rejected: async message => { rejected++; await f.receipts.recordNativeRejection(message); } });
    const send = (message: typeof f.message, valid = true) => new Promise<any>((resolve, reject) => {
      const socket = connect(socketPath); let response = "";
      socket.once("error", reject); socket.once("connect", () => socket.write(JSON.stringify({ issuerId: "host", message,
        signature: valid ? sign(null, Buffer.from(canonicalReceiptJson(message)), pair.privateKey).toString("base64") : Buffer.alloc(64).toString("base64") }) + "\n"));
      socket.on("data", chunk => response += chunk); socket.once("end", () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
    });
    try {
      expect(await send(f.message, false)).toMatchObject({ ok: false }); expect(rejected).toBe(0);
      expect(await send(f.message)).toMatchObject({ ok: false, code: "native_envelope_rejected", issues: [{ path: "idempotency_key" }] });
      expect(received).toBe(0); expect(rejected).toBe(1);
      const reopened = new HostReceiptJournal(f.directory, f.root, "session");
      expect(await inspectNativeDelivery(reopened, "operation", [])).toMatchObject({ delivery: "rejected_before_admission", resendAllowed: false });
      expect(await reopened.unacknowledgedNativeDeliveries()).toEqual([]);
      const runtime = { recordNativeDeliveryIntent: vi.fn(), reconcileNativeDelivery: vi.fn(), recordNativeDeliveryRejection: vi.fn() };
      await reopened.recoverNativeDeliveries(runtime);
      expect(runtime.recordNativeDeliveryIntent).not.toHaveBeenCalled();
      expect(runtime.reconcileNativeDelivery).not.toHaveBeenCalled();
      expect(runtime.recordNativeDeliveryRejection).toHaveBeenCalledOnce();
      await expect(reopened.recordNativeRejection({ ...f.message, idempotency_key: "valid" })).rejects.toThrow();
      const valid = { ...f.message, message_id: "valid-result", idempotency_key: "valid" };
      await f.receipts.recordNativeIntent("valid-operation", valid);
      expect(await send(valid)).toMatchObject({ ok: false }); expect(received).toBe(1); expect(rejected).toBe(1);
      expect(await inspectNativeDelivery(reopened, "valid-operation", [])).toMatchObject({ delivery: "unknown_delivery", resendAllowed: false });
      expect((await readdir(f.directory)).filter(name => name.startsWith("native-rejection-"))).toHaveLength(1);
      // Observed refusal is private evidence, never an ACK or a fabricated result.
      expect((await readdir(f.directory)).filter(name => name.startsWith("native-ack-"))).toEqual([]);
      expect((await readFile(join(f.directory, (await readdir(f.directory)).find(name => name.startsWith("native-rejection-"))!), "utf8"))).toContain("native_envelope_rejected");
    } finally { await ingress.close(); }
  });
});
