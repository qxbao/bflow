# Bflow Systemic Runtime Fault Model

Audit date: 2026-10-30  
Audit checkout: `f24b17e8defa3e12ce7a3d4517d286f04072204e`  
Baseline ancestor: `a46ab103428aa52e13d353c13eaf5286a92d30b4` (`origin/main`)  
Evidence scope: source inspection, deterministic/local tests, one existing real Herdr native smoke, and read-only inspection of the active host. No paid model call or full SDLC was run.

## Evidence rules

This audit uses four evidence levels:

- **Source:** code and exported contracts were inspected.
- **Local fault injection:** a deterministic fixture, local filesystem/database, subprocess, or fake transport exercised the boundary.
- **Live boundary:** an installed Herdr/provider/tool/daemon was exercised in an isolated probe.
- **Full SDLC acceptance:** a real user request completed through Conversation, Coordinator, Runtime, Herdr, provider execution, verification, approval, Git integration, and delivery. This level was **not** established.

A green CI or local test proves only the boundary represented by that test. Herdr `done`/`idle`, an accepted submission, a provider binary, or a host `UP` status is not task-success evidence.

## Runtime topology and trust boundaries

```text
Conversation / CLI
  -> authenticated Runtime host and private journal
  -> Coordinator / accepted role assignment
  -> capability, provider, skill, pane and sandbox preflight
  -> durable outbox intent + Registry lease/fence
  -> Herdr CLI/socket and provider process
  -> signed/correlated result or explicit uncertain delivery
  -> Core state transition and checkpoint
  -> independent verification / quality gates
  -> Git worktree and integration
  -> approval and Conversation delivery
```

The important architectural boundaries are:

1. **User and Conversation ingress.** A trusted physical/web user turn becomes a bounded Conversation record. Conversation creates a `DelegationRequest`; it does not dispatch Developers.
2. **Runtime journal.** `AgenticJournal` serializes mutations with a Linux `flock`, validates the complete state with the journal codec, and writes temp-file + fsync + rename. The journal is the recovery authority for Runtime-private intent, outbox, inbox, pending actions and Core append work.
3. **Core and persistence.** Core owns legal task/run transitions. SQLite projection/query state is not a substitute for the Core aggregate checkpoint or event replay.
4. **Lease and fence.** File-backed Registry capacity is acquired immediately before the physical side effect. A lease is not ownership proof unless its current version/fencing token is accepted.
5. **Pane/provider preflight.** `HerdrOutbox.step` validates recipient pane/native session continuity, profile/skill/tool readiness, execution-plan identity and required capabilities before acquiring capacity or sending.
6. **Process launch and transport.** `packages/pane-manager/src/runner.ts` and the Herdr adapter use child-process/socket boundaries with bounded output/deadline handling. `E2BIG` is a pre-launch OS error; timeout after a possible write is not equivalent to pre-launch failure.
7. **Delivery acknowledgement.** Durable message/request identity, transport receipts, signed native receipts and correlated inbox messages are separate facts. Unknown delivery forbids blind resend.
8. **Verification and evidence.** Independent Reviewer/QA/runner results are required. A transport completion or provider transcript cannot be promoted to verification evidence without authenticated correlation and trusted artifact ingestion.
9. **Git integration.** Worktrees, changed-file scope, conflict resolution and post-integration verification are separate from provider execution and task success.
10. **Recovery/watchdog.** Restart/reconcile paths inspect durable intent and current leases. Watchdog is a detector and notifier; it cannot manufacture a result, release an uncertain side effect, or waive approval.

## Fault categories

### A. Process and transport failures

| Failure | Current classification | Recovery | Confidence |
|---|---|---|---|
| Oversized launch (`E2BIG`) before child start | Exact pre-launch only when Linux, exact error, no handle, exact request/message, oversized original and no correlated reply all match | Bounded policy presentation/reference, locked-journal reconciliation, release old fence, fresh lease/fence; no fabricated handle | Confirmed source + local/direct Linux reproduction |
| Herdr timeout or CLI error after a possible side effect | `unknown_delivery` unless authoritative reconciliation proves `not_delivered` or `bound` | Persist intent, reconcile exact identity, never blind resend | Confirmed source + deterministic tests; live frequency unknown |
| EPIPE/ENOENT/EACCES/EPERM/child crash | Runner/adapter error; the safe outcome depends on whether invocation started | Preserve request/receipt/error, bounded retries only where pre-side-effect is proven, otherwise block/reconcile | Source-supported; selected variants not all live-tested |
| Malformed Herdr/provider output | Schema/transport rejection; no task success | Keep receipt/inbox evidence, surface actionable failure, do not infer success | Local test coverage |
| Oversized socket/output response | Bounded response/output handling; failure is not delivery success | Block or reconcile according to the owning boundary | Source + local tests |

### B. Delivery uncertainty

