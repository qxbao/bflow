# Bflow Failure Analysis

Audit revision: `a46ab10`

This report distinguishes failures observed during this audit from hypotheses and historical statements. No production run history or provider transcript was available, so no recurring full-run production root cause is declared.

## Evidence inventory

Available evidence:

- Checked-in source, package tests, Runtime integration tests, E2E scenarios, CI workflows, and audit/limitation documents.
- A current local build and focused test executions from the audit branch.
- A structural graph of 1,522 repository files with 14,302 nodes and 38,880 edges.
- The supplied GitHub Actions URL returned the GitHub page HTML but not job log content in this environment.

Missing evidence:

- Run IDs and durable Runtime journals from failed full SDLC executions.
- Herdr server/pane observations for those runs.
- Provider stdout/stderr, transcripts, authenticated session receipts, and permission/sandbox diagnostics.
- Correlated Runtime event tails, checkpoints, operation receipts, and recovery attempts.
- A time series from which blocker frequency, recovery time, or token cost could be measured.

## Confirmed finding F-LOCAL-TEST-CONTENTION

| Field | Finding |
| --- | --- |
| Failure ID | `F-LOCAL-TEST-CONTENTION` |
| Affected subsystem | Vitest execution of slow Runtime lifecycle fault matrices and cleanup hooks |
| Role/agent | None; test infrastructure |
| Expected state | Lifecycle fault/restart tests complete within the 30-second test budget and clean temporary stores/artifacts |
| Observed state | A concurrent four-process focused run produced six test timeouts. Three also reported `ENOTEMPTY` while cleaning `/tmp/bflow-lifecycle-*`. |
| Last confirmed successful operation | The same cases completed individually with `--maxWorkers=1 --minWorkers=1`. |
| First abnormal operation | The first concurrent lifecycle tests exceeded the per-test timeout while other heavy Runtime/E2E slices were using the host. |
| Error signature | `Test timed out in 30000ms`; cleanup `ENOTEMPTY: directory not empty, rmdir '/tmp/bflow-lifecycle-*'`. |
| Recovery attempted | Yes; each affected file was rerun serially. |
| Recovery result | 7/7 extended restart tests passed; 13/13 fault-matrix tests passed. |
| Existing coverage | The lifecycle tests cover Runtime behavior; no test protects the scheduling contract that keeps this matrix isolated from competing heavy suites. |
| Confidence | High for local test-runner contention; not evidence of production full-run reliability. |

The finding is explained by test shape and timing. Root configuration sets `testTimeout`, `hookTimeout`, and `teardownTimeout` to 30 seconds. Lifecycle fixtures use real SQLite, filesystem artifacts, Git repositories/worktrees, and asynchronous Runtime ticks. Serialized cases took roughly 10–16 seconds. The serial rerun rules out a deterministic Runtime state-transition failure in these scenarios. `ENOTEMPTY` is secondary teardown fallout: timed-out tests can leave asynchronous gate or fixture work active while `afterEach` removes the directory. The fixture already explicitly drains one held verification coroutine in [`lifecycle-fault-matrix-extended-restart.test.ts`](../../packages/runtime/test/agentic/lifecycle-fault-matrix-extended-restart.test.ts).

This can make CI red or hide a real failure, but it does not explain a user-facing Bflow run stalled in Herdr.

## Source-supported risk R-HERDR-UNCERTAIN-RECONCILIATION

| Field | Finding |
| --- | --- |
| Status | Source/local-test-supported risk; production occurrence unconfirmed |
| Affected subsystem | Herdr adapter delivery reconciliation |
| Expected state | After a possible external side effect with an uncertain CLI response, Runtime obtains authoritative delivery state or presents a bounded operator action |
| Observed source behavior | `HerdrCliTransport` stores accepted/uncertain receipts in a process-local map. If no matching cached receipt exists, `reconcile()` inspects the pane but returns `unknown_delivery` because Herdr exposes no prompt-specific receipt. |
| Safety behavior | The adapter does not invent a bound handle and does not allow blind resend. |
| Why it matters | A real process restart or unavailable receipt can leave a task blocked until a separate authenticated/native reconciliation path or operator action resolves it. |
| Existing tests | Herdr reliability F01/F06/F07; Runtime/E2E E02/E03; native delivery reconciliation tests. |
| Confidence | High that this source behavior exists; no evidence that it caused a particular production run. |

This is a deliberate fail-closed tradeoff, not a confirmed defect. Validate it with one low-cost real Herdr native-actor probe before changing product code.

## Non-failures that must not be misclassified

- A run waiting for human approval is not a system stall; the watchdog excludes `awaitingHuman` and pending decisions.
- Herdr `done` or `idle` is transport state, not task success; Runtime requires correlated result/evidence.
- An installed provider binary, release label, or model ping is not provider readiness or full workflow acceptance.
- An opt-in live test skipped by default CI is an evidence boundary, not a failed production execution.
- A `blocked`, `escalated`, or `inconclusive` result with a durable pending action can be intentional recovery state.

## Failure patterns evidenced by tests

The repository exercises these patterns with deterministic or local components:

1. Ambiguous delivery after no write: reconcile proves `not_delivered`, then safe resend is allowed.
2. Ambiguous delivery after external write: reconcile proves `bound`, then existing execution is adopted without duplicate dispatch.
3. Unresolved delivery across restart: task remains blocked and is not blindly resent.
4. Crash at dispatch, receipt, and binding boundaries: durable intent/checkpoint recovery reconstructs state and reconciles before continuation.
5. Storage failure while recording evidence: task success is not recorded when artifact or event persistence fails.
6. Silent or blocked specialist: bounded reminder/resume/escalation preserves an actionable state.
7. Pane/session replacement: target continuity and fencing reject stale execution results.

These are confirmed test behaviors, not incident counts.

## Prioritization

| Priority | Item | Why | Cheapest discriminating next step |
| --- | --- | --- | --- |
| 1 | R-HERDR-UNCERTAIN-RECONCILIATION | Can strand a task after a real side effect; current adapter cannot prove prompt-specific delivery generically | Run existing live native Herdr smoke with one custom actor and capture `initialize`, `send`, `reconcile`, pane/session identity, and Runtime state |
| 2 | F-LOCAL-TEST-CONTENTION | Can make CI red or hide regressions; reproduced locally and cheaply | Schedule the two lifecycle matrix files serially or give that lane an explicit slow-suite budget |
| 3 | Missing production evidence | Prevents incident ranking and root-cause claims | Preserve a redacted event/checkpoint/receipt bundle from the next naturally occurring failed run |
| 4 | Full provider/SDLC acceptance gap | External behavior is unverified by default CI | Periodic one-task/provider boundary probes, each with fixed scope and no feature generation |

No numerical frequency ranking is provided because no run population was available.
