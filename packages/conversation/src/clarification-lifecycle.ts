import type { ConversationContextSnapshot, PendingClarificationContext } from "./types.js";

/**
 * A clarification nobody answers within this window is closed. Its questions would otherwise keep
 * showing as open and keep capturing unrelated short replies.
 */
export const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** The most recently updated open clarification. Ties go to the later insertion, which is the newer one. */
export function newestClarification(
  pending: Readonly<Record<string, PendingClarificationContext>>
): PendingClarificationContext | undefined {
  let newest: PendingClarificationContext | undefined;
  for (const candidate of Object.values(pending)) {
    if (newest === undefined || Date.parse(candidate.updatedAt) >= Date.parse(newest.updatedAt)) newest = candidate;
  }
  return newest;
}

/**
 * Closes clarifications idle longer than CLARIFICATION_TTL_MS at `nowIso` and rebuilds the session's
 * unresolved questions from the survivors. Returns the same snapshot object when nothing expired.
 */
export function expireStaleClarifications(snapshot: ConversationContextSnapshot, nowIso: string): ConversationContextSnapshot {
  const nowMs = Date.parse(nowIso);
  const entries = Object.entries(snapshot.pendingClarifications);
  const open = entries.filter(([, clarification]) => nowMs - Date.parse(clarification.updatedAt) < CLARIFICATION_TTL_MS);
  if (open.length === entries.length) return snapshot;

  const unresolvedQuestions = open.flatMap(([, clarification]) => clarification.unresolvedQuestions);
  const status = snapshot.session.status === "awaiting_user_clarification" && unresolvedQuestions.length === 0
    ? "active"
    : snapshot.session.status;
  return {
    ...snapshot,
    pendingClarifications: Object.fromEntries(open),
    session: { ...snapshot.session, status, unresolvedQuestions, updatedAt: nowIso }
  };
}

/**
 * Closes clarifications that were about one approval once that approval is decided: e.g. the user sent a bare
 * approval id, Conversation asked which option, and a later "<id>: <answer>" decided it. Without this the question
 * stays open and keeps capturing later short replies. Returns the same snapshot object when nothing matched.
 */
export function closeClarificationsForApproval(
  snapshot: ConversationContextSnapshot,
  approvalId: string,
  nowIso: string
): ConversationContextSnapshot {
  const entries = Object.entries(snapshot.pendingClarifications);
  const open = entries.filter(([, clarification]) => !clarification.originalRequestText.includes(approvalId) &&
    !clarification.unresolvedQuestions.some(question => question.includes(approvalId)));
  if (open.length === entries.length) return snapshot;

  const unresolvedQuestions = open.flatMap(([, clarification]) => clarification.unresolvedQuestions);
  const status = snapshot.session.status === "awaiting_user_clarification" && unresolvedQuestions.length === 0
    ? "active"
    : snapshot.session.status;
  return {
    ...snapshot,
    pendingClarifications: Object.fromEntries(open),
    session: { ...snapshot.session, status, unresolvedQuestions, updatedAt: nowIso }
  };
}
