import {
  AgentProviderIdSchema, DelegationRequestSchema, SessionManifestSchema,
  type AgentProviderId, type DelegationRequest, type OperationResult, type RoleMessage, type SessionManifest
} from "@bflow/contracts";
import { redactString } from "../resilience/redaction.js";
import { digest } from "./journal.js";
import { notificationBody, renderConversationNotice, type NoticeLike } from "./conversation-notice-render.js";
import type { DirectorWorkStart } from "../director/tools.js";

/**
 * Pure pieces of the host's Director mode (ADR 0009, slice B2a). The host composes them; tests drive them without Herdr.
 * The session mode follows the activated SessionManifest (`schemaVersion: 3`), and the host layout must agree with it.
 */
export type HostLayout = "legacy_v2" | "director";

export function hostLayoutOf(layout: HostLayout | undefined): HostLayout { return layout ?? "legacy_v2"; }

/** Roles that exist only as panes of a v2 session; a Director session hosts neither. */
export const DIRECTOR_REPLACED_ROLES: readonly string[] = ["conversation", "coordinator"];

/** Host roles that get tokens, hooks and launch descriptors for the layout. */
export function hostRolesFor<T extends string>(layout: HostLayout | undefined, roles: readonly T[]): T[] {
  return hostLayoutOf(layout) === "director" ? roles.filter(role => !DIRECTOR_REPLACED_ROLES.includes(role)) : [...roles];
}

/** Refuses a v2 manifest for a Director host and a v3 manifest for a legacy host. */
export function assertManifestLayout(manifest: SessionManifest, layout: HostLayout | undefined): void {
  const director = hostLayoutOf(layout) === "director";
  if (director !== (manifest.schemaVersion === 3)) throw new Error("Session manifest layout does not match host configuration");
}

/** The provider of the first specialist role of the platform configuration; Claude when none is configured. */
export function directorDefaultAgentKind(platformRoles: readonly { role: string; provider: string }[]): AgentProviderId {
  const first = platformRoles.find(option => !DIRECTOR_REPLACED_ROLES.includes(option.role));
  return first ? AgentProviderIdSchema.parse(first.provider) : "claude";
}

/** Pane Manager default agent kind: v2 keeps the Coordinator pane's kind; v3 has no Coordinator pane and uses the host value. */
export function workspaceDefaultAgentKind(manifest: SessionManifest, hostDefault: string | undefined): string {
  if (manifest.schemaVersion === 3) return hostDefault ?? "claude";
  const coordinator = manifest.panes.find(pane => pane.role === "coordinator");
  if (!coordinator) throw new Error("Conversation and Coordinator panes are required");
  return coordinator.agentKind;
}

/** Progress viewer argv for the Director layout: the manifest's recorded command wins over the host configuration. */
export function directorProgressCommand(manifest: SessionManifest, configured: readonly string[] | undefined): string[] {
  const recorded = manifest.schemaVersion === 3 ? manifest.progressPane?.command : undefined;
  const command = recorded ?? configured;
  if (!command || command.length === 0) throw new Error("Director session has no progress pane command; run bflow up again");
  return [...command];
}

/** Deterministic ids from the Director key, identical to B1's `delegateDirectorWork`, so a replay yields the same run. */
export function directorDelegationIds(key: string): { hash: string; correlationId: string; runId: string } {
  const hash = digest(key).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  const correlationId = `director-${hash}`;
  return { hash, correlationId, runId: `run-${correlationId}` };
}

/** Structural view of `@bflow/conversation`'s `buildDelegationRequest`; the host passes the real builder. */
export type DelegationBuilder = (params: {
  sessionId: string; correlationId: string; runId: string; messageId: string; previousDelegationId: string; idempotencyKey: string;
  requestedAt: string; revision: number;
  draft: { title: string; objective: string; kind: string; sddLevel: string; priority: string; scopeDefined: boolean; isLargeTask: boolean;
    affectedPaths: string[]; acceptanceCriteriaDescriptions: string[]; acceptanceCriteria: readonly { description: string; verificationMethod: string }[];
    isRequirementChange: boolean };
}) => OperationResult<DelegationRequest>;

/**
 * R-B2-4: the Director opens the run itself. The Conversation builder still derives the criteria and metadata; the result is
 * rewritten to `requestedBy: "director"` for the Director's own session and parsed again by the exported contract.
 */
