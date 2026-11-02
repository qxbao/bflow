# Bflow Minimal Reliability Improvement Roadmap

Audit revision: `a46ab10`

This roadmap is deliberately small. It uses existing Runtime journals, checkpoints, receipts, telemetry, E2E harnesses, Herdr live smoke, and CI configuration. It does not propose a new testing framework or broad Orchestrator redesign.

## Immediate: make reliability validation deterministic

Schedule the two slow whole-run lifecycle matrix files in a serial one-worker lane, either as a separate CI step or by invoking them with existing Vitest worker controls. Keep the normal root suite unchanged for ordinary tests. Give the slow lane an explicit job-level budget based on observed serialized duration.

The audit reproduced six false timeout failures under concurrent load and then reproduced 20/20 passing tests serially. The smallest useful change is scheduling and budget ownership. Raising the global 30-second timeout would hide unrelated regressions and would not address cleanup of timed-out asynchronous work.

Suggested validation command:

```sh
pnpm exec vitest run \
  packages/runtime/test/agentic/lifecycle-fault-matrix-extended-restart.test.ts \
  packages/runtime/test/agentic/lifecycle-fault-matrix-faults.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=verbose
```

Success criterion: all 20 tests pass in the dedicated lane and no lifecycle fixture directories remain from the run.

## Next: collect one real Herdr boundary record

Run the existing native Herdr smoke with one custom actor and no model. Extend its existing console evidence only if needed to preserve:

- test revision and environment classification;
- Herdr protocol/schema result;
- named session, workspace, tab, pane, and native session identity;
- submission status and request identity;
- fresh-adapter reconciliation result;
- duplicate-send count;
- Runtime task/run status;
- whether a signed native message was received;
- provider/model usage, explicitly false for this probe.

This is the cheapest experiment that distinguishes an actual Herdr receipt/reconciliation limitation from a provider or permission failure. Run it once per hypothesis, with a fixed timeout and no paid model call.

## Then: preserve a redacted failed-run evidence bundle

The next naturally occurring blocked full run should retain a bounded bundle assembled from existing state:

1. Run ID, revision, session alias, and host attempt.
2. Last 100 relevant journal/event records around the first abnormal operation.
3. Latest aggregate checkpoint identity and event sequence.
4. Outbox/receipt identity and delivery state for the last pending handoff.
5. Herdr pane/session observation and provider readiness result.
6. Recovery action, reconciliation result, and whether a resend was allowed.
7. Read-only telemetry report and timestamps.
8. Git/worktree/artifact references, with secrets and raw transcripts redacted.

This is an evidence-retention proposal, not a new storage system. It should use existing redaction, journal, telemetry, and status commands. Without this bundle, failure frequency and root cause cannot be ranked.

## Periodic live boundary checks

Use a small matrix outside ordinary PR CI, only where credentials and binaries already exist:

| Boundary | Small task | Frequency/trigger | Cost control | Pass evidence |
| --- | --- | --- | --- | --- |
| Herdr transport/session | Native actor prompt/send/reconcile | Scheduled or after protocol change | No model; one session; one operation | Correlated identity, stable session, classified receipt |
| Provider startup | Start one provider in disposable profile and request one fixed response | After provider adapter/launch change | One provider at a time; no feature generation | Auth/readiness, permission/session receipt, exact response marker |
| Sandbox/permission | Run one existing provider/tool boundary under the selected sandbox | After OS/sandbox change | Reuse existing fixtures; no automatic approval | Explicit allowed/denied outcome and sandbox diagnostics |
| Gateway/tool uncertainty | One MCP operation with ledger reconcile | After Gateway/tool transaction change | One exclusive resource and one call | Intent, external status, reconcile result, no duplicate operation |
| Restart boundary | Restart host after one durable intent | After Runtime/recovery change | Native actor or controlled provider; no full SDLC | Checkpoint/tail, reconcile, continued task identity |

These checks remain separate from full SDLC acceptance. A live boundary pass certifies only the boundary it measures.

## Metrics available from existing telemetry

| Metric | Existing source | Current baseline |
| --- | --- | --- |
| Full-run success rate | Run terminal status plus accepted workflow attempts | Not measured in this checkout |
| Unexpected blocker rate | Run status, blocker/pending-action records, Conversation notices | Not measured |
| Unrecoverable blocker rate | Terminal escalations/failed runs with no valid recovery action | Not measured |
| Time to detect a stall | Journal activity timestamps plus watchdog action timestamp | Mechanism exists; no production series |
| Time to recover | Blocker/reconcile/resume timestamps to progress/terminal event | Not measured |
| Recovery success rate | Recovery attempts followed by continued progress/terminal completion | Not measured |
| Repeated failure by signature | Redacted error/finding/reconciliation signature | Not measured |
| AI tokens per confirmed defect | Provider usage records associated with a verified defect | Not measured |
| Real-provider validation cost | Per-probe provider usage and duration | Not measured |

The current telemetry command is read-only and intentionally does not invent cost or missing measurements. Targets should be set only after a baseline sample exists.

## What not to change yet

- Do not add unbounded retries to Herdr or provider operations.
- Do not treat Herdr `done`/`idle` as task completion.
- Do not weaken session continuity, sandbox, permission, or schema validation.
- Do not redesign Runtime recovery based only on the source-supported uncertain-delivery risk.
- Do not run full paid SDLC workflows to investigate an adapter or permission boundary.
- Do not claim a provider or Herdr defect until a live boundary record or retained failed-run bundle identifies it.

## Expected cost relative to repeated full runs

The recommended sequence is materially cheaper in scope because it uses one existing native actor probe, one provider startup probe only when needed, and one retained evidence bundle from a naturally occurring failure. It avoids generating a complete application feature and avoids concurrent paid agents. Precise savings are intentionally not estimated because no provider usage or full-run cost baseline is available.

## Open decisions after evidence collection

Only after the first real boundary record should the owner decide whether to:

1. improve durable external submission correlation;
2. improve operator-facing reconciliation diagnostics;
3. change provider/pane startup sequencing;
4. add a narrowly scoped recovery transition; or
5. leave Runtime unchanged and classify the failure as external/provider-specific.

Each choice should be tied to a captured operation, not a generic category such as “permissions” or “Herdr instability.”
