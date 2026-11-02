import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { WebWorkforceViewSchema, type SessionManifest } from "@bflow/contracts";
import { projectWorkforce } from "../../src/interaction/workforce.js";
import { projectRun } from "../../src/interaction/views.js";
import { projectionFingerprint } from "../../src/interaction/fingerprint.js";
import type { Outbound, JournalState } from "../../src/agentic/journal.js";
import { run, state, at } from "./fixtures.js";

const projectId = "project-test";
const now = "2026-11-02T00:00:00.000Z";
type Pane = SessionManifest["panes"][number];
const pane = (role: string, n: string, extra: Record<string, unknown> = {}): Pane => ({
  schemaVersion: 2, bindingId: `binding-${n}`, sessionId: "host-1", role, agentId: `agent-id-${n}`,
  workspaceId: "ws-private", tabId: "tab-private", paneId: `pane-private-${n}`, provider: "claude", agentKind: "claude",
  model: "model-x", cwd: "/home/secret/cwd-private", worktreePath: "/home/secret/worktree-private", isolationMode: "dedicated_pane",
  readOnlyWorkspace: false, transportState: "idle", boundAt: at, session: { kind: "claude", value: "native-session-secret" },
  metadata: { allocationStatus: "active", topologyRole: "x", note: "metadata-secret" }, ...extra,
}) as unknown as Pane;
const manifest = (panes: Pane[], extra: Record<string, unknown> = {}): SessionManifest => ({
  schemaVersion: 2, sessionId: "host-1", projectName: "P", workspaceRoot: "/repo", herdrWorkspaceId: "w", herdrTabId: "t",
  status: "up", conversationSessionId: "conversation-1", activeRunIds: [], panes, attachTarget: { role: "conversation", paneId: "p" },
  createdAt: at, updatedAt: at, ...extra,
}) as unknown as SessionManifest;
let seq = 0;
const out = (type: string, recipientAgent: string | undefined, status: Outbound["status"], extra: Record<string, unknown> = {}, runId = "run-1"): Outbound => {
  const n = ++seq;
  return {
    message: { schema_version: 2, message_id: `msg-${n}`, correlation_id: "corr", run_id: runId,
      sender: { role: "coordinator", agent_id: "agent-id-coord" },
      recipient: { role: type === "delegation.request" ? "coordinator" : "developer", ...(recipientAgent ? { agent_id: recipientAgent } : {}) },
      type, payload: { text: "PAYLOAD-SECRET-TEXT do not leak" }, artifact_references: [] },
    status, selector: "sel", taskId: `task-${n}`, attemptId: `attempt-${n}`, capabilities: [], ...extra,
  } as unknown as Outbound;
};
const handled = (o: Outbound, agentId: string, extra: Record<string, unknown> = {}): Outbound => ({
  ...o, handle: { executionId: "e", requestId: "r", attemptId: o.attemptId, runId: o.message.run_id, taskId: o.taskId, idempotencyKey: "k",
    target: { transport: "herdr", agentId, paneId: "pane-private-x" }, correlation: { token: "corr-token-secret", provenance: "transport", verified: true },
    acceptedAt: "2026-11-01T23:41:00.000Z" },
  ...extra,
}) as Outbound;
const base = (panes: Pane[], s: Partial<JournalState> = {}, observedAt = now, manifestExtra: Record<string, unknown> = {}) => ({
  state: { ...state([run()]), ...s }, sessionId: "conversation-1", observedAt, core: new Map(), ready: true,
  manifest: manifest(panes, manifestExtra), projectId,
});
const coordinator = () => pane("coordinator", "coord", { permanent: true, paneGroup: "coordination" });
const conversation = () => pane("conversation", "conv", { permanent: true, paneGroup: "conversation" });

