import { createHash } from "node:crypto";
import {
  AgentRoleSchema, WebWorkforceViewSchema,
  type AgentRole, type PaneBinding, type RoleMessage, type WebAgentView, type WebAgentWork, type WebHandoffView, type WebWorkforceView,
} from "@bflow/contracts";
import { digest, type Outbound } from "../agentic/journal.js";
import { stableProjection } from "./fingerprint.js";
import type { ReadSources } from "./views.js";

/** Bounds mirror the frozen schema and ADR 0008. */
const MAX_AGENTS = 100, MAX_WORK = 8, OUTBOUND_WINDOW = 60, INBOUND_WINDOW = 40, MAX_EVIDENCE = 20;
const RELEASED_RETENTION_MS = 60 * 60 * 1000;
const WORK_KINDS: Record<string, WebAgentWork["kind"] | undefined> = {
  "task.assignment": "assignment", "delegation.request": "delegation", "verification.requested": "verification",
};
/** An outbound still holds its recipient while it is queued, in flight, uncertain or accepted. */
const OPEN_STATUSES: ReadonlySet<Outbound["status"]> = new Set(["queued", "sending", "unknown_delivery", "accepted"]);
const INBOUND_STATE = { received: "delivered", applied: "applied", rejected: "rejected" } as const;

const hash = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);
const sliceSafe = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
};
const display = (s: ReadSources, text: string, max: number) => sliceSafe((s.redactOption ?? s.redact)?.(text) ?? text, max) || "[redacted]";

type Allocation = WebAgentView["allocation"];
/**
 * allocationStatus values written by role-pane-manager.ts: "active" (Developer/specialist allocation) and "released"
 * (release with retention; `stoppedRetained` additionally sets readOnlyWorkspace and transportState "cancelled").
 * Permanent panes carry no value and are allocated for the whole session. Anything else is future or corrupt: it is
 * reported as "released" so the UI never claims capacity or activity that nothing proves.
 */
export function allocationOf(pane: PaneBinding): Allocation {
  const status: unknown = pane.metadata?.["allocationStatus"];
  if (status === undefined || status === "active") return "active";
  if (status === "released") return pane.readOnlyWorkspace && pane.transportState === "cancelled" ? "stopped_retained" : "released";
  return "released";
}
function releasedTooLong(pane: PaneBinding, allocation: Allocation, now: number): boolean {
  if (allocation === "active") return false;
  const releasedAt = pane.metadata?.["releasedAt"];
  const at = typeof releasedAt === "string" ? Date.parse(releasedAt) : Number.NaN;
  // An undated release cannot be proven old, so it stays visible.
  return Number.isFinite(at) && now - at > RELEASED_RETENTION_MS;
}
/** enqueue() defaults taskId/attemptId to synthetic `message-`/`attempt-` values for messages that are not task work. */
const realTaskId = (out: Outbound) => out.taskId === `message-${out.message.message_id}` ? undefined : out.taskId;
const realAttemptId = (out: Outbound) => out.attemptId === `attempt-${out.message.message_id}` ? undefined : out.attemptId;

interface Listed { pane: PaneBinding; role: AgentRole; allocation: Allocation; instanceId: string }

