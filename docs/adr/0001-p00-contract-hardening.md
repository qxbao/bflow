# ADR 0001: Harden P00 contracts before implementation

- Status: Accepted on `fix/p00-contract-hardening`
- Baseline: `8d960d02d4f39d555ddd509a7606cc7ff6e750f2`
- Scope: contracts, pure validators, documentation, and contract tests only

## Context

The independent P00 audit found that the bootstrap contracts could not safely express uncertain prompt delivery, durable transport identity, separation of Herdr lifecycle from task outcome, or event/checkpoint compatibility. It also found integration blockers around errors, quality gates, approvals, transitions, concurrency, artifact trust, and cancellation.

Because no implementation package yet contains business logic, P00 is the least costly point to make intentional breaking changes and freeze a coherent baseline.

## Decision

1. Public asynchronous ports use `OperationResult<T>` and discriminated `ContractError` values.
2. Agent submission, transport observation, and verified business outcome are separate types. A durable neutral locator and correlation provenance live in `AgentExecutionHandle`.
3. Unknown delivery is non-retryable until explicit reconciliation proves `not_delivered`; lack of proof requires manual intervention.
4. Domain events and checkpoints use independent schema versions. Pure compatibility helpers support the original versionless shape as v0 and reject unknown versions.
5. Workflow commands/events cover execution binding, delivery reconciliation, gate request/result, approval request/decision, and cancellation request/acknowledgement/stop.
6. Pure transition and event-batch validators define semantic invariants shared by core and persistence.
7. Registry lookup remains separate from atomic capacity leases. Artifact proposals remain untrusted until store verification.

## Finding-to-change mapping

| Finding | Contract resolution | Primary files | Proof tests |
| --- | --- | --- | --- |
| P0-01 | Durable locator/handle, execution-bound and delivery events, reconcile operation, resend prohibition | `agent.ts`, `events.ts`, `ports.ts`, `orchestration.ts` | `agent-transport.test.ts`, `versioning-events.test.ts` |
| P0-02 | Submission receipt and lifecycle observation separated from verified result | `agent.ts`, `ports.ts` | `agent-transport.test.ts` |
| P0-03 | Event/checkpoint schema and codec versions with v0 upcasters | `events.ts`, `execution.ts`, `versioning.ts` | `versioning-events.test.ts` |
| P1-01 | Typed error/result convention with fixed retryability | `errors.ts`, `ports.ts` | `safety-contracts.test.ts` |
| P1-02 | Workflow gate definitions/bindings and evaluation commands/events | `workflow.ts`, `quality.ts`, `orchestration.ts`, `events.ts` | `workflow.test.ts` |
| P1-03 | Required approval target, revision/generation/idempotency/evidence | `approval.ts`, `events.ts`, `orchestration.ts` | `safety-contracts.test.ts` |
| P1-04 | Normative task/run transition tables and command/event validation | `transitions.ts`, `orchestration.ts`, `events.ts` | `workflow.test.ts` |
| P1-05 | Lease acquire/renew/release with expiry, fencing and version | `registry.ts`, `ports.ts` | `safety-contracts.test.ts` |
| P1-06 | Proposal/reference trust split, constrained ID/URI/checksum, expected integrity | `artifact.ts`, `agent.ts`, `quality.ts` | `safety-contracts.test.ts` |
| P1-07 | Versioned cancellation intent, acceptance/refusal and stop confirmation | `execution.ts`, `events.ts`, `ports.ts` | `safety-contracts.test.ts`, `workflow.test.ts` |
| P2 | Retry/time refinements and event-batch invariants | `execution.ts`, `agent.ts`, `orchestration.ts` | all contract suites |

## Migration from the initial P00 baseline

This is an intentional pre-implementation breaking revision:

- `AgentTransport.send` returns a receipt; `wait` returns a transport observation; `reconcile` is new.
- All Promise port returns are wrapped by `OperationResult`; streams yield typed results.
- Requests/results/events/checkpoints, workflow definitions/task state, approvals, artifacts, and cancellation records gain required fields.
- Legacy versionless event/checkpoint values must pass through compatibility helpers; stream sequence and aggregate version are preserved during upcast.
- Agent/gate output exposes `ArtifactProposal`, not a trusted stored reference.
- Agent registry adds explicit lease operations, while workflow engine adds binding/reconciliation/gate/approval/cancellation methods.

There is no data migration implementation in P00. The helpers upcast version/codec metadata only when the remaining payload validates as current; they do not invent newly required identity, target, correlation, or trust evidence. If a prototype persisted incompatible values from `8d960d0`, its owning phase must provide an explicit per-event migration or replay from an authoritative source under its selected migration mechanism.

## Consequences and deferred work

The contracts can now express the audited workflows without another known breaking change. They do not make runtime behavior atomic or correct by themselves. P01–P05 still must implement and test scheduling, Herdr mapping, durable transactions/upcasting, checksum/path enforcement, leases/fencing, gate execution, and use-case ordering. Live Herdr, SQLite migration, E2E recovery, and production readiness are explicitly deferred.
