import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, PaneBindingSchema, QualityGateContextSchema, QualityGateResultSchema, VerificationResultSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { HostReceiptJournal, type HumanHookProvenance } from "../../src/agentic/host-receipts.js";
import { digest, json } from "../../src/agentic/journal.js";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp("/tmp/bflow-host-receipts-"); cleanup.push(root);
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
});