/** Pure, read-only projection of the Session Manifest and journal into agents, their open work and recent handoffs. */
export function projectWorkforce(s: ReadSources): WebWorkforceView {
  if (!s.manifest || !s.projectId) throw new Error("Workforce projection requires a manifest and project scope");
  const manifest = s.manifest, now = Date.parse(s.observedAt);
  const listed: Listed[] = [];
  for (const pane of manifest.panes) {
    const role = AgentRoleSchema.safeParse(pane.role);
    // Roles outside the contract (e.g. an `sos` rescue pane) are not workforce members; they must not fail the read.
    if (!role.success) continue;
    const allocation = allocationOf(pane);
    if (releasedTooLong(pane, allocation, now)) continue;
    listed.push({ pane, role: role.data, allocation, instanceId: "agent-" + hash(pane.bindingId, 32) });
  }
  const shown = listed.slice(0, MAX_AGENTS);
  let truncated = listed.length > shown.length;

  // An agentId may be bound by several panes over time (retained Developer panes are reused): the live one wins.
  const byAgent = new Map<string, Listed>();
  for (const item of shown) {
    const previous = byAgent.get(item.pane.agentId);
    if (!previous || previous.allocation !== "active" || item.allocation === "active") byAgent.set(item.pane.agentId, item);
  }
  /** Exactly one live pane of a role is attributable without guessing; otherwise the participant stays unresolved. */
  const uniqueByRole = (role: string): Listed | undefined => {
    const live = shown.filter(item => item.role === role && item.allocation === "active");
    return live.length === 1 ? live[0] : undefined;
  };
  const resolve = (role: string, agentId?: string): Listed | undefined => {
    // An explicit identity is authoritative even when its pane has left the view.
    // Falling back to a role would attach historical work to a replacement instance.
    if (agentId === undefined) return uniqueByRole(role);
    const found = byAgent.get(agentId);
    return found?.role === role ? found : undefined;
  };

  const sessionRuns = new Set(s.state.runs.filter(r => r.delegation.sessionId === s.sessionId).map(r => r.runId));
  const inSession = (message: RoleMessage) => message.run_id !== undefined && sessionRuns.has(message.run_id);
  const outbound = s.state.outbound.filter(out => inSession(out.message));
  const inbound = s.state.inbox.filter(item => inSession(item.message));

  const profileName = (pane: PaneBinding): string | undefined => {
    const pin = pane.roleProfile;
    if (!pin) return undefined;
    return manifest.roleProfiles?.find(snapshot => snapshot.pin.profileId === pin.profileId && snapshot.pin.version === pin.version &&
      snapshot.pin.digest === pin.digest)?.definition.displayName;
  };

  const workBy = new Map<string, WebAgentWork[]>();
  for (const out of outbound) {
    const kind = WORK_KINDS[out.message.type];
    // A control notice borrows its assignment's lease and recipient; it is the same unit of work, not a second one.
    if (!kind || out.parentAssignmentId !== undefined || !OPEN_STATUSES.has(out.status)) continue;
    const owner = resolve(out.message.recipient.role, out.handle?.target.agentId ?? out.message.recipient.agent_id);
    if (!owner) continue;
    const taskId = realTaskId(out), attemptId = realAttemptId(out);
    const list = workBy.get(owner.instanceId) ?? [];
    list.push({
      messageId: out.message.message_id, kind, runId: out.message.run_id!,
      ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}), delivery: out.status as WebAgentWork["delivery"],
      ...(out.handle?.acceptedAt ? { acceptedAt: out.handle.acceptedAt } : {}),
      ...(out.turnObservedWorkingAt ? { turnSeenAt: out.turnObservedWorkingAt } : {}),
      ...(out.lease?.expiresAt ? { leaseExpiresAt: out.lease.expiresAt } : {}),
    });
    workBy.set(owner.instanceId, list);
  }

  const agents: WebAgentView[] = shown.map(({ pane, role, allocation, instanceId }) => {
    const all = workBy.get(instanceId) ?? [];
    if (all.length > MAX_WORK) truncated = true;
    return {
      instanceId, role, ...(pane.roleProfile ? { profileId: pane.roleProfile.profileId } : {}),
      displayName: display(s, profileName(pane) ?? role.charAt(0).toUpperCase() + role.slice(1), 200),
      ...(pane.paneGroup ? { group: pane.paneGroup } : {}), permanent: pane.permanent ?? false,
      provider: sliceSafe(pane.provider, 100), ...(pane.model ? { model: sliceSafe(pane.model, 200) } : {}),
      allocation,
      // transportState is written only on topology health inspection, so it is a diagnostic, not a liveness signal.
      transport: { state: pane.transportState, observedAt: manifest.updatedAt },
      boundAt: pane.boundAt, work: all.slice(-MAX_WORK),
    };
  });

  const evidence = (message: RoleMessage) => message.artifact_references.filter(ref => ref.runId === message.run_id).slice(0, MAX_EVIDENCE).map(ref => ({
    artifactId: ref.artifactId, runId: ref.runId, kind: ref.kind, mediaType: ref.mediaType, checksum: ref.checksum,
    ...(ref.sizeBytes === undefined ? {} : { sizeBytes: ref.sizeBytes }),
  }));
  const party = (role: string, agentId?: string) => {
    const found = resolve(role, agentId);
    return { role: sliceSafe(role, 32), ...(found ? { instanceId: found.instanceId } : {}) };
  };
  // Ordinals are positions in this session's append-only outbox/inbox; handoffId (a digest of the message ID) is the stable key.
  const handoffs: WebHandoffView[] = [
    ...outbound.map((out, ordinal) => ({ out, ordinal })).slice(-OUTBOUND_WINDOW).map(({ out, ordinal }): WebHandoffView => {
      const message = out.message;
      return {
        handoffId: "handoff-out-" + hash(message.message_id, 24), ordinal, runId: message.run_id!,
        ...(realTaskId(out) ? { taskId: realTaskId(out)! } : {}),
        messageType: message.type, direction: "outbound",
        from: party(message.sender.role, message.sender.agent_id),
        to: party(message.recipient.role, out.handle?.target.agentId ?? message.recipient.agent_id),
        state: out.status, evidence: evidence(message),
      };
    }),
    ...inbound.map((item, ordinal) => ({ item, ordinal })).slice(-INBOUND_WINDOW).map(({ item, ordinal }): WebHandoffView => {
      const message = item.message;
      return {
        handoffId: "handoff-in-" + hash(message.message_id, 24), ordinal, runId: message.run_id!,
        messageType: message.type, direction: "inbound",
        from: party(message.sender.role, message.sender.agent_id), to: party(message.recipient.role, message.recipient.agent_id),
        state: INBOUND_STATE[item.status], evidence: evidence(message),
      };
    }),
  ];
  if (outbound.length > OUTBOUND_WINDOW || inbound.length > INBOUND_WINDOW) truncated = true;

  // Only domain content feeds the token: observation times and renewed lease expiries are stripped (see fingerprint.ts).
  const revisionToken = digest(stableProjection({ agents, handoffs, truncated }));
  return WebWorkforceViewSchema.parse({
    apiVersion: 1, projectId: s.projectId, sessionId: s.sessionId, revisionToken, agents, handoffs, truncated, observedAt: s.observedAt,
  });
}
