# Bflow Runtime Cutover Report

**Validation date:** 2026-10-30 (Asia/Bangkok)
**Repository:** `/mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC`
**Scope:** read-only operational snapshot and deployment-candidate verification.
**Authorization state:** **cutover not authorized; no lifecycle mutation performed**.

## Executive decision

The active Bflow host must **not** be restarted, shut down, replaced, or otherwise mutated from this report. The snapshot contains durable unfinished work and uncertain ownership:

- PID `1781403` is alive and runs the repository Runtime host.
- Durable SQLite state reports one `running` Core run and one `cancelling` Core run, despite the manifest projection reporting `activeRunIds: []`.
- The cancelling run has two durable `agent.execution_bound` records targeting Developer worktrees that are no longer present in the current pane manifest.
- Four current Developer bindings are disconnected. One contains valuable uncommitted changes; the other three are clean but retain task branches and durable worktree state.
- Ten Registry leases are marked `active`, but all are expired relative to the current clock. They are stale authority records, not safe candidates for release.
- The current host is not proven to have loaded the verified Runtime build. Its persisted execution-resolution revision is `a46ab103…`; the current source is `58ef1fa…`, and the rebuilt Runtime artifact was written after the host started.

The safe outcome is to preserve all state and obtain explicit operator authorization after exact run, external-operation, worktree, and pane ownership reconciliation. `bflow status` reporting `UP` is not treated as cutover or recovery proof.

## 1. Pre-cutover state classification

### 1.1 Current process and Herdr session

| Item | Observed value | Classification |
|---|---|---|
| Runtime host | PID `1781403`, alive | Current process; do not interrupt without authorization |
| Host command | `node .../packages/runtime/dist/agentic/host.js daemon .../state/host/bf-c1695.../host.json` | Path identity only; does not prove loaded bytes |
| Process start | `2026-10-30 14:23:33 +07:00` | Predates current Runtime artifact mtime and watchdog commit |
| Herdr | `0.9.5`, protocol 22/schema 1; session `bf-c1695ccd3f2b994f91bd` running | Physical session remains live |
| Manifest | status `up`, `activeRunIds: []`, permanent roles idle, four Developers disconnected | Projection is inconsistent with durable Core state |
| `bflow status --json` | server running, manifest live, no reported issues | Diagnostic status only; not workflow or build proof |
| `bflow doctor --json` | `healthy: false` overall, with runtime/provider checks mostly passing | Not a cutover gate; does not attest loaded host artifact |

Permanent Conversation and Coordinator panes are present and idle in the current manifest. This does not prove that their host process or provider processes loaded the current source/build.

### 1.2 Durable Core runs

The authoritative read-only SQLite database is:

`/home/baodq/.local/state/bflow/repositories/f2ef45faade8b3b62a95bf88161e480238fa965a80c6f928e2920c57fac845f1/state/agentic/runs.db`

It is open by the host (PID fd `22`). The relevant durable rows are:

#### Run `run-web-440e69ac-4e10-4b69-a590-abe19bdc9c40`

- Status: **`running`**.
- Workflow: `wf-deepwiki-440e69ac`.
- Task: `task-deepwiki`, status **`running`**, attempt `1`, generation `0`.
- Created: `2026-10-30T03:55:59.979Z`.
- Task became running: `2026-10-30T04:02:51.316Z`.
- Last durable event: sequence `6`, no terminal result, no verified task-success evidence.
- The current manifest does not list this run in `activeRunIds`; that is a stale/incomplete projection, not evidence that the run is inactive.

**Classification:** active unfinished Core work. External execution ownership is unresolved from the current projection. Do not restart until the run is reconciled by exact run/task/attempt identity.

#### Run `run-web-16f901d5-1ce6-46a9-b305-9e5c95bc0568`

- Status: **`cancelling`**.
- Tasks `t1` and `t2`: **`cancelling`**, attempt `1`, with durable `agentExecution` handles.
- Task `t1` target: `dev-d3e75872d7a2a61702a1`, workspace `w2`, pane `w2:p2`, worktree `task-2b3541...`.
- Task `t2` target: `dev-b30b0a2416e6bdc6305f`, workspace `w3`, pane `w3:p2`, worktree `task-340b6e...`.
- The two handles were durably bound at `2026-10-29T17:17:23.689Z` and `2026-10-29T17:17:55.117Z` respectively.
- The run entered cancellation at `2026-10-29T17:33:00.963Z` and has not reached a terminal `cancelled` state.
- The current manifest no longer contains `w2`/`w3` bindings.

