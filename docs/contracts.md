# Public contracts

All public schemas, inferred types, pure validators, and ports are exported from `@ai-flow/contracts`. Zod schemas are the runtime authority at package ingress. Exchange objects are strict; unknown fields are rejected unless a later schema version explicitly adds them.

## Failure and async convention

Public Promise operations return `OperationResult<T>`:

```ts
type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };
```

`ContractError` is discriminated by `code`. Validation, cancellation, unknown delivery, corruption, unsupported version, and not-found errors are non-retryable as received. Conflict, timeout, and transport-unavailable errors are retryable only after their documented prerequisite (for example, reload after conflict). A `timeout` declares that the operation was not started or was observation-only. A send that might have crossed the transport boundary is instead `unknown_delivery`, always has `retryable: false`, and requires reconciliation/manual handling; callers must not reinterpret it as a generic retryable timeout.

Async streams (`read`, artifact `get`, and runtime `watch`) yield `OperationResult<T>` so item-level failures stay typed. An implementation may still be interrupted by the JavaScript runtime, but must translate expected domain/infrastructure failures to `ContractError`.

`OperationOptions` supplies cooperative `AbortSignal`, relative timeout, and absolute deadline. Cancellation of the local wait does not prove cancellation of a remote execution.

## Core data and invariants

| Contract | Guaranteed by schema/pure validator |
| --- | --- |
| `WorkflowDefinition` | Unique task/gate IDs, valid gate bindings and dependency endpoints, no duplicate dependency, no DAG cycle, positive bounded concurrency |
| `TaskDefinition` | Role/instruction, retry/timeout, approval flag, explicit quality-gate bindings |
| `AgentRequest` | Request and attempt identity, target locator, attempt number, timing, retry/timeout, agent-request idempotency |
| `AgentExecutionHandle` | Durable execution/request/attempt identity, target locator, correlation provenance, optional recovery cursor |
| `AgentResult` | Business outcome separate from transport state; verified correlation for every conclusive outcome; status-specific error/blockage and timestamp ordering |
| `ArtifactProposal` | Untrusted metadata with safe logical name and expected checksum/size |
| `ArtifactReference` | Trusted stored marker, opaque safe ID, constrained `artifact://store/id` URI, exact SHA-256/SHA-512 encoding |
| `ApprovalRequest` / `ApprovalDecision` | Required typed target, revision/generation, idempotency, evidence/feedback and audit time/actor |
| `DomainEvent` | Event schema v1 plus stream/aggregate identities and strict versioned payload |
| `RecoveryCheckpoint` | Checkpoint schema v1 plus named codec v1, stream/version position and JSON state |

`validateTaskTransition` and `validateRunTransition` are the normative transition rules. `validateEventBatch` is the normative precondition for atomic append. Zod command/event schemas invoke the applicable transition or batch validator.

## `AgentTransport`

- `initialize` returns verified transport capabilities, including whether submission correlation is available.
- `send` returns an `AgentSubmissionReceipt`, not a task result. `accepted` includes a handle; `rejected` proves no accepted submission; `unknown_delivery` forbids resend.
- `reconcile` uses request ID, attempt ID, idempotency key, and target locator. It returns `bound`, `not_delivered` (the only retry-safe ambiguous outcome), or `unknown_delivery` requiring manual intervention.
- `read` streams transport messages/proposals by execution handle and cursor.
- `wait` returns `AgentTransportObservation`. States such as `done` and `blocked` are transport facts and do not imply `succeeded` or failed task outcomes.
- `cancel` requests remote cancellation and returns acceptance/refusal; it never confirms that execution has stopped.

The durable ordering is dispatch intent -> send -> persist `agent.execution_bound` before relying on the handle. If the process fails between send and binding, recovery uses the persisted request identity/target to reconcile. A transport that cannot correlate a prompt must use an orchestrator token marked unverified and must not manufacture verified task success.

## `WorkflowEngine`

The engine validates definitions; creates/advances/reconstructs snapshots; validates explicit task transitions; binds execution handles; records delivery reconciliation and verified agent results; requests/applies approvals and quality evaluations; and records cancellation acceptance/confirmation. Every mutating command carries expected aggregate version and/or idempotency identity as appropriate.

The engine owns decisions but not external I/O. The caller persists emitted events atomically before executing derived side effects. `recordAgentResult` rejects `unverified` observations at its Zod boundary.

