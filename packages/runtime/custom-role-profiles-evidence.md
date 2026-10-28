# Custom specialist profiles — implementation evidence

Date: 2026-10-28. Owner approved RP-01, RP-AC01–10, required TDD and cross-owner integration (approval recorded by the project owner in the authoring session; reviewers should confirm it on the PR). This file supersedes the earlier proposal-only handoff. No commit, push or PR is authorized or performed.

## Workspace and baseline

- Integration worktree: a private integration worktree.
- Branch: `agent/runtime/custom-role-profiles`.
- Tested HEAD/baseline: `e73dca70cb91bdd53fbe1fe9dfb69ccba8b6f8ff`; implementation is an **uncommitted diff**, including untracked source/tests.
- Baseline contains P24 `8dbb056`. At original inspection cached `origin/main` and `origin/duc` matched HEAD; local `main` was behind. No fetch, remote mutation or history rewrite.
- Original checkout the original checkout preserved. Leaf patches were imported from isolated worktrees; integration fixes use separate platform/tool worktrees and delta patches.
- Node v22.17.1, pnpm 12.5.1, macOS. Orca CLI was unavailable at initial creation (`Unable to determine Orca.app path from symlink: /usr/local/bin/orca`), so the existing Git-worktree fallback was retained.
- macOS canonical temp root `/private/tmp` is required by tests that intentionally reject symlinked ancestors. `/var` is a symlink on this host. Use `TMPDIR=/private/tmp` for the final suite; do not weaken those production checks.

## Implementation and acceptance mapping

| Criteria | Actual source/evidence |
| --- | --- |
| RP-AC01/02 | Strict v3 profile documents and exact pins; fixed governance role enum; direct specialist inheritance only. CLI safe bounded local catalog loading; real Runtime workflow admission/allocation/dispatch tests. |
| RP-AC03/04 | Shared pure narrowing resolver; actual task ownership/native edit authorization; profile grants and capabilities intersect existing authority; exact skills and requiredness retained; original prompt prefix preserved. Unsupported process-tree restrictions fail before launch. |
| RP-AC05/06 | Dispatch and settle compare native executor/session and implementation history, including conflict resolvers. Profile aliases never confer review independence. Governance envelopes, approvals, required TDD and quality gates retain standard roles. |
| RP-AC07 | Typed pins join task/assignment/outbound/pane/manifest/environment/launch intent and attested material. Dedicated pane labels and audit envelopes carry profile plus governance role; existing content-addressed artifact bytes are not rewritten. |
| RP-AC08/09 | Immutable normalized snapshots, raw source watches/EP-01 drift gate, strict recovery pin/lineage joins, current policy/skill approval revalidation. Profile authority promotes the private agentic journal to v7; older binaries reject it. Unprofiled v1–v6 remain readable. |
| RP-AC10 | Preview and execution share policy resolution/provenance; automatic role defaults persist with acceptance. Recheck after awaited preflight, worktree preparation, skill checks and before mediated effects/dispatch. |

## Review and regression evidence

Independent reviewer inspected contracts, CLI, Runtime scheduler/outbox/workspace/tool paths, platform/skills/provider wiring and Pane Manager. Five important findings were reproduced and addressed: base tool-grant leakage from specialist launches; automatic QA/default pin bypass; drift during awaits; premature specialist pane destruction on transport completion; and model/effort defaults incorrectly treated as policy locks.

Root RED logs are under local RED logs that are not part of the repository. They record base-reviewer fallback, missing private feature version, forbidden effects after preparation, removed accepted pin/lineage being accepted, and pane cleanup before a result. The awaited-skill RED run was captured in the original transcript; `/tmp/bflow-role-profiles-review-tests.log` now contains the later GREEN rerun. Workers also recorded RED→GREEN for ingress, scope, exact skill/tool grants, launch joins, preference locks and actual host tool routing. Integrated smoke after the tool/preferences deltas: 133 tests in 4 suites passed, including the real Vitest reporter/runner tests. A linked dependency layout in the tool worker caused reporter sandbox-path failures there; the same integrated suite passed with the native installed dependency layout. No reporter rule was weakened.

Targeted Runtime integration after the root fixes: **40 tests in 3 files passed**, including 21 RP-01 tests plus existing conflict/review/replacement compatibility. Tests use real Git worktrees, SQLite/File Registry/ArtifactStore and fake transport/provider boundaries; they do not certify live Herdr or model judgment.

## Validation

Final integrated commands and results on the final diff:

- `pnpm run build` (`tsc -b`): PASS (exit 0).
- `pnpm run typecheck` (`tsc -b --pretty false`): PASS (exit 0).
- `pnpm check:deps`: PASS (Workspace dependency graph is acyclic: 22 packages, 49 internal edges; leaf package dependency boundaries and non-escaping relative import rules verified).
- `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit`: PASS (exit 0).
- `git diff --check`: PASS (0 errors).
- Final unit suite (`TMPDIR=/private/tmp pnpm test`): **328 passed, 15 skipped (343 test files)**; **5522 passed, 447 skipped (5969 tests)** in 354.62s.
- Targeted RP-01 tests:
  - `custom-role-profiles.test.ts` (correlated settlement: result, queued cancellation, stopped cancellation, idle cancellation, unconfirmed cancellation): 5 passed | 20 skipped.
  - `role-profiles.test.ts` (platform custom role profile policy & preferences): 16 passed.
  - `rtk-authorization.test.ts` + `host-platform.test.ts`: 77 passed (RTK probe/formatter authorization hook revalidating generation, grants, and await drift).
- E2E scenario suite (`TMPDIR=/private/tmp pnpm test:e2e`): **14 passed, 2 skipped (16 test files)**; **79 passed, 12 skipped (91 tests)** in 24.83s.

Historical intermediate results:

- Initial full unit run: 322 files passed, 5 failed, 15 skipped; 5474 tests passed, 12 failed, 447 skipped. This run overlapped additions of two deliberate RED regressions; ten other failures were macOS `/var` ancestor checks. The four affected environment suites (12 tests) all pass with canonical `TMPDIR=/private/tmp`.
- Affected selection at the baseline: package scope because GitNexus index was unavailable (`commit_mismatch`); no tests skipped for missing index.

## Limits and integration rulings

1. Model/effort preferences override unlocked base defaults, constrained by real exact pack locks. A different-provider preference is explicitly unsupported: the role's native login selector, Gateway grants and provider-specific ingress remain bound to its configured template. No silent fallback or credential/provider switch occurs. Cost if a project needs switching: configure a compatible template or implement a separately reviewed provider-switch path.
2. Whole-process read/deny restrictions, remaining network host allowlists and unmediated writable subtrees are unsupported where a backend cannot enforce them. Agy host-mediated write narrowing and true read-only permissions retain existing backend guarantees. Profile-scoped Developer feedback subprocesses are blocked without whole-process write enforcement; independent owner verification uses its own policy. This favors a visible blocker over widened authority.
3. Recovery preserves immutable profile identity and rejects corruption/drift. It retains the baseline daemon lifecycle that revokes previous launch authority; snapshots do not recreate tokens, prove native stop or authorize automatic resend. A retired launch requires fresh startup/reconciliation.
4. Private journal v7 is the approved RP-01 feature marker, not a public envelope-version change. No root configuration, lockfile, shared README/AGENTS, Core event/checkpoint codec or storage migration is changed.
5. No live provider/Herdr/full SDLC acceptance, hostile same-UID containment, multi-host filesystem guarantee or resolution of P02-RA01/P03-RA01 is claimed.

No commits, push, PR, remote merge, publication or external messages were performed. Generated dist and local logs remain ignored/outside deliverable source.
