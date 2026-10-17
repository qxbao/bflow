# Public contracts

All public schemas, inferred types, pure validators, and ports are exported from `@bflow/contracts`. Zod schemas are the runtime authority at package ingress. Exchange objects are strict; unknown fields are rejected unless a later schema version explicitly adds them.

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
| `TaskDefinition` | Role/instruction, retry/rework/timeout, approval flag, explicit quality-gate bindings |
| `AgentRequest` | Request and attempt identity, target locator, attempt number, timing, retry/timeout, agent-request idempotency |
| `AgentExecutionHandle` | Durable execution/request/attempt identity, target locator, correlation provenance, optional recovery cursor |
| `AgentResult` | Business outcome separate from transport state; verified correlation for every conclusive outcome; status-specific error/blockage and timestamp ordering |
| `ArtifactProposal` | Untrusted metadata with safe logical name and expected checksum/size |
| `ArtifactReference` | Trusted stored marker, opaque safe ID, constrained `artifact://store/id` URI, exact SHA-256/SHA-512 encoding |
| `ApprovalRequest` / `ApprovalDecision` | Required typed target, revision/generation, idempotency, evidence/feedback and audit time/actor |
| `DomainEvent` | Event schema v1 plus stream/aggregate identities and strict versioned payload |
| `RecoveryCheckpoint` | Checkpoint schema v1 plus named snapshot-v1 or aggregate-v1 codec, stream/version position and JSON state |

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

Every successful mutation ends with a `command.completed` event containing a versioned receipt: command identity, idempotency key, SHA-256 fingerprint of the validated command, the command's first event sequence, and runnable task IDs. The receipt contains no raw command payload. A repeated key with the same fingerprint returns the original result; a different fingerprint conflicts. `task.retry_scheduled` records the deterministic eligibility timestamp. Runtime must persist the entire returned event batch before acting on runnable tasks; Core does not promise distributed exactly-once execution.

`createCheckpoint` is a read-only engine operation with an expected aggregate version. It exports a complete aggregate checkpoint for `RunStore.saveCheckpoint`; a snapshot-only checkpoint is insufficient for tail-only recovery.

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

`ReworkPolicy.maxReworks` counts transitions from generation N to N+1; generation zero is the original work, not a rework. Retry `maxAttempts` applies separately within each generation, although the public `TaskState.attempt` remains a run-wide monotonic attempt identity. At exhaustion, `fail` makes the run terminal failed while `require_human` blocks the run without incrementing generation; a later, higher-revision approval can resolve the hold. Legacy definitions without `rework` remain schema-valid and are treated by Core as `{ maxReworks: 0, onExhausted: "fail" }`, so old definitions do not gain unlimited rework.

## Cancellation

Cancellation has three durable stages:

1. versioned `CancellationRequest` / `cancellation.requested` records intent;
2. `CancellationResult` / accepted or refused event records the transport response;
3. `CancellationStopConfirmation` / `cancellation.stop_confirmed` records observed terminal stop.

Acceptance alone leaves state `cancelling`. If success/failure is observed first, the legal transition allows completion to win; late cancellation acknowledgement is retained for audit but must not overwrite the terminal outcome.

A run-wide cancellation may cover several bound executions. Each `cancellation.stop_confirmed` identifies one stopped execution; the aggregate checkpoint retains distinct confirmations for the same cancellation ID. Confirming one execution never proves the others stopped.

## Event/checkpoint compatibility

Current event and checkpoint schema version is `1`. The original P00 format is designated legacy v0 because it omitted these fields. `parseDomainEventWithCompatibility` and `parseRecoveryCheckpointWithCompatibility`:

1. detect the explicit version, treating a missing version as v0;
2. upcast the known v0 envelope/codec metadata without changing domain payload;
3. validate the current strict schema;
4. return `unsupported_version` for unknown numeric versions and `validation` for malformed data.

After envelope parsing, `decodeWorkflowRunCheckpointState` validates checkpoint JSON against the codec's `WorkflowRunSnapshot` schema and returns `corruption` on mismatch. Recovery must not trust the opaque JSON field without this codec dispatch.

P01 adds the `bflow.workflow-aggregate+json` codec, decoded by `decodeWorkflowAggregateCheckpointState`. It contains snapshot, approval/gate/cancellation state, successful attempts, retry schedules and attempt baselines, and original command receipts/results. Tail-only replay requires this codec. A legacy snapshot checkpoint may be ignored only when events from `run.created` onward are available for full replay. Event histories predating `command.completed` cannot safely reconstruct exact command idempotency and must be migrated from authoritative command receipts or rejected; no identity is fabricated. Unsupported or corrupt checkpoints fail closed in Core.

No downcasting is supported. A future schema change must add an explicit upcaster and fixtures before producers emit it. Aggregate version and event sequence are never used as schema versions.

