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

Parallel task verification outcomes wait durably behind the active human task
approval. They resume after that decision, including across restart; a later
outcome cannot replace the active approval or revive a rejected run.

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
escalate. The verification plan stays frozen across repairs. Runtime also rejects
gate evidence naming any actual workflow implementer, including Developers
allocated after the plan was frozen. The trusted host must authenticate these
identities and exclude implementer aliases from reviewer authority.

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

Private host/provider/runtime state normally lives under `.bflow/state`.
Before creating credentials, Runtime probes whether that repository filesystem can
actually enforce `0600` files and `0700` directories. On mounts that cannot (for
example NTFS/FUSE with fixed `0777` permissions), it automatically uses
`$XDG_STATE_HOME/bflow/repositories/<sha256(canonical-repository-path)>/state`, or
`~/.local/state/bflow/repositories/<hash>/state` when `XDG_STATE_HOME` is unset or
relative. The user state location and its ancestors must pass ownership, symlink
and permission checks. Runtime never weakens private-file validation.

Host credentials, signing keys, provider launch material, platform state, SQLite,
artifacts and the P19 journal use the selected location consistently through
startup, activation, queries and shutdown/recovery. A nonsecret, schema-validated
`.bflow/state/private-runtime-state.json` locator pins external authority before
credentials are created, including across XDG changes and changes to repository
permission support. Missing/invalid pinned storage blocks startup instead of
creating replacement state. Locator and initial host config publication are atomic
and exclusive; concurrent startup readers never consume partial JSON. Repository configuration,
lifecycle locks/receipts and P13 pane manifests retain their existing paths and
session identities. `bflow doctor` reports the selected private Runtime location.
An unused old `host.json` left by the original privacy failure is preserved and
its exposed token is never copied or reused. Existing host ownership/other host
files, endpoints, agentic storage or platform state block automatic relocation and
require reconciliation; Runtime does not silently migrate recovery authority.
This behavior does not relocate explicit legacy Runtime storage configuration or
claim provider/Herdr acceptance on every filesystem.

The private P19 journal lives under `<selected-state>/agentic/journal`. It
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

## Authenticated Herdr host receipts

CLI release labels are diagnostic metadata. Initialization probes protocol 22 /
schema 1 and each operation validates its response. There is no release allowlist
or version-bypass flag. An installed version is tested directly; only actual wire
incompatibility is grounds for rejection.

The CLI submission handle remains unverified and immutable. ADR 0003, approved by
the project owner, adds `AuthenticatedWorkflowEngine.verifyAgentBinding` and an
`execution.receipt` RoleMessage. Runtime authenticates its sender/assignment and
lease, ingests the canonical signed receipt through ArtifactStore, and records the
Core proof event before accepting a correlated result. Core verifies Ed25519
against `bindingReceiptKeys`, exact original handle/target/session and receipt hash;
unknown issuers, forged signatures, conflicting proofs and cancelled/terminal
executions are rejected. Old unverified handles without proof still cannot succeed.

The native plugin is `agents/coordinator/herdr-receipts/herdr-plugin.toml`. Its
`deliver` action receives the structured RoleMessage in Herdr invocation context,
validates the sender against the host's P13 manifest, and for a binding receipt
rechecks the actual Herdr agent/session before signing. It forwards the signed
RoleMessage to the Runtime host ingress. No terminal snapshot is promoted into
proof. A signed binding acknowledges the request; P17 still independently verifies
the implementation. Host measurement/user-approval authentication callbacks remain
required and may not be replaced with unconditional success functions.

Configure a trusted issuer public key through `bindingReceiptKeys` on the Core
engine or `openAgenticWorkspace`. Set `nativeIngressSocket` to enable the native
host adapter. Link the plugin through the same named Herdr session. In the plugin's
Herdr-created config directory, create a private `host.json`:

```json
{
  "issuerId": "project-native-host",
  "privateKeyFile": "/private/native-host-key.pem",
  "runtimeSocket": "/short/path/bflow-ingress.sock",
  "manifestFile": "/project/.bflow/state/panes/session.manifest.json"
}
```

