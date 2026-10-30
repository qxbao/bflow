# Bflow Boundary Failure Matrix

Audit revision: `f24b17e` (2026-10-30). This matrix records inspected boundaries, failure timing, recovery policy, tests and evidence limits. “Pass” means the listed local evidence passed; it does not mean the external system is universally reliable.

| Boundary / code | Contract and side effect | Failure timing / selected faults | Existing recovery | Existing tests / evidence | Assessment |
|---|---|---|---|---|---|
| Conversation ingress; `host-conversation.ts`, `conversation.ts` | Authenticated user turn / `DelegationRequest`; writes trusted turn and queues Runtime message | Conflicting turn, invalid decision, Gateway unavailable | Idempotent receipts, bounded inbox retries, dead-letter notice, user resume/cancel | Conversation/host receipt tests; local web tests | Strong local; native provider display not full-live |
| Runtime journal; `agentic/journal.ts` | Validated `JournalState`; lock, durable state rename, fsync | Lock busy, malformed state, crash during save | Five-second bounded lock wait; kernel lock release; schema rejection; temp cleanup | Journal/recovery tests, lifecycle matrices | Safety strong; slow-holder/liveness evidence limited |
| Core session / RunStore; `core-session.ts`, `recovery.ts`, persistence | Events/checkpoint and legal task/run transitions | Crash before/after append, stale version, projection drift | Aggregate restore/event replay; idempotency/version checks | Scenarios 05–09, persistence tests | Strong local; power-loss not verified |
| Registry; `packages/agent-registry` | Lease capacity, version, fencing token | Expiry, release race, stale fence, capacity busy | Reconcile/release with original version; fresh monotonic fence for explicit continuation | Registry tests, policy-prompt and task-notice tests | Strong local; no multi-host guarantee |
| Outbox enqueue; `agentic/outbox.ts` | Durable message/request identity; no transport yet | Duplicate key, parent lease expired, changed parent | Deduplicate exact message; reject conflicting parent; cancel stale notice; continuation revives selected notice | `task-notices.test.ts`, A-Z acceptance | Fail-closed by design; repeated lease symptom needs evidence |
| Capability/profile preflight; `host.ts:1151-1197`, host platform | Authenticated pane/session, repository read, skills/tools/profile | Missing pane, changed occupant, unavailable capability, stale skill receipt | Retry with `[0,2s,8s,30s]`; terminal failed intent creates `pendingAction`/Conversation blocker | liveness regressions, profile/skill tests | Strong local; provider trust semantics external |
| Process launch; pane runner and Herdr adapter | Child/socket command with bounded output/deadline | E2BIG, ENOENT, EACCES, EPIPE, timeout, crash | Classify pre-launch only with proof; otherwise unknown delivery and reconcile; never blind resend | Herdr reliability tests; direct Linux E2BIG; live native smoke | E2BIG addressed in current source; all errno variants not live |
| Herdr socket/native receipt; `pane-manager/herdr-socket`, `herdr-ingress.ts` | Correlated response / signed native envelope | Lost ACK, malformed response, signature mismatch, disconnect | Sticky unknown, authenticated rejection, exact intent recovery | Socket/adapter reliability and native reconciliation tests; live smoke 1/1 | Transport live evidence only; task success not proven |
| Provider execution | Provider reads pinned prompt/skills and may mutate only authorized scope | Auth/trust prompt, provider crash, hidden permission wait, partial work | Provider preflight, session identity, process scope, failover only when policy allows; operator gate | Provider tests and optional live checks | Full provider behavior not default CI |
| Tool/Gateway boundary | Scoped tool grant/lease and durable invocation identity | Tool response lost, upstream nested/malformed output, lease loss | Tool ledger `unknown`, reconcile; grant scope/fence checks; no replay | MCP gateway/usage ledger tests | Local/fixtures strong; real service limited |
| Verification/quality gates | Authenticated result and trusted artifact references | Runner missing, timeout, gate failure, evidence persistence failure | `blocked`/`inconclusive`/rework, bounded max iterations, human escalation | Verification, policy, manual-review tests | Strong local; real provider response open |
| Watchdog; `host.ts:2576-2660`, `run-watchdog.ts` | Read-only facts -> reminder/resurface/stall actions | Pane idle, missing notice, activation manifest race, lock/lease errors | Valid waits excluded; bounded notices; activation guard now skips until manifest exists | notice watchdog 23 tests + new lifecycle guard 2 tests; active TypeError evidence | Guard corrected; full live restart not run |
| Git worktree/integration | Scoped changeset, conflict resolution, workflow verification | Conflict, dirty worktree, integration crash | Preserve worktree; bounded resolver; post-integration verification | Git orchestrator and Runtime integration tests | Strong local; no real coding-agent workflow |
| Host lifecycle/deployment | Persisted host config, binary/build/source identity, role launches | Source/build/host drift, interrupted activation, stale generation | Read-only status; explicit setup/up/reopen; no hot reload assumption | Host recovery/lifecycle tests | Active host is not aligned to current revision; restart intentionally deferred |

## Controlled fault-injection cases

| Case | Injection point | Expected safety/liveness | Actual result | Status |
|---|---|---|---|---|
| FI-01 | Linux child launch with 180 KiB inherited env | Child must not start; error must be classified as OS pre-launch | `spawnSync` returned `E2BIG`; child did not start | Passed; direct boundary |
| FI-02 | Same request replaced by small digest/reference | Child starts and receives exact reference | Exit 0; reference received | Passed; direct boundary |
| FI-03 | Herdr request timeout after possible write | Do not resend until reconciliation proves not-delivered | Sticky `unknown_delivery`; deterministic tests prevent blind resend | Passed locally |
| FI-04 | Native ACK absent/conflicting | Preserve intent; reject changed identity; no replay | Native reconciliation kept exact intent unknown and refused conflicting envelopes | Passed locally |
| FI-05 | Registry release failure during exact E2BIG recovery | Keep proof and retry; do not drop request/lease evidence | `PrelaunchRegistryRecoveryError`; second reconciliation succeeds | Passed locally |
| FI-06 | Parent lease expired/released while notice queued | No task notice side effect under stale authority | Notice becomes cancelled with explicit mismatch error; continuation tests revive selected notice after fresh fence | Passed locally; no independent defect proven |
| FI-07 | Journal lock held beyond five seconds | Bounded error, no unsafe unlocked write | `Journal lock timeout` is raised; state is not bypassed | Source + existing lock tests; targeted host incident symptom |
| FI-08 | Watchdog tick with workspace but no manifest | Skip pass; no `manifest!` exception | New guard returns false; existing watchdog suite remains green | Passed locally; host restart not run |
| FI-09 | Provider/pane absent or changed | No lease/transport side effect; durable actionable blocker | Preflight/recovery tests preserve queued/failed intent and blocker | Passed locally |

## Open evidence gaps

- No full user-to-delivery SDLC with a real provider was run.
- No post-fix restart/reopen of the active repository host was authorized or performed.
- No production population exists to rank lease mismatch or lock timeout frequency.
- No power-loss, network filesystem, hostile same-UID, or multi-host Registry guarantee is claimed.