The v0 helper only supplies version/codec metadata where the domain payload is otherwise compatible. Baseline event kinds whose required payload changed (for example execution/result/approval details) deliberately fail current validation instead of inventing identity or trust evidence. If such prototype data exists, the persistence phase must provide an explicit per-event migration or replay from an authoritative source; P00 does not silently fabricate missing facts.

## `RuntimeService`

This is the CLI-facing use-case boundary. Its operations and event stream use the same typed failure convention. Runtime will compose stores, engine, transport, registry, gates, and artifacts while preserving the ordering above. CLI code must not reach concrete adapters.

## Compatibility policy

This hardening release intentionally breaks the original `8d960d0` bootstrap before downstream implementation begins. Migration details are in `docs/adr/0001-p00-contract-hardening.md`. After this branch is accepted as the P00 baseline, required-field, method-signature, event-semantic, or idempotency changes require an integration decision, migration/upcast plan, and affected-owner approval.

## Contracts v2 (P11 Agentic SDLC Upgrade)

Contracts v2 expands `@bflow/contracts` to support the multi-agent agentic SDLC architecture (P11–P19). It adds 17 authoritative Zod schemas, the standardized inter-agent `RoleMessage` envelope, and strict boundary separation between four distinct state domains. All schemas enforce strict input parsing (`.strict()`) and typed error handling via `OperationResult<T>`.

### Four Separated State Domains

To prevent dangerous coupling between transport observation and business outcomes, the system strictly separates four orthogonal state domains:

| State Domain | Enum Type | Valid Values | Authority | Invariant Guarantee |
| --- | --- | --- | --- | --- |
| **Agent Transport State** | `AgentTransportState` | `starting`, `accepted`, `idle`, `working`, `blocked`, `done`, `unknown`, `disconnected`, `cancelled` | Herdr `AgentTransport` | Transport observation only. Herdr `done` **never** proves task completion or success. |
| **SDLC Work Status** | `SdlcWorkStatus` (`TaskStatus`, `RunStatus`) | `intake`, `clarifying`, `specifying`, `planning`, `tdd_deciding`, `implementing`, `verifying`, `reviewing`, `awaiting_approval`, `completed`, `escalated`, `failed`, `cancelled` | `WorkflowEngine` & Quality Gates | Conclusive task success requires correlated `AgentResult` and verified objective artifacts. |
| **Conversation Session Status** | `ConversationSessionStatus` | `active`, `awaiting_user_clarification`, `delegated_to_coordinator`, `reporting_progress`, `awaiting_user_approval`, `completed`, `paused`, `closed`, `archived` | `ConversationSessionManager` | Tracks user-facing dialogue lifecycle and human interaction turn management. |
| **Approval Status** | `ApprovalStatus` | `pending`, `approved`, `changes_requested`, `rejected`, `expired`, `cancelled`, `superseded` | Governance Gates & Human Approvers | Gate decisions control execution transitions; `changes_requested` drives rework generation N -> N+1. |

### Inter-Role Communication Envelope (`RoleMessage`)

All peer-to-peer and hierarchical communications transmitted over Herdr transport must be wrapped in the strict `RoleMessageSchema` (aliased as `InterRoleMessageSchema`) envelope:

```ts
export const RoleMessageSchema = z.object({
  schema_version: z.literal(2),
  message_id: IdentifierSchema,
  correlation_id: IdentifierSchema,
  causation_id: IdentifierSchema.optional(),
  run_id: IdentifierSchema.optional(),
  sender: z.object({
    role: z.union([AgentRoleSchema, z.literal("user"), z.literal("runtime")]),
    agent_id: IdentifierSchema.optional(),
    pane_id: IdentifierSchema.optional()
  }).strict(),
  recipient: z.object({
    role: z.union([AgentRoleSchema, z.literal("user"), z.literal("runtime")]),
    agent_id: IdentifierSchema.optional(),
    pane_id: IdentifierSchema.optional()
  }).strict(),
  type: z.enum([
    "conversation.intake",
    "conversation.clarification",
    "conversation.progress",
    "delegation.request",
    "delegation.accepted",
    "spec.draft",
    "spec.approved",
    "tdd.decision",
    "task.assignment",
    "task.status",
    "implementation.submitted",
    "verification.requested",
    "verification.result",
    "verification.escalation",
    "review.verdict",
    "approval.request",
    "approval.decision"
  ]),
  payload: JsonValueSchema,
  artifact_references: z.array(ArtifactReferenceSchema),
  occurred_at: IsoDateTimeSchema.optional(),
  idempotency_key: IdempotencyKeySchema.optional(),
  metadata: MetadataSchema.optional()
}).strict();
```

### The 17 Contracts v2