The signing key must be a private regular Ed25519 key file, outside source control
and model prompts. The public key configured in Core must match its issuer. Native
host signing is not an agent-facing model tool. Restrict plugin/config access as
part of the trusted local host boundary; hostile same-user isolation is not claimed.

Invoke the action using the installed Herdr API `plugin.action.invoke`, with
`plugin_id: "bflow.receipts"`, `action_id: "deliver"`, and invocation context
containing `selected_text` (the RoleMessage JSON), `focused_pane_id`, `workspace_id`
and `correlation_id` equal to the assignment message ID. The `execution.receipt`
payload carries the original handle and observation time; the host chooses its
issuer and transport correlation and replaces the input signature. Lost
acknowledgements still require reconciliation; never blindly retry a changed body.

The immutable handle stays in `agent.execution_bound`; `agent.binding_verified`
and its command receipt use event envelope v2. Receipt-bearing aggregates use
aggregate codec v2. Old runs remain readable and gain no fabricated evidence;
old readers reject the new event/codec instead of guessing. SQLite storage layout
is unchanged. Keep historical issuer public keys available for authoritative replay.

Native transport smoke tests deliberately use a real custom host process and
Herdr plugin, without a model/provider. On the installed 0.9.5 binary, that custom
actor has no exposed native `agent_session` and is not ready for normal agent
prompts; its prompt delivery remains unverified/uncertain. The smoke verifies
protocol initialization and signed structured RoleMessage delivery through the
plugin, not successful binding attestation for that custom actor. Session-less
binding receipts are rejected; signing/Core/checkpoint acceptance is covered in
the separate integration tests. Official agent integrations must supply their
actual native session identity for receipt attestation. Passing them does not establish live
AI-generated implementation, independent model review or a full SDLC delivery.
The default local host is exposed through `ensureAgenticHost`. It starts a detached
process before provider launch and prepares role-specific MCP and Claude hook
settings. Activation requires the complete `up` manifest and matching native
SessionStart receipts, including Herdr's actual `herdr:claude` session locator.
Legacy bare provider panes must be stopped/recreated; a process name alone does
not establish a configured role. The host's scheduler and inbound Herdr prompt
pump run independently of model turns. `close()` disconnects a CLI client;
`quiesce()`, aggregate `checkpoint()`, and `shutdown()` are separate lifecycle
operations. Shutdown requires the named Herdr server to have stopped. Failed or
uncertain work keeps its worktrees and requires reconciliation.

Host `prepare(options)` accepts the lifecycle deadline, timeout and cancellation
signal. Provider preparation uses that deadline instead of the short default
control RPC timeout. A disconnected preparation is cancelled; quiesce and shutdown
wait for it to drain before releasing launch registrations. No expired or cancelled
preparation authorizes a pane launch. Standalone preparation without options is
bounded to ten minutes; CLI startup supplies its remaining configured budget.
`openPersistedAgenticHost` reopens a host for shutdown/recovery using the stored
platform, policy and behavioral authority; it does not request a configuration
change. Permanent-role provider observations run at most three at a time, after
ordered environment/skills/Gateway preparation. Every provider subprocess receives
the operation's cancellation signal and remaining deadline; launch preparation
still waits for all required preflight verdicts.

The stdio MCP entrypoint exposes orchestration tools only to Coordinator, and
implementation authorization/submission only to Developer. Tester/QA alternative
evidence and Reviewer/QA verdicts are tied to host-captured exact committed diffs
and accepted criteria. Host authentication compares the exact issued receipts;
model-supplied `independentExecution` or approval flags grant no authority. Native
role messages still travel through the actual Herdr plugin; the control socket
carries host operations, rather than delivering assignments between agents.

The default verification configuration supports documentation (`.md`, `.txt`,
`.rst`) with manual acceptance criteria. It runs `git diff --check` against exact
task and integrated revisions, requires independent Reviewer and QA judgments,
and requires Tester/QA alternative evidence before task acceptance. This Git
integrity check does not establish arbitrary application behavior. Behavioral
changes and required TDD need configured measurement runners and fail closed in
the default host. Delivery and project-mandated approvals remain human decisions;
the approved low-risk specification policy may accept a lightweight spec.