**Classification:** potentially active external operations with durable execution handles, and an unresolved cancellation. A host reopen could alter reconciliation timing. Operator authorization and exact Herdr/process reconciliation are required.

Other SQLite runs include terminal historical runs. They were not treated as active merely because their artifacts, events, or leases remain stored.

### 1.3 External operations and delivery

The current snapshot does not prove that either active/cancelling Core run has completed an external side effect:

- Run `440e69ac…` has a running task but no `agentExecution` in its current aggregate snapshot. This means ownership is unresolved, not safely absent.
- Run `16f901d5…` has two durable execution handles and a cancellation request, so the corresponding Developer operations must be reconciled before any resend, restart, or cleanup.
- The durable journal is version `6`, with `381` outbound records, `83` inbox records, `0` `pendingCore`, and `0` `pendingVerifications`.
- Outbound records globally include `accepted`, `delivered`, `released`, and `cancelled` states. The journal contains six `unknown_delivery` markers and many `uncertain`/`reconcile` records. The read-only snapshot did not establish that any one of those markers belongs to run `440e69ac…` or `16f901d5…`.
- The host log contains 15 native-delivery uncertainty messages, including “inspect/reconcile before replay”. These are historical/retained log evidence, not proof of a new delivery from PID `1781403`.

**Required behavior:** keep any exact unknown delivery fail-closed. Do not resend until the exact request identity is authoritatively reconciled as `not_delivered`; adopt an exact handle only if reconciliation proves it was bound.

### 1.4 Disconnected Developer binding classifications

All four bindings below are `transportState: disconnected`, have released allocation metadata, and retain their task/run identity. No pane replacement or worktree cleanup was performed.

| Binding | Durable identity | Worktree state | Classification | Safe next action |
|---|---|---|---|---|
| `w4:p2` / `dev-b2e9c8ac33c89300dc87` | Run `run-web-941c028d…`, task `task-installer`; released `2026-10-29T19:26:21Z` | Clean; branch HEAD `2ea5f781…` | **Stale resource candidate, but not yet eligible for automatic cleanup**. No uncommitted work observed; task/run receipts remain durable. | Reconcile exact run terminal state, execution handle, lease/fence and external side effects; then operator may authorize controlled cleanup. |
| `w5:p2` / `dev-912539a312407eef3403` | Run `run-web-3136f92f…-r2`, task `task-deepwiki`; released `2026-10-29T22:52:33Z` | Clean; branch HEAD `9a7f762…` | **Orphaned completed-looking worktree with retained valuable branch history; potentially active is not proven absent**. Run is historically cancelled in SQLite, but physical process ownership was not independently observed. | Preserve branch/worktree. Reconcile provider process/session and exact cancellation before controlled cleanup. |
| `w6:p2` / `dev-d2e67587282329604fee` | Run `run-web-ef31aae3…-r2`, task `task-deepwiki`; released `2026-10-30T00:21:13Z` | **Uncommitted changes:** seven Context7-retirement files deleted; HEAD `5afaf268…` | **Orphaned but containing valuable work; safely recoverable only by preservation, not cleanup**. The changes are not disposable residue. | Freeze the worktree, capture its diff/commit identity, reconcile its run and any external operation, then decide whether to hand over or commit/recover through Runtime. Do not reset or delete. |
| `w7:p2` / `dev-e7c4c6dc8f8b30a498f6` | Run `run-web-322edf6c…`, task `task-deepwiki`; released `2026-10-30T03:55:16Z` | Clean; branch HEAD `59b046c…` | **Stale resource candidate, but not yet eligible for automatic cleanup**. Run is historically cancelled; pane/process absence was not independently proven. | Reconcile exact cancellation and provider process/session, then operator may authorize controlled cleanup. |

The older `w2` and `w3` worktrees referenced by the still-`cancelling` Core run are also retained and clean in the filesystem snapshot. They are not current manifest bindings and are therefore **unresolved cancellation resources**, not cleanup candidates.

### 1.5 Leases

Registry file:

`.../state/agentic/registry.json`

Observed facts:

- Schema version `1`.
- `155` lease records.
- `10` records have `active: true`.
- All ten are expired relative to the inspection clock (`2026-10-30T17:09:57+07:00`); the latest observed expiry was still many hours earlier.
- Registry `lastNow` is `2026-10-30T04:07:10.448Z`, so the registry’s own persisted clock is stale as well.
- No lease was released, renewed, rewritten, or force-cleared.