it("two parallel developers map to own assignments", () => {
  const a = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a", { turnObservedWorkingAt: "2026-11-01T23:41:10.000Z", lease: { expiresAt: "2026-11-02T00:10:00.000Z" } });
  const b = handled(out("task.assignment", "agent-id-b", "accepted"), "agent-id-b");
  const view = projectWorkforce(base([coordinator(), pane("developer", "a", { permanent: false }), pane("developer", "b", { permanent: false })],
    { outbound: [a, b] }));
  expect(WebWorkforceViewSchema.parse(view)).toBeTruthy();
  const devs = view.agents.filter(x => x.role === "developer");
  expect(devs).toHaveLength(2);
  expect(devs[0]!.instanceId).not.toBe(devs[1]!.instanceId);
  expect(devs[0]!.work).toEqual([{ messageId: a.message.message_id, kind: "assignment", runId: "run-1", taskId: a.taskId, attemptId: a.attemptId,
    delivery: "accepted", acceptedAt: "2026-11-01T23:41:00.000Z", turnSeenAt: "2026-11-01T23:41:10.000Z", leaseExpiresAt: "2026-11-02T00:10:00.000Z" }]);
  expect(devs[1]!.work.map(w => w.messageId)).toEqual([b.message.message_id]);
  expect(view.agents.find(x => x.role === "coordinator")!.work).toEqual([]);
});
it("control notice is not counted as second work", () => {
  const parent = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const notice = handled(out("task.status", "agent-id-a", "accepted", { parentAssignmentId: parent.message.message_id }), "agent-id-a");
  const view = projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [parent, notice] }));
  expect(view.agents[0]!.work.map(w => w.messageId)).toEqual([parent.message.message_id]);
  expect(view.handoffs.filter(h => h.direction === "outbound")).toHaveLength(2);
});
it("only open delegation/assignment/verification kinds count as work", () => {
  const closed = handled(out("task.assignment", "agent-id-a", "released"), "agent-id-a");
  const failed = out("task.assignment", "agent-id-a", "failed");
  const other = handled(out("task.status", "agent-id-a", "accepted"), "agent-id-a");
  const verif = handled(out("verification.requested", "agent-id-a", "sending"), "agent-id-a");
  const view = projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [closed, failed, other, verif] }));
  expect(view.agents[0]!.work.map(w => [w.messageId, w.kind, w.delivery])).toEqual([[verif.message.message_id, "verification", "sending"]]);
});
it("unknown_delivery is preserved", () => {
  const u = out("task.assignment", "agent-id-a", "unknown_delivery");
  const view = projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [u] }));
  expect(view.agents[0]!.work[0]).toMatchObject({ delivery: "unknown_delivery" });
  expect(view.handoffs[0]).toMatchObject({ state: "unknown_delivery", messageType: "task.assignment" });
});
it("does not guess an unattributed queued assignment between two developers", () => {
  const q = out("task.assignment", undefined, "queued");
  const two = projectWorkforce(base([pane("developer", "a", { permanent: false }), pane("developer", "b", { permanent: false })], { outbound: [q] }));
  expect(two.agents.flatMap(a => a.work)).toEqual([]);
  const one = projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [q] }));
  expect(one.agents[0]!.work).toHaveLength(1);
});
it("no private fields leak", () => {
  const a = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const view = projectWorkforce(base([conversation(), coordinator(), pane("developer", "a", { permanent: false })], { outbound: [a] }));
  const json = JSON.stringify(view);
  for (const secret of ["pane-private", "cwd-private", "worktree-private", "native-session-secret", "metadata-secret", "ws-private", "tab-private",
    "binding-", "agent-id-", "corr-token-secret", "/home/secret", "host-1"])
    expect(json).not.toContain(secret);
  expect(json).not.toMatch(/"(paneId|cwd|worktreePath|session|metadata|token|bindingId|agentId|workspaceId|tabId)"/);
  expect(view.agents[0]!.instanceId).toBe("agent-" + createHash("sha256").update("binding-conv").digest("hex").slice(0, 32));
});
it("payload text never appears in projection", () => {
  const a = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const view = projectWorkforce(base([coordinator(), pane("developer", "a", { permanent: false })], { outbound: [a],
    inbox: [{ message: { ...a.message, message_id: "in-1", type: "implementation.submitted", sender: { role: "developer", agent_id: "agent-id-a" }, recipient: { role: "coordinator" } }, status: "applied" } as never] }));
  expect(JSON.stringify(view)).not.toContain("PAYLOAD-SECRET");
  expect(view.handoffs.map(h => h.messageType)).toEqual(["task.assignment", "implementation.submitted"]);
});
it("foreign session is excluded", () => {
  const foreign = run("foreign"); foreign.delegation.sessionId = "other";
  const mine = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const theirs = handled(out("task.assignment", "agent-id-a", "accepted", {}, "foreign"), "agent-id-a");
  const inbound = { message: { ...theirs.message, message_id: "in-foreign", type: "implementation.submitted", recipient: { role: "coordinator" } }, status: "applied" } as never;
  const view = projectWorkforce(base([pane("developer", "a", { permanent: false })], { runs: [run(), foreign], outbound: [theirs, mine], inbox: [inbound] }));
  expect(view.agents[0]!.work.map(w => w.messageId)).toEqual([mine.message.message_id]);
  expect(view.handoffs.map(h => h.runId)).toEqual(["run-1"]);
  expect(JSON.stringify(view)).not.toContain("foreign");
});
it("maps every allocationStatus value and fails safe on unknown ones", () => {
  const mk = (n: string, extra: Record<string, unknown>) => pane("developer", n, { permanent: false, ...extra });
  const view = projectWorkforce(base([
    mk("active", {}),
    mk("none", { metadata: { topologyRole: "x" } }),
    mk("released", { metadata: { allocationStatus: "released", releasedAt: "2026-11-01T23:30:00.000Z" } }),
    mk("retained", { readOnlyWorkspace: true, transportState: "cancelled", metadata: { allocationStatus: "released", releasedAt: "2026-11-01T23:30:00.000Z" } }),
    mk("weird", { metadata: { allocationStatus: "reserved-by-future" } }),
    mk("nonstring", { metadata: { allocationStatus: 7 } }),
  ]));
  expect(view.agents.map(a => a.allocation)).toEqual(["active", "active", "released", "stopped_retained", "released", "released"]);
});
it("hides panes released more than an hour before the snapshot and keeps unprovable ones", () => {
  const view = projectWorkforce(base([
    pane("developer", "old", { permanent: false, metadata: { allocationStatus: "released", releasedAt: "2026-11-01T22:59:00.000Z" } }),
    pane("developer", "recent", { permanent: false, metadata: { allocationStatus: "released", releasedAt: "2026-11-01T23:30:00.000Z" } }),
    pane("developer", "undated", { permanent: false, metadata: { allocationStatus: "released" } }),
    pane("developer", "live", { permanent: false }),
  ]));
  expect(view.agents).toHaveLength(3);
  const later = projectWorkforce(base([pane("developer", "recent", { permanent: false, metadata: { allocationStatus: "released", releasedAt: "2026-11-01T23:30:00.000Z" } }),
    pane("developer", "live", { permanent: false })], {}, "2026-11-02T00:31:00.000Z"));
  expect(later.agents).toHaveLength(1);
});
it("skips panes whose role is not an agent role instead of failing", () => {
  const view = projectWorkforce(base([conversation(), pane("sos", "sos", {}), coordinator()]));
  expect(view.agents.map(a => a.role)).toEqual(["conversation", "coordinator"]);
});
it("displayName comes from the pinned profile snapshot, passes redact, and falls back to the role", () => {
  const definition = { schemaVersion: 3, profileId: "fe", version: "1.0.0", displayName: "Frontend token=abc", baseRole: "developer" };
  const pin = { profileId: "fe", version: "1.0.0", digest: "d".repeat(64) };
  const s = base([pane("developer", "a", { permanent: false, roleProfile: pin }), coordinator()], {}, now,
    { roleProfiles: [{ schemaVersion: 3, pin, definition }] });
  const view = projectWorkforce({ ...s, redact: (t: string) => t.replace(/token=\S+/, "[redacted]") });
  expect(view.agents[0]).toMatchObject({ displayName: "Frontend [redacted]", profileId: "fe" });
  expect(view.agents[1]!.displayName).toBe("Coordinator");
});
it("bounds the view and reports truncation", () => {
  const outbound = Array.from({ length: 70 }, (_, i) => out("task.status", undefined, "delivered", { }, "run-1"));
  const many = Array.from({ length: 12 }, () => handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a"));
  const view = projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [...outbound, ...many] }));
  expect(view.handoffs.filter(h => h.direction === "outbound")).toHaveLength(60);
  expect(view.agents[0]!.work).toHaveLength(8);
  expect(view.truncated).toBe(true);
  // newest wins, ordinals are positions in the session's append-only outbox
  expect(view.handoffs.at(-1)!.ordinal).toBe(81);
  expect(view.agents[0]!.work.at(-1)!.messageId).toBe(many.at(-1)!.message.message_id);
});
it("inbound ordinals are independent of outbound", () => {
  const msg = (n: number) => ({ message: { schema_version: 2, message_id: `in-${n}`, correlation_id: "c", run_id: "run-1", sender: { role: "developer" }, recipient: { role: "coordinator" },
    type: "implementation.submitted", payload: {}, artifact_references: [] }, status: n % 2 ? "received" : "rejected" }) as never;
  const view = projectWorkforce(base([coordinator()], { inbox: [msg(0), msg(1)] }));
  expect(view.handoffs.map(h => [h.direction, h.ordinal, h.state])).toEqual([["inbound", 0, "rejected"], ["inbound", 1, "delivered"]]);
});
it("evidence is limited to same-run artifact references", () => {
  const ref = (runId: string) => ({ artifactId: "art-" + runId, runId, kind: "document", mediaType: "text/markdown", uri: "artifact://x",
    checksum: { algorithm: "sha256", value: "0".repeat(64) }, sizeBytes: 5, createdAt: at, secret: "no" });
  const o = out("task.assignment", "agent-id-a", "queued"); o.message.artifact_references = [ref("run-1"), ref("other")] as never;
  const view = projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [o] }));
  expect(view.handoffs[0]!.evidence).toEqual([{ artifactId: "art-run-1", runId: "run-1", kind: "document", mediaType: "text/markdown",
    checksum: { algorithm: "sha256", value: "0".repeat(64) }, sizeBytes: 5 }]);
});
it("reading workforce does not change run revisionToken", () => {
  const plain = { state: state([run()]), sessionId: "conversation-1", observedAt: now, core: new Map(), ready: true,
    transport: { states: ["idle" as const], observedAt: at } };
  const before = projectRun(plain, "run-1").revisionToken;
  const a = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const s = { ...plain, state: { ...plain.state, outbound: [a] }, manifest: manifest([pane("developer", "a", { permanent: false })]), projectId };
  projectWorkforce(s);
  expect(projectRun(s, "run-1").revisionToken).toBe(before);
});
it("workforce revisionToken is deterministic from non-time content", () => {
  const original = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const mk = (observedAt: string, lease: string, updatedAt: string) => projectWorkforce(base([pane("developer", "a", { permanent: false })],
    { outbound: [{ ...original, lease: { expiresAt: lease } } as unknown as Outbound] }, observedAt, { updatedAt }));
  const first = mk(now, "2026-11-02T00:10:00.000Z", at);
  const second = mk("2026-11-02T00:00:09.000Z", "2026-11-02T00:20:00.000Z", "2026-11-02T00:00:08.000Z");
  expect(second.revisionToken).toBe(first.revisionToken);
  expect(second.agents[0]!.work[0]!.leaseExpiresAt).not.toBe(first.agents[0]!.work[0]!.leaseExpiresAt);
  const changed = projectWorkforce(base([pane("developer", "a", { permanent: false, transportState: "working" })]));
  expect(changed.revisionToken).not.toBe(projectWorkforce(base([pane("developer", "a", { permanent: false })])).revisionToken);
});
it("workforce change publishes one invalidate; repeated reads and lease heartbeats do not self-invalidate", () => {
  const original = handled(out("task.assignment", "agent-id-a", "accepted"), "agent-id-a");
  const read = (lease: string, extra: Partial<JournalState> = {}, observedAt = now) => {
    const a = { ...original, lease: { expiresAt: lease } } as unknown as Outbound;
    return projectionFingerprint([projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [a], ...extra }, observedAt))]);
  };
  const first = read("2026-11-02T00:10:00.000Z");
  expect(read("2026-11-02T00:10:00.000Z", {}, "2026-11-02T00:00:05.000Z")).toBe(first);
  // lease heartbeat: only the renewed expiry moves
  expect(read("2026-11-02T00:25:00.000Z", {}, "2026-11-02T00:00:09.000Z")).toBe(first);
  // a real change (a second handoff) moves the fingerprint
  const extra = projectionFingerprint([projectWorkforce(base([pane("developer", "a", { permanent: false })], { outbound: [
    { ...original, lease: { expiresAt: "2026-11-02T00:10:00.000Z" } } as unknown as Outbound,
    handled(out("verification.requested", "agent-id-a", "queued"), "agent-id-a")] }))]);
  expect(extra).not.toBe(first);
});

it("never reassigns an explicitly addressed retired agent's work to its replacement", () => {
  const assignment = handled(out("task.assignment", "agent-id-old", "accepted"), "agent-id-old");
  const view = projectWorkforce(base([pane("developer", "new", { permanent: false })], { outbound: [assignment] }));
  expect(view.agents[0]!.work).toEqual([]);
  expect(view.handoffs[0]!.to).toEqual({ role: "developer" });
});
it("an explicit agent identity cannot resolve across roles", () => {
  const assignment = handled(out("task.assignment", "agent-id-coord", "accepted"), "agent-id-coord");
  const view = projectWorkforce(base([coordinator(), pane("developer", "new", { permanent: false })], { outbound: [assignment] }));
  expect(view.agents.flatMap(agent => agent.work)).toEqual([]);
  expect(view.handoffs[0]!.to).toEqual({ role: "developer" });
});
