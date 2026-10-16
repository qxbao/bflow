# DX review and local integration — 2026-10-16

Reviewed original documentation commit `57924982481c3e3be1ba24a287759476e502fc3b`.
Before validation, merged current local main
`b29e5b20d64f18b91ff323afdc63b2e908d8082e` into the DX branch, preserving its
repository-local Git identity fixture fix. Review fixes are in
`d9df2e611f2b21f3b8103aded257b622d73eddb8`, the exact source/assets HEAD used for
the checks below. No CLI/runtime/contract implementation or root configuration
was changed relative to that main baseline.

## Findings and fixes

1. **P2 — template validation followed publication.** An invalid local fragment
   could replace `.bflow/config.yaml` before the final loader rejected it.
   `apply.mjs` now runs the actual environment loader against a private staged
   candidate before writing backups or replacing target config. It rejects
   checkout identity keys in fragments. Temporary files are cleaned up on failure.
   Existing-state detection now also rejects dangling state symlinks.
2. **P2 — quick-start copy included local generated files.** `cp -R` could bring
   source checkout node_modules/dist or local `.bflow` into the supposedly clean
   standalone repository. Getting Started now exports the committed example with
   `git archive HEAD:examples/portable-node | tar -x ...` into a new directory.
   The documented command was executed and the exported tree inspected before
   installation: no node_modules, dist or .bflow was present.
3. **Completeness — feature criteria required manual extension.** The original
   draft was explicitly marked as an incomplete seed. It now includes four
   criteria covering normal/negative multiplication, invalid inputs, output
   overflow and unchanged sum behavior. Workflow IDs, P15 traceability and the
   resolver-generated P16 strategy were updated together, then validated using
   their actual exported schemas/policies. It remains a draft requiring real
   intake binding and acceptance before execution.

`verify.mjs` now applies all four workflow seeds and checks malformed policy,
duplicate roles and identity overrides in copies of template assets. Each negative
probe confirms both target config bytes and backup entries remain unchanged.
Fixture Git commands clear inherited `GIT_*` overrides so verification does not
target an unrelated repository.

## Verification

Platform: Linux/local filesystem, Node v24.16.0, pnpm 12.5.1. Commands ran in
`/tmp/bflow-dx-docs` unless specified otherwise.

| Command/check | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Dependency boundaries and acyclic graph pass |
| `pnpm typecheck` | 0 | Workspace types/build pass |
| `TMPDIR=/tmp pnpm test` | 0 | 52 files passed, 2 skipped; 1209 tests passed, 2 skipped, 0 failed |
| `node templates/node-typescript/verify.mjs` | 0 | Four schemas/strategies, eight roles, real CLI probes and negative mutation guards pass |
| `node --check templates/node-typescript/apply.mjs` | 0 | Syntax pass |
| `node --check templates/node-typescript/verify.mjs` | 0 | Syntax pass |
| Local Markdown target scan | 0 | 141 relative links in 38 files including this report; none missing |
| `git diff --check` | 0 | No whitespace errors |
| Ownership comparison against main | 0 | No diff under packages/apps, contracts or root configuration/lockfile |

Fresh independent fixture: `/tmp/bfdx-review-3ligbhj7/calculator`, exported with
the documented archive command from the reviewed commit. With private short XDG
directories held constant across CLI diagnostics:

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm test`
  each exit 0; baseline tests: 4 passed, 0 failed/skipped.
- The documented sum command exits 0 and prints 5.
- Real CLI init, feature template application, status and doctor each exit 0.
  Attach/down before first up each exit 1 as expected for missing manifest.
- Feature exercise in that temporary copy: spec-derived tests give exit 1 with
  5 passing/3 failing assertions for the absent multiply API; after a local pure
  function implementation, exit 0 with 8 passing tests, followed by another
  unchanged-test rerun with 8 passing tests. Existing sum behavior is preserved.
- Independently restored the example baseline before the bugfix exercise: new
  output-overflow regression gives exit 1 with 4 pass/1 fail; after a local result
  bounds check, Green and rerun each exit 0 with 5 pass/0 fail.

These are local manual exercise checks, not authenticated P16/P17 receipts or AI
delivery. Only the shipped baseline is committed; temporary solutions are not.
Refactor/docs policy/schema samples remain validated, without a claim of model
implementation or review. No model/provider agent was started during this review.

The [original validation report](VALIDATION.md) retains the prior full-suite and
live native Herdr smoke evidence. Up/attach with model providers, default shutdown
integration, automatic P19 host boot and config-to-P19 policy wiring retain the
documented limits. No remote push, PR/merge or deploy is part of this local review.

No blocking review findings remain in the documentation/template/example scope.
The reviewed branch contains the current main baseline and is ready for the
project-owner-authorized local fast-forward into main. Only this review report and
the historical report's follow-up link were added after the tested assets commit.