The ten active flags include the two Developers and Coordinator/QA operations associated with the still-cancelling run, plus older Developer/Coordinator/QA records from cancelled or interrupted runs. They are **stale records requiring exact identity reconciliation**, not proof that capacity is safely available and not proof that a resource is safe to force-release.

### 1.6 Journal and checkpoint identity

Preserve these objects as the pre-transition evidence set:

- SQLite RunStore: `state/agentic/runs.db` (host fd `22`), with `runs`, `events`, `checkpoints`, `receipts`, and `command_receipts` tables.
- Journal state: `state/agentic/journal/state.json`, version `6`; `381` outbound, `83` inbox, zero pending Core/verification lists.
- Journal lock: `state/agentic/journal/lock`, observed open by PID fd `32`.
- Journal state file: `state/agentic/journal/state.json`, observed open by PID fd `35`.
- Registry: `state/agentic/registry.json`, `155` lease records.
- Host configuration: `state/host/bf-c1695ccd3f2b994f91bd/host.json`.
- Platform launch journal: `state/platform/bf-c1695ccd3f2b994f91bd/launch-journal.jsonl`.
- Current pane manifest: `.bflow/state/panes/bf-c1695ccd3f2b994f91bd.manifest.json`.
- Current repository session projection: `.bflow/state/session.json`.
- All `.bflow/state/worktrees/**` directories, including clean and dirty worktrees.

No state was reset, deleted, compacted, rewritten, or force-released.

## 2. Deployment candidate identity

### 2.1 Source and working tree

- Current Git HEAD: `58ef1fa800550de9a63d79db4565c0b4b2972f2e` (`doc: runtime live test`).
- Working tree: clean; branch `main` is ahead of `origin/main` by five commits.
- Watchdog correction commit: `5b76ccb…` (`fix(runtime): harden watchdog lifecycle reliability`).
- Current Runtime source SHA-256: `74bf90ae72cf3eb472f06798b4664aed1f42d7a08699cae67fba9832722afe16`.
- The source exports and uses `shouldRunWatchdog`, requiring workspace + manifest and rejecting quiescing/closing states.
- The source contains the existing bounded E2BIG/pre-launch recovery path; this audit did not replace or weaken it.

### 2.2 Built artifacts and launcher

| Artifact | SHA-256 | Mtime | Observation |
|---|---|---|---|
| `packages/runtime/dist/agentic/host.js` | `d8c6e60f…17cada` | `2026-10-30 16:28:07 +07:00` | Contains the watchdog guard according to the prior build inspection |
| `apps/cli/dist/bin.js` | `adc8a9e2…a536` | `2026-10-29 14:27:55 +07:00` | Older CLI artifact; not rebuilt in the Runtime build observation |
| `/home/baodq/.local/bin/bflow` | `1fea30a4…0bcc1` | managed launcher | Identical to `/home/baodq/.local/share/bflow/bin/bflow`; invokes this checkout’s `apps/cli/dist/bin.js` with Node `v24.16.0` |

The intended candidate for a controlled reopen is the clean source/build pair recorded above, but the CLI artifact is older than the current source history and must be explicitly verified/rebuilt as part of preparation. No rebuild or restart was initiated during this audit.

### 2.3 Persisted execution-resolution identity

`host.json` contains a Platform v3 execution resolution whose repository revision is:

`a46ab103428aa52e13d353c13eaf5286a92d30b4`

It also contains `119` execution source digests. This is evidence of the resolved private inputs used by the persisted host configuration, not proof of the bytes loaded into PID `1781403`. It differs from current Git HEAD `58ef1fa…`.

No host-start attestation was found that binds, in one durable receipt, all of:

- source revision;
- loaded Runtime artifact digest;
- loaded CLI/build digest;
- host PID and process start time;
- Herdr session identity; and
- Runtime/platform generation.

The existing provider/pane startup receipts prove provider/native startup paths for roles; they do not establish the Runtime host module identity. A minimal host-start attestation is therefore still a cutover acceptance requirement. It was not added during this read-only phase because doing so would require source/build/lifecycle changes while live work is unresolved.

## 3. Timestamp discrepancy and log attribution

The host process and retained log do not describe one uniformly current observation window:

