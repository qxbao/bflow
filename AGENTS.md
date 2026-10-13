# Multi-agent collaboration rules

This repository is designed for five implementation agents working in isolated Git worktrees. These rules apply to every agent and nested directory unless a more specific `AGENTS.md` is introduced later.

## Stable boundary

`packages/contracts/**`, root configuration, `pnpm-lock.yaml`, `AGENTS.md`, and `docs/**` are shared and review-gated. An implementation agent must not change them to make its local implementation easier. A public contract change requires an explicit integration decision documenting the motivation, affected agents, compatibility/migration plan, and approving owner.

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

1. Create one branch and one Git worktree per agent from the same integration commit.
2. Use branch names `agent/<area>/<short-task>` and keep commits scoped to the owned paths.
3. Rebase or merge the integration branch before handoff; do not force-push shared branches.
4. Report contract mismatches instead of editing shared contracts. Include the exact method/type, failing use case, and proposed compatible change.
5. The integrator applies shared-file changes, updates the lockfile, and resolves cross-package wiring.

## Architectural constraints

- `core` must never import `herdr-adapter` or refer to Herdr wire details.
- Leaf implementation packages depend on `contracts`, not on each other.
- `runtime` composes implementations through contract interfaces. It must not expose concrete adapters to the CLI.
- Herdr commands, Socket events, authentication, reconnect behavior, and capability negotiation must be verified against an available Herdr version before implementation.
- Do not add no-op, in-memory, or always-success implementations merely to satisfy tests.
- Preserve idempotency keys, event ordering, optimistic versions, cancellation intent, and recovery cursors across boundaries.
- Never treat a transport timeout as proof that the remote agent stopped; reconcile before retrying.

## Required validation before handoff

From the repository root run:

```bash
pnpm check:deps
pnpm typecheck
pnpm test
```

Report the exact commands and results, migrations or generated files, unresolved assumptions, and any requested contract decision.
