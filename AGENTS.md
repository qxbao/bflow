# Multi-agent collaboration rules

This repository is designed for five implementation agents working in isolated Git worktrees. These rules apply to every agent and nested directory unless a more specific `AGENTS.md` is introduced later.

## Current implementation context

Contracts, the deterministic Core workflow engine, Herdr CLI adapter, file-backed Agent Registry, SQLite RunStore, filesystem ArtifactStore, Quality-gates, RuntimeService and CLI (`bflow`) are implemented. Do not replace implemented modules with bootstrap scaffolds or claim live Herdr end-to-end verification without evidence. See [README.md](README.md) for package status and runnable commands, and package READMEs for guarantees and limitations.

## Stable boundary

`packages/contracts/**`, root configuration, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`, and `docs/**` are shared and review-gated. An implementation agent must not change them to make its local implementation easier. Shared-documentation edits require the owning/integration review or explicit project-owner authorization. A public contract change requires an explicit integration decision documenting the motivation, affected agents, compatibility/migration plan, and approving owner.

The accepted hardening contracts and [ADR 0001](docs/adr/0001-p00-contract-hardening.md) supersede the original bootstrap at `8d960d0`. [ADR 0002](docs/adr/0002-p01-recovery-rework.md) adds the approved recovery receipts, aggregate checkpoint codec and bounded rework semantics. New branches must start from the latest approved integration baseline containing the required predecessor implementations and accepted contract amendments, not merely the old hardening commit. Actual exported contracts are authoritative; no implementation owner may silently restore older method signatures or event shapes.

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
- P02-RA01 (large runner timeout overflow) and P03-RA01 (late final `get()` chunk after deadline/abort) remain open non-blocking P2 follow-ups. Their owners remain Herdr Adapter and ArtifactStore respectively; do not mark them fixed from documentation or transfer them to Runtime. See README for details.

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