## `RunStore`

- `appendEvents` atomically compares `expectedVersion`, verifies `expectedLastSequence`, and appends the validated batch.
- Duplicate command handling must reconstruct the original outcome and report duplicate event IDs without new side effects.
- Event and maintained snapshot/index rows must share one SQLite transaction.
- `saveCheckpoint` is optimistic and stores only a complete, codec-versioned checkpoint.
- Compatibility parsing occurs before replay. Unsupported/corrupt checkpoints are discarded in favor of earlier checkpoint/full replay according to future persistence policy.

P00 defines these obligations but does not select a SQLite driver or migration framework.

## `ArtifactStore`

`put` receives bytes plus expected integrity and returns a trusted immutable reference only after checksum/size verification and durable placement. Callers may never turn artifact IDs or logical names into filesystem paths. `get`, `resolve`, `find`, and lifecycle-authorized `delete` operate on trusted references/opaque IDs. URI generation and canonical path containment remain implementation responsibilities.

## `AgentRegistry`

`resolve` is configuration lookup only. Capacity is reserved separately through atomic `acquireLease`, `renewLease`, and `releaseLease`. Implementations must enforce `maxConcurrentTasks`, expiry, expected lease version, monotonically increasing fencing tokens, and idempotency in the same durable transaction. A stale fence must never dispatch work.

## `QualityGate`

Workflow-level gate definitions are bound from tasks by ID and phase. `EvaluateQualityGateCommand`/`quality_gate.evaluation_requested` schedule one evaluation identity. `RecordQualityGateResultCommand`/`quality_gate.evaluated` return it to the workflow under expected-version and idempotency protection. Produced output is an untrusted artifact proposal until stored. Only the workflow engine changes task/run state.

## Approval and rework

`ApprovalTarget` is exactly one of run, task, or quality gate. `approval.requested` and `approval.decided` are separate durable events. Decisions apply only to the same approval ID, target, revision, and generation; a future engine must reject stale or duplicate decisions idempotently. `changes_requested` drives the explicit rework transition (`succeeded -> ready`, generation +1), never a direct terminal-to-running transition.

## Cancellation

Cancellation has three durable stages:

1. versioned `CancellationRequest` / `cancellation.requested` records intent;
2. `CancellationResult` / accepted or refused event records the transport response;
3. `CancellationStopConfirmation` / `cancellation.stop_confirmed` records observed terminal stop.

Acceptance alone leaves state `cancelling`. If success/failure is observed first, the legal transition allows completion to win; late cancellation acknowledgement is retained for audit but must not overwrite the terminal outcome.

## Event/checkpoint compatibility

Current event and checkpoint schema version is `1`. The original P00 format is designated legacy v0 because it omitted these fields. `parseDomainEventWithCompatibility` and `parseRecoveryCheckpointWithCompatibility`:

1. detect the explicit version, treating a missing version as v0;
2. upcast the known v0 envelope/codec metadata without changing domain payload;
3. validate the current strict schema;
4. return `unsupported_version` for unknown numeric versions and `validation` for malformed data.

After envelope parsing, `decodeWorkflowRunCheckpointState` validates checkpoint JSON against the codec's `WorkflowRunSnapshot` schema and returns `corruption` on mismatch. Recovery must not trust the opaque JSON field without this codec dispatch.

No downcasting is supported. A future schema change must add an explicit upcaster and fixtures before producers emit it. Aggregate version and event sequence are never used as schema versions.

The v0 helper only supplies version/codec metadata where the domain payload is otherwise compatible. Baseline event kinds whose required payload changed (for example execution/result/approval details) deliberately fail current validation instead of inventing identity or trust evidence. If such prototype data exists, the persistence phase must provide an explicit per-event migration or replay from an authoritative source; P00 does not silently fabricate missing facts.

## `RuntimeService`

This is the CLI-facing use-case boundary. Its operations and event stream use the same typed failure convention. Runtime will compose stores, engine, transport, registry, gates, and artifacts while preserving the ordering above. CLI code must not reach concrete adapters.

## Compatibility policy

This hardening release intentionally breaks the original `8d960d0` bootstrap before downstream implementation begins. Migration details are in `docs/adr/0001-p00-contract-hardening.md`. After this branch is accepted as the P00 baseline, required-field, method-signature, event-semantic, or idempotency changes require an integration decision, migration/upcast plan, and affected-owner approval.
