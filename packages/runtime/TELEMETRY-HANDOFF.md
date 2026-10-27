Current integration state: telemetry was reconciled onto main at parent
`17cf4c119309f947a5eb428e1e98011940911887`. The owner clarified that `merge main`
authorizes the required local commit; this record accompanies that integrated commit.
No push/PR. Full suite was skipped at the owner's explicit request. Earlier no-commit
and baseline/conflict notes below are historical; the final integration section supersedes them.

# Workflow telemetry handoff

Implementation in isolated worktree `.worktrees/workflow-telemetry`, branch
`agent/runtime/workflow-telemetry`. Tested HEAD:
`bc29647917b0f8a32b6172cb4b277ab81d393361` **plus the uncommitted worktree changes**.
No commit, push, PR or merge. Original checkout's uncommitted work was preserved.
Baseline retains P24 `8dbb056` and origin/main `8895ecc`; local main was three commits
above origin/main when inspected. No remote refs were fetched or changed.

## Usage and definitions

```bash
node apps/cli/dist/bin.js status <run-id> --telemetry
node apps/cli/dist/bin.js status <run-id> --telemetry --json
# Or use bflow after the normal CLI build/setup PATH flow.
```

Use the rebuilt CLI in this worktree. An already-running host built from older source
returns unavailable until the normal owner-controlled lifecycle uses a matching build;
telemetry never restarts it. Exit 0 means the report was emitted, not task success.