| Evidence | Timestamp |
|---|---|
| PID `1781403` process start | `2026-10-30 14:23:33.170 +07:00` |
| `host.json` mtime | `2026-10-30 14:23:33.143 +07:00` |
| Rebuilt Runtime `host.js` mtime | `2026-10-30 16:28:07.493 +07:00` |
| Current source correction commit | `2026-10-30 16:42:06 +07:00` |
| Current HEAD documentation commit | `2026-10-30 17:08:48 +07:00` |
| Host log mtime | `2026-10-30 12:14:38.388 +07:00` |
| Current inspection | approximately `2026-10-30 17:10 +07:00` |

PID `1781403` stdout and stderr both point to the same host-log inode, but that inode’s mtime remains before the process start. The log therefore appears to be retained historical output or an inherited pre-existing file descriptor; it is not evidence that PID `1781403` emitted its final entries. The old watchdog `TypeError`, 6,648 parent-lease mismatch lines, one journal-lock timeout, and native-delivery uncertainty messages are recorded as **historical/retained anomalies** until a new process-generation observation proves recurrence.

Do not attribute those entries to the current process merely because its command line names the same log path.

## 4. Authorization boundary and required operator decisions

**Operator authorization is required before any of the following:**

1. `bflow down`, `bflow up`, `bflow recover`, host restart, or service restart affecting PID `1781403`.
2. Herdr session stop, pane close/replacement, or Developer rebinding.
3. Lease release/renewal, registry repair, cancellation completion, or journal reconciliation that mutates durable state.
4. Worktree reset, branch deletion, worktree deletion, or cleanup of any `w2`–`w7` resource.
5. Any resend or replay of an accepted/uncertain external operation.

Before authorization, the operator must decide:

- whether the two handles in cancelling run `16f901d5…` are known to have stopped, or require live Herdr/provider/process reconciliation;
- whether run `440e69ac…` should be resumed, held, or cancelled through its supported Runtime path;
- whether the dirty `w6` worktree is to be handed over as valuable work, preserved for later review, or deliberately abandoned after an explicit decision;
- whether clean `w4`, `w5`, and `w7` resources may be cleaned after exact cancellation and lease reconciliation;
- whether the stale active Registry flags should be left for Runtime reconciliation or repaired through a supported command; and
- whether the intended candidate includes a fresh CLI build and a newly written host-start attestation.

## 5. Pre-transition report and rollback procedure

### Pre-transition evidence captured

The report’s snapshot is keyed to:

- PID `1781403`, start `2026-10-30 14:23:33 +07:00`;
- Herdr session `bf-c1695ccd3f2b994f91bd`;
- Runtime host directory `state/host/bf-c1695ccd3f2b994f91bd`;
- RunStore, journal, Registry, manifest, session projection and all referenced worktrees;
- source HEAD `58ef1fa…`; and
- current Runtime/CLI artifact hashes listed above.

### Required controlled transition, if authorized later

1. Re-capture the same evidence and record byte sizes, mtimes, hashes, PID and process start time.
2. Confirm the operator’s decisions for both durable nonterminal runs and every disconnected binding.
3. Preserve/copy the report and all evidence paths without altering the authoritative files.
4. Use only the supported Bflow lifecycle mechanism to quiesce the host. Do not kill the PID, stop Herdr globally, delete worktrees, or force-release leases.
5. Reconcile cancellation and unknown delivery by exact run/task/attempt/request/message identity.
6. Prepare and build the candidate source/CLI pair; record a host-start attestation before declaring readiness.
7. Reopen through Bflow, then verify the new PID/start time, loaded artifact digest, source revision, session ID and platform generation.
8. Verify permanent Conversation/Coordinator readiness and separately reconcile each Developer binding.
9. Observe only events emitted by the new PID/generation. Do not count old host-log entries as post-reopen failures.

### Rollback

If the new process fails startup or its attestation does not match the authorized candidate:

- stop the transition through the supported Bflow lifecycle path;
- do not delete or rewrite the RunStore, journal, Registry, receipts, checkpoints, or worktrees;
- retain the failed-generation attestation and logs as evidence;
- reopen only the previously authorized known-good build, with the same durable state and exact reconciliation rules; and
- if delivery or lease ownership remains uncertain, leave the operation blocked/escalated rather than replaying or force-releasing it.

Rollback is not authorization to restore an older source by resetting Git or to discard the current worktree evidence.

## 6. Transition actions performed

**None.** Specifically, this validation performed no:

- host restart or shutdown;
- `bflow down`, `bflow up`, or recovery mutation;
- Herdr session stop or pane replacement;
- Developer rebinding;
- lease release/renewal/repair;
- journal/SQLite write or compaction;
- worktree reset/deletion/cleanup; or
- external dispatch/replay.

