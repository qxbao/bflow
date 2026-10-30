# Bflow Live Runtime Validation

**Validation date:** 2026-10-30 (Asia/Bangkok)  
**Repository:** `/mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC`  
**Validation scope:** deployment truth, pre-deployment checks, non-destructive live-boundary checks, and canary readiness.  
**Evidence rule:** source/build tests, host state, and live Herdr observations are reported separately. A transport receipt is not treated as task success.

## Executive result

The source correction is committed and the rebuilt artifact contains it, but the active repository host is **not proven to have loaded that artifact**. The host process started at `2026-10-30 14:23:33 +07:00` (PID `1781403`), while the watchdog correction commit is `5b76ccbc4aeded6e0f04ddcb4092dc2d393785ee` at `16:42:06 +07:00`; the rebuilt `packages/runtime/dist/agentic/host.js` was written at `16:28:07 +07:00`. The active process therefore predates both the correction commit and the current build artifact mtime. Its retained log still contains the old `manifest!.conversationSessionId` `TypeError`.

No restart or destructive `down`/`up` was executed. The active session has permanent Conversation/Coordinator/specialist roles and four disconnected Developer bindings with locked worktrees, so an operator-controlled transition is required before changing the loaded runtime. Durable state was preserved.

**Overall status: deployment not closed; live full-SDLC acceptance not authorized.**

## Gate summary

| Gate | Status | Evidence and disposition |
|---|---|---|
| **A — Source and existing tests** | **PASS for scoped evidence; standard suite not closed** | Clean source at `5b76ccbc…`; build, dependency graph, typecheck, focused Runtime/Herdr tests, E02/E03, E11, and native Herdr tests passed. The standard `pnpm test` was interrupted after observed timeout failures and Gateway health timeouts; no full CI-equivalent pass is claimed. |
| **B — Intended runtime revision proven loaded** | **FAIL** | Active PID `1781403` predates the correction commit and current artifact mtime. No runtime self-reported source/build revision was found that can prove the loaded module identity. Old watchdog `TypeError` remains in the active host log. |
| **C — Herdr native boundary** | **PASS for the bounded smoke** | Real Herdr `0.9.5`, protocol `22`, isolated named sessions, native actor without a paid model, signed message receipt ingress, and reconciliation behavior passed. The message was received/authenticated by the ingress test, while business binding remained unverified and task status remained `running`. |
| **D — No unresolved deployment-critical issue** | **FAIL** | Stale active host, four disconnected Developer bindings, 6,648 parent-lease mismatch log lines, one journal lock timeout, old watchdog TypeErrors, and repeated uncertain native-delivery notices remain. These are not cleared by local tests. |
| **E — Full-run canary ready for authorization** | **BLOCKED / plan prepared** | The canary plan is defined below, but authorization must wait for a controlled reopen on the intended build and a clean post-reopen anomaly observation. No paid full run was started. |

## 1. Deployment truth

### Source revision

- Git branch: `main`.
- Working tree: clean at inspection (`git status --short --branch` reported `main...origin/main [ahead 4]` with no file changes).
- Source HEAD: `5b76ccbc4aeded6e0f04ddcb4092dc2d393785ee`.
- Commit subject: `fix(runtime): harden watchdog lifecycle reliability`.
- Watchdog correction is committed in `packages/runtime/src/agentic/host.ts`.
- The correction exports `shouldRunWatchdog` and guards both the worker and timer while `workspace`/`manifest` activation state is incomplete, or while the host is quiescing/closing.

The source also retains the earlier E2BIG mitigation and pre-launch recovery changes (`3c64964`, `106502f`, `0594f92`, and related history). The current build contains the bounded prompt/recovery code; no source redesign was performed during this validation.

### Build artifacts

The standard build completed successfully:

```text
pnpm run build
# tsc -b: PASS
# @bflow/web production build: PASS (vite 6.4.1)
```

Observed artifact identity at the time of inspection:

