# Proposal: authenticated Herdr receipt and binding verification

Status: **APPROVED** by the project owner in this conversation on 2026-10-16
(“Proposal: duyệt”). The implementation decision, compatibility plan and affected
owners are recorded in [ADR 0003](../../docs/adr/0003-authenticated-herdr-receipts.md).
The original proposal below is retained as decision history; the Runtime README
and current validation report describe implemented versus live-verified scope.

## Exact failing boundary

`HerdrCliTransport.send()` currently returns an `AgentExecutionHandle` whose
`correlation` is `{ provenance: "orchestrator", verified: false, token: ... }`.
`HerdrCliTransport.read()` emits `AgentMessage.kind: "status"` with
`data.source: "terminal_snapshot"`, `correlationVerified: false` and
`executionOutputVerified: false`.

`WorkflowEngine.recordAgentResult(RecordAgentResultCommand)` correctly requires
both the stored binding and submitted result to carry matching, verified
correlation. `WorkflowEngine.bindAgentExecution(BindAgentExecutionCommand)` and
`recordDeliveryReconciliation(RecordDeliveryReconciliationCommand)` reject any
replacement of an existing binding. `AgentMessageSchema.kind` currently has no
structured result/receipt variant.

Failing fixture: `packages/runtime/test/agentic/integration.test.ts`, case
“refuses the actual Adapter-style unverified orchestrator handle as task success”.
The task remains running and never passes a completion gate. Removing that check
or asserting `verified: true` would invent evidence.

## Proposed compatible direction for owner review

1. Define authenticated, structured `RoleMessage`/receipt ingress over an actually
   supported Herdr version. Specify the native host hook/channel, authenticated
   process identity, pane/session binding, delivery identity and objective output
   collection. Do not scrape a terminal snapshot or trust agent-written JSON.
   Verify available Herdr commands/events before selecting the implementation.
2. Retain the current immutable submission handle and its persisted
   `agent.execution_bound` event. Introduce a distinct, receipt-backed verification
   action rather than replacing a handle through an existing bind method.
3. Candidate additive capability (names/signature subject to owner decision):

   ```ts
   interface AuthenticatedWorkflowEngine extends WorkflowEngine {
     verifyAgentBinding(
       command: VerifyAgentBindingCommand,
       options?: OperationOptions
     ): Promise<OperationResult<WorkflowAdvanceResult>>;
   }
   ```

   The command should contain `runId`, `taskId`, `expectedVersion`, `requestId`,
   `executionId`, `attemptId`, the exact original target/session locator, a verified
   remote/transport `SubmissionCorrelation`, an ArtifactStore-originated immutable
   receipt reference, verifier identity, `occurredAt` and `idempotencyKey`.
   Verification must bind all those identities to one previously recorded request.
   It must not change target, task attempt, cancellation intent or idempotency key.
4. Add an explicit domain event for that proof and the corresponding aggregate
   checkpoint state. Runtime authenticates and ingests the receipt before calling
   Core; Core enforces identity, legal lifecycle and deterministic replay. Agent
   assertions and orchestrator-generated correlation are rejected. Late proof
   cannot reopen a cancelled or terminal execution.
5. Keep `WorkflowEngine` v1 consumers unchanged through capability negotiation or
   a separate extended port. Existing events/checkpoints remain readable. Any new
   event/schema/aggregate codec version requires a documented compatibility
   matrix and approved migration. An upcaster must never fabricate missing receipt
   evidence. Old runs with unverified bindings remain inconclusive until explicit
   valid proof arrives. Old readers fail closed on unsupported new evidence.

## Affected owners and acceptance evidence

- Contracts/integration: explicit decision, wire schemas, event/checkpoint codec,
  version negotiation and migration/upcaster review.
- Herdr Adapter/native host: actual authenticated typed ingress and receipt
  verification; version/protocol evidence and reconnect behavior.
- Core/Runtime: independent binding verification, persistence, idempotency,
  fencing, cancellation and crash recovery at receipt boundaries.
- Conversation/agent host: native prompt/tool registration and independent inbound
  pumping; user approval provenance; all AI-to-AI traffic still passes through Herdr.
- CLI/lifecycle: compose the native host into `up`/`down` and its shutdown barrier
  without creating another session or ignoring active P19 runs.

Required validation includes forged/stale/replayed receipt refusal, wrong pane/
session/attempt/execution rejection, concurrent/cancelled delivery, SIGKILL before
and after receipt ingest/event append/checkpoint, compatibility fixtures, full
monorepo checks, and a real isolated Herdr session with an independently executed
verification and authenticated user approval. Until then, live delivery remains
**NO-GO**. Approval of this proposal authorizes design/implementation of that
reviewed boundary; it does not authorize a protected merge, production deploy,
secret change, destructive cleanup or remote publication.
