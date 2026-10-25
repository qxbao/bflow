# Workflow liveness incident audit

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Audit performed read-only against source at `4ae219f2475b461721775276de6bacf8e0342c90` and the local session receipts for run `run-2228e9e91ff4a0c58e0dbf3491300480682b14aaac9993f66cb7e61ff04cac6f`. All timestamps below are UTC; add seven hours for the session's Bangkok local time.

## Durable incident trace

The active session was `bf-c1695ccd3f2b994f91bd`, generation 21. Its private durable state is rooted at `/home/baodq/.local/state/bflow/repositories/f2ef45faade8b3b62a95bf88161e480238fa965a80c6f928e2920c57fac845f1/state`; no private state or secret values are copied into this report.

| UTC time | Durable evidence | Meaning |
| --- | --- | --- |
| 15:16:44.680 | `agentic/journal/state.json`, outbound 77 / inbox 16, `msg-delegation-56d2650c…` | Conversation delegation applied to Coordinator. |
| 15:17:27.998 | Outbound 79, `p19-bc884d2b…` | Coordinator dispatches read-only Context7 impact assessment to Architect. |
| 15:18:51.857 | Inbox 17, `architect-context7-impact-blocked-bc884d2b-v1`; matching `native-intent` and `native-ack` receipts | Architect returns valid `spec.draft(status=blocked)`. It records host rejection of native `exec_command` and MCP resource enumeration, with no repository-read or verification tool exposed. No source or permission changes occurred. |
| 15:18:53.431 | Outbound 81, `p19-wake-57594ea8…`, status `released` | Runtime recognized the specialist result and durably queued a `task.status(kind=specialist_result_ready)` wake for Coordinator. |
| 15:18:56.544 | `coordinator-start-8812bef…` receipt | Coordinator's wake-triggered turn began. |
| 15:18:57.209 / 15:18:58.144 | `specialist-stop-1f09747…` / `specialist-settled-1f09747…` | Architect's Herdr stop was reconciled and settled. |
| 15:19:37.991 / 15:19:38.291 | `native-intent-c565bd51…` / `native-ack-c565bd51…` | Coordinator sends and receives acknowledgement for `task.status(status=blocked)` addressed to Conversation. The prior attempted `escalation.notice` was schema-rejected; the accepted message uses `task.status`. |
| 15:19:38.313 | `conversation-notice-c565bd51…` | Host durably records the Coordinator's blocked notice. |
| 15:19:42.782 / 15:19:43.113 | `coordinator-stop-8812bef…` / `coordinator-stop-handled-8812bef…` | Coordinator turn ended and was handled. No subsequent workflow action was recorded. |
| 15:21:12.492 | `conversation-turn-8dec4da4…` | Conversation turn begins. |
| 15:21:13.553 | `notice-surfaced-c565bd51…` | The earlier blocked notice is surfaced only during this later Conversation turn; durable receipt creation did not itself make it immediately user-visible. |
| 15:21:56.002 | Outbound 82, `p19-1bbd5491…`, delivered | Watchdog finally reports `run_stalled` after its three-minute idle threshold. |

At the inspected journal snapshot, the run remains `specifying`, `tasks=[]`, `coreCreated=false`, `cancelled=false`, with `error=null`, `blockedBy=null`, `lastActivityAt=null`. The corresponding SQLite `agentic/runs.db` has no row for this P19 run; its authoritative observed state is the P19 JSON journal. Outbound wake 81 remains `released`, and there is no next action. This distinguishes a delivered/acknowledged message from a transitioned workflow.

## Source roots

- `packages/runtime/src/agentic/read-only-git.ts`: `permitsReadOnlyInvestigation` authorizes only Bash `git log/show/diff/status/branch`, only for planner/specifier/architect/reviewer/qa. It cannot authorize Coordinator, source-file reads, `rg`, or general read-only repository inspection.
- `packages/runtime/src/agentic/host.ts:702-703`: native PreToolUse checks Bflow MCP tools and Read/Glob/Grep/ToolSearch, then the narrow git allowlist, then Developer-only edits; all remaining non-Developer native tools fail with “Native mutation/command tool is unavailable for this role.” Codex's `exec_command` attempt is outside the allowed read interface. Thus a nominally read-only investigation can be denied by a guard whose error describes mutation/command availability.
- `packages/runtime/src/agentic/runtime.ts:165-174`: `wakeCoordinator` creates an idempotent `specialist_result_ready` wake when a specialist result is ingested. This worked in the incident.
- `packages/runtime/src/agentic/runtime.ts:649-671`: inbound specialist `status=blocked` is surfaced to Conversation and results addressed to Coordinator wake it. The incident result was a `spec.draft(status=blocked)`, so it generated the wake; Coordinator's later direct `task.status` to Conversation was acknowledged as a conversation notice, but the journal RunRecord remained `specifying` and the released wake had no runtime-owned next action/resume transition.
- `packages/runtime/src/agentic/runtime.ts:456-490` and `packages/runtime/src/agentic/run-watchdog.ts`: watchdog facts include time, pane states, active handoffs and pending decisions. They do not encode semantic outstanding SDLC work such as `specifying` with no accepted specification, no tasks, and no pending action. Watchdog intentionally treats valid waiting/human states specially, but this incomplete planning state was neither a valid wait nor changed into an actionable blocker.
- `packages/runtime/src/agentic/host.ts:1042-1110`: Conversation inbox notifier and watchdog surface receipts asynchronously. In this incident the receipt existed about 94 seconds before its surface receipt; no durable surface receipt is present before the subsequent Conversation turn.

