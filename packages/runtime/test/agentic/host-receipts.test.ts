import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalDecisionSchema, PaneBindingSchema, QualityGateContextSchema, QualityGateResultSchema, RoleMessageSchema, VerificationResultSchema, canonicalReceiptJson } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { HostReceiptJournal, type HumanHookProvenance } from "../../src/agentic/host-receipts.js";
import { digest, json } from "../../src/agentic/journal.js";
import { startHerdrReceiptIngress, authenticateNativeHerdrMessage } from "../../src/agentic/herdr-ingress.js";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";
import type { AgyNativeAnchor } from "../../src/agentic/agy-native-transcript.js";

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
  it("supersedes only the expected prior native authority without fabricating Stop or losing unhandled ingress", async () => {
    const f = await fixture();
    const binding = PaneBindingSchema.parse({ ...f.binding, role: "architect", agentId: "architect", paneId: "agy-pane", agentKind: "agy", provider: "herdr",
      session: { source: "herdr:antigravity_cli", kind: "id", value: "agy-native-session" } });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "assignment-a", correlation_id: "corr", run_id: "run",
      sender: { role: "coordinator" }, recipient: { role: "architect" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "a" });
    const anchor: AgyNativeAnchor = { transcriptPath: `${f.root}/native.jsonl`, device: "7", inode: "11", stepIndex: 0, rowDigest: "a".repeat(64), prefixDigest: "b".repeat(64) };
    const first = await f.journal.recordAgyNativeTurn(binding, "launch", anchor, message);
    const nextAnchor = { ...anchor, stepIndex: 10, rowDigest: "c".repeat(64), prefixDigest: "d".repeat(64) };
    const nextMessage = { ...message, message_id: "assignment-b", idempotency_key: "b" };
    await expect(f.journal.recordAgyNativeTurn(binding, "launch", nextAnchor, nextMessage, { supersedesTurnId: "0".repeat(64) })).rejects.toThrow();
    const second = await f.journal.recordAgyNativeTurn(binding, "launch", nextAnchor, nextMessage, { supersedesTurnId: first.turnId });
    await expect(f.journal.assertAgyNativeTurn(binding, "launch", anchor)).rejects.toThrow();
    await expect(f.journal.recordAgyNativeTurn(binding, "launch", anchor, message)).rejects.toThrow(/superseded/i);
    expect((await f.reopen().assertAgyNativeTurn(binding, "launch", nextAnchor)).turnId).toBe(second.turnId);
    expect((await f.reopen().recoverAgyNativeTurns()).map(turn => turn.message.message_id)).toEqual(["assignment-a", "assignment-b"]);
    expect((await f.reopen().latestAgyNativeTurn(binding, "launch"))?.stoppedAt).toBeUndefined();
    expect((await readdir(f.directory)).filter(name => name.startsWith("specialist-stop-") || name.startsWith("agy-native-turn-stop-"))).toEqual([]);
    const marker = (await readdir(f.directory)).find(name => name.startsWith("agy-native-turn-superseded-"));
    expect(marker).toBeDefined();
    await rm(join(f.directory, marker!)); // crash after durable successor, before redundant supersession bookkeeping
    expect((await f.reopen().assertAgyNativeTurn(binding, "launch", nextAnchor)).turnId).toBe(second.turnId);
    expect((await readdir(f.directory)).filter(name => name.startsWith("agy-native-turn-superseded-"))).toHaveLength(1);
  });

  it("admits and stops only exact monotonic Agy native transcript turns", async () => {
    const f = await fixture();
    const binding = PaneBindingSchema.parse({ ...f.binding, bindingId: "agy-binding", role: "developer", agentId: "agy-dev",
      paneId: "agy-pane", provider: "herdr", agentKind: "agy", readOnlyWorkspace: false,
      session: { source: "herdr:agy", kind: "id", value: "agy-native-session" } });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "agy-assignment", correlation_id: "corr-1", run_id: "run-1",
      sender: { role: "coordinator" }, recipient: { role: "developer", pane_id: binding.paneId, agent_id: binding.agentId },
      type: "task.assignment", payload: { assignment: { assignmentId: "assignment-1" }, context: { task: "exact task" } },
      artifact_references: [], occurred_at: f.at, idempotency_key: "assignment-key" });
    const anchor: AgyNativeAnchor = { transcriptPath: `${f.root}/private/transcript.jsonl`, device: "7", inode: "11", stepIndex: 4,
      rowDigest: "a".repeat(64), prefixDigest: "b".repeat(64) };
    const record = (f.journal as any).recordAgyNativeTurn.bind(f.journal);
    const assert = (f.journal as any).assertAgyNativeTurn.bind(f.journal);
    const stop = (f.journal as any).stopAgyNativeTurn.bind(f.journal);
    const first = await record(binding, "launch-1", anchor, message);
    expect(first).toMatchObject({ turnId: expect.any(String), binding, launchId: "launch-1", anchor, message, duplicate: false });
    expect(await record(binding, "launch-1", anchor, message)).toEqual({ ...first, duplicate: true });
    expect(await assert(binding, "launch-1", anchor)).toMatchObject({ turnId: first.turnId, binding, launchId: "launch-1", anchor, message });
    expect(await (f.reopen() as any).latestAgyNativeTurn(binding, "launch-1")).toMatchObject({ turnId: first.turnId, binding, launchId: "launch-1", anchor, message });
    await expect(record(binding, "launch-1", { ...anchor, stepIndex: 5, rowDigest: "e".repeat(64), prefixDigest: "f".repeat(64) },
      { ...message, message_id: "next-active", idempotency_key: "next-active" })).rejects.toThrow("previous Agy native turn has not stopped");
    await expect(record(binding, "launch-1", anchor, { ...message, message_id: "different", idempotency_key: "different" })).rejects.toThrow();
    await expect(record(binding, "launch-1", { ...anchor, inode: "12", stepIndex: 5 }, message)).rejects.toThrow();
    await expect(record(binding, "launch-1", { ...anchor, stepIndex: 3 }, message)).rejects.toThrow();
    await expect(assert(binding, "other-launch", anchor)).rejects.toThrow();
    expect(await stop(binding, "launch-1", { ...anchor, stepIndex: 3 })).toBeUndefined();
    const stopped = await stop(binding, "launch-1", anchor);
    expect(stopped).toMatchObject({ turnId: first.turnId, binding, launchId: "launch-1", anchor, message, stoppedAt: expect.any(String) });
    expect((await (f.reopen() as any).latestAgyNativeTurn(binding, "launch-1"))).toMatchObject({ turnId: first.turnId, stoppedAt: expect.any(String) });
    await expect(assert(binding, "launch-1", anchor)).rejects.toThrow();
    await expect(record(binding, "launch-1", anchor, message)).rejects.toThrow();
    const nextAnchor = { ...anchor, stepIndex: 8, rowDigest: "c".repeat(64), prefixDigest: "d".repeat(64) };
    await expect(record(binding, "launch-1", nextAnchor, message)).rejects.toThrow("Agy envelope message was already admitted at another native step");
    expect(await record(binding, "launch-1", nextAnchor, { ...message, message_id: "next", idempotency_key: "next" })).toMatchObject({ duplicate: false });
  });
  it("preserves Agy native turn and Coordinator turn identity when manifest heartbeat or transportState updates", async () => {
    const f = await fixture();
    const binding = PaneBindingSchema.parse({ ...f.binding, bindingId: "agy-coord", role: "coordinator", agentId: "coordinator",
      paneId: "coord-pane", provider: "agy", agentKind: "agy", readOnlyWorkspace: true,
      lastHeartbeatAt: "2026-10-24T08:33:26.457Z",
      session: { source: "herdr:agy", kind: "id", value: "agy-coord-session" } });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "coord-delegation", correlation_id: "corr-hb", run_id: "run-hb",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {},
      artifact_references: [], occurred_at: f.at, idempotency_key: "coord-delegation" });
    const anchor: AgyNativeAnchor = { transcriptPath: `${f.root}/coord.jsonl`, device: "7", inode: "11", stepIndex: 11,
      rowDigest: "a".repeat(64), prefixDigest: "b".repeat(64) };
    const admitted = await f.journal.recordAgyNativeTurn(binding, "launch-hb", anchor, message);
    const updatedBinding = { ...binding, lastHeartbeatAt: "2026-10-24T08:39:58.024Z", transportState: "working" as const };
    expect((await f.reopen().assertAgyNativeTurn(updatedBinding, "launch-hb", anchor)).turnId).toBe(admitted.turnId);
    expect((await f.reopen().latestAgyNativeTurn(updatedBinding, "launch-hb"))?.turnId).toBe(admitted.turnId);
    expect(await f.reopen().recordAgyNativeTurn(updatedBinding, "launch-hb", anchor, message)).toMatchObject({ turnId: admitted.turnId, duplicate: true });
  });
  it("recovers durable Agy prompt and Stop obligations across interrupted host writes", async () => {
    const f = await fixture();
    const binding = PaneBindingSchema.parse({ ...f.binding, role: "coordinator", agentId: "coordinator", paneId: "agy-pane", agentKind: "agy",
      session: { source: "herdr:antigravity_cli", kind: "id", value: "native-agy" } });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "agy-recover", correlation_id: "corr", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "agy-recover" });
    const anchor: AgyNativeAnchor = { transcriptPath: `${f.root}/transcript`, device: "7", inode: "11", stepIndex: 4,
      rowDigest: "a".repeat(64), prefixDigest: "b".repeat(64) };
    const fail = vi.spyOn(f.journal, "startCoordinatorTurn").mockRejectedValueOnce(new Error("interrupted after native receipt"));
    await expect(f.journal.recordAgyNativeTurn(binding, "launch", anchor, message)).rejects.toThrow("interrupted");
    fail.mockRestore();
    const reopened = f.reopen();
    const pending = await reopened.recoverAgyNativeTurns();
    expect(pending).toMatchObject([{ message, binding, anchor }]);
    const turn = pending[0]!;
    await reopened.markAgyNativePromptHandled(turn.turnId);
    expect(await f.reopen().recoverAgyNativeTurns()).toEqual([]);
    const failStop = vi.spyOn(reopened, "stopCoordinatorTurn").mockRejectedValueOnce(new Error("interrupted after native stop"));
    await expect(reopened.stopAgyNativeTurn(binding, "launch", anchor)).rejects.toThrow("interrupted");
    failStop.mockRestore();
    await f.reopen().recoverAgyNativeTurns();
    expect((await f.reopen().pendingCoordinatorStops()).map(item => item.message.message_id)).toEqual([message.message_id]);
  });
  it("links specialist Stop records to their source message when supplied", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "developer" as const };
    const stopId = await (f.journal as any).recordSpecialistStop(binding, "source-message");
    expect(await f.reopen().pendingSpecialistStops()).toMatchObject([{ stopId, sourceMessageId: "source-message" }]);
  });
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
    const phaseRequest = RoleMessageSchema.parse({ schema_version: 2, message_id: "phase-request", correlation_id: "correlation", run_id: "run",
      sender: { role: "coordinator" }, recipient: { role: "qa" }, type: "verification.requested", payload: { taskId: "task", phase: "red", sourceRevision: "a".repeat(40) }, artifact_references: [] });
    expect(await f.reopen().hasPolicyPhaseEvidence(phaseRequest)).toBe(false);
    await f.journal.recordEvidence({ ...evidence, verificationId: "phase-evidence", metadata: { conditionalTdd: { phase: "red", sourceRevision: "a".repeat(40) } } });
    expect(await f.reopen().hasPolicyPhaseEvidence(phaseRequest)).toBe(true);
    expect(await f.reopen().hasPolicyPhaseEvidence({ ...phaseRequest, payload: { taskId: "task", phase: "green", sourceRevision: "a".repeat(40) } })).toBe(false);
    expect(await f.reopen().getObservation("review", "review-id")).toEqual(observation);
    expect(await f.reopen().authenticateGate({ ...gate, status: "failed" })).toBe(false);
    expect(await f.reopen().authenticateEvidence({ ...evidence, metadata: { sourceRevision: "b".repeat(40) } })).toBe(false);
    await expect(f.journal.putObservation("review", "review-id", { ...observation, binding: { ...f.binding, bindingId: "changed" } })).rejects.toThrow("immutable");
  });
  it("bounds Stop refusals for an undecided Conversation turn across restart", async () => {
    const f = await fixture();
    expect(await f.journal.reserveDecisionReblock("user-1")).toBe(1);
    expect(await f.reopen().reserveDecisionReblock("user-1")).toBe(2);
    expect(await f.reopen().reserveDecisionReblock("user-1")).toBeUndefined();
    expect(await f.reopen().reserveDecisionReblock("user-2")).toBe(1);
  });
  it("durably binds one exact Agy assignment to its launch and native session before a Stop can settle it", async () => {
    const f = await fixture();
    const binding = PaneBindingSchema.parse({ ...f.binding, bindingId: "agy-binding", role: "developer", agentId: "agy-dev",
      paneId: "agy-pane", provider: "agy", agentKind: "agy", readOnlyWorkspace: false,
      session: { source: "herdr:agy", kind: "id", value: "agy-native-session" } });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "agy-assignment", correlation_id: "corr-1", run_id: "run-1",
      sender: { role: "coordinator" }, recipient: { role: "developer", pane_id: binding.paneId, agent_id: binding.agentId },
      type: "task.assignment", payload: { assignment: { assignmentId: "assignment-1" }, context: { task: "exact task" } },
      artifact_references: [], occurred_at: f.at, idempotency_key: "assignment-key" });
    const envelopeDigest = digest(message);
    const recordAdmission = (f.journal as any).recordAgyAdmission.bind(f.journal);
    const recordStop = (f.journal as any).recordAgyStop.bind(f.journal);

    const concurrent = await Promise.all([
      recordAdmission(binding, "launch-agy-dev-1", message, envelopeDigest),
      recordAdmission(binding, "launch-agy-dev-1", message, envelopeDigest)
    ]);
    const first = concurrent.find(value => value.duplicate === false)!;
    expect(first).toBeDefined();
    const duplicate = await recordAdmission(binding, "launch-agy-dev-1", message, envelopeDigest);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    await expect(recordAdmission(binding, "launch-agy-dev-1", message, "0".repeat(64))).rejects.toThrow();
    await expect(recordStop(binding, "launch-agy-dev-1", "foreign-session", 1)).rejects.toThrow();

    // Agy resets executionNum to zero each physical turn: session/counter alone is ambiguous.
    expect(await recordStop(binding, "launch-agy-dev-1", "agy-native-session", 0)).toBeUndefined();
    const stopped = await recordStop(binding, "launch-agy-dev-1", "agy-native-session", 0, first.admissionId);
    expect(stopped).toMatchObject({ admissionId: first.admissionId, message });
    expect(await (f.reopen() as any).activeAgyAdmission(binding, "launch-agy-dev-1")).toBeUndefined();
    await expect(recordAdmission(binding, "launch-agy-dev-1", message, envelopeDigest)).rejects.toThrow("already stopped");
    expect(await recordStop(binding, "launch-agy-dev-1", "agy-native-session", 2)).toBeUndefined();
    await expect(recordAdmission(f.binding, "launch-agy-dev-1", message, envelopeDigest)).rejects.toThrow();
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
      const { inspectNativeDelivery } = await import("../../src/agentic/native-delivery-status.js");
      expect(await inspectNativeDelivery(f.journal, "binding:operation", [{ message: attested, status: "applied" }]))
        .toMatchObject({ delivery: "applied", inbox: "applied", resendAllowed: false });
      expect((await send(sign(null, Buffer.from(canonicalReceiptJson(attested)), pair.privateKey).toString("base64"), attested)).ok).toBe(true);
      expect((await f.reopen().nativeDelivery("binding:operation"))?.status).toBe("acknowledged");
      const legacy = RoleMessageSchema.parse({ ...bindingMessage, message_id: "legacy-binding", idempotency_key: undefined });
      await f.journal.recordNativeIntent("legacy:binding", legacy);
      await f.journal.recordNativeRejection({ ...legacy, payload: bindingReceipt });
      expect(await inspectNativeDelivery(f.journal, "legacy:binding", []))
        .toMatchObject({ delivery: "rejected_before_admission", resendAllowed: false });
    } finally { await ingress.close(); }
  });
});

