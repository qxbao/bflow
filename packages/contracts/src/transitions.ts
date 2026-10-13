import type { RunStatus, TaskStatus } from "./execution.js";

export type TaskTransitionIntent = "normal" | "retry" | "rework" | "cancel";

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
  cancelled: []
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
  if (intent === "cancel" && to !== "cancelling" && to !== "cancelled") {
    return { valid: false, reason: "cancel intent must enter a cancellation state" };
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