## Earlier fixes and why they did not prevent this incident

| Commit | Prior change | Evidence and limitation |
| --- | --- | --- |
| `959b028` | Read-only Git guard and tests | Test file `packages/runtime/test/agentic/read-only-git.test.ts` proves a small Git command allowlist and rejects unsafe shell syntax. It deliberately excludes Coordinator and does not cover reading source files, filesystem enumeration, task-aware capability preflight, or proving that an assigned role has the tools needed before dispatch. The restriction was present in source and built host; it was insufficient for this role/task. |
| `13eb364` | Wake Coordinator on specialist replies | `runtime.ts:wakeCoordinator` and integration tests cover a reply-triggered wake. The live incident confirms that narrow behavior worked. It did not ensure that a wake is converted into one bounded next action or that Coordinator turn completion without a next action changes durable run status. |
| `c71c86d` | Record silent stop paths and notify Conversation | `no-silent-stop.test.ts` exercises selected stop/report paths. In this case the conversation notice receipt was durably written and acknowledged but not surfaced until a later Conversation turn; moreover the run state itself was not moved to a resumable blocked condition. |
| `f36657b` | Bound scheduler failures and add run watchdog/stuck-state tests | `stuck-states.test.ts` and `notice-watchdog.test.ts` exercise stuck messages, idle panes, and elapsed-time notices. The watchdog is time/pane based and lacks a state-machine invariant for pending business work across every SDLC phase. It eventually said “stalled”; it did not identify capability denial as the blocker or establish resume semantics. |
| `d5c808a`, `50fd377` | Drain Conversation dead letters and wake idle Conversation notices | These cover inbox retry/resurfacing paths, not immediate delivery guarantees for a just-persisted blocker when Conversation is idle, nor recovery of Coordinator's unconsumed next action. |

Classification: the primary cause is an unfixed cross-cutting capability-preflight and next-action/liveness gap. The guard was integrated and active; evidence does not support a regression. The live session does not appear stale: generation 21 started at 22:13:54 +07, `packages/runtime/dist/agentic/host.js` mtime is 22:11:21 +07, and source HEAD was committed at 22:11 +07. No evidence indicates that old source was loaded. Previous tests were local and did not exercise live model-driven capability denial/recovery. The incident itself is live Herdr/Codex evidence for the failure, not proof that a fix works.

## Evidence commands and boundaries

Read-only commands used included:

```sh
git status --short
git rev-parse HEAD
git worktree list --porcelain
find .bflow -maxdepth 4 -type f -printf '%TY-%Tm-%Td %TH:%TM %s %p\n'
python3 - <<'PY'  # SQLite opened with mode=ro; selected run ID and event metadata only
import sqlite3
p='/home/baodq/.local/state/bflow/repositories/f2ef45faade8b3b62a95bf88161e480238fa965a80c6f928e2920c57fac845f1/state/agentic/runs.db'
c=sqlite3.connect('file:'+p+'?mode=ro', uri=True)
print(c.execute('select run_id,status from runs where run_id=?', ('run-2228e9e91ff4a0c58e0dbf3491300480682b14aaac9993f66cb7e61ff04cac6f',)).fetchall())
PY
rg -n 'permitsReadOnlyInvestigation|wakeCoordinator|specialistBlockage|watchdogSnapshot|reportRunStalled' packages/runtime/src/agentic
git show --stat --oneline 959b028 13eb364 c71c86d f36657b d5c808a 50fd377
stat -c '%y %s %n' packages/runtime/dist/agentic/host.js packages/runtime/dist/agentic/read-only-git.js
```

No credentials, process environments, MCP secret config, or provider tokens were read into this report. The incident source was a real Herdr/Codex session. The separate live transport command `BFLOW_LIVE_HERDR=1 pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts` exited 0 on 2026-10-20; Vitest reported **1 passed, 0 failed, 0 skipped**. The test created and cleaned up isolated Herdr session `smoke`, used a local native actor, initialized protocol 22 and received an authenticated message; its output explicitly reports `submissionStatus=unknown_delivery`, `bindingVerified=false`, `taskStatus=running`, `modelProviderUsed=false`. Full stdout/stderr is at `/tmp/bflow-liveness-live-transport.log`.

A separate no-launch generic provider check was run from `/tmp/bflow-workflow-liveness` with private XDG/HERDR paths. The JSON invocation `bflow agent check codex --role coordinator --mode restricted --session evidence-check --json` returned JSON `exitCode=3`, outcome `not_ready`. A second invocation without `--json`, using session `evidence-check-shell`, returned shell exit **3** and a human report of five healthy and three failed checks; it cited inability to safely review inherited Codex hook configuration because the default Codex home was not accepted as user-owned/private. This command does not accept a profile selector; the main repository's ignored `.bflow/config.yml` selects `profile-name: personal` for Coordinator and Architect, while that config is absent from the temp worktree. Therefore these generic results do not establish readiness of the selected `personal` profile. No provider/model process started, and no credential or provider config value was inspected or changed. This is live Herdr transport evidence only, not an actual provider model reproduction or full SDLC acceptance. No post-fix acceptance is claimed.