The system separates `sending`, `accepted`, `unknown_delivery`, `released`, `delivered` and `failed`. Native delivery also has private write-ahead intents and authenticated acknowledgement/rejection receipts. A missing acknowledgement is not evidence that no side effect occurred. Reconciliation accepts only exact identity and authenticated/correlated evidence. This is a deliberate safety-first tradeoff; a real external provider may require operator action when it cannot expose prompt-specific receipt state.

### C. State and concurrency failures

- **Expired/mismatched parent lease:** task notices borrow the parent assignment's lease and are rejected/cancelled when the parent is no longer current. Existing continuation recovery propagates a renewed lease to children and revives selected cancelled notices. The repeated active-host message is therefore a fail-closed operational symptom, not independently proven root cause.
- **Journal lock timeout:** `AgenticJournal` uses nonblocking `flock` with a five-second bound. A holder crash releases the kernel lock, but a slow legitimate operation can cause a bounded `Journal lock timeout`. The current behavior surfaces the error; it does not silently corrupt or bypass the journal. Power-loss and hostile network-filesystem guarantees remain unverified.
- **Stale fence/version:** Registry and Core checks reject stale mutation. The caller retains durable intent and must reconcile or explicitly resume.
- **Concurrent restart:** host close/reopen, outbox writes, native receipts and role startup are independently serialized; no cross-system atomic transaction is claimed.

### D. Session/provider lifecycle failures

Pane absence, occupant replacement, changed native session, missing authentication/trust, stale skills/tool grants, and unsupported sandbox readiness are preflight blockers. The system does not treat an idle pane, installed CLI, release label or model ping as readiness. A provider may still expose semantics (trust prompts, account state, model behavior) that deterministic tests cannot prove.

### E. Workflow liveness failures

The durable `pendingAction` and bounded automatic-resume paths cover no-next-action stops, capability repair, schema blockers, verification storage/delivery failures and explicit reconciliation. Watchdog excludes valid human waits, pending decisions, active handoffs, Runtime-owned verification and working accepted panes.

A confirmed weakness was found in the host watchdog lifecycle boundary: during progressive activation `workspace` could be present while `manifest` was still absent, yet the watchdog dereferenced `manifest!.conversationSessionId`. The active host log contains the corresponding `TypeError`. The correction adds a shared `shouldRunWatchdog` guard to both the timer and worker. The guard skips that interval rather than converting activation into a host error. The regression test is `packages/runtime/test/agentic/host-watchdog-lifecycle.test.ts`.

### F. Environment and deployment failures

The installed launcher `/home/baodq/.local/bin/bflow` resolves to this checkout's `apps/cli/dist/bin.js`, but the active host processes were started before the current checkout/build. The persisted incident execution plan remains pinned to `a46ab103…`, platform generation 59. Thus source/build/host alignment is not proven. The active host was not restarted during this audit because it has live panes and in-flight work.

## Highest-risk combinations selected

1. **Large verification envelope + real child launch + lost acknowledgement.** Confirmed historically as E2BIG; current source has bounded projection/reference and exact pre-launch recovery.
2. **Role/pane replacement + accepted handoff + delayed result.** Safety is covered by binding/session/fence checks; liveness may require operator reconciliation.
3. **Lease expiry during a borrowed task notice + host tick.** Fail-closed cancellation/revival exists; repeated errors show operational churn but not duplicate dispatch.
4. **Journal lock contention + watchdog/reconciliation timer.** Bounded error is surfaced; no evidence of silent state loss, but lock timing is a liveness risk.
5. **Progressive activation + watchdog tick before manifest installation.** Reproduced from source/log evidence; corrected with a lifecycle guard.
6. **Provider trust/auth/sandbox failure + otherwise idle pane.** Correctly not inferred as success; live provider-specific proof remains open.

## Findings summary

| ID | Finding | Status | Correction |
|---|---|---|---|
| F-SYS-01 | Unbounded verification launch context could cross `execve` limit | Confirmed historical root cause; current source mitigated | Bounded policy projection, durable reference, exact pre-launch reconciliation |
| F-SYS-02 | Watchdog dereferenced an activation-only manifest | Confirmed source/log liveness defect | Guard watchdog on workspace + manifest + lifecycle state |
| R-SYS-03 | Generic Herdr reconciliation cannot always prove prompt-specific delivery after restart | Source-supported risk, not incident-confirmed | Keep fail-closed; run isolated native receipt probe and retain operator action |
| R-SYS-04 | Parent lease mismatch and journal lock timeout can produce repeated host errors | Confirmed operational symptoms; independent root cause unconfirmed | Preserve fail-closed behavior; collect post-restart evidence before changing lease/lock semantics |
| R-SYS-05 | Default CI does not prove live provider/Herdr/full SDLC behavior | Confirmed evidence gap | Scheduled bounded live probes, never a claim of full acceptance |