| Artifact | Size | Mtime (+07) | SHA-256 | Watchdog correction visible |
|---|---:|---|---|---|
| `packages/runtime/dist/agentic/host.js` | 320,216 bytes | 2026-10-30 16:28:07 | `d8c6e60fda5ac3314c3af5cead92cb1f4680c2f222c35e533a87a77dbe17cada` | **Yes**; contains `shouldRunWatchdog` and both guard sites |
| `packages/runtime/dist/agentic/host.js.map` | 256,389 bytes | 2026-10-30 16:28:07 | `7e45e3d13408256a56b1bce80cb64c86f4e7ed84fa077c083a4bd611e88829c1` | Source map present |
| `apps/cli/dist/bin.js` | 11,674 bytes | 2026-10-29 14:27:55 | `adc8a9e28184a13b04a5e72812f1a69d31f4ef8da06a0c4ed02e52a94856a536` | CLI artifact predates the current runtime build |

The installed launcher is a managed shell script at `/home/baodq/.local/bin/bflow`, identical to `/home/baodq/.local/share/bflow/bin/bflow` (SHA-256 `1fea30a4be0eaf20c6feb7a433a1bcbcd9b3213e9d9d2dec610cdd0d4300bcc1`). It invokes the repository checkout's `apps/cli/dist/bin.js` using Node `v24.16.0`; it is not a separately versioned package install.

### Loaded host process

The active host is:

```text
PID:       1781403
Started:   Fri Oct 30 14:23:33 2026 +0700
Command:   node /mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC/packages/runtime/dist/agentic/host.js daemon <...>/state/host/bf-c1695.../host.json
CWD:       /mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC
Node:      /home/baodq/.local/share/fnm/node-versions/v24.16.0/installation/bin/node
```

The command path proves which file the process was launched from, but does **not** prove the file contents loaded into memory. The process started before the current artifact was built and before the correction commit existed. No verifiable loaded source/build revision was exposed by the host state or process metadata. Therefore the loaded host identity is **unproven and treated as stale**.

### Persisted platform and execution state

- Repository config session: `bf-c1695ccd3f2b994f91bd`.
- Repository ID: `c1695ccd3f2b994f91bd366979199fda4bb91e747d49abcde9829a5650ac2902`.
- Persisted platform schema: `3`.
- Persisted platform generation: `59`.
- Persisted platform state contains Claude roles using `workspace_auto`; the configured repository does not record a source commit or build digest that can be used as loaded-host proof.
- `activeRunIds` is empty in `.bflow/state/session.json`; no active Core run was reported by the repository session projection.
- Persisted platform launch records identify provider/launch IDs but do not pin the current Git revision. They must not be used as proof that PID `1781403` loaded HEAD.
- The persisted state contains many historical launch receipts and native-session records. They are retained and were not deleted or rewritten.

### Herdr/session state

- Installed Herdr: `0.9.5`.
- Repository session `bf-c1695ccd3f2b994f91bd` is reported `running` by `herdr session list`.
- `bflow status` reports the repository `UP`, Herdr `RUNNING`, and `7/11` roles ready.
- Permanent Conversation, Coordinator, Planner, Architect, Specifier, Reviewer, and QA bindings are `idle` in the current manifest projection.
- Four dynamic Developer bindings (`w4:p2`, `w5:p2`, `w6:p2`, `w7:p2`) are `disconnected`; their Bflow-managed worktrees are locked and were not removed.
- No destructive session or worktree command was run.

## 2. Pre-deployment validation

### Commands and results

