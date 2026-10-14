# Multi-agent collaboration rules

This repository is designed for five implementation agents working in isolated Git worktrees. These rules apply to every agent and nested directory unless a more specific `AGENTS.md` is introduced later.

## Current implementation context

Contracts, the deterministic Core workflow engine, Herdr CLI adapter, file-backed Agent Registry, SQLite RunStore and filesystem ArtifactStore are implemented. Quality-gates, Runtime and CLI currently expose types only; there are no quality evaluators, RuntimeService composition or executable application commands yet. Do not replace implemented modules with bootstrap scaffolds or claim an end-to-end workflow is available. See [README.md](README.md) for module status and runnable commands, and package READMEs for guarantees and limitations.

## Stable boundary

`packages/contracts/**`, root configuration, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`, and `docs/**` are shared and review-gated. An implementation agent must not change them to make its local implementation easier. Shared-documentation edits require the owning/integration review or explicit project-owner authorization. A public contract change requires an explicit integration decision documenting the motivation, affected agents, compatibility/migration plan, and approving owner.

The accepted hardening contracts and [ADR 0001](docs/adr/0001-p00-contract-hardening.md) supersede the original bootstrap at `8d960d0`. [ADR 0002](docs/adr/0002-p01-recovery-rework.md) adds the approved recovery receipts, aggregate checkpoint codec and bounded rework semantics. New branches must start from the latest approved integration baseline containing the required predecessor implementations and accepted contract amendments, not merely the old hardening commit. Actual exported contracts are authoritative; no implementation owner may silently restore older method signatures or event shapes.

All exchanged data must be parsed at an ingress boundary with the exported Zod schema. Type assertions do not replace runtime validation. Implementations may define private internal models, but data that crosses a package boundary must use `@ai-flow/contracts`.

## Ownership for parallel implementation

| Agent | Owned paths | Responsibility |
| --- | --- | --- |
| 1 — workflow core | `packages/core/**` | Task DAG evaluation, legal state transitions, scheduling decisions, recovery logic |
| 2 — agent integration | `packages/herdr-adapter/**`, `packages/agent-registry/**` | Verified Herdr integration and role-to-agent resolution |
| 3 — data | `packages/persistence/**`, `packages/artifact-store/**` | SQLite run/event/checkpoint persistence and local artifact storage |
| 4 — quality | `packages/quality-gates/**` | Quality-gate evaluators, findings, acceptance decisions |
| 5 — runtime and CLI | `packages/runtime/**`, `apps/cli/**` | Port composition, high-level use cases, command-line UX |

Agents must edit only owned paths. Cross-owner changes are proposed to the owning agent or handled during integration. Generated `dist/**`, coverage, local databases, artifacts, and agent logs are never committed.

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