#### 1. `ConversationSession` (`ConversationSessionSchema`)
Represents the durable lifecycle and state of a user-facing dialogue session:
- `schemaVersion`: `2` — Numeric literal version 2.
- `sessionId`: `Identifier` — Unique conversation session ID.
- `herdrSessionId`: `Identifier` — Associated Herdr multi-pane session ID.
- `conversationAgentId`: `Identifier` — Bound Conversation Agent identity.
- `paneId`: `Identifier` — Terminal pane locator hosting the Conversation Agent.
- `status`: `ConversationSessionStatus` — `"active" | "awaiting_user_clarification" | "delegated_to_coordinator" | "reporting_progress" | "awaiting_user_approval" | "completed" | "paused" | "closed" | "archived"`.
- `activeRunId`: `Identifier` (optional) — Associated workflow run ID; required when `status` is `delegated_to_coordinator` unless `specificationId` is provided.
- `specificationId`: `Identifier` (optional) — Associated specification ID.
- `activeApprovalIds`: `Identifier[]` — Unresolved human approval IDs pending in this session.
- `turnCount`: `number` (non-negative integer) — Number of dialogue turns completed.
- `unresolvedQuestions`: `string[]` — Clarification questions awaiting user response (min length 1 when `status` is `awaiting_user_clarification`).
- `createdAt`, `updatedAt`: `IsoDateTime` — ISO timestamps for auditing.
- `closedAt`: `IsoDateTime` (optional) — Session termination timestamp.
- `metadata`: `Metadata` (optional) — Extensible session context.

#### 2. `ConversationMessage` (`ConversationMessageSchema`)
Represents an individual dialogue exchange turn between user, agents, and runtime:
- `schemaVersion`: `2` — Numeric literal version 2.
- `messageId`: `Identifier` — Unique message identity.
- `sessionId`: `Identifier` — Associated conversation session ID.
- `correlationId`: `Identifier` — Turn correlation token.
- `runId`: `Identifier` (optional) — Bound workflow run ID.
- `turnSequence`: `number` (non-negative integer) — Strictly increasing sequence counter within the session.
- `sender`: `"user" | "conversation" | "coordinator" | "runtime"`.
- `recipient`: `"user" | "conversation" | "coordinator"` — Invariant: `sender` cannot equal `recipient`; `"user"` sender can only send to `"conversation"`, and `"user"` recipient can only receive from `"conversation"`.
- `intent`: `"user_request" | "clarification_question" | "clarification_answer" | "spec_draft_review" | "delegation_handoff" | "progress_update" | "approval_prompt" | "approval_response" | "final_summary" | "error_report"`.
- `content`: `string` (min 1 character) — Human-readable text message.
- `artifactReferences`: `ArtifactReference[]` — Stored references linked to the turn.
- `createdAt`: `IsoDateTime`.
- `metadata`: `Metadata` (optional).

#### 3. `DelegationRequest` (`DelegationRequestSchema`)
Formal handoff contract between conversation and coordination layers:
- `schemaVersion`: `2` — Numeric literal version 2.
- `delegationId`: `Identifier` — Unique delegation request ID.
- `messageId`: `Identifier` — Originating message identity.
- `correlationId`: `Identifier` — Traceability token.
- `sessionId`: `Identifier` — Originating conversation session ID.
- `runId`: `Identifier` (optional; required when `requestedBy` is `"coordinator"`).
- `requestedBy`: `"conversation" | "coordinator"` — Invariant: `"conversation"` can only delegate to `"coordinator"`; `"coordinator"` cannot delegate to `"conversation"` or `"coordinator"`.
- `targetRole`: `AgentRole` — Target specialist role.
- `title`: `string` (min 1 character) — Short descriptive title.
- `objective`: `string` (min 1 character) — Detailed delegation objective.
- `specificationId`: `Identifier` — Bound specification artifact ID.
- `sddLevel`: `SddPolicyLevel` (`"lightweight" | "full"`).
- `acceptanceCriteria`: `AcceptanceCriterion[]` (min 1 criteria).
- `tddDecision`: `TddDecision` (optional).
- `inputArtifacts`: `ArtifactReference[]` — Supporting input context references.
- `priority`: `"low" | "normal" | "high" | "critical"`.
- `requestedAt`: `IsoDateTime`.
- `idempotencyKey`: `IdempotencyKey` — Deduplication guard.
- `metadata`: `Metadata` (optional).

#### 4. `AgentRole` & `AgentRoleProfile` (`AgentRoleSchema`, `AgentRoleProfileSchema`)
10 canonical roles replacing the 4 MVP roles:
- Enum values: `"conversation" | "coordinator" | "planner" | "architect" | "specifier" | "developer" | "tester" | "reviewer" | "qa" | "security"`.
- `AgentRoleProfile` defines role governance:
  - `role`: `AgentRole`.
  - `title`: `string`, `description`: `string`.
  - `defaultCapabilities`: `Identifier[]` (min 1).
  - `allowedRecipients`: `(AgentRole | "user" | "runtime")[]` (min 1; `"conversation"` may only include `"user" | "coordinator" | "runtime"`, and specialist roles may only include `"coordinator" | "runtime"`).
  - `canDelegateToSpecialist`: `boolean` — **System Invariant**: Must be `true` ONLY for `"coordinator"`; all other roles must be `false`.
  - `userFacing`: `boolean` — **System Invariant**: Must be `true` ONLY for `"conversation"`; all other roles must be `false`.
  - `readOnlyWorkspace`: `boolean`.
  - `requiresDedicatedPane`: `true` (literal `true`).
  - `requiresIndependentVerification`: `boolean`.

