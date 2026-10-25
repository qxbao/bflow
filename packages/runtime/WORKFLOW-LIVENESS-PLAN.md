# Runtime workflow liveness remediation plan

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

## Audit result

The observed capability denial is produced by the Runtime host's native `tool_guard` in
`src/agentic/host.ts`: after permitting Bflow MCP, Read/Glob/Grep/ToolSearch, and the strict
read-only Git allowlist, every non-Developer tool call is rejected with the same generic
"Native mutation/command tool is unavailable for this role" error. The allowlist in
`src/agentic/read-only-git.ts` covers only `planner`, `specifier`, `architect`, `reviewer`,
and `qa`, and only `git log/show/diff/status/branch`. Coordinator is excluded. Architect has
no host-owned bounded source-file read API, so a provider-native file reader is its only
source path; that depends on the provider launch/session permissions.

The launch history explains the regression window: commit `959b028` added the host Git
guard but did not enable Bash in provider launch; commit `ea407aa` later enabled constrained
Bash for selected Claude investigation roles. This does not cover Coordinator, arbitrary
provider launch policies, stale already-running panes, or source/resource reads. There is no
dispatch preflight verifying that the role's actual session can satisfy its task's read
needs.

Runtime has several useful local fixes: `receiveHerdr` applies valid specialist messages and
queues an idempotent Coordinator wake; `specialistTurnStopped` surfaces unanswered accepted
assignments; `coordinatorStopWithoutResponse` reports a stopped Coordinator; Conversation
outbox writes are durable and retried. These paths are conditional on host Stop reconciliation
or a valid/applied inbound message. Invalid/rejected results do not create a Coordinator
action, the specialist Stop path does not set a durable run-level next action, and
Coordinator Stop is suppressed once Core exists even when no subsequent action was recorded.
The watchdog classifies a run as stalled only when every session pane is observed non-working.
An unrelated busy pane can therefore hide a dead run; `unknown_delivery` can also remain an
active handoff indefinitely. The existing tests validate these helpers/selected boundaries,
not the complete failure-to-resume lifecycle across every SDLC phase.

For the reported run, the evidence handoff confirms this sequence: the Architect's `spec.draft`
carried `payload.status="blocked"` and said repository access was denied; the durable inbox
receipt arrived at 22:18:51.857 +07. The existing `wakeCoordinator` worked: `p19-wake-5759…`
was released at 22:18:53.431 +07, and the Coordinator ran 22:18:56.544–22:19:43.113 +07. The
Coordinator sent a schema-valid `task.status` directly to Conversation, acknowledged/stored at
22:19:38.312 +07. `workspace.ts` routes messages addressed to Conversation to
`conversation.receiveHerdr`, so Runtime never records that outcome or its blocker in the run
journal. Meanwhile `HostReceiptJournal.hasCoordinatorResponse` treats any new same-run/
correlation Coordinator native intent as a response, without checking whether it created a
durable workflow next action. Run state remained `specifying`, `tasks=[]`, `coreCreated=false`,
`error=null`. The notice was not surfaced until a later Conversation turn at 22:21:13.553 +07;
watchdog `run_stalled` followed at 22:21:56.002 +07. Host `dist` mtime was 22:11:21 while the
session launched at 22:13:54, before the constrained Bash fix. The supplied evidence provides
durable receipt/wakeup/timestamp evidence, but not a local replayable journal.

## Intended private Runtime behavior

Use a host-owned, authenticated read-only repository capability for investigation and
coordination roles. Expose bounded file listing/read, pinned skill/policy references, safe Git
metadata operations, and verification availability through the Bflow MCP surface, not general
shell execution. Resolve repository paths under the canonical root, reject symlink escapes and
private paths, cap result size/count, and disable Git pagers/external diff/text conversion.
Keep provider-native mutation restricted to the Developer's existing authorized workspace
flow. Derive required capabilities from role and task phase, and check the active role/session
before dispatch; report a concrete durable block if the session cannot provide them.

Every Coordinator-to-Conversation workflow outcome first passes authenticated Runtime
observation and journaling, then Conversation delivery. Coordinator Stop reconciliation always
asks Runtime whether a durable semantic next action exists; the presence of a progress/status
message alone is not completion of the turn. A schema-valid specialist blocker detector covers
blocked structured outcomes independent of the message type that carries them.

Persist a private, validated per-run next-action record whenever Runtime observes a terminal
specialist result, a rejected/malformed result, an unanswered stop, an unacknowledged result
wakeup, or a Coordinator turn ending without a subsequent durable action. The finite outcomes
must distinguish safe Coordinator continuation, capability repair/resume, waiting for user or
approval, unknown-delivery reconciliation, bounded reassignment, blocked, failed and cancelled.
Each action is keyed by a deterministic episode/message identity and has durable notification
state. Write the state and Conversation notice/outbound intent atomically in the existing
journal transaction. Recovery replays pending actions idempotently and does not resend an
uncertain mutation, retry a cancelled action, or bypass approval.

Replace whole-session pane-idle gating with a run-local classifier based on SDLC status, Core
tasks, pending verification, inbox/outbox delivery state, approval/user-decision state, and
durable next action. Valid work and valid waiting remain distinguishable from missing wakeup,
unknown delivery and a true blocker. Every nonterminal run must have a valid pending action or
be actively progressing; otherwise Runtime records and surfaces a concrete blocker. Resume
after capability repair reuses the durable message/task identity and only starts work when
reconciliation proves it safe.

## Regression test sequence

1. Integration-level host guard plus Runtime dispatch reproduction: Coordinator and Architect
   need bounded repository reads; arbitrary shell and writes remain refused.
2. Runtime receipt handling: valid blocked/failed result wakes Coordinator and writes the
   Conversation notice; malformed/rejected result is durable and actionable.
3. A specialist Stop with no structured result and a Coordinator Stop after a wake both leave
   a durable next action and user notice.
4. Conversation delivery failure/schema rejection is persisted and recovered without losing
   the original blocker.
5. Restart between result persistence, wake creation, and dispatch reproduces the same
   deterministic action exactly once.
6. Unknown delivery, cancellation and approval pending remain in their specific states without
   duplicate dispatch or false stall.
7. Repairing capability then resuming continues the same run without duplicate task/lease.
8. Run-local liveness table covers intake, clarifying, specifying, planning, TDD decision,
   implementation, verification, review, approval, completed, escalated, failed and cancelled.
9. Live Herdr/provider reproduction is attempted only if an installed isolated session is
   available; otherwise record it as NOT VERIFIED.

## Scope and validation

Implementation scope is `packages/runtime/**` and `agents/**`; no public contract, shared
document, provider/pane-manager package or root configuration change. New private journal
fields are optional for compatibility with existing version-1 journal files and are validated
at load. Tests are integration-focused and use the existing real Runtime/journal fixture with
fake transport only as local evidence, not as live verification. Run package build/tests and
the root acceptance checks on the integration owner's baseline; report evidence levels
separately.
