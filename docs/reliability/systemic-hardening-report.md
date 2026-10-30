# Bflow Systemic Runtime Reliability Hardening Report

Date: 2026-10-30  
Checkout: `f24b17e8defa3e12ce7a3d4517d286f04072204e`  
Scope: main Agentic SDLC runtime path; no paid full workflow.

## Executive result

This audit identified and traced the primary execution boundaries from Conversation through Coordinator, Runtime, assignment/lease, Herdr/provider, result delivery, verification, Git integration, approval and completion. It confirmed one historical systemic failure class and one current source-level liveness defect:

1. **Process-launch payload overflow:** the historical `spawn E2BIG` blocker was a shared process-boundary weakness, not a role-specific failure. The current checkout contains bounded policy projection, digest/reference delivery and exact pre-launch reconciliation. Focused local/direct evidence supports the correction, but the active host is not proven to have loaded it.
2. **Watchdog activation race:** the host watchdog could run while `workspace` existed but `manifest` did not, then dereference `manifest!.conversationSessionId`. The active host log contains the resulting `TypeError`. A narrow shared host guard now suppresses the watchdog pass until activation is complete.

Repeated parent-lease mismatch messages and a journal lock timeout were reproduced as observed host symptoms/source-supported fail-closed paths, but this audit did not establish them as independent root causes. Existing tests show stale notices are cancelled safely and selected continuation recovery revives them after a fresh fence. Changing those semantics without a post-restart evidence bundle would risk weakening safety.

## Actual baseline and deployment status

| Item | Observed value | Interpretation |
|---|---|---|
| Source checkout | `f24b17e` | Three documentation commits beyond `origin/main`/`a46ab10` |
| Installed `bflow` | `/home/baodq/.local/bin/bflow` launcher | Points to this checkout's `apps/cli/dist/bin.js`; reports `0.1.0` |
| Active host | session `bf-c1695ccd3f2b994f91bd`, repository host PID `1781403` | Live host with role processes and Herdr; not restarted |
| Persisted execution resolution | `a46ab103…` | Incident/baseline revision, not proof of current checkout |
| Platform generation | `59` | Active host generation evidence only |
| Active host runtime path | checkout `packages/runtime/dist/agentic/host.js` | Same path, but processes loaded their module before this audit’s current build/source revision |
| Current build | `pnpm run build` passed during this audit | Fresh local artifacts; does not hot-reload active processes |
| Host readiness | `bflow status` reported UP, Herdr RUNNING, 7/11 roles ready, 4 Developers disconnected | Environment status is not full workflow acceptance |

No host restart, `up`, `down`, pane replacement, or mutation of the live journal was performed. The deployment claim for the E2BIG mitigation therefore remains **not closed** until an authorized reopen/re-pin validates the current source/build revision.

## Failure boundary map

### Conversation -> Coordinator

`packages/runtime/src/agentic/conversation.ts` and `host-conversation.ts` validate trusted user turns and durable Conversation notices. `createAgenticConversationHost` queues `delegation.request` and approval decisions into Runtime; Conversation cannot directly dispatch a Developer. Gateway failures are write-ahead/queued and bounded. A message acknowledged by Conversation is not a Core transition unless Runtime applies it.

### Coordinator -> Runtime

`runtime.ts` parses `RoleMessage`, admission-checks delegation/assignments, records inbox/outbox state, and uses `pendingAction` for bounded resume/escalation. Invalid messages are counted and eventually surfaced. The source-supported liveness risk is that a semantic status notice can be delivered without itself proving a durable next workflow action; current local liveness tests cover the repaired cases, while live model behavior remains external evidence.

### Runtime -> lease/pane/Herdr

`HerdrOutbox` persists intent, preflights pane/session/capability/profile/skill state, acquires Registry lease/fence immediately before side effect, renews/revalidates, then sends through transport. A stale parent notice is rejected/cancelled, not sent. Unknown delivery is sticky and reconciled by exact request identity.

### Provider -> result/verification

Provider output is admitted only through authenticated, correlated RoleMessage/result/gate/evidence paths. Verification uses independent gates and trusted artifact references. A provider process ending or Herdr `done` is not business success.

### Git -> completion

Task changesets and integration are scoped by Git orchestrator; conflicts and worktree state are retained for bounded resolver/review. Workflow-level verification follows integration. Approval remains an independent human gate.

## Confirmed correction: watchdog activation guard

### Demonstrated failure

The prior host implementation ran the 15-second watchdog when `workspace` was truthy and `quiesced/closing` were false. It then called `watchdogSnapshot(manifest!.conversationSessionId)`. During progressive activation, `workspace` and `manifest` are not an atomic pair. The active host log recorded:

