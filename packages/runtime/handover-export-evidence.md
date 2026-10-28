# Handover export (HX-01) evidence

Evidence level: source implementation plus local tests. Not live provider/Herdr, not full SDLC acceptance.

- Date: 2026-10-28. Tested HEAD/baseline: `ae866899dff673f0917e80efe4293c5db0b4e43d` plus the uncommitted worktree diff
  (no commits). `main` = `origin/main`; P24 `8dbb056` is an ancestor.
- Worktree `/mnt/01DCE9A4D6522BD0/Project/AI/wt-handover-export`, branch `agent/runtime/handover-export`. Node v24.16.0, pnpm 12.5.1.
- Ownership: `packages/runtime/**`, `apps/cli/**` (including `apps/cli/docs/**`). No `packages/contracts`, root config,
  lockfile, root README/AGENTS/`docs/**` edits. No migration. `apps/cli/docs/command-reference.json` regenerated from the specs.
- Conditional TDD: required. `test/handover/handover-export.test.ts` was written first and failed (module absent) before
  implementation. The CLI binary test was written after CLI wiring (the commands did not exist on the baseline).

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Acyclic, leaf boundaries and relative-import rules verified. |
| `pnpm typecheck` | 0 | Passed. |
| `pnpm exec vitest run packages/runtime/test/handover apps/cli/test/handover-binary.test.ts` | 0 | 2 files, 11 passed. |
| `pnpm test:affected --base main --run` | 1 | Scope `package` (GitNexus index `commit_mismatch` → widened to `apps/cli`, `packages/runtime`); 240 files: 3 failed / 233 passed / 4 skipped; tests 5 failed / 3804 passed / 72 skipped; 498.97 s. |
| Rerun alone: `integration-p19-conflicts-reviews`, `az-acceptance`, `host` test files | 1 | 60 passed, 1 failed: only `host.test` provider-readiness case (pre-existing: real `codex` in PATH). |

The affected-run failures were 3 `integration-p19-conflicts-reviews` cases (30 s timeout / escalation under suite load),
`az-acceptance` resume budget (timing-flaky) and `host.test` (pre-existing); the first two files pass in isolation. E2E
was not selected (0 files). Full `pnpm test`/`pnpm test:e2e` were not run.

## Follow-up: evidence packaging, publication lock/cleanup/replace, exporter version, source safety

- Date 2026-10-28, same baseline `ae866899dff673f0917e80efe4293c5db0b4e43d` plus the uncommitted diff. Local `main` has since
  moved to `157add3` (PR #60, analysis-only workflow); its overlap with this diff (`packages/runtime/src/index.ts`,
  `packages/runtime/README.md`) three-way merges without conflict and adds no export-name collision. Not rebased (no commits).
- TDD: 5 new Runtime tests and the CLI additions were written first and failed (7 failing) before implementation.
- Contracts promotion was reconsidered and deferred (see the design decision); no shared file changed.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Passed. |
| `pnpm typecheck` | 0 | Passed (rerun after the last source edit). |
| `pnpm exec vitest run packages/runtime/test/handover apps/cli/test/handover-binary.test.ts apps/cli/test/high-level/units.test.ts` | 0 | 3 files, 29 passed. |
| `pnpm test:affected --base main --run` | 1 | Scope `package` (GitNexus `commit_mismatch`; widened to `apps/cli`, `packages/runtime`); 240 files: 14 failed / 222 passed / 4 skipped; tests 21 failed / 3793 passed / 72 skipped; 861.83 s. 20 of the failures are timeouts; the machine ran `clamscan -r /` concurrently (load average ≈ 15–18). |
| Rerun of the 14 failed files together | 1 | 14 failed / 238 passed / 1 skipped (still under the same load). |
| Each failed file alone, sequentially | — | 13 files pass; only `host.test.ts` fails its pre-existing provider-readiness case (real `codex` in PATH). |
| `git diff --check` | 0 | Passed. |

E2E was not selected. Full `pnpm test`/`pnpm test:e2e` were not run.

## Rebase onto main `7b158c4`

The uncommitted work was stashed, the branch fast-forwarded from `ae86689` to `7b158c4` (PR #60–#62: analysis-only and
QA-only workflows, agent guidance) and the work re-applied without conflicts or export-name collisions. On `7b158c4` plus
this diff: `pnpm check:deps` exit 0, `pnpm typecheck` exit 0, `git diff --check` exit 0. The affected-test run on this HEAD
was stopped at the owner's request before completion; CI is the regression check for the merged state.