describe("durable Coordinator turn observations", () => {
  it("settles the exact old Coordinator turn when a newer native turn starts concurrently", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "coordinator" as const, agentId: "coordinator", paneId: "coordinator-pane" };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "old", correlation_id: "corr", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "old" });
    await f.journal.startCoordinatorTurn(binding, message);
    await f.journal.startCoordinatorTurn(binding, { ...message, message_id: "new", idempotency_key: "new" });
    await f.journal.stopCoordinatorTurn(binding, message.message_id);
    expect((await f.reopen().pendingCoordinatorStops()).map(item => item.message.message_id)).toEqual(["old"]);
  });
  it("recovers handled stops without mistaking their acknowledgements for stop observations", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "coordinator" as const, agentId: "coordinator", paneId: "coordinator-pane" };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "turn", correlation_id: "correlation", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "turn" });
    await f.journal.startCoordinatorTurn(binding, message);
    await f.journal.stopCoordinatorTurn(binding);
    const stopped = (await f.journal.pendingCoordinatorStops())[0]!;
    await f.journal.completeCoordinatorStop(stopped);

    expect(await f.reopen().coordinatorStopObservations()).toEqual([stopped]);
    expect(await f.reopen().pendingCoordinatorStops()).toEqual([]);

    const next = { ...message, message_id: "next-turn", idempotency_key: "next-turn" };
    await f.reopen().startCoordinatorTurn(binding, next);
    await f.reopen().stopCoordinatorTurn(binding);
    expect((await f.reopen().coordinatorStopObservations()).map(item => item.message.message_id)).toEqual(["turn", "next-turn"]);
    expect((await f.reopen().pendingCoordinatorStops()).map(item => item.message.message_id)).toEqual(["next-turn"]);
  });
  it("rejects stop observations stored under a different canonical filename", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "coordinator" as const };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "turn", correlation_id: "correlation", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "turn" });
    await f.journal.startCoordinatorTurn(binding, message);
    await f.journal.stopCoordinatorTurn(binding);
    const name = (await readdir(f.directory)).find(name => /^coordinator-stop-[a-f0-9]{64}\.json$/.test(name))!;
    await writeFile(join(f.directory, `coordinator-stop-${digest("other-stop")}.json`), await readFile(join(f.directory, name)), { mode: 0o600 });
    await expect(f.reopen().coordinatorStopObservations()).rejects.toThrow("Host receipt filename identity mismatch");
  });
  it("rejects tampered stop observations during recovery", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "coordinator" as const };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "turn", correlation_id: "correlation", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "turn" });
    await f.journal.startCoordinatorTurn(binding, message);
    await f.journal.stopCoordinatorTurn(binding);
    const name = (await readdir(f.directory)).find(name => /^coordinator-stop-[a-f0-9]{64}\.json$/.test(name))!;
    const path = join(f.directory, name), receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.payload.sequence += 1;
    await writeFile(path, JSON.stringify(receipt));
    await expect(f.reopen().coordinatorStopObservations()).rejects.toThrow("Host receipt integrity mismatch");
  });
  it("ignores startup/foreign stops and recovers one exact stopped delegation after reopen", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "coordinator" as const, agentId: "coordinator", paneId: "coordinator-pane" };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "turn", correlation_id: "correlation", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "turn" });
    expect(await f.journal.stopCoordinatorTurn(binding)).toBe(false);
    await f.journal.startCoordinatorTurn(binding, message);
    expect(await f.reopen().stopCoordinatorTurn({ ...binding, session: { ...binding.session!, value: "other" } })).toBe(false);
    expect(await f.reopen().stopCoordinatorTurn({ ...binding, paneId: "other" })).toBe(false);
    expect(await f.reopen().stopCoordinatorTurn(binding)).toBe(true);
    await f.reopen().stopCoordinatorTurn(binding);
    const pending = await f.reopen().pendingCoordinatorStops();
    expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ binding, message });
    await f.reopen().completeCoordinatorStop(pending[0]!);
    expect(await f.reopen().pendingCoordinatorStops()).toEqual([]);
    // A new turn replaces the current turn identity; a duplicate old Stop cannot create another notification.
    await f.reopen().startCoordinatorTurn(binding, { ...message, message_id: "turn-2", idempotency_key: "turn-2" });
    await f.reopen().stopCoordinatorTurn(binding);
    expect((await f.reopen().pendingCoordinatorStops()).map(item => item.message.message_id)).toEqual(["turn-2"]);
  });
});