```text
Bflow watchdog: TypeError: Cannot read properties of undefined (reading 'conversationSessionId')
```

That exception aborts the watchdog pass. A lost pass can delay reconciliation, automatic bounded resume and stall detection at exactly the lifecycle boundary where state is changing.

### Correction

`packages/runtime/src/agentic/host.ts` now exports and uses `shouldRunWatchdog({ workspace, manifest, quiesced, closing })`. Both the timer and worker require `workspace && manifest && !quiesced && !closing`. No retry, timeout increase, permission change or state weakening was added.

### Regression evidence

- `packages/runtime/test/agentic/host-watchdog-lifecycle.test.ts`: 2 tests prove the missing-manifest skip and normal active path.
- `packages/runtime/test/agentic/notice-watchdog.test.ts`: 23 existing watchdog/notice tests passed with the guard.
- `pnpm run build`: passed.

The test is deterministic and does not touch the active host. A full host reopen validation remains separate.

## Existing E2BIG correction and verification

The current source already contains the shared fix: bounded conditional-evidence projection, durable digest-bound references, exact pre-launch `E2BIG` classification, original fence release, fresh-fence rebind and locked-journal restart recovery. Existing audit evidence records:

- 44 focused Runtime tests passed across policy prompt/manual review/native intent selection.
- Direct Linux launch reproduced `E2BIG` for a 180 KiB environment and successful bounded reference launch.
- Real native Herdr smoke passed 1/1 with authenticated receipt evidence, no provider/model, and `bindingVerified=false`.

This is prevention/recovery evidence for the current source, not live host deployment evidence.

## Lease and journal fault-injection findings

### Parent lease mismatch

Injection of expired/released/replaced parent authority causes the task notice to be cancelled before transport. Registry continuation tests verify that the parent gets a higher fence and children receive the updated lease. The behavior preserves safety: no stale notice is sent. The remaining risk is operational churn/noisy scheduler logs when a stale notice is revisited. It should be addressed only after a post-restart evidence bundle shows whether notices are repeatedly recreated, whether a recovery action is missing, and whether the same message identity is involved.

### Journal lock timeout

`AgenticJournal` uses a nonblocking `flock` and rejects after five seconds. The timeout is bounded and fail-closed; it does not bypass the journal. The active symptom may reflect contention between scheduler, delivery reconciliation and watchdog, but no independent deadlock or lost state was proven. A slow-lane contention experiment and retained lock-holder telemetry are recommended before changing lock policy.

## Regression commands and results

Commands run in this audit:

```sh
pnpm exec vitest run packages/runtime/test/agentic/host-watchdog-lifecycle.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=basic
# 1 file, 2 tests passed

pnpm exec vitest run packages/runtime/test/agentic/host-watchdog-lifecycle.test.ts \
  packages/runtime/test/agentic/notice-watchdog.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=basic
# 2 files, 25 tests passed

pnpm run build
# passed: TypeScript build and web production build
```

Additional existing evidence retained in the repository includes policy/manual/native focused tests, task-notice/lease continuation tests, native reconciliation tests, lifecycle fault matrices, Herdr reliability tests, E2E recovery scenarios and the direct Linux E2BIG probe. A broader affected test run is required before integration claim; this report does not claim the full repository suite passed.

## Unresolved risks and follow-ups

1. Authorize a controlled host reopen/re-pin on the current source/build only after assessing live in-flight work; record the new execution-resolution revision and loaded artifact hashes.
2. Capture a bounded redacted failure bundle on the next blocked run: run/revision/generation, last 100 journal events, checkpoint, outbox/receipt identity, pane/provider readiness, reconciliation result, telemetry and recovery action.
3. Run one isolated native Herdr send/reconcile probe after adapter/host restart to measure whether prompt-specific delivery can be proven; no model call.
4. Add a dedicated slow serial lane for the two real lifecycle fault matrices; do not raise the global 30-second timeout.
5. Investigate lease/log churn only with message identity, parent/child lease history, Registry versions/fences and journal lock-holder timing. Do not add generic retry or treat an expired lease as safe to release without proof.
6. Periodically validate assembled provider launch size and sandbox/trust behavior with disposable profiles. Keep full provider/SDLC acceptance separate.

## Closure status

- Boundary map: **completed at source/local evidence level**.
- Systemic fault model: **completed with selected realistic combinations**.
- Historical E2BIG class: **mitigated in current source; active deployment not proven**.
- Watchdog activation race: **corrected in source; deterministic regression passes**.
- Lease/journal symptoms: **fail-closed behavior verified; independent root cause unresolved**.
- Full live SDLC reliability: **open / not claimed**.