#### 5. `AgentCapability` (`AgentCapabilitySchema`)
Defines operational capability bounds, category, and tool assignments:
- `id`: `Identifier` — Unique capability identifier.
- `name`: `string`, `description`: `string`.
- `category`: `AgentCapabilityCategory` (`"conversation" | "coordination" | "specification" | "architecture" | "implementation" | "testing" | "verification" | "review" | "security"`).
- `readOnly`: `boolean` — Whether the capability operates without workspace mutation.
- `requiredTools`: `string[]` (optional) — Whitelist of executable CLI or shell tools.
- `metadata`: `Metadata` (optional).

#### 6. `AgentAssignment` (`AgentAssignmentSchema`)
Durable record binding a task execution to a specific agent instance, role, and physical pane:
- `schemaVersion`: `2` — Numeric literal version 2.
- `assignmentId`: `Identifier` — Unique assignment ID.
- `runId`: `Identifier`, `taskId`: `Identifier`, `delegationId`: `Identifier`.
- `role`: `AgentRole` — Invariant: `role` cannot be `"conversation"`.
- `agentId`: `Identifier` — Target agent instance identifier.
- `paneId`: `Identifier` — Herdr terminal pane locator.
- `leaseId`: `Identifier` — Associated registry lease.
- `fencingToken`: `number` (positive integer) — Monotonic fencing token protecting transport dispatch.
- `requiredCapabilities`: `Identifier[]` — Validated capabilities for the task.
- `assignedBy`: `"coordinator"` (literal).
- `assignedAt`: `IsoDateTime`.
- `status`: `"assigned" | "active" | "released" | "revoked" | "completed" | "failed"`.
- `worktreePath`: `string` (optional) — Path to isolated git worktree.
- `idempotencyKey`: `IdempotencyKey`.
- `metadata`: `Metadata` (optional).

#### 7. `PaneBinding` (`PaneBindingSchema`)
Describes the physical allocation of a terminal pane within a multi-pane Herdr session:
- `schemaVersion`: `2` — Numeric literal version 2.
- `bindingId`: `Identifier` — Unique pane binding ID.
- `sessionId`: `Identifier` — Parent session manifest ID.
- `role`: `AgentRole` — Bound agent role.
- `agentId`: `Identifier` — Bound agent instance.
- `workspaceId`: `Identifier`, `tabId`: `Identifier`, `paneId`: `Identifier`.
- `terminalId`: `Identifier` (optional) — Associated Herdr terminal handle.
- `session`: `AgentSessionLocator` (optional).
- `paneGroup`: `"conversation" | "coordination" | "verification" | "developer_worktree"` (optional) — Categorizes terminal tab/pane grouping.
- `permanent`: `boolean` (optional) — Declares whether the pane role is permanent (e.g. Conversation, Coordinator) or dynamically spawned/destroyed (e.g. Developer worktrees).
- `provider`: `string`, `agentKind`: `string`, `model`: `string` (optional).
- `cwd`: `string`, `worktreePath`: `string` (optional).
- `isolationMode`: `"dedicated_pane"` (literal).
- `readOnlyWorkspace`: `boolean`.
- `transportState`: `AgentTransportState` (`"starting" | "accepted" | "idle" | "working" | "blocked" | "done" | "unknown" | "disconnected" | "cancelled"`).
- `boundAt`: `IsoDateTime`.
- `lastHeartbeatAt`: `IsoDateTime` (optional).
- `metadata`: `Metadata` (optional).

