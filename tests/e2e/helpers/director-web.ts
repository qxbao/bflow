import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ApprovalDecisionSchema, WebCommandSchema, type ApprovalDecision, type WebIssueCommand } from "@bflow/contracts";
import { webCommandFingerprint } from "@bflow/contracts/web-host";
import { DirectorWebBridge } from "@bflow/runtime";
import { createDirectorSession, type DirectorSession, type DirectorSessionOptions } from "./director-session.js";

/**
 * E18 Director Web composition: the host's DirectorWebBridge (packages/runtime/src/agentic/host.ts) built over the real
 * DirectorEndpoint and Runtime of a Director session, with a recording feed in place of the host ProjectionFeed. The bridge is
 * the single writer path the Local Server reaches through the host socket; this composition calls it in process.
 */

export const PROJECT_ID = "project-1";
/** Conversation session of the Director manifest (DirectorPanes.manifest().conversationSessionId). */
export const HOST_CONVERSATION_SESSION = "session-1";

export interface FeedEvent { type: "chat" | "invalidate"; resourceIds: string[] }

export function directorWebBridge(session: DirectorSession, options: { ready?: () => boolean; layout?: () => "director" | "legacy_v2" } = {}) {
  const feed: FeedEvent[] = [];
  const bridge = new DirectorWebBridge({
    endpoint: session.endpoint,
    projectId: PROJECT_ID,
    layout: options.layout ?? (() => "director"),
    ready: options.ready ?? (() => true),
    sessionId: () => session.panes.manifest().conversationSessionId,
    inspect: () => session.runtime.inspect(),
    runSession: async runId => {
      const run = await session.runtime.inspect(runId).catch(() => undefined) as { delegation?: { sessionId?: unknown } } | undefined;
      return typeof run?.delegation?.sessionId === "string" ? run.delegation.sessionId : undefined;
    },
    feed: { publish: (type, resourceIds) => { feed.push({ type, resourceIds: [...resourceIds] }); } }
  });
  return { bridge, feed };
}

/** Exact-copy fake human authentication (E17): only a decision the structured gateway recorded for a human is authorized. */
export async function createWebDirectorSession(options: Omit<DirectorSessionOptions, "authorizeHuman"> = {}) {
  const authorized: ApprovalDecision[] = [];
  const session: DirectorSession = await createDirectorSession({ ...options, authorizeHuman: async decision => {
    const parsed = ApprovalDecisionSchema.parse(decision);
    const exact = session.humanDecisions.some(recorded => isDeepStrictEqual(ApprovalDecisionSchema.parse(recorded), parsed));
    if (exact) authorized.push(decision);
    return exact;
  } });
  return { session, authorized };
}

/** The Gateway's projection token (localeCompare key order), as the Web client echoes it back (E17). */
export function projectionToken(value: unknown): string {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical)}]` : v !== null && typeof v === "object"
    ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)}}`
    : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** WebPrincipal shape for the structured gateway; this session's gateway authorization is the composition's fake. */
export function webPrincipal(command: unknown) {
  const parsed = WebCommandSchema.parse(command);
  const now = new Date();
  return { schemaVersion: 1, source: "local_web", issuerId: "issuer-1", keyId: "key-1", principalId: "human-1", browserSessionId: "browser-1",
    projectId: parsed.projectId, hostSessionId: "session-1", capability: "user_interaction", commandId: parsed.commandId,
    commandDigest: webCommandFingerprint(parsed), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(), nonce: randomUUID(),
    signature: { algorithm: "ed25519", value: `${"A".repeat(86)}==` } };
}

/** A signed-shape Web issue command (retry/dismiss) as the Web issue queue sends it. */
export function issueCommand(kind: "issue_retry" | "issue_dismiss", issue: { runId: string; issueId: string; updatedAt: string }, overrides: Partial<{ runId: string; expectedUpdatedAt: string; projectId: string }> = {}): WebIssueCommand {
  return WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: overrides.projectId ?? PROJECT_ID, kind,
    runId: overrides.runId ?? issue.runId, issueId: issue.issueId, expectedUpdatedAt: overrides.expectedUpdatedAt ?? issue.updatedAt }) as WebIssueCommand;
}

/** Seeded PRNG (mulberry32): reproducible stateful sequences without new dependencies. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! };
}
