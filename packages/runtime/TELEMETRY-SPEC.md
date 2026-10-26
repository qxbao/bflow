# Workflow telemetry — specification for owner review

Status: approved by project owner in this conversation, including Runtime + CLI scope
and Conditional TDD required. No public schema decision is implied.
Baseline: bc29647917b0f8a32b6172cb4b277ab81d393361.
Scope: Runtime projection/report and CLI reader, with package-local documentation/tests.
No public contracts, persisted event/journal versions, SQLite migrations, root configuration,
lockfile, shared documents, commits or external writes.

## Purpose and implementation decision

Measure workflow bottlenecks and verification effectiveness using existing authoritative
records. Rebuild an ephemeral, deterministic projection on demand. Do not add another log
or put telemetry in scheduling, acceptance, dispatch or recovery transactions.

Proposed CLI: `bflow status <run-id> --telemetry [--json]`. The option is opt-in;
ordinary status retains its behavior. Agentic-host and legacy RunStore coverage must be
identified explicitly in each report, never silently substituted for each other.
Add an optional private `telemetry_report` read RPC alongside `platform_status` in
host.ts/host-controller.ts, with strict private request/report validation. It reads the
host-owned RunStore and authenticated receipt readers. CLI connects only to an existing
host: it must not start/recover/activate a host to report. If the host is stopped or older,
agentic telemetry is unavailable with a fixed reason, never silently replaced by legacy
data. Journal-only runs return explicit partial/unavailable metrics. The reusable Core reader uses paginated RunStore access from the owning host. Legacy
standalone returns unavailable until owner Persistence exposes read-only composition;
its existing Runtime composition seeds registry state and cannot be used for this query. Select
the source explicitly from repository lifecycle state before taking the legacy status path.
Do not extend RuntimeService or introduce a public event. A telemetry read failure is
reported separately from authoritative run status and does not change workflow state.

## Report semantics

Each metric includes unit, value (nullable), quality, numerator/denominator where relevant,
eligible/observed/excluded counts, source names and limitations. Quality is `measured`,
`estimated`, `partial` or `unavailable`. `estimated` describes an explicit model with
provenance; `partial` describes incomplete observation and must never imply extrapolation.
No source means null, never zero. Zero is valid only with a complete eligible population.
The report also carries report-format version, run ID, run outcome, explicit as-of time,
source coverage, event high-water mark and fixed diagnostic codes (no raw error/payload).
An empty cohort has a null ratio. Totals of concurrent intervals are work-time sums and
are never labeled end-to-end elapsed time.

| Metric | Definition and population | Authority and limits |
| --- | --- | --- |
| Task state elapsed | Sum nonnegative intervals from a task status transition to its next transition, split by task and state. Mean divides by closed observed intervals, with open/missing intervals reported separately. | Core task.status_changed in sequence order. This is business-state wall time, not CPU time or an SDLC phase inference. |
| Phase/role elapsed | Initial scope: sum paired, host-generated verification operation start/end intervals per explicit verification phase and bound role; mean divides by complete operation pairs. | Only known host measurement paths generating startedAt/completedAt, authenticated receipts and validated bindings. Receipt persistence alone cannot authenticate agent-supplied timestamps. Never infer a role from task names, pane idle/done, activity prose or agent timestamps. Unsupported phases remain unavailable. |
| Approval wait | Event-observed request-to-valid-decision interval for the same approval ID, run, target, revision and generation. Mean divides by closed, correctly paired requests. Also report open, superseded, cancelled and expired populations separately. | Core requests/decisions and host human receipts/current journal. Superseded approvals are not decisions or approvals. A supersession without an authoritative time cannot produce a closed duration. |
| Clarification wait | Host-recorded clarification request to trusted corresponding human response, paired by durable identity. Mean divides by complete pairs. | Trusted Conversation/host receipts only; unanswered or uncorrelated requests are partial/unavailable. Do not read question or response bodies into the report. |
| Rework cycles | Count distinct task generation advances caused by rework, keyed by run/task/generationTo. Report per task and outcome. Retry attempts are separate, not rework. | Core task.status_changed with intent=rework, plus host source coverage reported explicitly. Never infer cycles from repeated findings or messages. |
| First-pass rate | Core tasks ending succeeded in generation 0 without rework or retry / all tasks ending succeeded with complete execution history. Failed, cancelled and incomplete tasks are excluded from this ratio and reported in separate counts alongside it. | Authoritative task transitions and acceptance, complete history from creation. No transport completion or agent result alone qualifies. This is conditional on success and has survivor bias; it is not overall workflow success rate. |
| Gate turnaround | Request-to-recorded-result for the same run/task/evaluation ID. Mean divides by closed valid pairs. Include passed/failed/blocked/error results, split by outcome; open evaluations are separate. | Core quality_gate.evaluation_requested/evaluated. Partial proxy of recorded event timestamp delta only: evaluatedAt may be sampled before execution completes. Does not prove execution or persistence latency. |
| Gate execution | Host start-to-finish of an individual gate only if both boundaries are independently recorded for that gate/evaluation. | Existing authenticated host measurements where available. An evaluatedAt alone is insufficient. Never substitute gate turnaround. |
| Evidence reuse | Within this run only: reuse consumers beyond the first distinct host-validated consumer of the same stored artifact checksum algorithm + value, divided by all validated artifact-consumer links. Consumer identity includes run/task/generation/operation ID or invocation ID. | Only explicit receipt links for actual acceptance/consumption. host_context delivery ACK, repeated artifact mentions, equal inputs and tool completion do not establish reuse. If existing records do not establish distinct reuse consumers, unavailable. |
| Regression widening | Evaluations with a nonempty host-recorded regression.widening list / host regression evaluations with validated selection metadata. Also report widening decisions by allowlisted reason/tier and unknown-selection evaluations. | Host-generated gate metadata, deduplicated by evaluation ID. No agent-supplied arbitrary metadata. Report selected test counts only, not paths or file contents. |
| Tokens / USD | Null/unavailable until an authenticated provider usage source exists. No pricing estimation in this increment. | ToolUsageRecord is invocation/consumption evidence, not model usage. Future estimates require model, price source/version/effective date, units and coverage; no hardcoded current prices. |

