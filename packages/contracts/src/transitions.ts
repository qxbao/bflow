import type { CancellationStopConfirmation, RunStatus, TaskStatus } from "./execution.js";

export type TaskTransitionIntent = "normal" | "retry" | "rework" | "cancel" | "park" | "unpark";

/** Every task transition intent, for ingress schemas (`park`/`unpark` are B2b, R-B2-14). */
export const TASK_TRANSITION_INTENTS = ["normal", "retry", "rework", "cancel", "park", "unpark"] as const;

const parkableTaskStatuses: readonly TaskStatus[] = ["pending", "ready", "blocked", "waiting", "running"];

const normalTaskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["ready", "cancelled"],
  ready: ["running", "cancelling", "cancelled"],
  running: ["waiting", "blocked", "succeeded", "failed", "cancelling"],
  waiting: ["running", "blocked", "succeeded", "failed", "cancelling"],
  retrying: ["ready", "cancelling", "cancelled"],
  blocked: ["ready", "running", "failed", "cancelling", "cancelled"],
  succeeded: [],
  failed: [],
  cancelling: ["cancelled", "succeeded", "failed"],
  cancelled: [],
  // Every move out of parked is an explicit unpark or cancel intent.
  parked: []
};

const normalRunTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelling", "cancelled"],
  running: ["waiting", "blocked", "succeeded", "failed", "cancelling"],
  waiting: ["running", "blocked", "failed", "cancelling"],
  blocked: ["running", "failed", "cancelling", "cancelled"],
  succeeded: [],
  failed: [],
  cancelling: ["cancelled", "succeeded", "failed"],
  cancelled: []
};

export interface TaskTransitionValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

export function validateTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  intent: TaskTransitionIntent,
  generationDelta = 0
): TaskTransitionValidation {
  if (from === to) return { valid: false, reason: "a transition must change state" };
  if (intent !== "rework" && generationDelta !== 0) {
    return { valid: false, reason: "only rework may change the task generation" };
  }
  if (intent === "retry") {
    return from === "failed" && to === "retrying"
      ? { valid: true }
      : { valid: false, reason: "retry must transition failed to retrying" };
  }
  if (intent === "rework") {
    return from === "succeeded" && to === "ready" && generationDelta === 1
      ? { valid: true }
      : { valid: false, reason: "rework must transition succeeded to ready with generation incremented by one" };
  }
  if (intent === "park") {
    return to === "parked" && parkableTaskStatuses.includes(from)
      ? { valid: true }
      : { valid: false, reason: "park must transition pending, ready, blocked, waiting or running to parked" };
  }
  if (intent === "unpark") {
    return from === "parked" && to === "ready"
      ? { valid: true }
      : { valid: false, reason: "unpark must transition parked to ready" };
  }
  if (intent === "cancel" && to !== "cancelling" && to !== "cancelled") {
    return { valid: false, reason: "cancel intent must enter a cancellation state" };
  }
  if (intent === "cancel" && from === "parked") {
    return to === "cancelled" ? { valid: true } : { valid: false, reason: "a parked task can only be cancelled directly" };
  }
  return normalTaskTransitions[from].includes(to)
    ? { valid: true }
    : { valid: false, reason: `${from} cannot transition to ${to} with ${intent} intent` };
}

export function validateRunTransition(from: RunStatus, to: RunStatus): TaskTransitionValidation {
  if (from === to) return { valid: false, reason: "a transition must change state" };
  return normalRunTransitions[from].includes(to)
    ? { valid: true }
    : { valid: false, reason: `${from} cannot transition to ${to}` };
}

/**
 * B2b (R-B2-14): a park transition may carry the confirmed stop of the task's bound execution. It reuses the
 * cancellation stop-confirmation shape but must name the stopped execution and report it `cancelled` (stopped).
 * It creates no cancellation record; Core matches `executionId` to the exact bound execution.
 */
export function validateParkStopConfirmation(
  intent: TaskTransitionIntent,
  confirmation: CancellationStopConfirmation | undefined
): TaskTransitionValidation {
  if (confirmation === undefined) return { valid: true };
  if (intent !== "park") return { valid: false, reason: "only a park transition may carry a stop confirmation" };
  if (confirmation.executionId === undefined || confirmation.terminalStatus !== "cancelled") {
    return { valid: false, reason: "a park stop confirmation must name the stopped execution with terminalStatus cancelled" };
  }
  return { valid: true };
}