export function buildDirectorWorkDelegation(build: DelegationBuilder, input: DirectorWorkStart, sessionId: string): OperationResult<DelegationRequest> {
  const { hash, correlationId, runId } = directorDelegationIds(input.key);
  const built = build({ sessionId, correlationId, runId,
    messageId: `msg-director-${hash}`, previousDelegationId: `del-director-${hash}`, idempotencyKey: `idemp-director-${hash}`,
    requestedAt: input.requestedAt, revision: 1,
    draft: { title: input.title, objective: input.objective, kind: input.kind, sddLevel: input.sddLevel, priority: input.priority,
      scopeDefined: true, isLargeTask: false, affectedPaths: [], acceptanceCriteriaDescriptions: [],
      acceptanceCriteria: input.acceptanceCriteria, isRequirementChange: false } });
  if (!built.ok) return built;
  const parsed = DelegationRequestSchema.safeParse({ ...built.value, requestedBy: "director", targetRole: "coordinator", sessionId, runId,
    metadata: { ...built.value.metadata, origin: "director" } });
  if (!parsed.success) return { ok: false, error: { code: "validation", retryable: false, message: parsed.error.message } };
  return { ok: true, value: parsed.data };
}

export interface DirectorStartWorkDeps {
  manifest: () => SessionManifest;
  build: DelegationBuilder;
  admitDirectorWork: (delegation: DelegationRequest) => Promise<{ runId: string; correlationId: string; admission: "new" | "duplicate" }>;
  log: (entry: { kind: "tool" | "error"; action: string; outcome?: string }) => Promise<void>;
}

/** `start_work` in a Director session: admitted by Runtime directly, never through the Conversation bridge. */
export async function startDirectorWork(deps: DirectorStartWorkDeps, input: DirectorWorkStart): Promise<{ runId: string; correlationId: string; status: "queued" }> {
  let admitted: Awaited<ReturnType<DirectorStartWorkDeps["admitDirectorWork"]>>;
  try {
    const manifest = SessionManifestSchema.parse(deps.manifest());
    if (manifest.schemaVersion !== 3) throw new Error("Director work requires an active Director session");
    const built = buildDirectorWorkDelegation(deps.build, input, manifest.conversationSessionId);
    if (!built.ok) {
      await deps.log({ kind: "error", action: "director:start_work:failed", outcome: built.error.code });
      throw new Error(`start_work refused: ${redactString(built.error.message)}`);
    }
    admitted = await deps.admitDirectorWork(built.value);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("start_work refused: ")) throw error;
    if (error instanceof Error && error.name === "AdmissionRejectedError") {
      await deps.log({ kind: "error", action: "director:start_work:failed", outcome: "validation" });
      throw new Error(`start_work refused: ${redactString(error.message)}`);
    }
    await deps.log({ kind: "error", action: "director:start_work:failed", outcome: error instanceof Error ? error.name : "HostToolError" });
    throw error;
  }
  await deps.log({ kind: "tool", action: "director:start_work:completed" });
  return { runId: admitted.runId, correlationId: admitted.correlationId, status: "queued" };
}

export interface DirectorNoticeMirrorDeps {
  /** Writes (or finds) the durable notice receipt; the receipt carries the #n alias. */
  appendNotice: (message: RoleMessage) => Promise<{ created: boolean; notice: (NoticeLike & { shortId?: string | undefined }) | undefined }>;
  /** Present only in a Director session. */
  mirror?: ((message: RoleMessage, rendered: { text: string; code?: string }) => Promise<void>) | undefined;
  log: (entry: { kind: "error"; action: string; outcome: string }) => Promise<void>;
}

/**
 * Host `onConversationNotice`: the receipt is always written (and its failure propagates as before); in a Director session the
 * rendered notice is copied into the Director mailbox for the user audience. A mirror failure is logged and never fails delivery.
 */
export async function recordConversationNotice(deps: DirectorNoticeMirrorDeps, message: RoleMessage): Promise<void> {
  const { notice } = await deps.appendNotice(message);
  if (!deps.mirror || notice === undefined) return;
  try {
    const text = notificationBody(renderConversationNotice(notice), 1200);
    await deps.mirror(message, { text, ...(notice.shortId !== undefined ? { code: notice.shortId } : {}) });
  } catch (error) {
    await deps.log({ kind: "error", action: "director_notice_mirror_failed", outcome: redactString(String(error)).slice(0, 240) }).catch(() => undefined);
  }
}

/** One reconciliation of the Director progress pane; never throws. Returns whether the pane was reconciled. */
export async function ensureDirectorProgressPane(panes: { ensureProgressPane?: () => Promise<OperationResult<unknown>> },
  log: (entry: { kind: "error"; action: string; outcome: string }) => Promise<void>): Promise<boolean> {
  if (!panes.ensureProgressPane) return false;
  let failure: string | undefined;
  try {
    const result = await panes.ensureProgressPane();
    if (!result.ok) failure = result.error.message;
  } catch (error) { failure = String(error); }
  if (failure === undefined) return true;
  await log({ kind: "error", action: "progress_pane_unavailable", outcome: redactString(failure).slice(0, 240) }).catch(() => undefined);
  return false;
}