#### 8. `SessionManifest` (`SessionManifestSchema`)
Manifest defining the topology, layout, and active state of a multi-pane Herdr session:
- `schemaVersion`: `2` — Numeric literal version 2.
- `sessionId`: `Identifier` — Session manifest ID.
- `projectName`: `string`, `workspaceRoot`: `string`.
- `herdrWorkspaceId`: `Identifier`, `herdrTabId`: `Identifier`.
- `status`: `"initializing" | "up" | "degraded" | "stopping" | "down"`.
- `conversationSessionId`: `Identifier` — Bound conversation session identity.
- `activeRunIds`: `Identifier[]` — Concurrent active workflow run IDs.
- `panes`: `PaneBinding[]` (min 1 pane; invariant: unique `paneId` across all panes; every pane's `sessionId` must match; when `status` is `"up"`, must include both `"conversation"` and `"coordinator"` panes).
- `attachTarget`: `{ role: "conversation", paneId: Identifier, terminalId?: Identifier }` — **Invariant**: `attachTarget.paneId` must equal the conversation pane's `paneId`.
- `createdAt`, `updatedAt`: `IsoDateTime`.
- `stoppedAt`: `IsoDateTime` (optional).
- `metadata`: `Metadata` (optional).

#### 9. `Specification` (`SpecificationSchema`)
Structured requirements artifact produced under Spec-Driven Development (SDD):
- `schemaVersion`: `2` — Numeric literal version 2.
- `specId`: `Identifier` — Unique specification ID.
- `runId`: `Identifier` (optional).
- `sessionId`: `Identifier` — Originating conversation session ID.
- `level`: `SddPolicyLevel` (`"lightweight" | "full"`).
- `complexity`: `"trivial" | "standard" | "complex"` (optional; `ChangeComplexitySchema`) — Adaptive change complexity classification guiding requirement and testing depth.
- `riskLevel`: `"low" | "medium" | "high" | "critical"` (optional; `RiskLevelSchema`) — Risk assessment governing review and approval criteria.
- `version`: `number` (optional, positive integer) — Monotonic revision counter for specification evolution.
- `title`: `string` (trimmed, min 1), `summary`: `string` (trimmed, min 1), `problemStatement`: `string` (trimmed, min 1).
- `scope`: `{ inScope: string[]; outOfScope: string[] }` (`inScope` min 1 entry).
- `acceptanceCriteria`: `AcceptanceCriterion[]` (min 1 entry; duplicate `id` rejected).
- `traceabilityTaskIds`: `Identifier[]` (optional) — Bidirectional traceability linking criteria to task DAG nodes.
- `affectedPaths`: `string[]` (min 1 entry).
- `architectureNotes`: `string` (optional; **required** when `level` is `"full"`).
- `dataModelChanges`: `string` (optional).
- `securityConsiderations`: `string` (optional; **required** when `level` is `"full"`).
- `rollbackPlan`: `string` (optional; **required** when `level` is `"full"`).
- `testStrategy`: `TestStrategy` (optional; **required** when `level` is `"full"`).
- `tddDecision`: `TddDecision` (optional; **required** when `level` is `"full"`).
- `status`: `"draft" | "review_pending" | "approved" | "superseded" | "rejected"`.
- `artifactRef`: `ArtifactReference` (optional; **required** when `status` is `"approved"`).
- `createdBy`: `string`, `approvedBy`: `string` (optional; **required** when `status` is `"approved"`).
- `createdAt`, `updatedAt`: `IsoDateTime`.
- `metadata`: `Metadata` (optional).

#### 10. `AcceptanceCriterion` (`AcceptanceCriterionSchema`)
Formal acceptance criterion linked to automated or gate verification:
- `id`: `Identifier` — Unique criterion identifier.
- `description`: `string` (trimmed, min 1 character).
- `category`: `"functional" | "non_functional" | "security" | "performance" | "edge_case" | "regression"`.
- `verificationMethod`: `"unit_test" | "integration_test" | "e2e_test" | "typecheck" | "lint" | "static_analysis" | "manual_review"`.
- `required`: `boolean`.
- `status`: `"pending" | "satisfied" | "failed" | "waived"`.
- `evidenceArtifactIds`: `ArtifactId[]` — Invariant: Min 1 evidence artifact required when `status` is `"satisfied"`, unless `verificationMethod` is `"manual_review"`.
- `waiverReason`: `string` (optional; **required** when `status` is `"waived"`).

#### 11. `TestStrategy` (`TestStrategySchema`)
Testing policy guiding task verification and criterion coverage:
- `schemaVersion`: `2` — Numeric literal version 2.
- `strategyId`: `Identifier` — Strategy identifier.
- `specId`: `Identifier` — Bound specification identifier.
- `tddDecision`: `TddDecision` — Invariant: `tddDecision.specId` must match `specId`.
- `requiredTestLevels`: `("unit" | "integration" | "e2e" | "property" | "regression" | "smoke")[]` — Invariant: Min 1 level required when TDD mode is `"required"`.
- `targetCommands`: `string[]` — Invariant: Min 1 target test command required when TDD mode is `"required"`.
- `coverageThresholdPercent`: `number` (optional, 0–100 range).
- `independentVerificationRequired`: `true` (literal `true`).
- `criterionMappings`: Array of `{ criterionId: Identifier; testNames: string[] }`.
- `createdAt`: `IsoDateTime`.
- `metadata`: `Metadata` (optional).

#### 12. `TddDecision` (`TddDecisionSchema`)
Conditional TDD decision evaluated by Coordinator:
- `schemaVersion`: `2` — Numeric literal version 2.
- `decisionId`: `Identifier` — Decision identifier.
- `runId`: `Identifier`, `taskId`: `Identifier` (optional), `specId`: `Identifier`.
- `mode`: `TddMode` (`"required" | "recommended" | "not_applicable"`).
- `rationale`: `string` (trimmed, min 10 characters).
- `verifiableConditions`: `string[]` (min 1 non-empty condition string).
- `changeClassification`: `ChangeClassification` (`"domain_logic" | "bugfix" | "api_contract" | "refactoring" | "ui_layout" | "documentation" | "configuration" | "exploratory_spike"`).
- `requiresFailingTestFirst`: `boolean` — Invariant: Must be `true` when `mode` is `"required"`; must be `false` when `mode` is `"not_applicable"`; `"domain_logic"` and `"bugfix"` cannot be marked `"not_applicable"` without explicit `metadata.humanOverrideApproved === true`.
- `decidedBy`: `"coordinator" | "planner" | "architect" | "human_operator"`.
- `decidedAt`: `IsoDateTime`.
- `verifiedByGateId`: `Identifier` (optional).
- `metadata`: `Metadata` (optional).

#### 13. `VerificationResult` (`VerificationResultSchema`)
Comprehensive verification outcome produced by independent evaluators:
- `schemaVersion`: `2` — Numeric literal version 2.
- `verificationId`: `Identifier` — Verification outcome ID.
- `runId`: `Identifier`, `taskId`: `Identifier`, `cycleNumber`: `number` (positive integer), `attemptId`: `Identifier`.
- `status`: `VerificationResultStatus` (`"passed" | "failed" | "inconclusive" | "blocked" | "escalated"`) — Comprehensive verdict classification. `"inconclusive"` indicates ambiguous test signals or unverified findings requiring re-run.
- `verificationScope`: `"task" | "workflow"` (optional) — Distinguishes task-level verification from post-integration workflow-level verification.
- `independentExecution`: `true` (literal `true`).
- `evaluatedCriteria`: Array of `{ criterionId: Identifier; passed: boolean; command?: string; exitCode?: number; evidenceArtifactId: ArtifactId; summary: string }` (min 1 entry; every `evidenceArtifactId` must exist in `evidenceArtifacts`; when `status` is `"passed"`, all criteria must have `passed: true`).
- `qualityGateResults`: `QualityGateResult[]` — Invariant: When `status` is `"passed"`, all quality gate results must have `status: "passed"`.
- `evidenceArtifacts`: `ArtifactReference[]` (min 1 entry; all must match `runId`).
- `findings`: `QualityFinding[]` — Invariant: When `status` is `"passed"`, findings cannot contain severity `"error"`.
- `changeSet`: `GitChangeSet` (optional).
- `verifiedBy`: `"quality_gate" | "qa" | "reviewer" | "tester"`.
- `startedAt`, `completedAt`: `IsoDateTime` (invariant: `completedAt >= startedAt`).
- `metadata`: `Metadata` (optional).

#### 14. `VerificationCycle` & `VerificationEscalation` (`VerificationCycleSchema`)
State of an iterative verification loop bounded by `maxIterations`:
- `schemaVersion`: `2` — Numeric literal version 2.
- `cycleId`: `Identifier`, `runId`: `Identifier`, `taskId`: `Identifier`, `specId`: `Identifier`.
- `verificationScope`: `"task" | "workflow"` (optional) — Task-level vs. workflow-level scope.
- `currentIteration`: `number` (positive integer; cannot exceed `maxIterations`).
- `maxIterations`: `number` (integer between 1 and 10; default: `3`).
- `status`: `"in_progress" | "passed" | "rework_required" | "escalated" | "aborted"` — Invariants: `"passed"` status requires non-empty `history` with the last result having status `"passed"`; when `currentIteration === maxIterations` and the last result is `"failed"` or `"inconclusive"`, cycle cannot be `"rework_required"` and must escalate or abort.
- `tddDecision`: `TddDecision`.
- `history`: `VerificationResult[]`.
- `escalation`: `VerificationEscalation` (optional; **required** when `status` is `"escalated"`):
  - `escalatedAt`: `IsoDateTime`.
  - `reason`: `string` (min 1 character).
  - `target`: `"coordinator" | "human_operator"`.
  - `approvalRequestId`: `Identifier` (optional).
  - `evidenceArtifacts`: `ArtifactReference[]` (min 1 entry).
- `startedAt`, `updatedAt`: `IsoDateTime`.
- `metadata`: `Metadata` (optional).

#### 15. `GitChangeSet` (`GitChangeSetSchema`)
Git workspace modification state captured as a trusted artifact:
- `schemaVersion`: `2` — Numeric literal version 2.
- `changeSetId`: `Identifier`, `runId`: `Identifier`, `taskId`: `Identifier`, `attemptId`: `Identifier`.
- `worktreePath`: `string`, `branchName`: `string`.
- `baseCommitHash`: `string` (7–40 hex characters).
- `headCommitHash`: `string` (7–40 hex characters).
- `dirtyWorkingTree`: `boolean`.
- `filesChanged`: `GitChangedFile[]` (min 1 entry; `{ path: string; changeType: "added" | "modified" | "deleted" | "renamed"; previousPath?: string; additions: number; deletions: number }`; paths must be repo-relative safe paths without directory traversal).
- `patchArtifact`: `ArtifactReference` — Invariants: `kind` must be `"patch"`; `runId` must match changeSet `runId`.
- `createdAt`: `IsoDateTime`.
- `metadata`: `Metadata` (optional).

#### 16. Extended `ApprovalRequest` & `ApprovalDecision` (`approval.ts`)
Backward-compatible discriminated union expansion supporting 8 target types:
- `schemaVersion`: `1 | 2` (supports both v1 and v2 records).
- `approvalId`: `Identifier`, `runId`: `Identifier`, `sessionId`: `Identifier` (optional).
- `status`: `ApprovalStatus` (optional; `"pending" | "approved" | "changes_requested" | "rejected" | "expired" | "cancelled" | "superseded"`).
- `expiresAt`: `IsoDateTime` (optional).
- `target`: `ApprovalTarget` discriminated union supporting:
  - `{ type: "run" }`
  - `{ type: "task", taskId: Identifier }`
  - `{ type: "quality_gate", taskId?: Identifier, gateId: Identifier }`
  - `{ type: "specification", specId: Identifier }`
  - `{ type: "tdd_decision", decisionId: Identifier, taskId?: Identifier }`
  - `{ type: "verification_escalation", cycleId: Identifier, taskId: Identifier }`
  - `{ type: "git_changeset", changeSetId: Identifier, taskId: Identifier }`
  - `{ type: "delegation", delegationId: Identifier }`
- `revision`: `number` (positive integer), `generation`: `number` (non-negative integer).
- `requestedBy`: `string`, `requestedAt`: `IsoDateTime`, `reason`: `string`.
- `evidence`: `ArtifactReference[]`.
- `idempotencyKey`: `IdempotencyKey`.
- `metadata`: `Metadata` (optional).
- `ApprovalDecisionSchema`: `schemaVersion: 1 | 2`, `approvalId`, `runId`, `sessionId?`, `target`, `revision`, `generation`, `decision: "approved" | "rejected" | "changes_requested"`, `decidedBy`, `decidedAt`, `reason?` (required for rejection/changes_requested), `feedbackArtifacts`, `idempotencyKey`, `metadata?`.

#### 17. Extended `RecoveryCheckpoint` (`execution.ts`, `recovery.ts`)
Backward-compatible extension of checkpoint envelope and aggregate state:
- **Envelope (`RecoveryCheckpointSchema`)**:
  - `checkpointSchemaVersion`: `1` (backward-compatible literal `1`).
  - `codec`: Discriminated union `{ name: "bflow.workflow-run-snapshot+json", version: 1 }` | `{ name: "bflow.workflow-aggregate+json", version: 1 }`.
  - `checkpointId`: `Identifier`, `runId`: `Identifier`.
  - `sessionId`: `Identifier` (optional).
  - `conversationSessionId`: `Identifier` (optional).
  - `eventSequence`: `number`, `version`: `number`.
  - `state`: `JsonValue`, `resumeCursor`: `string` (optional).
  - `createdAt`: `IsoDateTime`, `metadata`: `Metadata` (optional).
- **State (`WorkflowAggregateCheckpointStateSchema`)**:
  - `schemaVersion`: `1`.
  - `snapshot`: `WorkflowRunSnapshot`.
  - `sdlcContext`: `SdlcRecoveryContext` (optional) containing:
    - `conversationSession`: `ConversationSession` (optional).
    - `sessionManifest`: `SessionManifest` (optional).
    - `specifications`: `Specification[]` (optional).
    - `activeAssignments`: `AgentAssignment[]` (optional).
    - `verificationCycles`: `VerificationCycle[]` (optional).
    - `gitChangeSets`: `GitChangeSet[]` (optional).
  - `approvals`, `gateRequests`, `gateOutcomes`, `successfulAttempts`, `cancellations`, `retrySchedules`, `attemptBaselines`, `commands`.

#### 18. `RoleMessage` / `InterRoleMessage` (`session.ts`)
Standardized peer-to-peer and hierarchical envelope over Herdr transport:
- `schema_version`: `2` (literal 2).
- `message_id`: `Identifier`, `correlation_id`: `Identifier`.
- `causation_id`: `Identifier` (optional).
- `run_id`: `Identifier` (optional; **required** for all types except `"conversation.intake"` and `"conversation.clarification"`).
- `sender`: `{ role: AgentRole | "user" | "runtime", agent_id?: Identifier, pane_id?: Identifier }`.
- `recipient`: `{ role: AgentRole | "user" | "runtime", agent_id?: Identifier, pane_id?: Identifier }`.
- `type`: `RoleMessageType` (17 distinct wire types: `"conversation.intake" | "conversation.clarification" | "conversation.progress" | "delegation.request" | "delegation.accepted" | "spec.draft" | "spec.approved" | "tdd.decision" | "task.assignment" | "task.status" | "implementation.submitted" | "verification.requested" | "verification.result" | "verification.escalation" | "review.verdict" | "approval.request" | "approval.decision"`).
- `payload`: `JsonValue`.
- `artifact_references`: `ArtifactReference[]` (all must match `run_id` when present).
- `occurred_at`: `IsoDateTime` (optional).
- `idempotency_key`: `IdempotencyKey` (optional).
- `metadata`: `Metadata` (optional).

#### 19. Environment Doctor Contracts (`EnvironmentDoctorCheck`, `EnvironmentDoctorReport`)
Used by `bflow doctor` (P12) and `SessionLifecycleManager.doctorSession` to inspect environment prerequisites:
- `EnvironmentDoctorCheck` (`EnvironmentDoctorCheckSchema`): Individual system check outcome:
  - `checkId`: `Identifier` — Unique check identifier.
  - `name`: `string` (trimmed, min 1).
  - `status`: `"passed" | "warn" | "failed"`.
  - `message`: `string` (trimmed, min 1).
  - `remediation`: `string` (optional, trimmed, min 1).
- `EnvironmentDoctorReport` (`EnvironmentDoctorReportSchema`): Aggregated doctor report:
  - `schemaVersion`: `2` (literal 2).
  - `workspaceRoot`: `string` (trimmed, min 1).
  - `sessionId`: `Identifier` (optional).
  - `healthy`: `boolean` — Invariant: Cannot be `true` when any check in `checks` has `status === "failed"`.
  - `checks`: `EnvironmentDoctorCheck[]` (min 1 check).
  - `checkedAt`: `IsoDateTime`.
  - `metadata`: `Metadata` (optional).
- `SessionLifecycleManager.doctorSession(options: { workspaceRoot: string }): Promise<EnvironmentDoctorReport>`: Port interface executing the doctor suite against the environment.

## Contracts v3 (P24 platform baseline)

P24 thêm các root document additive với `schemaVersion: 3` (`CURRENT_PLATFORM_SCHEMA_VERSION`), strict parsing; nested value objects thừa hưởng version của envelope. Không đổi signature port cũ, RoleMessage v2, SessionManifest v2, event/checkpoint codec. Version khác 3 phải trả `unsupported_version`; v3 malformed trả `validation`. Quyết định D24-01 và kế hoạch compatibility ở [runtime architecture v3](runtime-architecture-v3.md). Tất cả được export từ barrel `packages/contracts/src/index.ts`.

| File | Exports chính | Thiết kế chi tiết |
| --- | --- | --- |
| `platform.ts` | `AgentProviderIdSchema` (`claude`/`codex`/`agy`), `ConfigurationLevelSchema` (`machine`/`repository`/`session`), `TrustScopeSchema` + `isTrustScopeWithin`, `ScopedOperationSchema`, `Sha256DigestSchema`, `SecretReferenceSchema`, `SafeArgumentSchema` | [runtime v3](runtime-architecture-v3.md) |
| `provider.ts` | `PermissionProfileSchema`, `AgentEnvironmentSchema`, `AgentProviderDescriptorSchema`, `AgentLaunchProfileSchema`, `AgentLaunchAttestationSchema`, `AgentHealthRequestSchema`/`AgentHealthResultSchema`, `AGENT_HEALTH_CHECKS`, port `AgentProviderAdapter` | [provider contracts](provider-contracts.md) |
| `setup.ts` | `ToolCapabilitySchema`, `ToolInstallRequestSchema`, `SetupStepSchema`, `MachineSetupPlanSchema`, `SetupReceiptSchema`, `SetupApplyRequestSchema`, port `ToolInstaller` | [runtime v3 §4](runtime-architecture-v3.md) |
| `mcp.ts` | `MCPEndpointSchema`, `MCPServiceDefinitionSchema`, `MCPClientRegistrationSchema`, `MCPServiceObservationSchema`, `MCPResourceLeaseSchema`/`MCPResourceRequestSchema`/`MCPResourceRenewRequestSchema`, `MCPToolCallSchema`/`MCPToolCallResultSchema`, ports `MCPServiceManager`, `SharedMCPGateway` | [shared MCP](shared-mcp-architecture.md) |
| `skills.ts` | `SkillPinSchema`, `SkillDefinitionSchema`, `RoleSkillBindingSchema`, `SkillManifestSchema` | [skills](skills-architecture.md) |
| `commands.ts` | `BflowCommandSchema`, `CommandExecutionResultSchema`, port `BflowCommandExecutor` | [runtime v3 §7](runtime-architecture-v3.md) |

Các package leaf P25–P29 phân tích dữ liệu trao đổi bằng các schema này (ví dụ `agent-providers` với `AgentHealthRequestSchema`/`AgentLaunchProfileSchema`). Một số tham số package-local (metadata skill, `.bflow/skills.json`, request của machine-setup) dùng schema strict riêng và không phải public contract. `SkillManager` là class của `@bflow/skills`; contracts v3 chỉ có data schemas cho skills, không có port `SkillManager`. Ngoài các contract trên, `EnvironmentDoctorReportSchema` vẫn ở `schemaVersion: 2`; chi tiết check theo nhóm của `bflow doctor` hiện nằm trong CLI, chưa là contract public.
