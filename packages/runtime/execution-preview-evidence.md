# Preview preparation evidence

This records design/source reconnaissance and unchanged-baseline tests, not an implemented preview or live-provider/full SDLC acceptance.

- Date: 2026-10-27.
- Baseline/tested HEAD: `85753125982cf8d4df33916abf3f0dde4fa64d8a`.
- `main` and `origin/main`: zero commits on either side; `git cherry origin/main main` empty; P24 `8dbb056` is an ancestor (exit 0).
- Original checkout working tree/index: clean before reconnaissance. Existing worktrees on `fix/runtime/execution-preview` and `duc` were preserved.
- New branch/worktree: `agent/runtime/execution-preview-design`, `/tmp/bflow-execution-preview-8575312`.
- Node `v24.16.0`, pnpm `12.5.1`.
- Only owned additions: `packages/runtime/execution-preview-design.md` and this evidence file. No product implementation, contract, root config, shared documentation, lockfile or migration edits. No commits, pushes, PRs or external service writes.
- Builds may refresh ignored `dist`/TypeScript incremental outputs in the original checkout. These are not committed.

Commands below ran from the original repository root against the unchanged baseline, which already had installed workspace dependencies. The new worktree contains only the proposal documents and was not used to claim tested implementation.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Acyclic graph; leaf boundaries verified. |
| `pnpm typecheck` | 0 | Passed. |
| `pnpm exec vitest run apps/cli/test/platform-options.test.ts apps/cli/test/parser.test.ts apps/cli/test/high-level-parser.test.ts packages/runtime/test/platform/skills-session.test.ts packages/runtime/test/agentic/fast-path.test.ts` | 0 | 5 files passed; 208 passed, 0 failed, 0 skipped. |
| `pnpm test` | 1 | 21 files failed, 278 passed, 7 skipped (306). Tests: 85 failed, 5547 passed, 80 skipped (5712). Duration 1075.42s. |
| `git diff --check` | 0 | Original checkout clean. |
| `git status --short` | 0 | Original checkout empty output. |
| `git diff --no-index --check /dev/null packages/runtime/execution-preview-design.md` (new worktree) | 0 | New design whitespace valid. |
| `git status --short` (new worktree) | 0 | Only the two owned untracked proposal documents. |

Logs are local: `/tmp/bflow-preview-check-deps.log`, `/tmp/bflow-preview-typecheck.log`, `/tmp/bflow-preview-targeted-baseline.log`, `/tmp/bflow-preview-baseline-tests.log`.

Pending: owner acceptance of Specification/Conditional TDD, EP-01 contract/pack decision, and custom-skill ownership scope. No compatibility or security guarantee for the requested feature is established before implementation and its tests. Current code's custom-catalog rejection and absent pack semantics are described in the proposal, not repaired by these documents.

## Final integration validation (2026-10-27)

Implementation source and tests in this worktree; no commits. HEAD/baseline `85753125982cf8d4df33916abf3f0dde4fa64d8a`. Evidence level: source plus local tests only, not live-provider/Herdr or full SDLC acceptance.

Late fixes: policy provenance (`policy.explanations`, additive EP-01 reason `accepted_workflow_gates`), global help lists `task preview`, and host execution resolution checks a role-fallback config against its on-disk `sourceConfig` (previously `up` with fallback roles was rejected as configuration drift).

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Passed. |
| `pnpm typecheck` | 0 | Passed. |
| Targeted vitest (27 files: contracts/runtime/skills preview, binding, revalidation, CLI preview/binary/custom/accepted, parser, friendly-output, host-recovery) | 0 | 485 passed, 0 failed, 0 skipped. |
| `pnpm test` | 1 | Files 7 failed / 303 passed / 6 skipped; tests 8 failed / 5694 passed / 75 skipped (baseline: 85 failed / 5547 passed / 80 skipped). |
| `git diff --check` | 0 | Clean. |

Remaining full-suite failures: 2 agent-providers/setup tests also in the baseline list; `host.test` provider-readiness case fails on clean `main` too (`codex` in PATH); `runner-detection` real-repository case requires committed runner definitions (dirty worktree); `execution-preview-custom`, `integration` (2) and `lifecycle-fault-matrix` hit the 30 s timeout under full-suite load; rerun in isolation `pnpm exec vitest run apps/cli/test/execution-preview-custom.test.ts packages/runtime/test/agentic/integration.test.ts packages/runtime/test/agentic/lifecycle-fault-matrix.test.ts` exit 0, 159 passed, 0 failed, 0 skipped.
