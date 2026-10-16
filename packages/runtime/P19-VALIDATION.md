# P19 integration evidence — 2026-10-16

Source implementation tested: `a44d2a1c414842a77f652af767ac97323a6b85a1`.
Approved Wave B baseline: `9de64924790bd4bfab7ee7fc6388e8463eb149f0`.
Branch: `agent/runtime/p19-coordinator`; implementation worktree: `/tmp/bflow-p19-runtime`.
Node: 24.16.0; pnpm: pinned 12.5.1; Linux, local filesystems.

This is source implementation and local composition evidence. Live Herdr delivery
closure and remote merge/publication are not established.

## Commands and outcomes

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Isolated worktree install after the P14 manifest correction |
| `pnpm build` | 0 | All packages built; subprocess/worker tests use built `dist` |
| `pnpm check:deps` | 0 | 15 packages, 22 internal edges; no dependency cycle/boundary violation |
| `pnpm typecheck` | 0 | Full monorepo TypeScript build |
| `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test packages/core/test` | 0 | 213 passed at the preceding tree; the later retry regression adds one test |
| `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts apps/cli/test/environment.test.ts --maxWorkers=2 --minWorkers=1` | 0 | 60 passed: 21 P19 integration cases and 39 existing CLI lifecycle cases |
| `TMPDIR=/tmp pnpm test` | 1 | 1,194 passed, 1 skipped, 1 deadline-sensitive existing CLI shutdown test failed under default parallel load |
| `TMPDIR=/tmp pnpm test --maxWorkers=2 --minWorkers=1` | 0 | Complete monorepo: 52 files passed, 1 file skipped; 1,195 tests passed, 1 skipped |
| `TMPDIR=/tmp pnpm test:e2e --maxWorkers=2 --minWorkers=1` | 1 | Existing supplemental E2E: 61 passed, 2 failed; both failures in E09 CLI |
| Baseline: `TMPDIR=/tmp pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/scenarios/e09-cli.e2e.test.ts --maxWorkers=2 --minWorkers=1` | 1 | At unchanged `9de6492`: the same 2 E09 cases failed, 5 passed |
| `git diff --check` and staged diff check | 0 | No whitespace errors |
| `git status --short` after source commit | 0 | Clean worktree |

The initial baseline `pnpm check` failed one ArtifactStore Unix-socket fixture due
to the environment's long default temp path. `TMPDIR=/tmp pnpm check` passed the
baseline: 1,174 passed, 1 skipped. The filesystem platform/fixture was not weakened.

The E09 failures expect `bflow init` in a non-Git empty directory to create the
legacy `.bflow/config.json`, and expect legacy `status -j` errors in that setup.
P12 now requires repository identity and initializes `.bflow/config.yaml`. No E09
fixture was rewritten to conceal those baseline compatibility discrepancies.

## What was exercised

Actual Core, FileAgentRegistry, SQLite RunStore, filesystem ArtifactStore, P15
SpecificationEngine, P16 TestStrategyResolver, P17 VerificationEngine and P18
GitIntegrationEngine were composed over real temporary Git repositories. Physical
pane behavior and Herdr transport were fake; independent runner results were
injected by the test host. Those tests establish neither live model behavior nor
physical reviewer identity/isolation.

Cases include dialogue without a workflow, a short route without Architect,
complex design approval/rejection, two parallel Developers with distinct leased
panes/worktrees, required TDD and alternative evidence, scoped Reviewer repair,
verification exhaustion, real merge conflicts, complete post-integration diff and
workflow verification, busy Conversation/outbox restart, actual P14 busy inbound
queue composition, nonblocking Coordinator tools and remote Reviewer reply flow,
unknown delivery and exact-request resend only after proven non-delivery,
project-required task approval, forged-result refusal, cancellation, writer-stop
reconciliation before retry, and SQLite append failure recovery without rerunning
verification checks.

## Ownership, storage and compatibility

Implementation: `packages/runtime/**`, the opt-in bounded gate retry extension in
`packages/core/src/workflow-engine.ts`, and `agents/coordinator/**`.

Integration packaging correction: P14 already imports Zod directly but omitted it
from its package manifest. Only `packages/conversation/package.json` and its
`pnpm-lock.yaml` importer were corrected. No P14 source behavior changed.

No exported contract, shared root configuration, shared README/AGENTS or `docs/**`
file changed. No schema migration/upcaster was added. P19's new private journal is
version 1; it is not a replacement for the Core aggregate codec or SQLite event
history. No generated `dist`, coverage, database, artifact or agent log is committed.
Existing P02-RA01/P03-RA01 remain with their owners and are not claimed fixed.

The new workspace API needs a trusted native agent host to register prompts/tools,
provide authenticated structured Herdr ingress and independent runner identities,
and manage its inbound/scheduler/lifecycle pumps. `bflow up` does not auto-install
that host. Interrupted P17 execution before outcome application and ambiguous
Registry/journal mutation receipts require host reconciliation, never assumed
success or automatic redispatch. Protected merges, production deployment, secret/
access changes and destructive data operations are not enabled by these tools.

## Actual Herdr preflight

Read-only local observations:

- `herdr --version`: `herdr 0.9.0`.
- `herdr api schema --json`: bundled protocol 22, schema 1.
- `herdr status server`: no running server.
- Actual `createHerdrAdapter().initialize(...)`: `ok: false`,
  `error.code: unsupported_version`, message `Herdr herdr 0.9.0 has not been verified`.

Adapter implementation additionally emits only unverified terminal snapshots from
`read()`, and submission handles have orchestrator-generated, unverified
correlation. Core refuses a successful result on that binding. The P19 regression
fixture deliberately supplies that actual handle shape and proves refusal.

No Herdr binary was upgraded, no user session was started/changed, and no live
Herdr E2E success is claimed. The concrete proposal for the missing receipt boundary
is in [P19-RECEIPT-DECISION-PROPOSAL.md](P19-RECEIPT-DECISION-PROPOSAL.md).