All failed/cancelled runs retain closed measured work/wait intervals and rework counts,
tagged with outcome. They do not become successful runs. Incomplete runs retain closed
intervals; open intervals are censored with separately labeled observed-to-as-of lower
bounds where a valid start exists, excluded from closed means. Never close an interval at
restart, at arbitrary report generation time, or at a terminal outcome without a relevant
authoritative boundary. Negative/skewed/missing times yield partial coverage, not clamped 0.

## Source audit

- contracts/src/events.ts: strict DomainEventSchema; run-scoped sequence, eventId,
  occurredAt; task generation/intent, approval and gate identities.
- contracts/src/ports.ts: paginated RunStore.readEvents. Read a bounded consistent prefix;
  expose truncation, sequence gaps and concurrent-head movement rather than claiming full coverage.
- runtime/src/agentic/host-receipts.ts: authenticated host gates, verification evidence,
  human decisions, Conversation notices. Receipt existence establishes only its documented fact.
- runtime/src/agentic/journal.ts: current approval and superseded identities; not an
  immutable timeline and not a replacement for authoritative event history.
- runtime/src/agentic/task-activity-log.ts: best-effort diagnostic journal, default
  1,000 entries / 512 KiB. Not a complete population or acceptance authority.
- runtime/src/platform/tool-usage-ledger.ts and contracts/src/tool-usage.ts: durable,
  identity-checked invocation and consumption evidence; latest state overwrites earlier
  observation time, so duration cannot be reconstructed from observedAt alone.
- runtime/src/agentic/host-verification.ts: host regression selection/widening metadata.
- apps/cli/src/bin.ts and commands.ts: environment status and run status are distinct paths.
- Reference StatsPage.tsx distinguishes measured coverage and missing cost; reference
  runtime/telemetry uses spans/context. Reuse the coverage distinction, not raw argument,
  command or content collection. No dashboard or tracing dependency is needed here.

## Replay, validation and privacy

Parse crossed-package values with exported schemas. Missing required timestamps are
invalid inputs; report fixed invalid-record counts and partial coverage without inventing
replacement timestamps or relaxing schemas. Sort by authoritative sequence, not arrival
order. Deduplicate exact events by run/eventId and run/sequence. Conflicting duplicate
identities invalidate the affected source scope; do not pick a winner. Receipt operations
are deduplicated by their durable semantic IDs. Restart must produce the same projection
for the same input prefix and as-of time. Replayed snapshots do not add extra cycles.

Count superseded approvals only when the original request is observed; current journal
superseded IDs without original requests are coverage diagnostics. Their duration stays
null/partial without an authoritative supersession time. Replacement request time is not
an implicit supersession timestamp.

Allowlist only IDs, enums, counts, durations, timestamps, quality and source provenance.
No prompts, reasons, questions, arguments, command strings, credentials, raw findings,
output bodies, filesystem paths or agent summaries in reports or diagnostics. Report
code reads existing validated sources through their owning reader, not ad-hoc SQL/JSON
file access that bypasses storage checks. Source/report exceptions are isolated from all
workflow actions. Do not modify existing readers used by acceptance merely for telemetry.