| Command | Result | Notes |
|---|---|---|
| `pnpm run build` | **PASS** | TypeScript build and web production build completed. |
| `pnpm run check:deps` | **PASS** | 24 packages, 54 internal edges; no dependency cycles or escaping relative imports. |
| `pnpm run typecheck` | **PASS** | Root TypeScript and web typecheck completed. |
| Focused watchdog tests | **PASS** | `host-watchdog-lifecycle.test.ts` (2) + `notice-watchdog.test.ts` (23): **25/25**. |
| Focused boundary tests | **PASS** | Manual review (26), task notices (27), Herdr adapter (30), Herdr reliability (40), policy prompt (9): **132/132**. Runtime was serial and took 55.81s. |
| E02/E03 E2E | **PASS** | **15/15**: crash/recovery and unknown-delivery reconciliation. 35.60s. |
| E11 with live platform/Herdr flags | **PASS** | **8/8**. Real host checks, Herdr compatibility, setup/repair/idempotency, doctor, and systemd-user service checks. 110.90s. |
| Live CLI Herdr smoke | **PASS** | Real isolated named sessions `p12a`/`p12b`; protocol 22; selective stop preserved the second session. No model agents started. |
| Live native Herdr receipt smoke | **PASS** | Real isolated session `smoke`; protocol 22; native actor; `submissionStatus=unknown_delivery`, `authenticatedMessageReceived=true`, `bindingVerified=false`, task status `running`. |
| `pnpm test` | **NOT PASS / incomplete** | Started with output redirected to `/tmp/bflow-pnpm-test.log`, but the run was interrupted after it stopped making progress. Before interruption the log contained multiple Runtime host-RPC test timeouts (20–30s) and Gateway protocol health timeouts. No full-suite pass is claimed. |

A previous broad focused invocation was intentionally interrupted because it produced excessive interactive output and included long-running lifecycle tests. It is not counted as a pass. The bounded reruns above are the authoritative focused results.

### Correction-specific checks

- **Watchdog activation guard:** source and rebuilt artifact both expose `shouldRunWatchdog`; the focused lifecycle and 23-case watchdog suite passed. This proves the guard's local behavior and normal watchdog coverage, but not behavior in the active process.
- **Normal watchdog activity:** `notice-watchdog.test.ts` passed the normal active-workspace cases; no source change suppresses normal activity once a manifest exists.
- **Bounded prompt projection:** policy/manual-review focused tests passed, including oversized policy review paging/projection and manual evidence fencing.
- **Pre-launch recovery:** focused policy prompt/manual review and E02/E03 recovery coverage passed; exact unknown delivery remains fail-closed and no blind resend occurs.
- **Live host proof:** not available until controlled reopen. The active host log still includes the pre-correction watchdog exception.

## 3. Safe host transition

### Action taken

No restart, `bflow down`, `bflow up`, pane close, session stop, worktree deletion, lease release, or durable-state cleanup was executed.

This was the safe action because:

1. The session is marked `up` and has active permanent role processes.
2. Four dynamic Developer bindings are disconnected and point to locked worktrees.
3. Persisted host and receipt/journal state is extensive and includes uncertain native-delivery records.
4. The current process is not proven to have loaded the corrected artifact.
5. A restart without operator review could alter recovery behavior for disconnected roles and pending external side effects.

### Required operator authorization before reopen

Authorize a controlled host transition only after confirming that the four disconnected Developer worktrees are not awaiting an external side effect or human handover. Preserve the host journal, checkpoints, receipts, `.bflow/data/runs.db`, and all locked worktrees. Use the existing lifecycle commands; do not delete state or perform a blind down/up cycle.

The controlled transition should:

1. Capture `bflow status --json`, `bflow doctor --json`, Herdr session/pane state, worktree status, host PID/start time, and a journal/checkpoint snapshot.
2. Confirm no task is in a non-replayable external operation.
3. Reopen through the existing Bflow lifecycle.
4. Record the new PID/start time and artifact hashes **after** the build.
5. Require a host-start receipt or equivalent runtime self-report pinning source revision/build digest before marking Gate B passed.
6. Verify all permanent roles and the Conversation pane, then reconcile disconnected Developer bindings explicitly.
7. Re-run the native smoke and inspect the post-reopen log for watchdog TypeError recurrence.

## 4. Herdr native boundary results

The native smoke used an isolated named Herdr session and a custom native actor, not a paid model provider. It produced:

