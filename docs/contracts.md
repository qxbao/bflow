# Public contracts

All public schemas and interfaces are exported from `@ai-flow/contracts`. Zod schemas are the runtime authority for data entering a module; TypeScript types are inferred from those schemas. JSON exchange objects are strict, so unknown fields are rejected until a versioned contract intentionally adds them.

## Core data types

| Type | Purpose and invariants |
| --- | --- |
| `WorkflowDefinition` | Versioned task graph. Task IDs are unique; dependency endpoints exist; self-dependencies and cycles are rejected. |
| `TaskDefinition` | Role, instruction, acceptance criteria, retry and timeout policy for one task. |
| `TaskDependency` | Directed edge from `taskId` to prerequisite `dependsOnTaskId`; condition is `succeeded` or any terminal `completed`. |
| `TaskStatus` | Non-terminal, blocked, cancellation, and terminal task lifecycle values. |
| `RunStatus` | Aggregate workflow lifecycle values. |
| `AgentRequest` | A single attempt with request/run/task identity, role, instruction, inputs, retry/timeout policy and idempotency fingerprint. |
| `AgentResult` | Terminal attempt observation with outcome, artifacts, structured error/blockage, retryability, timestamps and optional resume cursor. |
| `ArtifactReference` | Stable content reference with owner IDs, URI, media type, checksum, optional size and metadata. |
| `ApprovalDecision` | Auditable approval, rejection, or requested change with actor and timestamp. |
| `DomainEvent` | Strict discriminated union with event/run identity, sequence, aggregate version, correlation/causation and idempotency key. |

Additional policy schemas cover retry/backoff, timeout/deadline, cancellation acknowledgement, recovery/checkpointing, block reasons, quality findings, registry configuration, run queries, and runtime commands.

## `AgentTransport`

- `initialize` establishes one transport instance and returns verified capabilities. Configuration remains opaque JSON at the contract boundary.
- `send` accepts a validated request and returns a durable execution handle. Repeated requests with the same idempotency identity must not launch duplicate work.
- `read` streams ordered messages after a sequence/cursor. Reconnection may replay messages, so consumers deduplicate by execution ID and sequence.
- `wait` reconciles to exactly one terminal `AgentResult`; it remains valid after stream interruption.
- `cancel` requests cancellation and returns an acknowledgement. Acceptance does not imply the agent is already stopped.

Herdr mapping is intentionally unspecified until the CLI and Socket API are verified. The adapter must document how each capability, cursor, terminal condition, and cancellation acknowledgement maps to a verified Herdr behavior.

## `WorkflowEngine`

- `validateDefinition` applies structural and semantic graph validation.
- `createRun` creates initial state and events idempotently.
- `advance` derives runnable work from persisted state without performing transport I/O.
- `transitionTask`, `recordAgentResult`, and `applyApproval` validate expected versions and legal state transitions, returning the new snapshot plus emitted events.
- `requestCancellation` records intent and moves affected state through cancellation transitions.
- `recover` reconstructs state from an optional checkpoint plus ordered events.
- `getSnapshot` returns current aggregate state or `null`.

The engine owns decisions but not storage transactions or external side effects. Callers persist returned events atomically before dispatching derived work.

## `RunStore`

- `create` stores a definition and initial snapshot with an idempotency key.
- `get` and `find` query durable run history.
- `appendEvents` atomically verifies `expectedVersion`, appends ordered events, and reports duplicates.
- `readEvents` pages by a stable cursor.
- `saveCheckpoint` uses optimistic versioning; `loadLatestCheckpoint` returns only a complete checkpoint.

An implementation must distinguish not-found, duplicate, and version-conflict outcomes with typed errors. SQLite transactions must cover event append and any maintained snapshot/index rows.

## `ArtifactStore`

- `put` consumes an async byte stream, verifies/computes the declared checksum, and returns a durable reference idempotently.
- `get` streams bytes for a known immutable reference.
- `resolve` and `find` query metadata without reading content.
- `delete` removes content only when lifecycle policy authorizes it; returning `false` means it was absent.

URIs are opaque outside the store. Callers must never construct local paths from artifact IDs.

## `AgentRegistry`

- `resolve` maps a role and required capabilities to one enabled configuration, or `null` if none is eligible.
- `list`, `upsert`, and `remove` manage configurations without exposing live transport instances.
- Resolution must be deterministic for the same registry snapshot and context; load-aware strategies must record their decision inputs.

## `QualityGate`

Each gate has a stable `id` and an `evaluate` method. The result is `passed`, `failed`, `blocked`, or `error`, with findings and produced artifacts. `blocked` means required evidence or an external dependency is missing. `error` means the evaluator could not make a decision. Only the workflow engine applies gate results to state.

## `RuntimeService`

This is the high-level boundary consumed by the CLI:

- `start` validates and starts a workflow idempotently.
- `resume` recovers and continues an interrupted run after reconciliation.
- `cancel` and `decide` submit explicit user decisions.
- `getRun` and `findRuns` provide query views.
- `watch` streams ordered domain events; consumers must tolerate replay after reconnect.

Runtime implementations compose ports and own use-case transaction ordering. CLI code must not reach around this interface to concrete stores or adapters.

## Compatibility policy

These interfaces are the integration baseline. Additive optional fields require a contract review and tests. Renames, removals, semantic changes, new required fields, event reinterpretation, or changed idempotency behavior require an explicit integration decision and migration plan. Implementers should first use private types or adapter translation rather than changing shared contracts.
