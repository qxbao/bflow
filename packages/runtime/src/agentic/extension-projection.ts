import { z } from "zod";
import { ApprovalRequestSchema, IdentifierSchema, SdlcWorkStatusSchema, WorkflowDefinitionSchema, type SdlcWorkStatus } from "@bflow/contracts";
import { digest, record, type JournalState } from "./journal.js";

/** Maintained read model only. Core/events/SDK journals retain all execution and approval authority. */
export const ExtensionProjectionSchema = z.object({ schemaVersion: z.literal(1), runId: IdentifierSchema,
  sessionId: IdentifierSchema, delegationDigest: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["analysis", "qa"]),
  status: SdlcWorkStatusSchema, cancelled: z.boolean(), coreVersion: z.number().int().nonnegative(),
  definition: WorkflowDefinitionSchema, approvals: z.array(ApprovalRequestSchema).max(1) }).strict();

export function extensionSdlcStatus(status: string | undefined, kind: "analysis" | "qa"): SdlcWorkStatus {
  if (status === "published" || status === "reported") return "completed";
  if (status?.startsWith("awaiting_")) return "awaiting_approval";
  if (status === "cancelling" || status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "needs_revision") return "escalated";
  return kind === "analysis" ? "specifying" : "verifying";
}

/** Overlay an exact admitted extension on a copy, so live and offline queries use the same bounded view. */
export function projectExtensionRoutes(state: JournalState, routes: JournalState, sessionId: string, diagnostic: (code: string) => void = code => console.warn(code)): JournalState {
  const projections = new Map(routes.inbox.filter(item => item.status === "applied" && record(item.message.payload).kind === "extension.route")
    .flatMap(item => {
      try {
      const route = record(record(item.message.payload).route);
      if (route.projection === undefined) return [];
      const projection = ExtensionProjectionSchema.parse(route.projection);
      if (projection.sessionId !== sessionId) return [];
      if (route.runId !== projection.runId || route.kind !== projection.kind || route.started !== true ||
          digest(route.delegation) !== projection.delegationDigest || record(route.delegation).sessionId !== projection.sessionId)
        throw new Error("Extension read projection has a foreign admission/session");
      return [[projection.runId, projection] as const];
      } catch { diagnostic("extension_projection_invalid"); return []; }
    }));
  return { ...state, runs: state.runs.map(run => {
    const projection = projections.get(run.runId);
    if (!projection || run.delegation.sessionId !== sessionId) return run;
    if (digest(run.delegation) !== projection.delegationDigest) { diagnostic("extension_projection_delegation_mismatch"); return run; }
    const terminal = run.cancelled || !!run.supersededBy || ["completed", "completed_with_parked", "failed", "cancelled"].includes(run.status);
    const approval = terminal ? undefined : projection.approvals[0];
    const { approval: _approval, decision: _decision, pendingAction: _pendingAction, error: _error, ...base } = run;
    return { ...base, status: terminal ? run.status : projection.status, cancelled: run.cancelled || projection.cancelled, coreCreated: true,
      definition: projection.definition, userDecisions: {}, ...(approval ? { approval } : {}) };
  }) };
}

/** Compose SDK detail with its admitted parent; an extension never reopens a terminal/cancelled parent. */
export function mergeExtensionRun(parentInput: unknown, extensionInput: unknown): Record<string, unknown> {
  const parent = record(parentInput), extension = record(extensionInput);
  if (parent.runId !== extension.runId) throw new Error("Extension parent/run mismatch");
  if (parent.cancelled === true || parent.supersededBy || ["completed", "completed_with_parked", "failed", "cancelled"].includes(String(parent.status))) {
    const { approval: _approval, ...detail } = extension;
    return { ...detail, ...parent, queuedDecisions: [] };
  }
  return { ...parent, ...extension };
}