Read-only commands inspected source, process metadata, manifests, SQLite, JSON state, Registry, worktree status and build/launcher identity.

## 7. Post-reopen validation results

No reopen occurred, so there are no post-reopen results. The following remain **not tested** for the new generation:

- loaded Runtime source/build attestation;
- permanent role readiness after reopen;
- Conversation/Coordinator availability after reopen;
- disconnected Developer reconciliation;
- duplicate-dispatch absence in the new generation;
- watchdog normal behavior in the new generation; and
- post-reopen lease, journal and delivery anomaly counts.

The previously recorded local/build/native-smoke evidence remains separate evidence and is not upgraded to live post-reopen acceptance by this report.

## 8. New anomalies versus historical anomalies

### New/currently established from read-only state

- Durable Core/manifest disagreement: SQLite has `running`/`cancelling` work while manifest `activeRunIds` is empty.
- Four disconnected current Developer bindings.
- One valuable dirty Developer worktree (`w6`); three current Developer worktrees clean.
- Two older worktrees (`w2`, `w3`) still referenced by durable cancelling execution handles but absent from the current manifest.
- Ten Registry leases marked active while all are expired relative to the inspection clock.
- Current host is not loaded-build-proven; persisted execution-resolution revision differs from current HEAD.
- No host-level source/build/PID/session/generation attestation was found.

### Historical/retained until a new-generation observation proves recurrence

- Watchdog `manifest!.conversationSessionId` `TypeError`.
- `6,648` parent lease mismatch log entries.
- One journal lock timeout log entry.
- Fifteen native-delivery uncertainty log entries.
- The host log’s final contents generally, because its mtime predates the current PID start and the current process has not advanced that inode’s mtime.

## 9. Unresolved recovery risks

1. **External operation ownership:** durable execution handles in `16f901d5…` may correspond to provider work not observed by the current manifest.
2. **Run projection disagreement:** `activeRunIds: []` must not suppress the SQLite `running` run.
3. **Dirty worktree loss:** `w6` contains seven uncommitted deletions and must not be reset or deleted.
4. **Stale leases:** active flags are expired, but force-release could violate fencing/ownership assumptions.
5. **Unknown delivery:** exact current-run association is not proven; all uncertainty remains fail-closed.
6. **Loaded build:** the command path is known, but loaded bytes are not. The process predates the current artifact and source correction.
7. **CLI/build skew:** `apps/cli/dist/bin.js` predates the current Runtime build; candidate preparation must verify/rebuild it explicitly.
8. **Historical log ambiguity:** prior failures cannot be counted as current-generation failures without a new PID/generation observation.
9. **Live acceptance gap:** no full SDLC workflow or paid model canary was run, and no such run is authorized by this report.

## 10. Gate B and Gate D status

| Gate | Status | Reason |
|---|---|---|
| **Gate B — intended Runtime revision proven loaded** | **FAIL / OPEN** | PID `1781403` started before the current Runtime artifact and watchdog correction commit; persisted resolution is `a46ab103…`, current HEAD is `58ef1fa…`; no host-start attestation binds loaded artifact/source/PID/session/generation. |
| **Gate D — no unresolved deployment-critical issue** | **FAIL / BLOCKED** | Durable nonterminal runs, unresolved cancellation handles, disconnected Developers, dirty valuable worktree, stale active leases, delivery uncertainty, and ambiguous historical log attribution remain. |

## Evidence and commands

Primary state:

- `state/agentic/runs.db`
- `state/agentic/journal/state.json`
- `state/agentic/registry.json`
- `state/host/bf-c1695ccd3f2b994f91bd/host.json`
- `state/host/bf-c1695ccd3f2b994f91bd/host.log`
- `state/platform/bf-c1695ccd3f2b994f91bd/launch-journal.jsonl`
- `.bflow/state/panes/bf-c1695ccd3f2b994f91bd.manifest.json`
- `.bflow/state/session.json`
- `.bflow/state/worktrees/**`

Representative read-only checks:

```text
ps -p 1781403 -o pid,ppid,lstart,stat,etime,cmd
bflow status --json
bflow doctor --json
herdr --version
herdr session list --json
sqlite3 'file:<runs.db>?mode=ro' '.schema'
git status --short --branch
git rev-parse HEAD
sha256sum packages/runtime/src/agentic/host.ts packages/runtime/dist/agentic/host.js apps/cli/dist/bin.js
```

This report is a pre-transition decision record, not a declaration that the host is healthy, current, recovered, or ready for a full workflow.
