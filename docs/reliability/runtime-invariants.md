# Bflow Runtime Safety and Liveness Invariants

Audit revision: `f24b17e`. These invariants are the acceptance rules used by the systemic fault model. They distinguish what Runtime can enforce from what remains an external-provider limitation.

## Safety invariants

### S1 — No duplicate side effect after uncertain delivery
A message with `sending` or `unknown_delivery` must retain its immutable request/message identity and cannot be resent until authoritative reconciliation proves `not_delivered`. If reconciliation proves `bound`, Runtime adopts the exact handle; if it remains unknown, the run stays blocked/escalated with an actionable reconciliation path.

**Evidence:** outbox, native delivery, Herdr reliability, Runtime E02/E03 and selected local fault injections.

### S2 — No stale fence mutation
Every Registry mutation carries the lease ID, fencing token and expected version that were durably captured for that mutation. Expiry, release, version mismatch or fence mismatch fails closed. A continuation obtains a strictly newer fence and propagates it to borrowed task notices before dispatch.

**Evidence:** FileAgentRegistry, task-notice, cancellation, policy-prompt and continuation tests. Distributed/multi-host semantics are not claimed.

### S3 — No task success without evidence
Transport `accepted`, Herdr `done`/`idle`, provider startup, model ping, and a status notice cannot transition Core to success. Success requires the correlated `AgentResult`, required independent gates, trusted artifact references and legal Core transition.

**Evidence:** Core/runtime/verification tests and contract validators.

### S4 — No unauthorized approval or permission widening
A skill, provider readiness result, native tool call, or unattended mode cannot create human approval. Direct native user questions are denied for non-Conversation roles. Unsupported sandbox/provider enforcement reports blocked/unsupported rather than widening permissions.

**Evidence:** decision routing, provider/platform, sandbox and permission tests. Provider UI behavior remains live evidence only.

### S5 — Durable intent survives recovery
Before an external side effect, Runtime persists the dispatch/native/tool intent. Recovery replays or reconciles the exact intent; it does not discard it, synthesize a handle, or replay unrelated completed work.

**Evidence:** journal codec, restart, native intent, tool ledger and E2BIG recovery tests.

### S6 — Bounded data at process boundaries
Untrusted or potentially large policy/evidence content must not be embedded without a bound in process environment/argv or other OS-limited launch channels. Full evidence remains in durable/artifact storage and the process receives a bounded projection or digest-bound reference.

**Evidence:** direct Linux E2BIG probe and policy prompt tests. Provider-specific assembled launch environment still needs periodic live validation.

### S7 — Validated ingress
Every package-boundary envelope, journal state, receipt, result, gate output and artifact reference is parsed by the exported contract/schema at ingress. Type assertions are not validation.

**Evidence:** contracts and package tests; malformed envelope fault cases.

## Liveness invariants

### L1 — Every nonterminal task has an owner or recovery state
A nonterminal task must have an active owner/accepted handoff, Runtime-owned work, a human/pending decision, an uncertain-delivery reconciliation, or a durable `pendingAction`. It must not simply disappear from the scheduler.

**Evidence:** `runFacts`, pending actions, stuck-state and recovery tests. The selected historical E2BIG incident demonstrated why a generic transport error must become an explicit recovery state.

### L2 — Every awaited external operation has a bounded detector
Process, socket, Gateway, provider, gate, lock and lease waits have a deadline, bounded retry/reconcile count, or explicit operator state. No timeout is converted into proof of remote stop.

**Evidence:** operation budgets, outbox backoff, watchdog, gate limits, journal five-second lock and cancellation bounds. Long provider/model execution remains bounded by configured policy, not by generic retry.

### L3 — Pre-launch confirmed failure cannot strand a phantom execution
If an exact pre-launch failure proves no child started, Runtime releases the old capacity using its original fence, records the proof and queues a new request that requires a fresh fence. It must not leave an accepted execution with no possible result.

**Evidence:** exact E2BIG classifier, policy prompt, Registry and locked-journal recovery tests.

### L4 — Missing pane/session is detected before side effect
A changed or missing pane/native session produces a preflight blocker before lease/transport side effect, or an existing accepted execution enters reconciliation. A missing pane cannot be treated as a completed role.

**Evidence:** pane manager, outbox preflight, session recovery and lifecycle tests.

### L5 — Watchdog lifecycle preconditions are explicit
The watchdog runs only when the workspace is active, the activated `SessionManifest` exists, and the host is not quiescing/closing. Progressive activation is a valid wait state, not an exception. This invariant was violated by the old `manifest!` dereference and is now enforced by `shouldRunWatchdog`.

**Evidence:** `host-watchdog-lifecycle.test.ts` and `notice-watchdog.test.ts`; active host restart validation remains open.

### L6 — Recovery does not replay unrelated work
Recovery is keyed by run/task/message/attempt identity and current lease/session/fence. A repaired capability or pre-launch failure resumes only the exact pending action and does not resend an unrelated accepted or completed operation.

**Evidence:** recovery, native delivery, lease continuation and task notice tests.

### L7 — Exhausted recovery becomes actionable escalation
When automatic retries/resumes are exhausted, Runtime records a blocker/escalation and a user-visible Conversation notice. It does not spin forever, silently drop the intent, or auto-approve.

**Evidence:** A-Z bounded resume tests, Conversation delivery dead-letter tests, capability preflight tests.

### L8 — A valid human wait is not a stall
Pending approval, clarification, user decision, active handoff with a working pane, Runtime verification work and explicit unknown delivery are classified separately from a true stalled run. Watchdog must not cancel or claim success for these states.

**Evidence:** watchdog and approval/verification tests.

## External limits

- Herdr/provider transport may not expose a prompt-specific authoritative receipt after adapter restart. Runtime can preserve safety by remaining `unknown_delivery`, but cannot guarantee automatic progress without external evidence.
- Provider authentication, trust prompts, model behavior, sandbox enforcement and real tool response semantics cannot be inferred from local fake runners.
- Local `flock`/SQLite/filesystem tests do not prove power-loss atomicity, network-filesystem behavior or multi-host same-UID isolation.
- The active host may continue to run a previously loaded artifact until explicitly reopened. Source inspection cannot retroactively change that process.