```json
{
  "evidence": "herdr-native-plugin-message",
  "protocol": "22",
  "session": "smoke",
  "submissionStatus": "unknown_delivery",
  "authenticatedMessageReceived": true,
  "bindingVerified": false,
  "taskStatus": "running",
  "modelProviderUsed": false
}
```

Interpretation:

- Herdr session initialization and protocol compatibility worked.
- A native message was submitted with a correlated identity and delivered to the receipt ingress.
- The authenticated receipt/message path worked in the isolated smoke.
- The operation remained `unknown_delivery` at the transport submission boundary, so the test correctly forbade treating it as a verified execution binding.
- The workflow task remained `running`; this is not task completion evidence.
- The live CLI smoke separately proved two isolated named sessions can coexist and be selectively stopped without stopping the other session.

This is sufficient for Gate C's bounded native transport check, not for full workflow acceptance.

## 5. Operational anomaly review

### Observed in the active host

The active host log at `/home/baodq/.local/state/bflow/repositories/f2ef45fa.../state/host/bf-c1695.../host.log` contains:

- **5** old watchdog `TypeError: Cannot read properties of undefined (reading 'conversationSessionId')` entries, including the final log region.
- **6,648** `Task notice parent lease is expired or mismatched` entries.
- **1** `Journal lock timeout` entry.
- Repeated native-delivery uncertainty and reconciliation messages.
- The log mtime is `2026-10-30 12:14:38 +07:00`; the file is retained as historical/active-host evidence, not modified by this validation.

### Classification

| Anomaly | Current classification | Progress impact | Required next evidence |
|---|---|---|---|
| Watchdog activation `TypeError` | Confirmed old-host symptom; source correction is present locally but not loaded-host proven | Deployment-critical because the active process identity is stale/unproven | Controlled reopen, new PID/start receipt, and post-reopen log observation |
| Parent lease mismatch | Fail-closed behavior is covered by focused tests; repeated active-host symptom; independent root cause unconfirmed | Can prevent task notices/recovery progress; no lease semantics changed | Correlate message/task/parent lease IDs, Registry version/fence history, and post-reopen recurrence |
| Journal lock timeout | Bounded fail-closed lock behavior; independent contention/deadlock root cause unconfirmed | Potential liveness delay; no unsafe unlocked access introduced | Capture lock-holder timing and operation identity after reopen |
| Unknown native delivery | Expected safety state when authoritative prompt-specific receipt is unavailable | Blocks automatic replay; prevents duplicate side effects | Exact-identity reconciliation or operator action; do not resend blindly |
| Disconnected Developers | Persisted lifecycle/resource condition; not proof of task success or failure | May require explicit reconciliation before any reopen | Inspect each worktree, task handover, lease, and external side-effect state |

No lease/fencing or journal-lock semantic change was made based on log frequency alone.

## 6. Full-run canary plan (prepared, not executed)

The full canary remains blocked pending Gate B and Gate D. Once the operator authorizes it after a successful controlled reopen, use this fixed plan:

1. Create a disposable local Git repository outside the production checkout, with a known initial commit and no protected-branch merge target.
2. Initialize Bflow for that repository using the existing CLI and a dedicated Bflow/Herdr session.
3. Use real Herdr and the configured real coding providers. Do not claim provider readiness from version output alone; record provider preflight, permission mode, sandbox/isolation result, and role/pane readiness.
4. Run one bounded request through Conversation → Coordinator → specification/SDD approval → planning → Developer implementation → Reviewer/QA verification → Git integration → delivery.
5. Choose a small task where Conditional TDD has an unambiguous decision and record the resolver output. If `required`, preserve Red/Green/Refactor evidence; if `recommended` or `not_applicable`, preserve the selected alternative evidence.
6. Set bounded concurrency (`maxConcurrency=1` or `2`), an explicit wall-clock timeout, and an explicit provider/model cost ceiling before starting.
7. Record run ID, task IDs, assignment/attempt IDs, role/agent/pane IDs, message IDs, request IDs, lease/fence versions, receipt/reconciliation IDs, worktree paths, commits, verification artifacts, and final gate decisions.
8. Permit no production deployment and no automatic protected-branch merge. Preserve the disposable repository, worktrees, journal/checkpoint state, and failure bundle.
9. Treat Herdr `done`, idle panes, model output, and authenticated transport receipt as transport/progress evidence only; require correlated verified Runtime/Quality-Gate evidence for business success.
10. Stop on the first unknown delivery, lease/fence mismatch, journal timeout, stale pane, sandbox blocker, or missing correlated result. Do not increase global timeouts or weaken security requirements.