The owner-approved [Specification](TELEMETRY-SPEC.md) defines metrics, populations,
denominators, cancellation/failure/incomplete treatment, source authority and acceptance
criteria. [Runtime README](README.md#telemetry-hiệu-quả-workflow) summarizes current
coverage. [CLI README](../../apps/cli/README.md#báo-cáo-telemetry-workflow) documents source
selection and structured output.

Report v1 includes nullable metric values, units, quality, numerator/denominator, source,
limitations, Core/host source coverage, cohort counts, task-state intervals, phase/role
verification aggregates, regression widening reason/tier counts and fixed diagnostics.
The first-pass ratio is conditional on Core tasks ending succeeded with complete history,
not workflow success or final human delivery approval. Failed/cancelled/open cohorts
remain visible. Rework counts generation advances; retry transitions are separate.

Gate turnaround is a partial timestamp proxy: Core uses evaluator `evaluatedAt`, which
some evaluators sample before commands complete. Neither execution nor receipt persistence
latency is established. No gate-execution duration is invented. Phase/role durations cover
host-measured verification operation pairs only, aggregated within a run; they do not cover
all SDLC phases. Host receipt inventories lack immutable publication timestamps and do not
prove complete failed/interrupted operation coverage, so those aggregates remain partial.

Evidence reuse, unpaired clarification intervals, provider tokens and USD are unavailable
without authoritative sources. Tool completion/delivery ACK is not reuse evidence or token
usage. No cost estimates or pricing table are shipped. No prompt, secret, command body,
output, finding text or widening file path is added to reports.

Legacy standalone telemetry deliberately returns `legacy_readonly_source_unavailable`.
The existing Persistence factory has no read-only open and Runtime composition seeds
registry state. Enabling that source requires owner Persistence to provide a compatible
read-only reader; this change does not bypass the owner with private SQL or a migration.

## Evidence

Environment: Node `v24.16.0`, pnpm `12.5.1`, Linux/local test fixtures. Initial dependency
installation: `pnpm install --frozen-lockfile --offline`, exit 0, no lockfile changes.
Conditional TDD: required. New projection/client modules initially failed as absent;
CLI assertions failed before parser/wiring; additional approval-time, batch-validator,
identity conflict, coverage and legacy-state tests were observed Red before fixes.
Independent review findings were fixed and rechecked; the final review reported no
important unresolved issues in those corrections.

- `pnpm build`: exit 0.
- `pnpm check:deps`: exit 0.
- `pnpm typecheck`: exit 0.
- `git diff --check`: exit 0.
- Targeted regression command below: exit 0; **219 passed, 1 skipped**, 12 files passed.
- Final `pnpm test`: exit 1; **74 failed, 5322 passed, 80 skipped** (5476 tests),
  13 failed / 274 passed / 7 skipped files (294 total), duration 640.46 seconds.
  Failed testcase identity comparison: exactly the same 74 as baseline; no added/removed
  failures. All **26 newly added telemetry tests passed**. Final log:
  `/tmp/bflow-telemetry-full-final.log`; comparison:
  `/tmp/bflow-telemetry-failure-comparison.json`.
- Final `git status --short`: exit 0; only Runtime/CLI source, tests and local docs modified
  or untracked, no staged changes.

```bash
pnpm exec vitest run packages/runtime/test/telemetry \
  packages/runtime/test/agentic/host-receipts.test.ts \
  packages/runtime/test/agentic/private-state.test.ts \
  packages/runtime/test/agentic/private-state-host.test.ts \
  packages/runtime/test/agentic/task-activity-log.test.ts \
  packages/runtime/test/platform/tool-usage-ledger.test.ts \
  apps/cli/test/telemetry.test.ts apps/cli/test/parser.test.ts apps/cli/test/commands.test.ts
```

New fixtures cover duplicate/reordered replay, restart, multiple rework generations, retry,
missing/reversed timestamps, missing usage, superseded/late/mismatched approvals, elapsed
expiry deadlines, cancellation, pagination with post-head events, batch identity/version
conflicts, source exceptions, receipt authority, secret/path sentinels, journal-only outcome,
connect-only RPC, foreign replies, no state creation for absent host, and no legacy bootstrap.
The private-state host integration suite has one platform-conditional skip.

Smoke: built binary `status fixture-run --telemetry --json`, exit 0, produced the existing
CLI success envelope with report v1 and explicit unavailable source diagnostic. A synthetic
Core fixture JSON report is `/tmp/bflow-telemetry-example.json`: firstPass 0/1, reworkCycles
1, tokens null, costUsd null. CLI example is `/tmp/bflow-telemetry-cli-example.json`.
These are fixtures/local smoke, not live provider, Herdr transport or full SDLC acceptance.

Additional inactive local daemon RPC probe observed the expected `workspace_inactive`
report without activating a workspace. Both whole probe scripts nevertheless exited 1 in
existing shutdown: Herdr reported its local socket name exceeded sun_path capacity (also
when retrying with TMPDIR=/tmp). Do not count these as successful lifecycle smoke tests.
Only the verified owned inactive smoke daemons were terminated and temporary files removed;
no live role/workflow session was started. No unrelated shutdown fix is included.

## Baseline failures

Before product source changes, `pnpm test` exited 1: **74 failed, 5296 passed, 80 skipped**,
13 failed / 269 passed / 7 skipped files (289 total). Failure file/count inventory:

- `packages/agent-providers/test/agent-providers.test.ts`: 6 failed of 145.
- `packages/artifact-store/test/artifact-store.test.ts`: 1 failed of 76.
- `packages/agent-providers/test/codex-hook-trust.test.ts`: 27 failed of 34.
- `packages/runtime/test/agentic/polyglot-core.test.ts`: 1 failed of 24.
- `packages/agent-providers/test/codex-probe-coalescing.test.ts`: 1 failed of 52.
- `apps/cli/test/iso-engine.test.ts`: 1 failed of 14.
- `apps/cli/test/codex-hook-setup.test.ts`: 19 failed of 22.
- `packages/agent-providers/test/profile-environment.test.ts`: 1 failed of 8.
- `apps/cli/test/host-recovery.test.ts`: 1 failed of 10.
- `packages/agent-providers/test/codex-compatibility.test.ts`: 9 failed of 26.
- `apps/cli/test/gateway-control-client.test.ts`: 2 failed of 7.
- `packages/runtime/test/agentic/host-recovery.test.ts`: 1 failed of 6.
- `apps/cli/test/iso-agy.test.ts`: 4 failed of 4.

Observed baseline causes include Codex hook trust rejecting the current profile ancestor,
Unix socket fixture paths under the long TMPDIR producing `EINVAL`, Agy profile fixtures,
and pre-existing runner/host expectations. No unrelated implementation, test expectation,
permission setting or environment setting was changed to hide these failures. The complete
baseline log is `/tmp/bflow-telemetry-baseline-test.log`.

## Ownership and remaining limits

Only `packages/runtime/**` and `apps/cli/**` changed. Added source is under
`packages/runtime/src/telemetry/**` and `apps/cli/src/telemetry.ts`; tests under the matching
package test directories. Host control, receipt, Runtime journal-context reader and private
state locator additions are narrowly scoped. Package READMEs/specification/handoff are local.
No public contract/event/checkpoint/journal schema, migration, dependency, shared config,
root README/AGENTS/docs or lockfile changes. Build generated ignored dist/tsbuildinfo only;
no generated output was staged or committed.

Replay and idempotency hold for validated source identities. Conflicting event/sequence/
idempotency identities or impossible aggregate versions quarantine Core measurements;
ordinary gaps retain partial observations. Host receipts are trusted only within existing
local private-store assumptions; this does not strengthen hostile same-UID safety. Report
errors never settle task results, approve work, resend dispatch or change workflow success.


## Concurrent integration baseline drift

At final handoff inspection, local main had advanced to
`17cf4c119309f947a5eb428e1e98011940911887` and origin/main to
`62b4e6cdb1a7a0890feb67b18591c18620544e9a`. Tested HEAD remains an ancestor of both:
worktree is 4 commits behind main and 1 behind origin/main, with no unique committed changes.
Upstream includes unique test-integrity finding IDs/reworkContext detection and task handovers.
`git cherry HEAD main` reports these as new, not patch-equivalent telemetry work.

A read-only `git apply --check /tmp/bflow-workflow-telemetry.patch` against the new clean
main exited 1 for `packages/runtime/README.md`, `packages/runtime/src/agentic/host.ts` and
`packages/runtime/src/agentic/runtime.ts`. Integration must reconcile those files and rerun
validation on the resulting tree. No work was applied to main; do not claim current-main
integration or remote closure from this baseline validation. The complete reviewable patch
(including added files) is `/tmp/bflow-workflow-telemetry.patch`.


## Main working-tree integration after owner request

The owner requested `merge main`. Main was clean at `17cf4c119309f947a5eb428e1e98011940911887`.
The telemetry diff was merged by three-way file reconciliation against its `bc29647` base,
without creating commits or modifying shared history. Both main's task-handover additions
and telemetry additions were retained in the three additive conflicts: runtime README,
host.ts imports and runtime.ts imports. Existing test-integrity fixes remain unchanged.
The original telemetry worktree/branch is preserved as a backup; no cleanup was requested.

Independent read-only review confirmed every telemetry patch/new file matches the original
worktree, with upstream handover/rework behavior retained and no out-of-scope changes.
`pnpm check:deps`, `pnpm typecheck` and `git diff --check`: exit 0 on integrated main.
Targeted integrated suite: exit 0, **283 passed, 1 skipped**, 17 files passed, duration 92.56s.

```sh
env -u AI_ISOLATOR -u AI_ISOLATOR_REAL_HOME -u AI_ISOLATOR_HOME -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_TOOL TMPDIR=/tmp pnpm exec vitest run --maxWorkers=3 --minWorkers=1 packages/runtime/test/telemetry packages/runtime/test/agentic/host-receipts.test.ts packages/runtime/test/agentic/private-state.test.ts packages/runtime/test/agentic/private-state-host.test.ts packages/runtime/test/agentic/task-handover.test.ts packages/runtime/test/agentic/task-handover-view.test.ts packages/runtime/test/agentic/rework-causality.test.ts packages/runtime/test/agentic/core-checkpoint-restore.test.ts packages/runtime/test/agentic/conversation-context-budget.test.ts packages/runtime/test/agentic/mcp-output-trim.test.ts packages/runtime/test/agentic/tool-action-policy.test.ts apps/cli/test/telemetry.test.ts apps/cli/test/parser.test.ts apps/cli/test/commands.test.ts
```

Full integrated validation was stopped at the owner's explicit request to skip the full suite (SIGINT, exit 130). No full-suite PASS is claimed for this integrated tree. Command started:

```sh
env -u AI_ISOLATOR -u AI_ISOLATOR_REAL_HOME -u AI_ISOLATOR_HOME -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_TOOL TMPDIR=/tmp pnpm test --maxWorkers=6 --minWorkers=1
```

Environment overrides apply only to these subprocesses; no global settings or permissions
were modified. Prior default-environment results remain above and are not reclassified.

Owner steering after integration: “skipp full suite đi”. The full test process was interrupted and confirmed exited 130. Targeted validation remains 283 passed / 1 skipped; dependency check, typecheck and final diff check remain exit 0. No commit/push/PR or worktree cleanup was performed.


Final owner clarification: “merge mà không commit à”. This authorizes committing the
already reconciled telemetry directly on main. The integrated source is the same source
validated by the 283-pass/1-skip targeted run; only this handoff text changed afterward.
No full-suite rerun, push, PR or worktree cleanup is performed.
