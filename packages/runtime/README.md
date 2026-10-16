# @bflow/runtime

The existing `RuntimeServiceImpl`, dispatcher, MVP orchestrator and workspace
factory remain available. P19 adds `AgenticWorkflowRuntime`, `CoordinatorTools`,
`createAgenticConversationHost` and `openAgenticWorkspace` for the v2 SDLC flow.
These are host composition APIs. `bflow up` still manages the P12/P13 environment;
it does not automatically install a model-provider tool plugin or start a P19 daemon.

## Composition and execution

`openAgenticWorkspace(options)` opens an existing, up P12/P13 session, validates
its repository binding, uses the actual RolePaneManager and Herdr CLI adapter,
and composes the implemented Core, file Registry, SQLite RunStore, filesystem
ArtifactStore and P14–P18 engines. It does not create duplicate permanent roles.
Herdr commands use a repository-specific `HERDR_SESSION`, clearing inherited
pane/socket routing overrides in the same way as P12. CLI/protocol preflight runs
before persistent resources or Developer allocations are opened.

Required host inputs are explicit: repository/session identity, role capabilities,
task/workflow check definitions, deterministic gate runners, authenticated Herdr
message/result/evidence ingress and authenticated human approval. There are no
production success stubs or default authentication callbacks. Review check IDs are
composed as `runtime.herdrQualityGate(id)`, which sends `verification.requested`
through the durable Herdr outbox and awaits an authenticated `review.verdict`
containing a `QualityGateResult`. P17 verifies its observation, exact revision,
criterion mapping, independence and execution window. Deterministic gates must be
real, isolated host runners configured for the corresponding check IDs.

A host uses the returned interfaces as follows:

```ts
const host = await openAgenticWorkspace({
  repositoryPath, sessionId,
  taskChecks, workflowChecks, deterministicGates, roleCapabilities,
  authenticateMessage, authenticateResult, authenticateEvidence,
  authenticateGateResult, authorizeHuman,
  projectApprovalRequired
});

// Authenticated user interaction goes only to the actual P14 Conversation Gateway.
await host.conversation.handleUserTurn(userTurn);
await host.runtime.flushOutbound();

// A separate trusted inbound pump delivers envelopes AFTER physical Herdr receipt.
await host.runtime.receiveHerdr(coordinatorOrRuntimeEnvelope);
await host.conversation.receiveHerdr(conversationEnvelope);

// The Coordinator's provider host injects its principal; never read it from tool arguments.
await host.tools.invoke("propose_workflow", {
  runId, specification, definition, maxIterations: 3
}, { role: "coordinator" });
await host.tools.invoke("tick", {}, { role: "coordinator" });
```

The Coordinator's `tick` tool schedules background work and returns immediately.
Coordinator must yield its turn instead of polling while its own pane is busy.
`tick_status` reports host scheduler errors; `CoordinatorTools.drain()` is a host
lifecycle wait, and `close()` drains outstanding Coordinator-scheduled work.
The inbound pump must remain available while Runtime `tick()` awaits remote verification.
Do not await an agent turn from inside its own mailbox handler. Keep ticking/draining
outbound messages independently of user turns. Stop scheduling and finish outstanding
host operations before `host.close()` closes storage handles. Native provider prompt
and tool registration belongs to the trusted agent host; load
`agents/coordinator/system-prompt.md` into its Coordinator pane.

The Conversation composition retains P14's intent recognition, context persistence,
correlation IDs, busy inbound queue, approval provenance and cancellation delegation.
Its outbound delegation/approval methods queue through P19. The old bridge's local
progress/approval callback shortcut is disabled in this composition. A persisted
queue entry acknowledges local enqueue, not remote prompt receipt.

## Policies and lifecycle

The Coordinator can assess requirements, request only useful specialists, prepare a
specification/DAG itself, or request Analyst/Architect/Planner expertise through
Herdr. There is no fixed role sequence. The implementation DAG currently contains
Developer nodes; read-only preparatory/specialist work uses `request_specialist`.
No arbitrary graph mutation or source editing tool is exposed to Coordinator.

