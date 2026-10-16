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

Integration validation and local-main closure are recorded below after the
integration checks; the original `HANDOFF.md` remains historical evidence.
