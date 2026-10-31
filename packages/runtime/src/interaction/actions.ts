import {
  WebActionSchema,
  type WebAction,
  type WebDecision,
} from "@bflow/contracts";
import {
  digest,
  isConversationDelivery,
  type JournalState,
  type RunRecord,
} from "../agentic/journal.js";
import { unmeasuredPolicyPhaseRequests } from "../agentic/phase-recovery.js";
export const terminal = (r: RunRecord) =>
  r.cancelled ||
  !!r.supersededBy ||
  ["completed", "failed", "cancelled"].includes(r.status);
/** Command-specific optimistic version: neither observation timestamps nor unrelated run activity. */
export function actionVersion(r: RunRecord, kind: string) {
  return {
    revisionToken: digest([
      r.runId,
      kind,
      r.delegation,
      r.cancelled,
      r.supersededBy,
      kind === "resume" ? r.pendingAction : undefined,
      kind === "revise_request" ? r.delegation.metadata?.followUp : undefined,
    ]),
  };
}
export function availableActions(
  r: RunRecord,
  state: JournalState,
  decisions: WebDecision[],
  ready: boolean,
  commandsSupported = false,
  stale = false,
): WebAction[] {
  if (terminal(r)) return [];
  const uncertain =
    !!r.nativeDeliveries?.length ||
    state.outbound.some(
      (o) =>
        o.message.run_id === r.runId &&
        ["sending", "unknown_delivery"].includes(o.status),
    );
  const gate = decisions.some((d) => d.status === "pending");
  const baseReason = !ready
    ? "host_unavailable"
    : !commandsSupported
      ? "structured_commands_unavailable"
      : stale
        ? "core_projection_unavailable"
        : undefined;
  const action = (
    kind: "cancel" | "revise_request" | "resume",
    reason?: string,
  ): WebAction =>
    WebActionSchema.parse({
      kind,
      actionId:
        kind === "resume" ? r.pendingAction!.actionId : `${kind}-${r.runId}`,
      enabled: !(baseReason || reason),
      ...(baseReason || reason ? { disabledReason: baseReason || reason } : {}),
      expectedVersion: actionVersion(r, kind),
    });
  const actions = [
    action("cancel"),
    action(
      "revise_request",
      Number(r.delegation.metadata?.followUp ?? 1) >= 6
        ? "follow_up_budget_exhausted"
        : r.coreCreated
          // Mirrors Runtime admission: tasks already in Core cannot be re-planned in place.
          ? "core_execution_started"
          : uncertain
            ? "delivery_reconciliation_required"
            : undefined,
    ),
  ];
  const previousResume = r.resumeReceipts?.find(item => item.actionId === r.pendingAction?.actionId);
  // Runtime accepts a separately identified explicit resume after its automatic wake, including while queued.
  const explicitAfterAutomatic = r.pendingAction?.kind === "resume_coordinator" && previousResume !== undefined &&
    state.outbound.some(out => out.message.message_id === previousResume.messageId && out.message.run_id === r.runId &&
      out.message.type === "task.status" && out.message.sender.role === "runtime" &&
      typeof out.message.payload === "object" && out.message.payload !== null && !Array.isArray(out.message.payload) &&
      out.message.payload.kind === "resume_run" && out.message.payload.actionId === r.pendingAction?.actionId && out.message.payload.automatic === true);
  const unmeasuredResume = r.pendingAction?.kind === "coordinator_continuation" && r.status === "implementing" &&
    unmeasuredPolicyPhaseRequests(state, r).length > 0;
  const resumeUncertain = !!r.nativeDeliveries?.length || state.outbound.some(out => out.message.run_id === r.runId &&
    ["sending", "unknown_delivery"].includes(out.status) && !isConversationDelivery(out));
  if (r.pendingAction && (r.pendingAction.kind !== "coordinator_continuation" || unmeasuredResume)) {
    const a = r.pendingAction;
    const issued = new Set(
      state.outbound
        .filter(
          (o) =>
            o.message.run_id === r.runId &&
            o.message.type === "task.status" &&
            o.message.sender.role === "runtime" &&
            typeof o.message.payload === "object" &&
            o.message.payload !== null &&
            !Array.isArray(o.message.payload) &&
            o.message.payload.kind === "resume_run" &&
            o.message.payload.automatic === false &&
            o.message.payload.actionId === a.actionId,
        )
        .map((o) => o.message.message_id),
    ).size;
    const restore =
      a.previousStatus === "awaiting_approval" &&
      ["task", "delivery"].includes(r.approvalKind ?? "") &&
      !Object.values(r.userDecisions ?? {}).some((d) => d.status === "pending");
    actions.push(
      action(
        "resume",
        resumeUncertain
          ? "delivery_reconciliation_required"
          : Math.max(a.manualResumeAttempts ?? 0, issued) >= 3
            ? "resume_budget_exhausted"
            : gate && !restore
              ? "decision_required"
              : !explicitAfterAutomatic && ((r.status !== "escalated" && !unmeasuredResume) || a.state !== "pending")
                ? "action_not_pending"
                : a.requiredRole
                  ? "capability_revalidation_required"
                  : undefined,
      ),
    );
  }
  for (const d of decisions.filter((d) => d.status === "pending"))
    actions.push(
      WebActionSchema.parse({
        kind: "answer_decision",
        actionId: d.decisionId,
        expectedVersion: d.expectedVersion,
        enabled: !(baseReason || uncertain),
        ...(baseReason || uncertain
          ? { disabledReason: baseReason ?? "delivery_reconciliation_required" }
          : {}),
      }),
    );
  return actions;
}

/** A workspace under construction is not authenticated activated health. */
export function interactionHostReady(state: {
  workspace: boolean;
  manifest: boolean;
  activating: boolean;
  closing: boolean;
  quiesced: boolean;
}): boolean {
  return (
    state.workspace &&
    state.manifest &&
    !state.activating &&
    !state.closing &&
    !state.quiesced
  );
}