`proposeWorkflow` validates the actual frozen Specification/WorkflowDefinition
schemas, P15 impact policy and traceability, preserves delegated criteria, checks
literal path ownership and requires successful dependencies. P16 resolves the
workflow and per-task strategies; P15 stores/reviews immutable dossiers. Full input
specifications include their required design, security, rollback, decision and
strategy fields. Task `metadata.conditionalTdd` may provide a specific assessment;
otherwise the overall assessment is specialized to that task ID. Low-risk spec
acceptance is autonomous only when P15 and project policy permit it. Complex design
and project-mandated implementation approvals return to Conversation. One approval
binds the complete dossier bundle; internal spec decisions retain that bundle ID.

All Developer tasks name `metadata.ownedPaths` (literal repository prefixes), with
optional `forbiddenPaths` and `requiredCapabilities`. Agent-controlled gate definitions
are rejected: trusted project checks are configured through `taskChecks` and
`workflowChecks`. Task `requiresApproval` is also enforced before dependent tasks
may run. User rejection stops further scheduling. Destructive operations, protected
branch merges, deployments and secret/access mutations have no execution tool in
this Runtime, so an unrelated approval cannot grant those capabilities.

Core owns DAG/concurrency and legal transitions. Runtime binds actual pane IDs,
capabilities, leases and fencing tokens, persists transport intent, then dispatches
`RoleMessage` assignments through Herdr. A current Registry renewal is required
immediately before send and before accepting a conclusive implementation result.
Accepted Developer leases are renewed on subsequent ticks. Run the scheduler more
frequently than the five-minute lease TTL; an expired/stale lease requires explicit
reconciliation, not an assumed extension.

Required TDD needs independent Red before `authorize_implementation`, followed by
Green/Refactor evidence validated by P16. `not_applicable` still requires alternative
evidence. Missing policy evidence holds the task and reports the missing obligation.
The host must enforce the write capability boundary and authenticate the measurements;
a prompt alone cannot constrain an agent's OS permissions. P17 acceptance also requires
the actual independent checks. Authenticated terminal activity is not measurement
provenance, and schema-valid evidence is not proof of physical isolation.

A verified successful Developer result waits behind a required independent completion
gate. Runtime releases its writer allocation only after a ready, matching pane and
P13's clean-worktree checks, then collects the actual P18 change set. P17 verifies
outside the Runtime journal lock, allowing Reviewer replies and cancellation to
arrive. Known check/review failures can trigger scoped Developer repair attempts;
max iterations, inconclusive/blocked outcomes and exhausted implementation attempts
escalate. The verification plan stays frozen across repairs; the trusted host must
also exclude every subsequent implementer identity/alias from reviewer authority.

Core's optional gate metadata `boundedVerificationRetry: true` enables retries only
for a failed required independent `before_completion` gate over a previously verified
successful attempt. Live execution and authoritative event replay enforce the same
bounds and retry schedule. Ordinary workflows retain their previous gate behavior.
No shared schema, migration, event shape or method signature changes. Implementation
retries and verification repairs share the task's finite attempt budget, while P17
separately bounds actual verification iterations.

After task verification, P18 integrates pinned branches in dependency order into a
dedicated integration branch. Conflicts preserve work and escalate; committed scoped
resolutions can be acknowledged with `accept_conflict_resolution`. Runtime captures
the actual complete integrated Git diff, including merge/resolution commits, stores
its patch through ArtifactStore, and invokes P17 with workflow scope and exact
integration provenance. Task results never substitute for this check. Workflow-level
failure escalates for an explicitly scoped repair plan/new accepted delegation;
Runtime does not mutate an approved graph to repair an integrated revision implicitly.
Passing workflow verification is recorded back in P18. Delivery still requires human
approval, readable evidence and a fresh check of the pinned, clean integration revision.
The final Conversation progress envelope carries verified completion and evidence.

## Durability and recovery

The private P19 journal lives under `.bflow/state/agentic/journal` by default. It
uses same-process serialization plus Linux `flock`, file fsync, atomic rename and
directory fsync. It is repository bound and rejects corrupt/unsupported state.
It is not an ArtifactStore communication channel. All actual agent delivery uses
Herdr; the journal stores scheduling/outbox/inbox state and receipts.

