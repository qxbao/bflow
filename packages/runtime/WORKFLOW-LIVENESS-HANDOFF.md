# Workflow liveness remediation handoff

The incident audit and prior-fix classification are in `WORKFLOW-LIVENESS-AUDIT.md`.
The implementation plan is in `WORKFLOW-LIVENESS-PLAN.md`. Native Luna workers authored the
Runtime implementation and reader; the integration reviewer added failure-injection tests and
corrected the remaining no-action, durable authentication, verification and Conversation paths.
No public contracts, shared root configuration, lockfile, CLI or shared documentation changed.

## Next-action model

A live run must retain a correlated work obligation, a durable wait, or an explicit recoverable
action. Herdr acceptance/release/idle/done only affects transport capacity. It is not business
success. `pendingAction` carries stable identity, owner, source message, reason, recovery class,
previous phase where applicable, and bounded resume attempts. Other valid waits are represented
by existing approval/user-decision, verification outcome and uncertain-outbox records.

| Failure / wait | Durable state and owner | Recovery |
| --- | --- | --- |
| Required capability unavailable before dispatch | Failed unsent intent; escalated action; Coordinator | Recheck current pane/launch/tools/pins, then reuse the original unsent intent; no lease/send before proof |
| Specialist blocked/failed | Applied correlated result, reason, Conversation notice and Coordinator wake | Coordinator chooses a concrete next action or escalates; wake identity is deterministic |
| Specialist ends without valid result | Stop receipt, result obligation, notice/wake | Coordinator handles/reassigns through existing bounded policy; transport done cannot discharge the obligation |
| Coordinator ends with only progress/no action | Escalated run, previous phase, Coordinator action | Explicit resume/cancel; progress is not an action |
| Schema-invalid native message | Authenticated rejection record and schema-valid blocker notice | Correct the envelope; do not claim a result was accepted |
| Received result at process loss | Validated owned inbox write-ahead | Exact-row replay restores the previously established authentication scope, then repeats business/correlation/evidence checks |
| Applied result missing wake | Correlated applied inbox result + original bound assignment | Recreate only its missing deterministic wake, not the specialist mutation |
| Verifier coroutine lost before invocation/outcome | Frozen verification plan/cycle; orphan local pending flag | First initialization releases only orphan flags; persisted outcomes replay without rerunning checks |
| Unknown delivery | Original uncertain outbox and reconciliation action | Reconcile first; no resend until transport proves not-delivered; no idle-stall diagnosis |
| Human/user decision pending | Existing approval/question records | Keep waiting for the exact authorized decision; no auto-resume |
| Conversation Gateway delivery error | Original outbox, bounded retry/backoff, failed-delivery receipt | Recover inbox delivery or surface the retained host notice |
| Idle Conversation wake or notification fails | Original unsurfaced notice + delivery diagnostics | Safe empty-input wake, at most three attempts per notice across restart; then manual Conversation status/resume/cancel |
| Cancellation | Existing cancellation intent, stop reconciliation and retained worktrees | No task resend/resume; report unresolved stops instead of inventing confirmation |

Restart replay trusts the existing private local filesystem boundary. It does not create a new
native signature, remote delivery, AgentResult, verification measurement, or human approval.
The exact durable envelope must already exist. Fresh untrusted ingress still requires its normal
authentication. Existing leases, fences, cancellation, Core transitions and independent gates remain.

## Permissions and scope

| Before | After | Scope |
| --- | --- | --- |
| Selected Claude investigation roles had a small Bash/Git allowlist; Codex exec and resource enumeration fell through generic denial | Authenticated Bflow MCP text/list/Git reader, independent of native shell tool names | Bound repository; private/cache paths, symlinks and special files refused; bounded bytes/count/time |
| Skills were rendered as pinned path references that some roles could not open | Host can return verified selected SKILL.md content and manifest digest with bounded paging | Current role/launch, instruction-only; no install hook or permission grant |
| Coordinator-to-Conversation messages bypassed RunRecord state | Runtime journals semantic blockers before the original authenticated envelope reaches Conversation | Same run/session/correlation; no replacement signature or forged completion |
| Conversation idle nudge recognized Claude only and reset its budget with the process | Observed Codex footer supported; durable three-attempt budget | Exact idle/empty input; typed drafts and unknown layouts fail closed |

No global bypass, global hook trust, provider setting mutation or OS sandbox escape was added.
Developer mutations remain on the existing assigned-worktree/TDD authorization path. Provider-
native editing parity is not established by these read-only tests.

## Validation boundaries

Required commands are `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, `git diff --check`, and
`git status --short`; `pnpm check` expands the first three. Final execution evidence records
actual commit, commands, exit status and test counts in the handoff message and local logs.

Run subprocess tests only after building. In this nested isolator environment, tests use a clean
child environment with `TMPDIR=/tmp` and inherited `AI_ISOLATOR*` profile selectors removed.
The original baseline failures and corrected environment reruns remain documented in the audit
ledger; no global permission/configuration was changed to make tests pass.

Local regression coverage includes real Runtime/journal/Registry boundaries, original delegation
Stop without action, correlated missing-wake repair, expired authentication context after restart,
owned native ACK replay, lost verification jobs, replayed saved verification outcomes, capability
revocation between resume/dispatch, approval/cancellation/unknown delivery, malformed envelopes,
all SDLC phase watchdog inputs, bounded Conversation wake across restart and read-only Git filter
sentinels. Fake transport remains local evidence.

The live Herdr native actor test is transport-only (protocol 22). It deliberately uses no model,
may observe unknown delivery, and does not prove authenticated task completion.

## NOT VERIFIED / remaining limits

- Post-fix live model/provider reproduction and full SDLC acceptance. A scoped Codex/personal
  startup attempt was blocked before panes started by `codex_global_hooks_unsupported`; the
  profile Codex directory was group writable. No trust-all or permission changes were applied.
  The temporary session was cleaned up; the original incident session/run was not restarted.
- Real typed-draft handling/model surfacing after the Codex parser change. The idle ANSI footer
  was captured read-only from the incident pane, then exercised locally with draft/modal cases.
- Cross-provider native edit parity, every provider/terminal layout, same-UID hostile isolation,
  network filesystems and power-loss guarantees. Existing P02-RA01/P03-RA01 remain with their owners.
- No claim that every task succeeds or that flow can never stop. The demonstrated guarantees are
  the particular durable obligations, bounded retries, safe waits and recovery boundaries above.