**Authorization condition:** do not execute the paid full run until the operator explicitly authorizes it after Gate B and Gate D are closed.

## 7. Remaining risks and operator actions

1. **Reopen the active host on the intended build** after inspecting the four disconnected Developer worktrees and any pending external effects.
2. **Prove loaded identity**, not just command path: persist source revision, build/artifact digest, PID/start time, and platform generation together in a host-start receipt.
3. **Reconcile disconnected Developer bindings** by exact task/worktree/lease identity; do not delete or auto-mark them successful.
4. **Recheck parent lease mismatch and journal-lock behavior** after reopen with correlated IDs and lock-holder timing; preserve fail-closed semantics.
5. **Keep unknown delivery blocked** until exact reconciliation proves `bound` or `not_delivered`; do not blind resend.
6. **Investigate the standard `pnpm test` timeout cluster** (including the Native role/Conversation host-RPC cases and Gateway protocol health timeout), then rerun the standard command to a terminal result before using “full CI-equivalent checks passed.”
7. **Do not infer full live SDLC reliability** from the native Herdr smoke, E02/E03 harness tests, E11 platform tests, or prior release reports.

## Evidence files and commands

- Source correction: `packages/runtime/src/agentic/host.ts`
- Watchdog regression: `packages/runtime/test/agentic/host-watchdog-lifecycle.test.ts`
- Watchdog suite: `packages/runtime/test/agentic/notice-watchdog.test.ts`
- Prompt/recovery coverage: `packages/runtime/test/agentic/policy-prompt.test.ts`, `manual-review-policy.test.ts`, `task-notices.test.ts`
- Herdr adapter coverage: `packages/herdr-adapter/test/herdr-adapter.test.ts`, `reliability.test.ts`
- Live native smoke: `packages/runtime/test/agentic/live-herdr.test.ts`
- Live CLI Herdr smoke: `apps/cli/test/environment-live.test.ts`
- Recovery E2E: `tests/e2e/scenarios/e02-crash-recovery.e2e.test.ts`, `e03-unknown-delivery.e2e.test.ts`
- Platform E2E: `tests/e2e/scenarios/e11-group-a-setup.e2e.test.ts`
- Active host log: `<BFLOW state>/host/bf-c1695ccd3f2b994f91bd/host.log`
- Existing reliability reports: `docs/reliability/systemic-hardening-report.md`, `runtime-invariants.md`, `boundary-failure-matrix.md`, `systemic-fault-model.md`, and `e2big-mitigation-validation.md`

## Closure status

- Source watchdog correction: **committed**.
- Current build contains watchdog correction and E2BIG/pre-launch mitigations: **verified**.
- Installed `bflow` launcher: **identified**, points to this checkout's CLI artifact.
- Active host loaded revision: **not proven; stale by start time**.
- Scoped pre-deployment validation: **passed**.
- Native Herdr boundary: **passed for bounded no-model smoke**.
- Active host deployment/reopen: **not performed; operator approval required**.
- Parent lease/journal anomalies: **observed; independent root causes unresolved**.
- Standard `pnpm test`: **not closed; interrupted after observed timeout failures**.
- Full live SDLC reliability: **not claimed**.
- Full-run canary: **plan prepared, execution not authorized**.
