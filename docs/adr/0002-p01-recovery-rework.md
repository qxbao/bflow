# ADR 0002: Close P01 recovery and rework contract gaps

- Status: Accepted for P01 remediation by project-owner request, 2026-10-14; independent review required before integration
- Baseline: `93147ec` (P00 hardening plus original P01)
- Approving owner: project owner authorizing the P01 remediation
- Affected owners: contracts/integration, P01 Core, P03 persistence, P06 Runtime

## Context

The independent P01 audit reproduced loss of approvals, gates, cancellation and idempotency after snapshot-only checkpoint recovery. Full event history also lacked command fingerprints and result boundaries needed to return the original outcome for a duplicate command. Task definitions had RetryPolicy but no approved rework limit. Retry scheduling needed a durable eligibility time for deterministic replay.

## Decision

1. Keep full events authoritative. A successful Core mutation emits its domain effects and a final versioned `command.completed` receipt in one batch. The receipt stores identity, SHA-256 fingerprint of the parsed command, event-group start and runnable task IDs, never the raw command. Replay reconstructs the original snapshot/events/result at the receipt boundary. Same key and same fingerprint returns the original outcome; same key and different fingerprint conflicts.
2. Add `bflow.workflow-aggregate+json` codec. `WorkflowEngine.createCheckpoint` exports snapshot plus all auxiliary state, command result receipts, retry schedules and generation attempt baselines. Checkpoint-plus-tail replay requires this codec. The old snapshot codec is accepted only as an optimization when complete events from `run.created` are supplied; otherwise Core rejects it. Invalid, unsupported or inconsistent state is rejected, not silently filled with empty maps.
3. Add optional `TaskDefinition.rework`. Omission is a deliberate migration default of zero reworks with `onExhausted: fail`. `maxReworks` counts generation increments, not total generations. Retry attempts are bounded per generation while `TaskState.attempt` remains globally monotonic. At exhaustion, `fail` ends the run without a new generation; `require_human` blocks it for a later higher-revision decision.
4. Add `task.retry_scheduled` with policy-derived `eligibleAt`. Backoff is fixed, linear or exponential, capped by `maxDelayMs`; optional jitter is a deterministic full-jitter value derived from stable identity. Core compares command time to eligibility and never runs a timer.
5. A run-wide cancellation may receive more than one `cancellation.stop_confirmed` event, one per bound execution. The aggregate checkpoint stores a confirmation list rather than a singular confirmation; duplicate execution confirmations conflict, and one stopped execution does not imply all have stopped.

## Compatibility and migration

The new `rework` field is optional so old definitions parse. Its fail-closed zero-rework behavior is intentionally different from the old unbounded implementation. Public `WorkflowEngine` gains `createCheckpoint`, so implementations must add that method. Existing event schema version 1 remains parseable, but histories without command receipts cannot establish exact post-restart idempotency and are rejected for mutable recovery until authoritative receipts are migrated. The legacy snapshot checkpoint codec remains parseable and can be ignored for full replay. New aggregate checkpoints use a distinct codec name/version; no silent upcast invents missing state. `task.retry_scheduled` and `command.completed` are new event kinds; RunStore's generic event envelope and batch contract stay unchanged.

## Ownership and consequences

P01 enforces state transitions, replay, retry/rework and checkpoint correctness. P03 will provide atomic durable event/checkpoint storage and any migration from prototype data. P06 will persist the complete event batch before dispatch or other external effects and wake a retry at its eligibility time. This ADR does not assert distributed exactly-once execution, implement SQLite, allocate agents or call Herdr.