describe("Coordinator Stop response correlation", () => {
  it("retains turn identity across transport observations and recognizes pending native structured replies", async () => {
    const f = await fixture();
    const binding = { ...f.binding, role: "coordinator" as const, agentId: "coordinator", paneId: "coordinator-pane" };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "turn", correlation_id: "correlation", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "turn" });
    await f.journal.startCoordinatorTurn(binding, message);
    expect(await f.journal.stopCoordinatorTurn({ ...binding, transportState: "done" })).toBe(true);
    const stopped = (await f.journal.pendingCoordinatorStops())[0]!;
    expect(await f.journal.hasCoordinatorResponse(stopped)).toBe(false);
    const response = { ...message, message_id: "reply", idempotency_key: "reply", sender: { role: "coordinator" as const },
      recipient: { role: "conversation" as const }, type: "conversation.progress" as const, payload: { headline: "Waiting for clarification" } };
    await f.journal.recordNativeIntent("native-response", { ...response, correlation_id: "unrelated" });
    expect(await f.journal.hasCoordinatorResponse(stopped)).toBe(false);
    await f.journal.recordNativeIntent("matching-native-response", response);
    expect(await f.reopen().hasCoordinatorResponse(stopped)).toBe(true);
    expect((await f.reopen().nativeDelivery("matching-native-response"))?.status).toBe("unknown_delivery");
  });
});


it("never attributes a later ordinary/startup Stop to an earlier unanswered delegation", async () => {
  const f = await fixture(), binding = { ...f.binding, role: "coordinator" as const };
  const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "old-turn", correlation_id: "correlation", run_id: "run",
    sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "old-turn" });
  await f.journal.startCoordinatorTurn(binding, message);
  await f.reopen().recordCoordinatorBoundary(binding);
  expect(await f.reopen().stopCoordinatorTurn(binding)).toBe(false);
  expect(await f.reopen().pendingCoordinatorStops()).toEqual([]);
  await f.reopen().startCoordinatorTurn(binding, { ...message, message_id: "new-turn", idempotency_key: "new-turn" });
  expect(await f.reopen().stopCoordinatorTurn(binding)).toBe(true);
  expect((await f.reopen().pendingCoordinatorStops()).map(item => item.message.message_id)).toEqual(["new-turn"]);
});