Only Conversation's launch-local UserPromptSubmit hook feeds authenticated user
turns to the Gateway; exact Runtime RoleMessage deliveries are handled as
transport, and role envelopes cannot be promoted into human approval text. No
MCP tool approves on behalf of a user. Private host keys/configuration and Unix
sockets have owner-only permissions. Activation requires an exact native Bflow
launch receipt; older panes without host hooks are not silently adopted. These are local host trust controls, not
hostile same-user OS isolation. Live provider launch, native-session binding,
role-message receipt, task implementation and final delivery are distinct pieces
of evidence; local host tests alone do not prove a full live SDLC run.

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
check runners. These verify composition/policy. Separate opt-in native transport tests exercise
actual Herdr plugin/signature delivery, without claiming live AI behavior or
live binding attestation for a custom host without session identity. `TMPDIR=/tmp` avoids the Unix-domain-socket path limit in an
existing ArtifactStore POSIX fixture under this environment's long default temp path.

A clean isolated install also exposed P14's existing direct Zod imports without its
manifest dependency. The integration correction adds only `zod` to that package's
manifest and lockfile importer; no P14 implementation or shared contract is changed.

To exercise the installed binary in a temporary named session, after building:

```sh
BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts --maxWorkers=1 --minWorkers=1
```

This test owns its short XDG/socket paths and shell configuration, registers a
custom native host process (not an AI model), and stops only its own test session.

## Session recovery, context management, observability and resilience

`@bflow/runtime` also exports optional local reliability services for real repositories:

- **Session Recovery (`SessionRecoveryService`)**: Distinguishes `graceful_shutdown`, `crash`, and `transient_disconnect` across `bflow down` / `bflow up`; flushes and deduplicates `AgenticJournal` and SQLite `RunStore` state; restores incomplete runs from aggregate checkpoints plus event tails; reconciles SQLite with Herdr panes/roles to detect `agent_lost`, `agent_replaced`, and `orphan_agent` discrepancies; revokes stale leases; inspects Git worktrees/commits without destructive commands; forbids blind prompt resends when prior execution is uncertain (`unknown_delivery` or worktree modified); and never marks a task succeeded without a correlated, verified `AgentResult` and passing gates.
- **Context Management (`ProjectContextService`)**: Analyzes repository structure and workspace packages without a vector database, reads project documentation and role instructions, stores and queries architectural decision records (ADRs), deterministically selects task-relevant files within strict byte/file budgets, tracks `Specification` and `ArtifactReference` versions, prepares role-specific bounded context bundles with secret scrubbing, and detects context/spec drift across restarts.
- **Observability (`ObservabilityTracker`)**: Tracks run duration, per-task and per-attempt duration, agent assignments, verification cycles, retry/rework counts, blocked time episodes, test pass/fail rates, context bundle sizes, and verified model token/cost metrics strictly when `source: "provider_reported"` (never estimating tokens or costs when provider telemetry is absent).
- **Resilience (`BoundedConcurrencyLimiter`, `StructuredLogger`, `redactSecrets`, `executeWithRetry`, `withOperationTimeout`)**: Provides bounded concurrency with `quiesce()` drain barriers, structured JSONL logging with automatic secret redaction (preserving domain identifiers like `fencingToken` and token counters), and backoff/timeout helpers that block automatic retry on `unknown_delivery` until reconciliation completes.

These services are exported building blocks; `openAgenticWorkspace` and the CLI do
not automatically compose the context service, structured logger or observability
tracker. CLI background Herdr stdout/stderr now pass through a detached, bounded
line-redaction relay; host diagnostics also scrub known secret forms. Redaction recognizes configured patterns
and textual credential forms; it cannot guarantee removal of arbitrary unlabeled,
encoded or binary secrets. Keep secrets out of requirements and prompts, which
the Herdr CLI receives through process arguments.

`withOperationTimeout` returns the contract-defined `unknown_delivery` with
`retryable: false` and `manualInterventionRequired: true` when its local timeout
expires: aborting the wait does not prove a started operation stopped. The
deprecated `onTimeoutCode` option remains accepted for source compatibility but
cannot override that uncertainty. `executeWithRetry` will not resend it.

