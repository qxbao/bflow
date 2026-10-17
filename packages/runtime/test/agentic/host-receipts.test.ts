import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, PaneBindingSchema, QualityGateContextSchema, QualityGateResultSchema, RoleMessageSchema, VerificationResultSchema, canonicalReceiptJson } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { HostReceiptJournal, type HumanHookProvenance } from "../../src/agentic/host-receipts.js";
import { digest, json } from "../../src/agentic/journal.js";
import { startHerdrReceiptIngress, authenticateNativeHerdrMessage } from "../../src/agentic/herdr-ingress.js";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-receipts-"))); cleanup.push(root);
  const directory = join(root, "receipts"), journal = new HostReceiptJournal(directory, root, "herdr-session");
  const at = new Date().toISOString();
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "chat-binding", sessionId: "herdr-session", role: "conversation",
    agentId: "chat", paneId: "chat-pane", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: root,
    isolationMode: "dedicated_pane", readOnlyWorkspace: true, permanent: true, transportState: "idle", boundAt: at,
    session: { source: "herdr:claude", kind: "id", value: "native-chat-session" } });
  const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: "approval", runId: "run", sessionId: "conversation-session",
    target: { type: "specification", specId: "spec" }, revision: 2, generation: 1, decision: "approved", decidedBy: "local-user-1000", decidedAt: at,
    reason: "Approve the exact design", feedbackArtifacts: [], idempotencyKey: "approval-key" });
  const provenance: HumanHookProvenance = { origin: "UserPromptSubmit", binding, nativeSessionId: "native-chat-session",
    conversationSessionId: "conversation-session", userId: decision.decidedBy, messageId: "physical-message", promptDigest: digest("approve") };
  return { root, directory, journal, decision, provenance, at, binding, reopen: () => new HostReceiptJournal(directory, root, "herdr-session") };
}
describe("private durable host authentication receipts", () => {
  it("restores the exact human decision and refuses altered identity, target, revision, feedback and status", async () => {
    const f = await fixture();
    expect(await f.journal.authenticateHuman(f.decision)).toBe(false);
    await f.journal.recordHuman(f.decision, f.provenance);
    expect(await f.reopen().humanDecisions()).toEqual([f.decision]);
    expect(await f.reopen().authenticateHuman(f.decision)).toBe(true);
    for (const change of [ { approvalId: "other" }, { runId: "other" }, { sessionId: "other" }, { target: { type: "run" as const } },
      { revision: 3 }, { generation: 2 }, { decidedBy: "coordinator" }, { reason: "Changed feedback" }, { decision: "rejected" as const } ]) {
      expect(await f.reopen().authenticateHuman({ ...f.decision, ...change })).toBe(false);
    }
    await expect(f.journal.recordHuman({ ...f.decision, reason: "Changed feedback" }, f.provenance)).rejects.toThrow("immutable");
    expect(await f.reopen().humanDecisions()).toEqual([f.decision]);
  });
  it("rejects model provenance, wrong native sessions, cross-session stores and tampered persisted decisions", async () => {
    const f = await fixture();
    await expect(f.journal.recordHuman(f.decision, { ...f.provenance, origin: "RoleMessage" as "UserPromptSubmit" })).rejects.toThrow("provenance");
    await expect(f.journal.recordHuman(f.decision, { ...f.provenance, nativeSessionId: "forged-session" })).rejects.toThrow("provenance");
    await f.journal.recordHuman(f.decision, f.provenance);
    await expect(new HostReceiptJournal(f.directory, f.root, "foreign-session").authenticateHuman(f.decision)).rejects.toThrow("foreign");
    const path = join(f.directory, (await readdir(f.directory)).find(name => name.startsWith("human-"))!);
    const stored = JSON.parse(await readFile(path, "utf8")); stored.payload.decision.revision += 1;
    await writeFile(path, JSON.stringify(stored));
    await expect(f.reopen().authenticateHuman(f.decision)).rejects.toThrow("integrity");
  });
  it("durably restores gate/evidence results and observations with immutable conflict detection", async () => {
    const f = await fixture();
    const gate = QualityGateResultSchema.parse({ gateId: "review", runId: "run", taskId: "task", evaluationId: "evaluation", status: "passed",
      findings: [], producedArtifacts: [], evaluatedAt: f.at, metadata: { sourceRevision: "a".repeat(40), summary: "Independent review" } });
    const opened = await openFilesystemArtifactStore({ root: join(f.root, "artifacts"), storeId: "receipts-test" });
    if (!opened.ok) throw new Error(opened.error.message);
    const bytes = Buffer.from("Independent observed failure");
    const stored = await opened.value.put({ options: { artifactId: "observed-failure", runId: "run", taskId: "task", kind: "test-result", mediaType: "text/plain",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }, idempotencyKey: "evidence" },
      content: (async function* () { yield bytes; })() });
    opened.value.close();
    if (!stored.ok) throw new Error(stored.error.message);
    const evidence = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: "verification", runId: "run", taskId: "task", cycleNumber: 1,
      attemptId: "attempt", status: "failed", independentExecution: true,
      evaluatedCriteria: [{ criterionId: "criterion", passed: false, evidenceArtifactId: stored.value.artifactId, summary: "Observed failure" }],
      qualityGateResults: [], evidenceArtifacts: [stored.value], findings: [],
      verifiedBy: "tester", startedAt: f.at, completedAt: f.at, metadata: { sourceRevision: "a".repeat(40) } });
    const context = QualityGateContextSchema.parse({ runId: "run", taskId: "task", definition: { id: "review", name: "Review", evaluator: "native",
      required: true, timeout: { executionTimeoutMs: 1000, onTimeout: "block" } }, artifacts: [], input: {} });
    const observation = { binding: f.binding, context, observation: json({ revision: "a".repeat(40), diff: "actual diff" }) };
    await Promise.all([f.journal.recordGate(gate), f.journal.recordEvidence(evidence), f.journal.putObservation("review", "review-id", observation)]);
    expect(await f.reopen().authenticateGate(gate)).toBe(true);
    expect(await f.reopen().authenticateEvidence(evidence)).toBe(true);
    expect(await f.reopen().getObservation("review", "review-id")).toEqual(observation);
    expect(await f.reopen().authenticateGate({ ...gate, status: "failed" })).toBe(false);
    expect(await f.reopen().authenticateEvidence({ ...evidence, metadata: { sourceRevision: "b".repeat(40) } })).toBe(false);
    await expect(f.journal.putObservation("review", "review-id", { ...observation, binding: { ...f.binding, bindingId: "changed" } })).rejects.toThrow("immutable");
  });
  it("serializes competing immutable writes and refuses symlinked receipt files", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.journal.recordHuman(f.decision, f.provenance),
      f.reopen().recordHuman({ ...f.decision, reason: "Other decision" }, f.provenance)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const decision = (await f.reopen().humanDecisions())[0]!;
    expect(await f.reopen().authenticateHuman(decision)).toBe(true);
    const path = join(f.directory, (await readdir(f.directory)).find(name => name.startsWith("human-"))!);
    const outside = join(f.root, "outside.json"); await writeFile(outside, await readFile(path)); await rm(path); await symlink(outside, path);
    await expect(f.reopen().authenticateHuman(decision)).rejects.toThrow();
  });
  it("retains uncertain native intent across restart and fsyncs signed ingress acknowledgement before ACK", async () => {
    const f = await fixture();
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "native-verdict", correlation_id: "correlation", run_id: "run",
      sender: { role: "reviewer", agent_id: "reviewer", pane_id: "review-pane" }, recipient: { role: "coordinator" },
      type: "review.verdict", payload: { status: "passed" }, artifact_references: [], idempotency_key: "native-verdict" });
    const claims = await Promise.all([f.journal.recordNativeIntent("review:operation", message), f.reopen().recordNativeIntent("review:operation", message)]);
    expect(claims.sort()).toEqual([false, true]);
    expect(await f.reopen().nativeDelivery("review:operation")).toEqual({ message, status: "unknown_delivery" });
    const pair = generateKeyPairSync("ed25519"), socketPath = join(f.root, "native.sock");
    let accepted = 0;
    const ingress = await startHerdrReceiptIngress({ socketPath, publicKeys: { host: pair.publicKey.export({ type: "spki", format: "pem" }).toString() },
      receive: async received => {
        if (!await authenticateNativeHerdrMessage(received)) throw new Error("Untrusted ingress");
        await f.reopen().recordNativeAcknowledgement(received); accepted += 1;
      } });
    const send = (signature: string, envelope = message) => new Promise<any>((accept, reject) => {
      const socket = connect(socketPath); let response = "";
      socket.once("error", reject); socket.once("connect", () => socket.write(JSON.stringify({ issuerId: "host", signature, message: envelope }) + "\n"));
      socket.on("data", chunk => response += String(chunk)); socket.once("end", () => { try { accept(JSON.parse(response)); } catch (error) { reject(error); } });
    });
    try {
      expect((await send(Buffer.alloc(64).toString("base64"))).ok).toBe(false);
      expect(accepted).toBe(0);
      expect((await f.reopen().nativeDelivery("review:operation"))?.status).toBe("unknown_delivery");
      const signature = sign(null, Buffer.from(canonicalReceiptJson(message)), pair.privateKey).toString("base64");
      expect((await send(signature)).ok).toBe(true);
      expect(accepted).toBe(1);
      expect(await f.reopen().nativeDelivery("review:operation")).toEqual({ message, status: "acknowledged" });
      await expect(f.journal.recordNativeIntent("review:operation", { ...message, payload: { status: "failed" } })).rejects.toThrow("immutable");
      const bindingReceipt = createSignedBindingReceipt({ receiptId: "binding-receipt", issuerId: "host", observedAt: f.at,
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), correlation: { token: "assignment", provenance: "transport", verified: true },
        handle: { executionId: "execution", requestId: "request", attemptId: "attempt", runId: "run", taskId: "task", idempotencyKey: "assignment",
          target: { transport: "herdr", agentId: "developer", paneId: "developer-pane" }, correlation: { token: "assignment", provenance: "transport", verified: true }, acceptedAt: f.at } });
      const bindingMessage = RoleMessageSchema.parse({ ...message, type: "execution.receipt", message_id: "binding-envelope", causation_id: "assignment",
        payload: { ...bindingReceipt, signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } } });
      await f.journal.recordNativeIntent("binding:operation", bindingMessage);
      const attested = RoleMessageSchema.parse({ ...bindingMessage, payload: bindingReceipt });
      expect((await send(sign(null, Buffer.from(canonicalReceiptJson(attested)), pair.privateKey).toString("base64"), attested)).ok).toBe(true);
      expect((await f.reopen().nativeDelivery("binding:operation"))?.status).toBe("acknowledged");
    } finally { await ingress.close(); }
  });
});
