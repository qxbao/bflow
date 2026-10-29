# Compact Tailwind UX — local validation

Implementation commit: `ef2e6d936bcf90a04f5d7fc5f3a3a7bfb6d06c04`.
Base: `2aa02d6b752e824804298d4b0469a3369882be2e`.
Branch: `agent/web/compact-tailwind-ux`. Date: 2026-10-29.
Environment: Linux, Node 24.16.0, pnpm 12.5.1, existing `/usr/bin/google-chrome`.

## Results

| Check | Observed result |
| --- | --- |
| `pnpm run build` during migration; final `pnpm --filter @bflow/web build` | Passed, production assets compiled with Tailwind 4.3.3 |
| `pnpm run typecheck` | Passed after implementation commit |
| `pnpm run check:deps` | Passed: acyclic package graph and package boundaries |
| `pnpm --filter @bflow/web test` | 13 files, 72 tests passed |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web test:e2e` | 10 passed, 1 explicitly skipped live-provider scenario |
| `git diff --check` | Passed |
| Independent code review | Three important findings fixed; rereview found no further important issue |

Browser checks use built production assets, real Local Server cookie/CSRF handling,
fixture Git repositories and deterministic host fixtures. The UX collection test
expands only its displayed run response through a test-local browser route to
exercise 25-item cursor pages. There is no production mock mode or API change.
Checks cover initial skeleton, cursor next/previous/history/deep link, mobile menu
and route focus, no viewport overflow, 375/768/1280/1440px, 812×375 landscape,
16px mobile inputs, 44px mobile controls, CSS zoom 200%, reduced motion, settings
anchors, real configuration save/commit, chat recovery, competing decisions and
inert artifacts. A configuration test additionally checks 16px mobile YAML text.

Screenshots were inspected for desktop project management and mobile run detail;
UX screenshots also cover the run list, settings and desktop run detail. Images
remain ignored in `apps/web/dist/test-results/`; generated output/logs are not
committed. A phantom gray grid area on single-project desktop views was corrected
with auto-fit tracks.

## Review fixes and behavior evidence

- Review drafts survive browser Back/Forward and snapshot page movement in memory,
  keyed by run/decision and retaining the exact reviewed snapshot. Changed revision,
  expiry, freshness and live reread still gate submission; no draft grants authority.
- Failed reads are recorded per run while same-run reads are deduplicated, so one
  inaccessible run does not disable unrelated authorized packages.
- Mobile/landscape form sizing changes to desktop density at 1024px; YAML follows
  the same sizing rule. Confirmation dismissal restores focus to its trigger.
- Tests exercise draft history plus changed-version blocking, partial failure,
  background read focus/draft retention, local page clamping and filter-preserving
  retry. New tests initially exposed missing navigation/pagination behavior; history
  draft coverage failed before the review fix. One malformed partial-failure test
  fixture was corrected to satisfy decisionId/approvalId identity validation.

## Broad-suite limitation

`pnpm test:affected --base 2aa02d6` selects `full` because the approved Tailwind
installation changes the root lockfile (including Vite optional peer resolution).
A broad `pnpm test` attempt encountered failures outside `apps/web`. It was stopped
with SIGINT after collecting these failures; it did not complete and has no full
passing result. These packages were not modified to accommodate this UI work.

The Codex hook trust failure was independently reproduced on unchanged baseline
`2aa02d6`: `pnpm exec vitest run packages/agent-providers/test/codex-hook-trust.test.ts
--maxWorkers 2 --minWorkers 1` produced 27 failed / 7 passed. The guard reports an
unsafe approval-state ancestor at `/home/baodq/.local/share/ai-isolator`. No ancestor
permissions, trust policy or provider settings were changed. Other broad-suite
assertion/timing failures below were observed under the concurrent broad run and
have not each been independently reproduced on baseline; no blanket attribution
or full-repository acceptance is claimed.

Observed failing suite summaries before interruption:

| Suite | Failed / total |
| --- | --- |
| `packages/agent-providers/test/agent-providers.test.ts` | 6 / 147 |
| `packages/runtime/test/agentic/conversation-host-rpc.test.ts` | 1 / 9 |
| `packages/runtime/test/agentic/host.test.ts` | 1 / 34 |
| `packages/artifact-store/test/artifact-store.test.ts` | 1 / 76 |
| `packages/runtime/test/agentic/az-acceptance.test.ts` | 1 / 13 |
| `packages/agent-providers/test/codex-hook-trust.test.ts` | 27 / 34 |
| `packages/runtime/test/agentic/integration-host-notices.test.ts` | 1 / 38 |
| `apps/cli/test/iso-engine.test.ts` | 1 / 14 |
| `packages/runtime/test/agentic/polyglot-core.test.ts` | 1 / 24 |
| `packages/agent-providers/test/codex-probe-coalescing.test.ts` | 1 / 52 |
| `packages/runtime/test/agentic/developer-process-scope.test.ts` | 1 / 11 |
| `packages/runtime/test/agentic/integration-p19-conflicts-reviews.test.ts` | 6 / 14 |
| `apps/cli/test/iso-compat.test.ts` | 2 / 9 |
| `apps/cli/test/host-recovery.test.ts` | 1 / 10 |
| `apps/cli/test/codex-hook-setup.test.ts` | 19 / 22 |
| `packages/agent-providers/test/profile-environment.test.ts` | 1 / 8 |
| `packages/runtime/test/agentic/behavioral-runner-output.test.ts` | 1 / 24 |
| `packages/runtime/test/agentic/integration-p19-workflow.test.ts` | 2 / 31 |
| `packages/agent-providers/test/codex-compatibility.test.ts` | 9 / 26 |

Root Vitest omits the web TSX suite, so web checks were run separately with the
package configs. One web initial-load assertion exceeded its default deadline
while the heavy root run was active; a limited-worker rerun passed, followed by a
successful ordinary package test run. Browser tests were updated to open the new
mobile disclosure and scope the YAML validation assertion to its configuration
section; the original assertions about missing fields and security remain.

Source/local browser evidence does not establish live Herdr/provider/full SDLC
acceptance. The explicit live workflow scenario remains skipped. No remote push,
PR or integration was performed; the branch/worktree is preserved for integration.
