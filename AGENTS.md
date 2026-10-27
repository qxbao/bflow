# Multi-agent collaboration rules

This repository is designed for five implementation agents working in isolated Git worktrees. These rules apply to every agent and nested directory unless a more specific `AGENTS.md` is introduced later.

## Current implementation context

Contracts, the deterministic Core workflow engine, Herdr CLI adapter, file-backed Agent Registry, SQLite RunStore, filesystem ArtifactStore, Quality-gates, RuntimeService and CLI (`bflow`) are implemented. Do not replace implemented modules with bootstrap scaffolds or claim live Herdr end-to-end verification without evidence. See [README.md](README.md) for package status and runnable commands, and package READMEs for guarantees and limitations.

Since the P24 baseline, source implementations with package-local tests exist for P25 (`packages/agent-providers`), P26 (`packages/machine-setup`, `packages/tool-installer`), P27 (`packages/mcp-gateway`, `packages/mcp-services`), P28 (`packages/skills`, `skills/**`) and P29 (`apps/cli` high-level and setup/platform commands), plus agent system prompts and behavior policies under `agents/**`. P30 Runtime/Pane Manager/Conversation integration of these platform packages is implemented in source with local tests (`packages/runtime/src/platform/**`, host wiring in `packages/runtime/src/agentic/**`, Gateway control endpoint in `apps/cli`); scoped historical provider/Herdr probes are recorded separately and do not establish full SDLC acceptance. Platform coverage exists in package tests and E2E e11–e16; the dedicated P31 trees (`tests/platform-v3/**`, `tests/acceptance/platform-v3/**`) are absent. See [implementation status](docs/implementation-status.md) for the current source/evidence map.

Current post-P30 source also includes D-TOOLS-01 policy/grant/usage integration, optional integrated-tool defaults and `init --update`, GitNexus resource leases, polyglot runner detection, macOS workspace/Seatbelt backends, bounded repository survey context and actionable Conversation blockers. Do not rebuild these as missing scaffolds. Agy specialist native binding has source/local tests; Agy Conversation and unattended remain unsupported. Browser tool actions use Runtime-managed Gateway resource lease transactions per assignment attempt (source plus local tests, no live browser acceptance); owner `appChecks` add a sandboxed real-app UI/API gate (`host-app-<suite>`, Linux bwrap + Chrome). Keep full live workflow/fault acceptance separate from these source fixes.

