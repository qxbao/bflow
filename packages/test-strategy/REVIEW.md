# P16 review and integration — 2026-10-16

Reviewed the policy resolver, evidence ingress, contract compatibility, prompt
instructions, package registration and original handoff before local integration.
Original implementation/report commits: `02e6ca5`, `c91a139`.

## Findings fixed

| Finding | Correction and regression evidence |
| --- | --- |
| Existing automated checks made pure formatting require an artificial Red phase | Separate executable checks from evidence of changed behavior; preserve regression checks under alternative verification |
| `ready` infrastructure with only some behavioral commands could still require TDD | Require configured commands for every selected behavioral method; retain explicit provisioning conditions otherwise |
| Red incorrectly required every observed criterion to fail | Allow passing existing regression criteria and baseline checks while requiring at least one failing target behavioral observation; preserve all tests through Green/refactor |
| Evidence phases could come from different verification cycles | Bind successive phase receipts to the same `cycleNumber` |
| Manual/visual observations could claim success with a nonzero exit code | Reject contradictory observation/evaluation exit codes |
| Several target commands sharing one verification method could be partially skipped | Successful evidence must cover every target command as well as every method and required criterion |

The initial regression run reproduced five failures (75 passed / 5 failed); the
all-passing Red guard already worked. A separate multi-command regression reproduced
one more failure (80 passed / 1 failed). After fixes, `pnpm --filter
@bflow/test-strategy test` passed 81 tests in two files, with zero failures/skips.
Both reproduction runs exited 1; the final package run exited 0.

No shared contract or other implementation owner's source was changed. Evidence
validation continues to rely on P17 for artifact contents/revision verification
and on P19 for authoritative-spec binding, persistence and Runtime enforcement.
Those responsibilities are not claimed as complete by this review.

## Integration validation and local closure

Source fixes: `4942b08`. The implementation and fixes are preserved through merge
commit `b35f063`. Workspace registration is commit
`9a71765f9e79fdc26ea3c5a8a576f5d89e18cac5`, the exact integration HEAD tested below.
This review report is a subsequent documentation-only commit. The original
`HANDOFF.md` remains historical evidence.

Validation ran from `/tmp/bflow-p16-integration` on Linux with Node `v24.16.0`
and pnpm `12.5.1`:

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Fresh integration worktree; all workspace packages installed without lockfile changes |
| `pnpm check:deps` | 0 | Acyclic: 13 packages, 19 internal edges |
| `pnpm typecheck` | 0 | Root references now include P16 |
| `pnpm --filter @bflow/test-strategy test` | 0 | Build; 2 files, 81 passed / 0 failed / 0 skipped |
| `TMPDIR=/tmp pnpm test` | 0 | Root build; 42 files, 954 passed / 0 failed / 0 skipped |
| Installed package ESM export/example smoke check | 0 | Self-import through `@bflow/test-strategy` exports; resolve and authoritative-spec binding pass |
| `git diff --check` | 0 | No whitespace errors |

The short TMPDIR preserves the original ArtifactStore Unix-socket fixture's path
length requirement in this environment. No storage test or implementation changed.

Integration changes are limited to registering P16 in `tsconfig.json`, its pinned
lockfile importer, the root package/command documentation and updated package
integration notes. Contracts, Core, Runtime and other owners' implementation paths
have no diff. Generated output is not committed; no migration or contract decision
is needed. Runtime enforcement still belongs to P19 after the full P12–P18 gate.

The validated integration history and its report-only successor are merged into
local `main` by fast-forward from `4e818b4`; the main working tree is clean. This
closes local P16 integration only. No push, remote merge, live Herdr verification
or complete P12–P18 synchronization is claimed.