Message IDs and idempotency keys reject conflicting payload reuse. Busy recipients
remain queued without blocking other panes. Dispatch intent precedes transport;
`sending` after a crash becomes `unknown_delivery`. Timeout, thrown transport errors
and malformed receipts never prove non-delivery. Only explicit reconciliation with
`not_delivered` permits a resend of the exact original AgentRequest. A changed pane,
request fingerprint or lease is not silently substituted. Ambiguous messages retain
leases and do not automatically resend across restart.

Core event batches are journaled before SQLite append and retried idempotently.
Aggregate checkpoints are retained; authoritative complete event replay restores
approval, retry, gate and cancellation state. The maintained RunStore projection is
not used as an aggregate replacement. Completed P17 outcomes have a write-ahead
application journal, so a SQLite failure can recover the outcome without rerunning
checks. If execution is interrupted before that outcome reaches the Runtime journal,
its pending flag requires explicit host reconciliation against P17's stored receipt;
Runtime does not start another verification execution automatically.

Cancellation persists intent before interrupts, rejects new task assignments,
aborts local verification waits, and retains worktrees/uncertain bindings. An accepted
interrupt is not stop confirmation. Core may remain `cancelling` while the SDLC domain
records cancellation intent. Late verification cannot revive that run. No automatic
destructive cleanup, protected merge, remote push or production deploy is performed.
A Registry mutation acknowledged before a local journal write is lost may also
require host reconciliation of its stored idempotency receipt; Runtime stops on
stale-version/fingerprint errors and does not assume that mutation was rolled back.
Linux/local-filesystem assumptions remain; no network-filesystem, hostile same-user,
multi-host or power-loss guarantees are added. Existing P02-RA01/P03-RA01 remain open.

## Live Herdr limitation / integration decision required

The supplied Adapter is verified for CLI 0.9.1 / protocol 22 / schema 1. The machine
used for this implementation has CLI 0.9.0; actual adapter initialization returns
`unsupported_version`, and `herdr status server` reports no running server.
No compatibility guard was relaxed and no existing user session was started/changed.

There is also a conclusive-result boundary: current Herdr `send()` returns an
orchestrator correlation with `verified: false`, and `read()` returns unverified
`terminal_snapshot` observations. Core's `recordAgentResult` requires a matching
verified correlation on both the result and the already-bound handle.
`bindAgentExecution` and `recordDeliveryReconciliation` refuse replacement of an
existing binding. Therefore the supplied CLI adapter cannot currently produce an
accepted live business outcome, even if an agent prints JSON saying it succeeded.
P19 deliberately rejects that case; a regression fixture demonstrates the refusal.

Live closure requires an integration-reviewed authenticated structured Herdr ingress
and receipt protocol (and, if needed, an explicit compatible contract decision for
receipt-backed correlation promotion). The proposal must preserve request/attempt/
execution identity, pane/session binding, immutable receipt evidence and replay
validation, with approval from the adapter/contract integration owner. It must not
turn snapshots or orchestrator-generated tokens into remote proof. The current
package supplies the host interfaces and actual composition; it does not claim that
missing bridge, provider-native tool registration or live Herdr E2E has been verified.

## Validation

Build before targeted tests, which compose real package `dist` implementations:

```sh
pnpm build
TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts
TMPDIR=/tmp pnpm exec vitest run packages/runtime/test packages/core/test
pnpm check:deps
pnpm typecheck
TMPDIR=/tmp pnpm test
git diff --check
git status --short
```

P19 tests use real Core/Registry/SQLite/ArtifactStore/P15/P16/P17/P18 and real temporary
Git repositories, with fake physical panes/Herdr transport and injected independent
check runners. These verify composition and policy, not live AI behavior or Herdr
receipt authenticity. `TMPDIR=/tmp` avoids the Unix-domain-socket path limit in an
existing ArtifactStore POSIX fixture under this environment's long default temp path.

A clean isolated install also exposed P14's existing direct Zod imports without its
manifest dependency. The integration correction adds only `zod` to that package's
manifest and lockfile importer; no P14 implementation or shared contract is changed.