Post-baseline upstream changes through the 2026-10-25 audit (including setup native-login diagnostics and narrowly verified stale native-intent recovery in `2357669`) add Runtime-private rework root-cause dossiers, per-finding IDs/evidence and reviewer verdict inputs; Conversation uses plain Vietnamese cards, session aliases (#n / Việc #k), read_updates and Log detail; skill references add verifiable NFRs and conditional risk-based test design. See [the commit audit](docs/main-updates-2026-10-25.md), [rework reference](docs/rework-causality.md) and [NFR guide](docs/nfr-and-test-design.md). Host/Runtime now require independent verdicts covering every rework finding of the current generation (pinned to revision/attempt/dossier) and settle per finding; a mandatory `host-test-integrity` gate requires Reviewer adjudication of test/config weakening with per-candidate owner exceptions, and downgrades fast-path under default host checks. Evidence level is source plus local tests. Structural guards do not prove reviewer judgment quality; instructions and local tests are not live acceptance.

The binary high-level parser differs from the legacy `HighLevelCliFacade`: standalone `mcp status` lacks a default live Gateway health port (machine setup/Runtime Gateway integration exists), `skills list`/`skills sync --list` are not accepted, and standalone `agent check` may run model probes without selecting repo-configured profiles/models. Document these command-level limits rather than claiming host readiness from them.

Bootstrap the built CLI once with `node apps/cli/dist/bin.js setup`, reload the managed shell PATH, then use `bflow`. `BFLOW_HOME` selects isolated setup/provider state; use `BFLOW_SOURCE` only as a documentation convenience for a source checkout path.

## Stable boundary

`packages/contracts/**`, root configuration, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`, and `docs/**` are shared and review-gated. An implementation agent must not change them to make its local implementation easier. Shared-documentation edits require the owning/integration review or explicit project-owner authorization. A public contract change requires an explicit integration decision documenting the motivation, affected agents, compatibility/migration plan, and approving owner.

The accepted hardening contracts and [ADR 0001](docs/adr/0001-p00-contract-hardening.md) supersede the original bootstrap at `8d960d0`. [ADR 0002](docs/adr/0002-p01-recovery-rework.md) adds the approved recovery receipts, aggregate checkpoint codec and bounded rework semantics. New branches must start from the latest approved integration baseline containing the required predecessor implementations and accepted contract amendments, not merely the old hardening commit. ADR 0003 (`docs/adr/0003-authenticated-herdr-receipts.md`), approved by the project owner, adds authenticated native-host binding receipts without rewriting submission handles and removes CLI release allowlists. Actual exported contracts are authoritative; no implementation owner may silently restore older method signatures or event shapes.

All exchanged data must be parsed at an ingress boundary with the exported Zod schema. Type assertions do not replace runtime validation. Implementations may define private internal models, but data that crosses a package boundary must use `@bflow/contracts`.

## Ownership for parallel implementation

### Wave 1 (P00–P10) Path Ownership

| Agent | Owned paths | Responsibility |
| --- | --- | --- |
| 1 — workflow core | `packages/core/**` | Task DAG evaluation, legal state transitions, scheduling decisions, recovery logic |
| 2 — agent integration | `packages/herdr-adapter/**`, `packages/agent-registry/**` | Verified Herdr integration and role-to-agent resolution |
| 3 — data | `packages/persistence/**`, `packages/artifact-store/**` | SQLite run/event/checkpoint persistence and local artifact storage |
| 4 — quality | `packages/quality-gates/**` | Quality-gate evaluators, findings, acceptance decisions |
| 5 — runtime and CLI | `packages/runtime/**`, `apps/cli/**` | Port composition, high-level use cases, command-line UX |

### Bflow Agentic SDLC v2 (P11–P19) Execution Waves & Path Ownership

The v2 implementation execution order is strictly staged across three waves with a mandatory integration synchronization gate:

- **Wave A (Sequential Prerequisite)**: `P11` — Architecture v2 & Contract Migration (`packages/contracts/**`, `AGENTS.md`, `docs/**`). Must complete, pass full validation, and freeze contracts before P12–P18 begin.
- **Wave B (Parallel Execution on 7 Independent Git Worktrees from P11 Baseline)**: `P12`, `P13`, `P14`, `P15`, `P16`, `P17`, `P18` run in parallel on separate worktrees branching from the P11 commit. No agent may modify shared contracts (`packages/contracts/**`).
- **Synchronization Point (Integration Gate)**: Sequential merge of `P12–P18`, running `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, and monorepo compatibility verification.
- **Wave C (Post-Integration Sequential)**: `P19` — Coordinator Agent & Runtime Integration. Must NOT be implemented before P12–P18 are integrated and verified.

| Phase | Wave | Name | Owned paths | Responsibility |
| --- | --- | --- | --- | --- |
| P11 | Wave A | Architecture v2 & Contract Migration | `packages/contracts/**`, `AGENTS.md`, `docs/**` | P00–P10 audit, v2 architecture, 17 v2 contracts, Herdr `RoleMessage` protocol, contract freeze |
| P12 | Wave B | Bflow CLI & Environment Lifecycle | `apps/cli/**` | `bflow init`, `bflow up`, `bflow down`, `bflow attach`, `bflow status`, `bflow doctor`; project-specific session, idempotency, error handling, cross-repo isolation |
| P13 | Wave B | Herdr Role & Pane Manager | `packages/pane-manager/**` | Herdr workspace/tab/pane/agent management, role-to-pane mapping, Conversation/Coordination/Verification tabs, permanent roles, dynamic Developer spawn with Git worktree + pane, lifecycle/resource limits, restart recovery, attach focus (no CLI or Workflow Engine here) |
| P14 | Wave B | Conversation Agent & Delegation Gateway | `packages/conversation/**`, `agents/chat/**` | Sole user interface, dialogue/clarification/status/approval handling, intent recognition & `DelegationRequest` creation, Herdr handoff to/from Coordinator, correlation ID management (no direct Developer dispatch, no code edits, no Coordinator logic here) |
| P15 | Wave B | Spec-Driven Development Engine | `packages/specification/**`, `agents/analyst/**`, `agents/architect/**` | Adaptive SDD based on specification & acceptance criteria, change classification (`trivial`, `standard`, `complex`), risk-proportional detail, versioning/approval, spec-to-task traceability, requirement change impact detection, design approval gates |
| P16 | Wave B | Conditional TDD Policy Engine | `packages/test-strategy/**` | `TestStrategyResolver`, `required` / `recommended` / `not_applicable` classification, Red-Green-Refactor evidence when `required`, mandatory alternative verification when `not_applicable` (strategy resolution only, not Verification Loop) |
| P17 | Wave B | Verification Loop Engine | `packages/verification/**`, `agents/verifier/**` | Task-level & post-Git workflow-level verification against spec/criteria/evidence, deterministic checks + Reviewer + QA, bounded rework loop (default max 3 iterations), `passed` / `failed` / `inconclusive` / `blocked` classification, escalation (not Git Integration Engine) |
| P18 | Wave B | Git Integration & Parallel Worktrees | `packages/git-orchestrator/**` | Git repo/branch/commit/worktree management, per-Developer task worktrees, changed-file scope checks, diff & change summary, dependency-ordered branch integration, controlled conflict handling, PR support, safe cleanup, post-integration workflow-level verification trigger |
| P19 | Wave C | Coordinator Agent & Runtime Integration | `packages/runtime/**`, `packages/core/**`, `agents/coordinator/**` | Coordinator Agent logic & full Workflow Runtime integration across P12–P18 (executed strictly after P12–P18 synchronization point) |

Agents must edit only owned paths. Cross-owner changes are proposed to the owning agent or handled during integration. Generated `dist/**`, coverage, local databases, artifacts, and agent logs are never committed.

## P24 platform v3 baseline and P25–P31 ownership

The project owner explicitly authorized P24's additive public contracts, shared architecture
documents, this ownership update and local baseline commit. The contract decision and
compatibility plan are D24-01 in [runtime architecture v3](docs/runtime-architecture-v3.md).
Also read [provider contracts](docs/provider-contracts.md), [shared MCP architecture](docs/shared-mcp-architecture.md)
and [skills architecture](docs/skills-architecture.md) before implementation.

Every implementation after P24 MUST branch from the exact P24 baseline commit reported in
its handoff, or a verified integration descendant retaining that commit. Do not use the old
P11 baseline or rebuild implemented P00–P23 functionality. Phase-number labels are not
evidence of implementation or acceptance; use the source audit and existing release reports.
P24 adds contracts/design only; P25–P31 modules are not implemented by this baseline.

Implementation status after the baseline (verified from source and `git log 8dbb056..HEAD`;
evidence level is source implementation plus package-local/local tests, not live provider,
Herdr transport or full SDLC acceptance):

- P25, P26, P27, P28: implemented as leaf packages (see ownership table); `skills/**` holds
  the canonical catalog. Package READMEs describe remaining integration work.
- P29: `apps/cli` provides `setup`, `repo inspect`, `task plan`, `task implement`, `verify`,
  `git prepare`, `mcp status`, `tool status`, `skills sync` and `agent check` in addition to the
  lifecycle commands. The CLI consumes `agent-providers` and `machine-setup`; `mcp status`/`tool status`/
  `skills sync` operate on machine-setup state and repository config. `up` now derives host
  platform options and gates on the Runtime host's per-role preflight report (no provider-name
  gate); P29 command acceptance still awaits P31 compatibility evidence.
- P30: implemented in source with local/fake-runner tests. `packages/runtime/src/platform/**`
  composes role environments, session skill manifests, Gateway registrations (via the
  authenticated control endpoint started by the setup Gateway daemon), provider preflight,
  launch profiles, Ed25519 startup attestations and activated health. The persistent host uses
  it for `prepare`/`activate`, dynamic Developer launches, `platform_status` and Gateway
  revocation on quiesce/shutdown; activation accepts `herdr:<provider>` sessions for any
  adapter-ready provider. Pane Manager launches from validated launch material. Non-Conversation
  roles route user decisions through `request_user_decision` → Runtime → Conversation; native
  `AskUserQuestion`/elicitation is denied. Historical live probes have their own recorded scope; they do not certify full workflow acceptance at HEAD.
- P31: dedicated test trees are NOT implemented. Cross-provider coverage exists in E2E e11–e16
  and package tests; historical provider/tool/Herdr reports have limited scope. Full platform-v3
  live workflow/fault acceptance remains open.
- Agent system prompts and behavior policies (`agents/**`) are implemented and covered by
  behavioral tests; they are not live-provider acceptance evidence.

| Phase | Owned paths | Responsibility |
| --- | --- | --- |
| P25 | `packages/agent-providers/**` | Claude Code, Codex, Agy discovery/auth/version/capability/permission probes, launch profiles and startup attestations; Herdr retains process ownership |
| P26 | `packages/machine-setup/**`, `packages/tool-installer/**` | Machine/repository/session setup plans, pinned tools, owned config and recoverable receipts |
| P27 | `packages/mcp-gateway/**`, `packages/mcp-services/**` | Shared tool connections, stdio bridges/client shims, scoped registration and exclusive resource leases |
| P28 | `packages/skills/**`, `skills/**` | Approved skill catalog, exact pins/dependencies, role manifests and provider-neutral rendering |
| P29 | `apps/cli/**` | Unified command UX using existing lifecycle and Runtime facade; no independent workflow engine/gates |
| P30 | `packages/runtime/**`, `packages/pane-manager/**`, `packages/conversation/**`, `agents/**` | Post-prerequisite integration of readiness, provider launch, skills, Gateway and Conversation decision routing into existing host |
| P31 | `tests/platform-v3/**`, `tests/acceptance/platform-v3/**` | Cross-provider conformance, security/fault/live acceptance evidence; findings return to production owners |

Execution gates: freeze P24 first; P25–P28 may implement in separate parallel worktrees
from P24. Integrator sequentially merges and runs dependency/type/full-test checks before
P30 wiring. P29 command UX may use frozen contracts concurrently, but cannot close before
the P30 Runtime facade is integrated and compatibility verified. P31 acceptance follows
P29/P30 integration. Shared paths/root build configuration/lockfile remain integration-owned;
leaf agents propose wiring rather than modifying another owner's package. Package READMEs
and package-local tests follow package ownership. P31 owns its new test config; wiring it
into root CI/test discovery is an integration change, not implicit permission to edit root config.

V3 invariants:

- Keep existing `AgentCapability`, RoleMessage v2, SessionManifest v2, event/checkpoint
  codecs, RuntimeService and QualityGate signatures compatible. New platform documents use
  strict version-3 schemas; nested value objects inherit the envelope version. Reject
  unknown versions, never cast old config/receipts into new proof.
- Provider adapters validate binary/version/auth/environment/MCP/launch arguments/permissions/
  skills and actual readiness. Herdr idle/done, installed CLI or a provider release label
  cannot establish readiness/task success. Require preflight before launch side effects and
  authenticated activated health before `up` success; preserve interrupted-startup receipts.
- Permission modes are `restricted`, `workspace_auto`, `unattended_isolated`. No machine-scope
  agent permission or global bypass. Unattended requires verified full-provider OS sandbox/
  container and session scope; worktrees/native hooks alone do not satisfy it. Report
  unsupported when the provider cannot enforce policy; never silently widen privileges.
- Machine setup, repo desired config and session/runtime state have distinct ownership and
  lifetimes. `up` verifies prerequisites; installation/global configuration requires an
  explicit setup plan/apply. Do not mutate user-global provider settings to avoid a task prompt.
- Gateway manages tool connections only; all inter-role messages still use Runtime/Herdr.
  Distinguish CLI-only tools, adopted workers, remote MCP, bridged stdio MCP and exclusive
  resources. Never stop an external worker during repo down or replay an uncertain mutation.
- Every role except Conversation must route user decisions through Runtime → Herdr →
  Conversation. Disable native direct questions/elicitation, retain exact human approval
  authority and waiting state. Unattended does not waive mandatory human gates.
- Skills are pinned instructions, not permission grants or executable install hooks. Preserve
  original role prompts and existing SDD/TDD/verification/lease/fence/human approval checks.
- New commands reuse existing Runtime and independent Quality Gates. Keep legacy Runtime
  storage/commands explicit; command acceptance is not workflow acceptance.

P24 does not close P22/live acceptance gaps, same-UID provider isolation, hosted governance,
P02-RA01 or P03-RA01. Keep source implementation, local tests, live transport/provider probes
and full SDLC acceptance as distinct evidence levels.

## Architecture v2 & P11–P19 Upgrade Rules

The v2 architectural specification is formally documented in [docs/architecture-v2.md](docs/architecture-v2.md), with protocol details in [docs/communication-protocol.md](docs/communication-protocol.md) and development policies in [docs/sdlc-policies.md](docs/sdlc-policies.md). All implementation agents must adhere to the following architectural rules:

### 1. Five-Component Responsibility Boundary

- **Conversation Agent**: Sole interface with the user (`bflow attach` attaches only to the Conversation Agent pane). Receives and interprets user intent, conducts clarification dialogues, and reports progress. Delegates to the Coordinator Agent via `DelegationRequest`. **NEVER** directly coordinates or dispatches to Developer or specialist roles, and **NEVER** mutates source code directly.
- **Coordinator Agent**: Acts as the technical lead. Analyzes requirements, determines the SDD level (`lightweight` vs. `full`), evaluates `TddDecision`, decomposes tasks into a DAG, and issues specialist assignments (`AgentAssignment`). Executes workflows **EXCLUSIVELY through Workflow Runtime**. **NEVER** bypasses system policies, quality gates, leases, loop limits, or human approvals.
- **Workflow Runtime**: The central execution arbiter. Manages task DAG dependencies, enforces concurrency limits (`maxConcurrency`), validates legal state transitions (`validateTaskTransition`), enforces lease validity and monotonic fencing tokens prior to transport dispatch, bounds retry/rework/verification loops (`maxIterations`), and calls independent acceptance gates.
- **Herdr**: The physical process and multi-pane orchestration platform. Operates dedicated terminal panes (`PaneBinding` inside `SessionManifest`) per active role, manages agent OS processes, and transports inter-agent interactions over protocol 22.
- **Artifact Store**: Content-addressable trusted store. Persists immutable documents (`Specification`), objective verification evidence (`patch`, `test-result`, logs) addressed via `artifact://` URIs and verified SHA-256/SHA-512 checksums. **NEVER** used as an ad-hoc polling/communication channel replacing Herdr.

### 2. Four Distinct State Domains

Agents and runtime components must strictly distinguish the four orthogonal state domains and never conflate them:
1. **`AgentTransportState`** (`starting | accepted | idle | working | blocked | done | unknown | disconnected | cancelled`): Physical Herdr transport observation. Herdr `done` only signifies turn completion and **NEVER proves task completion or success**.
2. **`SdlcWorkStatus`** (`intake | clarifying | specifying | planning | tdd_deciding | implementing | verifying | reviewing | awaiting_approval | completed | escalated | failed | cancelled`): Tracks high-level SDLC business phase governed by Workflow Engine and verified by Quality Gates, operating alongside Core task/run execution statuses (`TaskStatus` / `RunStatus`).
3. **`ConversationSessionStatus`** (`active | awaiting_user_clarification | delegated_to_coordinator | reporting_progress | awaiting_user_approval | completed | paused | closed | archived`): Lifecycle of user interaction with the Conversation Agent.
4. **`ApprovalStatus`** (`pending | approved | changes_requested | rejected | expired | cancelled | superseded`): Governance gates and human decision lifecycle.

### 3. Inter-Role Message Envelope

All cross-role communication across Herdr transport must use the standardized `RoleMessage` envelope specifying `message_id`, `correlation_id`, `causation_id?`, `run_id?`, `sender`, `recipient`, `type`, `payload`, `artifact_references`, and `schema_version`. See [docs/communication-protocol.md](docs/communication-protocol.md).

### 4. SDD, Conditional TDD, and Bounded Verification Loop

- **Spec-Driven Development (SDD)**: All feature development requires an accepted `Specification` (`lightweight` or `full`) containing explicit `AcceptanceCriterion` records before implementation begins.
- **Conditional TDD**: The Coordinator evaluates `TddDecision` and `TestStrategy`. When `TddDecision.mode` is `"required"` (`requiresFailingTestFirst: true`), the Developer agent must follow the Red-Green-Refactor sequence.
- **Bounded Verification Loop**: Automated verification cycles (`VerificationCycle`) are bounded by `maxIterations`. Each cycle produces `VerificationResult` and `GitChangeSet`. Exhausted iterations escalate to human intervention instead of looping indefinitely. See [docs/sdlc-policies.md](docs/sdlc-policies.md).

## Worktree and branch protocol

1. Inspect HEAD, working tree/index, worktrees, local/remote refs, ancestry and patch equivalence before selecting a baseline. Local `main` and `origin/main` need not match; verify predecessor fixes instead of comparing hashes alone. Agents in the same implementation wave use the same approved integration commit.
2. Create one branch and one Git worktree per agent from that baseline. Preserve uncommitted work and do not switch branches inside another agent's worktree.
3. Use branch names `agent/<area>/<short-task>`; scoped remediation and integration branches may use `fix/<area>/<task>` and `integration/<phase>-closure`. Keep implementation commits scoped to owned paths.
4. Reconcile with the approved integration baseline before handoff. Do not rewrite shared history, reset main or force-push. Integrators check for already-applied/equivalent patches, preserve the original implementation plus its fixes, and use a separate integration worktree when appropriate. Do not push, create PRs or merge remotely without the corresponding authorization.
5. Report contract mismatches instead of editing shared contracts. Include the exact method/type, failing use case, and proposed compatible change.
6. The integrator applies authorized shared-file changes, updates the lockfile when needed, and resolves cross-package wiring. Distinguish source implementation, audit PASS, local integration and remote closure; a feature-branch test run does not prove remote closure.

## Architectural constraints

- `core` must never import `herdr-adapter` or refer to Herdr wire details.
- Leaf implementation packages depend on `contracts`, not on each other.
- `runtime` composes implementations through contract interfaces. It must not expose concrete adapters to the CLI.
- Herdr commands, Socket events, authentication, reconnect behavior, and capability negotiation must be verified against an available Herdr version before implementation.
- Herdr compatibility is determined by the actual protocol/schema and required operation behavior, never an exact CLI release allowlist. Keep the release label as diagnostics only. Test the installed binary in an isolated named session; an untested version is not evidence of incompatibility and is not, by itself, a reason to stop testing or demand an upgrade. Compatibility tests must accept older/newer release labels with the same supported wire contract and reject actual incompatible/malformed responses. Distinguish transport compatibility from authenticated task-result evidence.
- Do not add no-op, in-memory, or always-success implementations merely to satisfy tests.
- Preserve idempotency keys, event ordering, optimistic versions, cancellation intent, and recovery cursors across boundaries.
- Never treat a transport timeout as proof that the remote agent stopped; reconcile before retrying.
- Never treat Herdr `done` as task success. Only a correlated, verified `AgentResult` may drive a conclusive business outcome.
- Persist `agent.execution_bound` before using a returned handle as recoverable state. `unknown_delivery` forbids automatic resend until reconciliation proves `not_delivered`.
- Apply exported transition, event-batch, and compatibility validators at ingress; do not duplicate or weaken their rules privately.
- A trusted `ArtifactReference` can only originate from `ArtifactStore`; agent and gate outputs are `ArtifactProposal` values.
- Registry resolution does not reserve capacity. Dispatch requires a current lease and fencing token from the implemented file-backed Registry; verify them immediately before the transport side effect. Do not claim distributed/network-filesystem guarantees.
- Core aggregate checkpoints retain approval/gate/cancellation/retry state and command outcomes. RunStore's maintained query projection is not a substitute for the aggregate checkpoint or authoritative event replay.
- Preserve P03's atomic event/receipt/projection writes, versioned checkpoint validation, owned-buffer ingest, nonblocking special-file rejection, consistent catalog observations, integrity checks and tombstones. SQLite, filesystem and transport are not one atomic transaction.

## Shared integration points

The module implementations already provide event/checkpoint persistence, compatibility parsing, migrations, artifact ingestion, leases and transport receipt/reconciliation handling. Remaining Runtime integration must compose them: persist dispatch intent before transport, persist execution bindings/receipts, retain unknown delivery through restart, check current leases/fencing, use Core aggregate recovery, ingest proposals into trusted references, and sequence quality/approval/rework decisions. Runtime must not treat terminal snapshots or stored artifacts alone as task-success evidence. New schema migrations/upcasters require explicit compatibility review; do not fabricate missing recovery state. Contract mismatches are reported to the integrator with a failing fixture and proposed migration instead of editing shared files.

## Environment and documentation maintenance

- Use Node >=22.13 for unflagged P03 `node:sqlite` (verified on 22.23.2) and the pnpm version pinned in `package.json`. Root `engines: >=22` is broader than P03's requirement. The verified storage/security test platform is Linux with local filesystems and POSIX fixtures.
- Read package manifests/scripts before running commands. Build before targeted subprocess/worker tests because they import `dist/`; rebuild after source changes, including during watch-mode development.
- Update user-facing module status, commands and limitations when an implementation is integrated. Update package READMEs within ownership; propose shared README/AGENTS/architecture/contract edits for review. Avoid permanent test-count or moving-branch-hash claims; report the exact tested commit and actual counts in handoff evidence.
- Do not equate fake-runner tests with live Herdr verification or advertise unsupported E2E/application commands. Do not upgrade power-loss, network-filesystem, multi-host or hostile same-user safety from NOT VERIFIED without evidence.
- P02-RA01 (large runner timeout overflow) and P03-RA01 (late final `get()` chunk after deadline/abort) remain open non-blocking P2 follow-ups. Their owners remain Herdr Adapter and ArtifactStore respectively; do not mark them fixed from documentation or transfer them to Runtime. See [known limitations](docs/known-limitations-v3.md) for details.

## Required validation before handoff

From the repository root run:

```bash
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
git status --short
```

`pnpm check` runs the dependency, typecheck and full-test checks together. Also run the targeted package tests documented in README when the owned implementation changes. Report exact commands, exit codes, pass/fail/skip counts, tested HEAD, ownership diff, migrations/generated files, unresolved assumptions and any requested contract decision. Generated output is not committed. An audit/review request does not authorize implementation, commits or external writes.
