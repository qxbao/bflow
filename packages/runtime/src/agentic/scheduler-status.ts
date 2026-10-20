export interface SchedulerObservation {
  /** The interval that drives Runtime ticks has been created and not yet cleared by shutdown. */
  timerAlive: boolean;
  quiesced: boolean;
  workspaceOpen: boolean;
  /** A Runtime tick promise is currently in flight. */
  tickInFlight: boolean;
  lastTickAt?: string | undefined;
  error?: string | undefined;
}

/**
 * `schedulerRunning` keeps its legacy meaning (a tick is in flight), so it reads false between healthy 500 ms ticks.
 * `schedulerActive` reports whether the scheduler will tick again; use it for liveness.
 */
export function schedulerStatusReport(observation: SchedulerObservation) {
  return {
    schedulerRunning: observation.tickInFlight,
    schedulerActive: observation.timerAlive && !observation.quiesced && observation.workspaceOpen,
    schedulerLastTickAt: observation.lastTickAt ?? null,
    schedulerError: observation.error ?? null
  };
}
