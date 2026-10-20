/**
 * Pure decision logic for the host watchdog. It reads facts and returns actions; it performs no I/O and changes no state.
 * The host executes the actions one at a time, outside the journal lock, through the existing Runtime and receipt APIs.
 */

/** Durable facts about one run, derived by Runtime from journal state. Activity ignores Conversation-bound notices. */
export interface RunFacts {
  runId: string;
  status: string;
  /** Not terminal and not cancelled. */
  live: boolean;
  /** Latest message time (ms) of non-Conversation traffic for the run, or the delegation time when there is none. */
  lastActivityAt: number;
  /** The run is at a human gate (design approval pending). Waiting on a person is not a stall. */
  awaitingHuman: boolean;
  /**
   * A handoff that is still being delivered (queued within its not-ready window, sending or unknown delivery) exists for the run.
   * An accepted handoff is NOT activity by itself: it is active only while its pane is observed working (see acceptedRoles).
   */
  activeHandoff: boolean;
  /** Roles that hold an accepted, not yet released handoff of this run. A holder whose pane is not working has stopped without reporting. */
  acceptedRoles?: readonly string[];
  /** Pending user decisions (specialist questions) of the run. */
  pendingDecisions: readonly { approvalId: string; requestedAt: string }[];
}

/** Herdr agent status of one role pane, observed by the host. Only "idle", "done" and "unknown" mean not working. */
export interface PaneFact { role: string; status: string }

/** Display state of a user-decision notice (see ConversationNoticeState in host-receipts.ts). `since` is ISO time. */
export interface NoticeFact { messageId: string; surfaced: boolean; displayed: boolean; resends: number; since: string }

export interface WatchdogOptions {
  /** Wait before reconciling a missing notice, and before resurfacing an undisplayed one. */
  resurfaceAfterMs: number;
  /** Resurfacings allowed before the blocked notice is emitted instead. */
  maxResends: number;
  /** Idle time with no activity before a run is reported as stalled. */
  stallAfterMs: number;
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = { resurfaceAfterMs: 60_000, maxResends: 3, stallAfterMs: 180_000 };

export interface WatchdogInput {
  now: number;
  runs: readonly RunFacts[];
  notices: readonly NoticeFact[];
  panes: readonly PaneFact[];
  options?: Partial<WatchdogOptions>;
}

export type WatchdogAction =
  /** Pending user decision with no notice receipt: recreate it from the pending request and re-register with Conversation. */
  | { kind: "reconcile_notice"; runId: string; approvalId: string; messageId: string }
  /** Surfaced or unsurfaced but undisplayed for too long: start a new surfacing epoch and re-notify. */
  | { kind: "resurface"; runId: string; approvalId: string; messageId: string; attempt: number }
  /** Resends exhausted: emit one blocked notice for the approval (the host dedupes by approval). */
  | { kind: "blocked"; runId: string; approvalId: string; messageId: string; resends: number }
  /** Live run that is not working for too long. The episode key changes with every new activity, so each episode reports once. */
  | { kind: "stalled"; runId: string; episodeKey: string; idleSince: number; holders?: readonly string[] };

/** Notice message identity of a user decision, as Runtime emits it (buildDecisionRequestMessage). */
export function decisionMessageId(approvalId: string): string { return `decision-${approvalId}`; }

const NOT_WORKING = new Set(["idle", "done", "unknown"]);

/** Actions for the current facts. Terminal runs and displayed decisions produce nothing. */
export function evaluateWatchdog(input: WatchdogInput): WatchdogAction[] {
  const options: WatchdogOptions = { ...DEFAULT_WATCHDOG_OPTIONS, ...input.options };
  const notices = new Map(input.notices.map(notice => [notice.messageId, notice]));
  const actions: WatchdogAction[] = [];
  for (const run of input.runs) {
    if (!run.live) continue;
    for (const decision of run.pendingDecisions) {
      const messageId = decisionMessageId(decision.approvalId), notice = notices.get(messageId);
      if (notice === undefined) {
        if (input.now - Date.parse(decision.requestedAt) > options.resurfaceAfterMs)
          actions.push({ kind: "reconcile_notice", runId: run.runId, approvalId: decision.approvalId, messageId });
        continue;
      }
      if (notice.displayed || input.now - Date.parse(notice.since) <= options.resurfaceAfterMs) continue;
      if (notice.resends < options.maxResends)
        actions.push({ kind: "resurface", runId: run.runId, approvalId: decision.approvalId, messageId, attempt: notice.resends + 1 });
      else actions.push({ kind: "blocked", runId: run.runId, approvalId: decision.approvalId, messageId, resends: notice.resends });
    }
    // A pending human gate, handoff or question is waiting, not stalled. Every role pane must be observed as not working.
    if (run.awaitingHuman || run.activeHandoff || run.pendingDecisions.length > 0) continue;
    if (input.panes.length === 0 || !input.panes.every(pane => NOT_WORKING.has(pane.status))) continue;
    if (input.now - run.lastActivityAt <= options.stallAfterMs) continue;
    // Holders are accepted handoffs whose panes are not working (every pane is, by the check above). Runtime names them in the notice.
    const holders = run.acceptedRoles ?? [];
    actions.push({ kind: "stalled", runId: run.runId, episodeKey: `${run.runId}@${run.lastActivityAt}`, idleSince: run.lastActivityAt,
      ...(holders.length ? { holders } : {}) });
  }
  return actions;
}