## Acceptance criteria and Conditional TDD

TddDecision proposal: required; requiresFailingTestFirst=true. The projection is domain
logic whose deduplication, denominator and censoring errors would mislead operators.
Verification conditions: exact totals/quality and denominator against independently
calculated fixtures; identical replay/restart report; workflow state unaffected by failures.

1. Fixture with duplicate/out-of-order events and paginated replay yields identical totals
   to a unique sequence; conflicting identities/gaps mark partial and cannot inflate counts.
2. Multiple rework generations and retry attempts have separate exact counts; first-pass
   numerator/denominator and excluded failed/cancelled/open populations match the table.
3. Missing timestamp, negative interval, absent usage and empty population never produce
   invented zero values or successful task evidence.
4. Superseded approval and late old-generation decision cannot close a replacement wait;
   duplicate decisions and restart do not add time. Untimed supersession stays partial.
5. Paired gate request/result has exact turnaround, while an unpaired result cannot claim
   execution duration. Outcomes include gate failures and interrupted evaluations.
6. Host regression widening metadata is counted once; arbitrary agent metadata is not a
   measurement. Missing reuse proof and usage return unavailable.
7. CLI text and JSON expose quality, coverage and units; legacy/environment status routing
   and exit behavior remain compatible. Source/report exceptions leave workflow status intact.
8. Sentinel prompt/secret/path strings in ignored fields are absent from report and error
   output. No changes to shared contracts/config/migrations or generated tracked artifacts.

Implementation sequence after approval: write failing fixture tests; implement pure
projection; add isolated owning-source readers; wire opt-in CLI and integration tests;
document supported metric coverage in package READMEs; perform review and validation.
Required validation: build, targeted Runtime and CLI tests, pnpm check:deps,
pnpm typecheck, pnpm test, git diff --check and git status --short.

Owner review requested: approve this specification and TDD decision, and the scoped
Runtime + CLI implementation ownership. No schema/migration/shared-config change requested.

## Implementation plan

Use writing-plans and executing-plans, inline execution in the isolated worktree.
No commits. Tech stack: TypeScript, existing Zod contracts, Vitest.

- [x] Pure projection: create src/telemetry/report.ts and test/telemetry/report.test.ts.
  Export buildWorkflowTelemetry(input), WorkflowTelemetryReportSchema and a bounded
  readWorkflowTelemetry(store, runId) reader. Test duplicate identities, multiple rework
  generations, failed/cancelled/open cohorts, supersession, missing/negative timestamps,
  gaps, pagination, missing usage and privacy. Run Red, implement, run Green.
- [x] Source composition: reusable RunStore reader and read-only report
  method in AgenticWorkflowRuntime, host telemetry_report RPC and connect-only client
  function. Test stopped host, source failure, partial journal-only run and source routing.
- [x] CLI: parser/types/command formatting and bin composition for opt-in status telemetry.
  Test text/JSON, no-run rejection, existing status unchanged and report failure isolation.
- [x] Package READMEs and handoff evidence: concrete coverage and unavailable metrics,
  baseline failures, exact validation commands/codes/counts. Review implementation with a
  fresh reviewer; resolve findings; run targeted and required full validation.

Review focus: conflicting IDs cannot choose a winner; omitted tasks cannot improve the
denominator; post-head events cannot extend a bounded report; inactive hosts cannot start;
invalid-source error text cannot leak payload content. Tests belong to the owning steps.


Implementation refinements from independent review (within approved scope): do not open
legacy Runtime because it seeds registry; report explicit unavailability instead. This
requires no owner schema decision. Outcome carries `outcomeSource` and `hostWorkStatus`
to keep Core and SDLC domains distinct. Overall coverage downgrades when host receipts
are incomplete; `sourceCoverage` keeps Core and host coverage separate. Missing original
superseded requests produce a diagnostic. Unproved zero counts are null. Approval counts
include cancelled, elapsed-expiry-deadline and terminal-incomplete groups; none contributes
a fabricated closed duration. Core approval durations use event observation timestamps,
not payload timestamp claims.

Final source audit: Core quality_gate.evaluated uses evaluator evaluatedAt as occurredAt; some evaluators sample it before commands finish. Gate turnaround is therefore always partial and explicitly a recorded timestamp proxy. Shared batch identity/version conflicts quarantine the entire Core source scope; ordinary missing sequences retain only partial observations.