Repository context reads (including documentation, role prompts, ADRs and file
selection) recheck resolved-path containment, including parent symlinks,
rejects special files using nonblocking/no-follow descriptor opens, and computes
size/checksum from the bytes read rather than cached analysis. This does not
claim protection from a hostile same-user process continuously replacing paths.
`prepareRoleTaskContext` also enforces `maxTotalBytes` on the complete prompt,
including instructions, specifications and ADR summaries. Oversized contexts fail
with an actionable error instead of silently truncating governance or criteria.
This output budget does not bound all analysis memory allocations.

Targeted verification commands:

```sh
pnpm exec vitest run packages/runtime/test/unit/resilience-observability.test.ts
pnpm exec vitest run packages/runtime/test/unit/project-context-service.test.ts
pnpm exec vitest run packages/runtime/test/scenarios/09-session-recovery-reliability.test.ts
```

## Configured host verification and durable authentication

The default Claude host now supports owner-configured Node TAP and Vitest 2.1
commands, independent conditional-TDD phases, frozen Red test files, constrained
Developer commits and bounded phase repairs. Behavioral commands run in mandatory
Linux Bubblewrap namespaces with explicit read-only dependencies; there is no
unsandboxed fallback. See [runner configuration](../../docs/verification-runners.md).

Private fsynced receipts preserve human-hook provenance, independent review
observations, gate/evidence authentication and native send intent/acknowledgement.
Restart restores trusted approvals and receipts without treating cached dialogue
or transport completion as authority. Lease renew/release arguments and failed
phase outcomes are written before side effects, with exact idempotent recovery.
Task notices borrow the active assignment lease and cannot reserve/release a
second Developer slot. These are local process-crash guarantees under the stated
Linux/filesystem trust model, not live AI fault-campaign or power-loss evidence.

## Role prompts and non-user-facing policy in the default host

`runAgenticHost` builds each role's launch system prompt from the original installed `agents/<role>/system-prompt.md` via `readBuiltinRolePrompt` from the built `@bflow/pane-manager` (`packages/pane-manager/dist/index.js`, loaded at host start, so build pane-manager first). A missing Conversation or Coordinator prompt aborts host start. For every role except Conversation the host guarantees the verbatim non-user-facing policy (`NON_USER_FACING_AUTONOMOUS_POLICY`, exported from `src/agentic/host.ts`) plus `NON_USER_FACING_STRUCTURED_RESULT_REQUIREMENT` (fields `status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, optional `assumptions`): it is appended when the loaded prompt lacks it, or when no builtin prompt exists. A closing instruction also forbids asking the user in the pane and requires escalation to Coordinator over Herdr `RoleMessage`. The Coordinator no longer reads its prompt file separately; the shared loader supplies it, followed by host integration instructions. The prompt text is instruction only and does not prove a provider obeys it.

During startup, a missing launch-local SessionStart receipt or native-session receipt is reported as `[bflow:native-startup-pending]`, which `host-controller` surfaces as a retryable `conflict` (`details.stage: "native_startup"`) instead of a transport failure; retry after the native hooks publish their receipts.

`ProjectContextService` now maps the `reviewer` role to `agents/reviewer` (previously `agents/verifier`) and falls back to the verifier/QA instructions only when reviewer or security instructions are absent. Behavior tests: `pnpm exec vitest run packages/runtime/test/agentic/agent-behavior-policies.test.ts`.

## P30 platform readiness

`DefaultPlatformReadinessService` (exported from `src/platform/index.ts`) composes the implemented
platform components for one session generation: role environment, skill session records, Gateway
registrations, provider preflight/launch intent, and activation with a host-signed launch attestation.
`createPlatformReadinessService` wires the real components from a state directory, a `SkillManager`,
an optional Gateway control port and an attestation signer. Concrete provider adapter classes are not
exported.

Guarantees implemented here, with package-local tests in `test/platform/service.test.ts`:

