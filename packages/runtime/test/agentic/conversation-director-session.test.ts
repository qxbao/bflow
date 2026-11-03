import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, WebCommandSchema, type SessionManifest } from "@bflow/contracts";
import { webCommandFingerprint } from "@bflow/contracts/web-host";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

// B2a Task 6 (R-B2-7): the human gateway runs in-process in a Director session, without Conversation or Coordinator panes.

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const REFUSAL = "Phiên Director: hãy gửi yêu cầu cho Director trong CLI (chạy /bflow-start).";
const NOW = () => new Date().toISOString();
/** Mirrors the Gateway's own projection token (localeCompare key order). */
function token(value: unknown): string {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical)}]` : v !== null && typeof v === "object"
    ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)}}`
    : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function principalFor(command: unknown, principalId = "human-1") {
  const parsed = WebCommandSchema.parse(command);
  const issuedAt = NOW(), expiresAt = new Date(Date.now() + 30_000).toISOString();
  return { schemaVersion: 1, source: "local_web", issuerId: "issuer-1", keyId: "key-1", principalId, browserSessionId: "browser-1",
    projectId: parsed.projectId, hostSessionId: "session-1", capability: "user_interaction", commandId: parsed.commandId,
    commandDigest: webCommandFingerprint(parsed), issuedAt, expiresAt, nonce: "nonce-1",
    signature: { algorithm: "ed25519", value: `${"A".repeat(86)}==` } };
}
async function directorHost(options: { humanApproval?: boolean } = {}) {
  const f = await fixture({ director: true, ...options });
  const manifest: SessionManifest = unwrap(await f.panes.getManifest());
  expect(manifest.schemaVersion).toBe(3);
  const resumed: string[] = [];
  const host = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory: join(f.root, "director-conversation") });
  host.configureStructuredInteraction({ authorize: async () => true, now: NOW, approval: async () => undefined,
    resume: async command => { resumed.push(command.runId); return { ok: true, value: { kind: "interaction", runId: command.runId, currentRunId: command.runId } }; } });
  return { f, host, resumed };
}

describe("Conversation gateway without a pane (Director session)", () => {
  it("creates the host from a v3 manifest and refuses the Web request commands before any bridge call", async () => {
    const { f, host } = await directorHost();
    const outboundBefore = ((await f.runtime.inspect()) as any).outbound.length;
    const base = { apiVersion: 1, projectId: "project-1" };
    const commands = [
      { ...base, commandId: randomUUID(), kind: "create_request", title: "Tạo tính năng", requestKind: "feature", objective: "Mục tiêu",
        acceptanceCriteria: [{ description: "Tiêu chí", verificationMethod: "manual_review" }], constraints: [] },
      { ...base, commandId: randomUUID(), kind: "revise_request", runId: "run-1", expectedVersion: { revisionToken: "t" }, objective: "Mục tiêu",
        acceptanceCriteria: [{ description: "Tiêu chí", verificationMethod: "manual_review" }], constraints: [] },
      { ...base, commandId: randomUUID(), kind: "answer_clarification", runId: "run-1", questionId: "q-1", expectedVersion: { revisionToken: "t" }, answer: "Trả lời" }
    ];
    for (const command of commands) {
      expect(await host.handleStructuredInteraction(command, principalFor(command))).toEqual({
        ok: false, error: { code: "validation", retryable: false, message: REFUSAL } });
    }
    expect(((await f.runtime.inspect()) as any).outbound.length).toBe(outboundBefore);
    expect(f.transport.sentRequests).toEqual([]);
  }, 60000);

  it("refuses the pane hook turn and the Conversation-bridge delegation in a Director session", async () => {
    const { host } = await directorHost();
    await expect(host.handleUserTurn({ sessionId: "session-1", content: "xin chào" })).rejects.toThrow("Director session has no Conversation pane");
    await expect(host.delegateDirectorWork({ key: "k", title: "T", objective: "O", kind: "feature", acceptanceCriteria: [],
      sddLevel: "lightweight", priority: "normal", requestedAt: NOW() })).rejects.toThrow("Use admitDirectorWork in a Director session");
  }, 60000);

  it("turns answer_decision into a pane-less approval.decision that the mailbox delivers and Runtime applies", async () => {
    const { f, host } = await directorHost({ humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const waiting = await f.inspect();
    expect(waiting.status).toBe("awaiting_approval");
    await host.reconcileApprovals();
    const context = await host.getContext() as any;
    const pending = context.pendingApprovals[waiting.approval.approvalId];
    expect(pending).toBeDefined();
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "answer_decision", runId: "run-1",
      decisionId: pending.approvalId, outcome: "approved",
      expectedVersion: { revisionToken: token(pending), approvalId: pending.approvalId, target: pending.target, revision: pending.revision,
        generation: pending.generation, evidenceDigest: token(pending.evidence) } });
    const answered = await host.handleStructuredInteraction(command, principalFor(command));
    expect(answered.ok).toBe(true);
    const state = await f.runtime.inspect() as any;
    const queued = state.outbound.find((out: any) => out.message.type === "approval.decision");
    expect(queued).toBeDefined();
    expect(queued.message.sender).toEqual({ role: "conversation" });
    expect(queued.message.recipient).toEqual({ role: "coordinator" });
    expect(queued.delivery).toBe("director_mailbox");
    expect(JSON.stringify(queued.message)).not.toMatch(/pane_id|agent_id/);
    const sentBefore = f.transport.sentRequests.length;
    await f.runtime.flushOutbound();
    const delivered = ((await f.runtime.inspect()) as any).outbound.find((out: any) => out.message.message_id === queued.message.message_id);
    expect(delivered.status).toBe("delivered");
    expect(f.transport.sentRequests.length).toBe(sentBefore);
    expect(RoleMessageSchema.parse(delivered.message).type).toBe("approval.decision");
    const after = await f.inspect();
    expect(after.status).not.toBe("awaiting_approval");
    expect(after.decision).toMatchObject({ approvalId: pending.approvalId, decision: "approved" });
  }, 60000);

  it("runs resume and cancel through the pane-less gateway", async () => {
    const { f, host, resumed } = await directorHost();
    await host.reconcileApprovals();
    const context = await host.getContext() as any;
    expect(Object.values(context.workflows).map((workflow: any) => workflow.runId)).toContain("run-1");
    const resume = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "resume", runId: "run-1",
      actionId: "action-1", expectedVersion: { revisionToken: "revision-1" } });
    expect((await host.handleStructuredInteraction(resume, principalFor(resume))).ok).toBe(true);
    expect(resumed).toEqual(["run-1"]);
    const cancel = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "cancel", runId: "run-1",
      expectedVersion: { revisionToken: "revision-1" }, reason: "Người dùng hủy" });
    const cancelled = await host.handleStructuredInteraction(cancel, principalFor(cancel));
    expect(cancelled.ok).toBe(true);
    const out = ((await f.runtime.inspect()) as any).outbound.filter((item: any) => item.message.type === "delegation.request");
    expect(out.length).toBeGreaterThan(0);
    for (const item of out) {
      expect(item.message.sender).toEqual({ role: "conversation" });
      expect(item.message.recipient).toEqual({ role: "coordinator" });
      expect(item.delivery).toBe("director_mailbox");
    }
  }, 60000);
});