- `prepareSession` is all-or-nothing. Any required role that is not ready (or whose launch intent cannot
  be journaled) produces `ready: false` and no launch material; Gateway registrations made in that call are
  revoked per role. Optional roles that fail are reported as `blocked` and skipped.
- A role that needs Gateway services without a configured Gateway control port is `blocked`.
- Launch material (`launch.env` bearer tokens) is kept in memory only. Reports, status snapshots and errors
  never contain token values. Released or shut-down launches drop their material.
- `verifyActivated` requires a launch this instance prepared; `assertFresh` delegates to the cached preflight.
- Codex setup review, preflight probes and permanent/dynamic role launches share the selected HOME/PATH
  and explicitly empty outer Orca pane/root/endpoint/port selectors in child environments. Parent settings
  and Bflow's mandatory Herdr/Runtime hooks are preserved; an unsupported hook snapshot still blocks launch.
- Short hook runner paths bind the full repository/session host directory and remain stable across
  host recovery. Separate repositories cannot overwrite or remove each other's runners. A pre-existing
  unsafe or symlinked temporary directory is never chmodded or adopted.
- Hook ingress validates the event/session and required prompt/tool fields. Banner-wrapped input must
  contain exactly one matching hook object; ambiguous input is rejected. Invalid `PreToolUse` input
  emits an explicit deny decision. Only the reserved environment-bound Codex startup turn is skipped.
- Native session sources must identify the configured provider (`codex` or `herdr:codex`, for example).
  Herdr as a transport does not make generic `herdr`/`herdr:herdr` sources valid provider proof.

Limitations: this is source composition with local fake-runner and fake-Gateway evidence only. Live
provider probes, a live Gateway daemon and Pane Manager/Conversation wiring are not verified here. The
service creates each role's private `gen-<n>/roles/<role>` state directory before preflight.

### In-process MCP tool reachability, Developer gate and Gateway loss (P30 hardening)

`src/agentic/tool-reachability.ts` proves Gateway tool reachability from inside the launched provider process,
not only from config digests. For every launch with Gateway registrations (permanent roles at `prepare`, dynamic
Developers at allocation) the host writes a private, token-free plan `gateway-probes/<launchId>.json` (dir 0700,
file 0600, atomic): launch id, Gateway endpoint, registration ids, the derived `BFLOW_MCP_TOKEN_*` variable names
and allowed tools. Launch material carries the non-secret `BFLOW_LAUNCH_ID`, so the provider's native
`SessionStart` hook finds its own plan even when several Developers run concurrently (a legacy `<role>.gateway.json`
is read only as a fallback and removed at `prepare`). The hook probes each registration with the bearer token from
its own environment (`initialize`, then `tools/list` with the session id, 5 s per request, `redirect: "error"`) and
reports only the registration id, env var name, `ok`, discovered tools and a code (`token_env_missing`,
`unauthorized`, `http_error`, `timeout`, `unreachable`, `protocol_error`, `missing_tools`). Records are stored per
launch and pane.

- `activate` requires, for each required permanent role with registrations, an `ok` record for the exact prepared
  launch; a missing record is `[bflow:native-startup-pending]`, a failed one throws a named error.
- A dynamic Developer's allocation returns a retryable `conflict` (`details.stage: "developer_startup"`) until its
  record is `ok`; a failed proof or no proof within 30 s releases its launch and pane (non-retryable `validation`).
- Every 30 s the host reconciles Gateway registrations with the Gateway control. A registration missing after a
  Gateway daemon restart (or expired/changed) marks its launch `degraded`; degraded roles report `readyForPrompt:
  false`, so the outbox keeps their messages queued until `bflow up` relaunches them (running providers keep a
  revoked token; it cannot be hot-swapped). Uncertain checks change nothing.
- A restarted host daemon retires the previous daemon's launches: it revokes the session's registrations, journals
  `released` for open intents and removes their plans/records; activation then needs a fresh `bflow up`.
- `platform_status` reports per-launch reachability, the last Gateway check and any restart recovery, without tokens.

Limitations: the hook-environment inheritance, Claude's `${VAR}` header expansion and Codex's
`bearer_token_env_var` are verified only with local spawned hooks and rendered config, not live providers or Herdr.
