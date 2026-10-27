# TI-01 local implementation evidence — 2026-10-26

Tested HEAD: `8895eccbf610fd1e499f7a61179aa71e66c86272` plus the uncommitted
TI-01 diff in `.worktrees/test-integrity`, branch
`agent/quality-gates/test-integrity`. No commit, push, PR or migration.
Local `main` and cached `origin/main` both referenced that HEAD at initial inspection;
the initial working tree/index were clean and HEAD retained P24 ancestry. This is
local evidence, not a remote closure or a live Herdr/provider acceptance claim.

The project owner approved TI-01 and its exact TypeScript 5.9.3 lockfile importer
change in this conversation, then required owner exceptions per candidate. Planning
artifacts: `/tmp/bflow-test-integrity-design.md`, `/tmp/bflow-test-integrity-plan.md`.
Conditional TDD was required for deterministic validation/workflow behavior. Red
cases were executed before implementation and before fixes; no native Bflow approval
receipt or live workflow is fabricated from this external implementation session.

## Ownership and integration

Production changes are confined to `packages/runtime/**`: parser, bounded Git blob
reader, host gate registration and review tools, Runtime owner approval routing and
additive private journal validation. Package README and package-local tests are in
that ownership. The only shared change is the owner-authorized three-line importer
in `pnpm-lock.yaml`; no shared contracts, `docs/**`, root configuration or root README
changed. The Runtime package adds an exact direct dependency on TypeScript 5.9.3,
already present in the lockfile. Generated `dist/**`, databases and logs are not
included in the diff.

The surveyed `quality-gates` already provides independent evaluators/command results;
`verification` already owns bounded loops and independently validates observations;
Runtime already composes those checks, behavioral/regression measurements and
ArtifactStore evidence. Existing runner-definition pinning protects execution inputs,
not assertion deltas. Review/test-planning skills already require criterion/risk
traceability. These components were reused without a second verification engine.
The supplied `assertion_rot.py` informed scenarios; its global keyword bans and
comment-based waivers were not adopted.

`host-test-integrity` is required for task and integrated-workflow plans. It compares
immutable original-base/candidate blobs with Git replacement refs disabled. Rework
retains the first task base; workflow retains run base. Findings carry revisions,
side/path/line/column, rule/finding IDs, bounded snippets and checkable reasons.
Literal tautologies are proven violations; other deltas and coverage gaps require
an exact, complete independent Reviewer disposition set and committed source anchors.
Confirmed weakening cannot pass without an authenticated owner exception. Exceptions
bind run/task/attempt/revisions/spec/scope/finding/evidence and reauthenticate after
restart. Developer comments/metadata, generic user decisions and QA cannot self-waive.

Conservative v1 tradeoff: default host plans downgrade fast-path even on a clean diff
so Reviewer is always present. Existing fast-path integration tests now require both
task/workflow Reviewer and QA, assert actual gate receipts and persisted downgrade,
and preserve design/delivery approval checks. Cached pre-upgrade plans missing the
gate or keeping a review waiver are fenced; old evidence is never upgraded silently.
Human-wait/timeout/reconciliation remains the existing Runtime behavior.

## Executed evidence

- Baseline `pnpm check:deps`: exit 0.
- Baseline `pnpm typecheck`: exit 0.
- Baseline targeted quality/verification/host/regression suites: exit 0,
  12 files / 181 tests passed.
- Baseline `pnpm test`: exit 1, 17 failed / 262 passed / 7 skipped files;
  79 failed / 5,192 passed / 80 skipped tests (5,351 total).
  Full log: `/tmp/bflow-test-integrity-baseline.log`.
- Parser/host/authority/receipt suites: `/tmp/bflow-ti-core-final.log`, exit 0,
  4 files / 78 tests passed; subsequent replace-ref test:
  `/tmp/bflow-ti-host-handoff.log`, exit 0, 18 tests passed.
- Extended authority, existing user-decision Runtime/E2E and fast-path unit suites:
  `/tmp/bflow-ti-targeted-final.log`, exit 0, 7 files / 139 tests passed
  (earlier snapshot; later changes separately rechecked).
- Compatibility quality-gates/verification/behavioral/host suites:
  `/tmp/bflow-ti-compat-targeted.log`, exit 0, 11 files / 225 tests passed.
- Connected Runtime policy phases: `/tmp/bflow-ti-integration-final.log`, exit 0,
  6 passed / 123 intentionally filtered tests. Includes actual task/workflow host
  invocation and ArtifactStore retrieval, plus bounded rework for a literal tautology
  while behavioral measurements remain passed; fake Herdr transport is explicitly
  not live Herdr evidence.
- Fast-path integration with mandatory integrity policy:
  `/tmp/bflow-ti-fastpath-integration-final.log`, exit 0, 3 tests passed.
- Intermediate full run `/tmp/bflow-test-integrity-final-full.log` was intentionally
  interrupted (exit 130) because workers had loaded older modules while review fixes
  were being applied. It is not final validation; the stable full run is recorded below.

Independent source review found report amplification, coverage sign/unit changes,
old-plan replay, replaced Reviewer fencing, binary fixture handling and missing
verdict evidence. Each was reproduced or pinned with regression cases and fixed.
Scoped re-review found no remaining Important/Critical issues. Report/input bounds,
foreign assertion imports, opaque config, platform skip, fixtures, rename/move,
equivalent primitive assertions, owner rejection/expiry/restart, stale/missing IDs,
source drift and Git replacement refs have local checks.

## Known false positives, false negatives and acceptance limits

- Parser support is JS/JSX/TS/TSX for the explicit Vitest/Jest, ESM Node test/assert
  and Playwright forms in fixtures. Other languages are not assertion-parser support,
  regardless of behavioral runner support. No polyglot assertion-integrity claim.
- Repeated config keys in different nested scopes can be paired heuristically;
  edited skipped tests can re-flag skip; marker multiset matching does not prove
  the same marker stayed in the same test. These require Reviewer, not an automatic
  violation verdict.
- Custom/helper assertions, CommonJS aliases, dynamic generation/discovery, opaque
  imported helpers and nonstandard test paths can escape precise semantic analysis.
  Recognized unsupported forms create coverage gaps; arbitrary unrecognized forms
  cannot be guaranteed detected. A clean syntax report does not establish full
  semantic equivalence or replace behavioral/regression and independent review.
- Changed discovery is a suspicion, not proof of narrowing. Truthy checks, conditional
  skips and test-count changes alone are not automatic failures.
- Binary fixture data is not parsed as test source. Deleted fixture helpers are not
  deleted test declarations. Equivalence/move matching is bounded to supplied changed
  sources; substantial moves/rewrites can need manual confirmation.
- Bounds: 256 changed source/config files, 1 MiB/blob, 8 MiB aggregate, 2,000 findings
  and roughly 2 MB report. Bounds fail explicitly; no truncation into a false PASS.
  Stored excerpts are 256 chars and reasons 512 chars; exact Git anchors remain
  available to check source. Large responses page findings with full report evidence.
- Browser syntax inspection is not a live browser run. Same-UID isolation, live
  provider transport, full SDLC/fault acceptance and unrelated P02/P03 follow-ups
  are not certified by these tests.

## Final stable validation

| Command / evidence | Exit | Observed result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Acyclic workspace graph and ownership boundaries verified |
| `pnpm typecheck` | 0 | Full monorepo build/typecheck |
| `pnpm test` | 1 | 15 failed / 267 passed / 7 skipped files; 80 failed / 5,265 passed / 80 skipped tests (5,425 total) |
| `git diff --check` | 0 | No whitespace errors |
| `git status --short` | 0 | Expected uncommitted Runtime changes plus approved lockfile importer; no generated files |

Stable production-source full log: `/tmp/bflow-ti-final-stable-full.log`.
This full run passed all three new files (47 AST + 18 host + 7 authority = 72 tests),
all 129 tests in `integration.test.ts`, and all 3 native-host fast-path integration
cases. Against baseline, 74 unique failures recur; 5 baseline failures did not recur;
6 new failures were observed. Five of those six were the old `fast-path-run` fixture
using new default definitions without registering the gate and still expecting old
default waivers. That test-only compatibility repair was applied after the full run
had loaded the file; `/tmp/bflow-ti-fastpath-policy-final.log` then passed **11/11**,
including an added default-policy no-waiver case. Four prior low-level waiver cases
retain their assertions under explicitly injected custom policies without integrity;
default fixtures keep integrity. Independent review verified coverage was preserved.
No production code changed after this full run began. The whole suite was not rerun
after this final test-only fixture repair, so the 80 failures above are the actual
full-run result, not a claim that the final tree has exactly 80 failures.

The one new unresolved failure is unchanged `runner-detection.test.ts` →
`detectTestRunners > detects the real repository runner`. It rejects uncommitted
runner definitions because the Runtime manifest is intentionally different from
committed HEAD after adding the approved parser dependency. Message:
`Runner definitions must match the committed original revision`.
The user prohibited implementation commits, so this guard was preserved and the
uncommitted manifest was not made to masquerade as committed provenance. This is a
handoff limitation, not a claim of green full validation.

Existing failures include unsafe provider approval-state directory permissions under
`/home/baodq/.local/share/ai-isolator`, Unix-socket/platform fixture behavior, isolated
profile probes and Gateway control fixtures. No global permissions/state were changed
to make these tests green. Exact failing names and stack traces remain in both logs.

Full-run failing files (includes the subsequently repaired fast-path fixture):

| File | Failed cases in full run | Baseline overlap |
| --- | --- | --- |
| `apps/cli/test/codex-hook-setup.test.ts` | 19 | 19 |
| `apps/cli/test/gateway-control-client.test.ts` | 2 | 2 |
| `apps/cli/test/host-recovery.test.ts` | 1 | 1 |
| `apps/cli/test/iso-agy.test.ts` | 4 | 4 |
| `apps/cli/test/iso-engine.test.ts` | 1 | 1 |
| `packages/agent-providers/test/agent-providers.test.ts` | 6 | 6 |
| `packages/agent-providers/test/codex-compatibility.test.ts` | 9 | 9 |
| `packages/agent-providers/test/codex-hook-trust.test.ts` | 27 | 27 |
| `packages/agent-providers/test/codex-probe-coalescing.test.ts` | 1 | 1 |
| `packages/agent-providers/test/profile-environment.test.ts` | 1 | 1 |
| `packages/artifact-store/test/artifact-store.test.ts` | 1 | 1 |
| `packages/runtime/test/agentic/fast-path-run.test.ts` | 5 | 0 |
| `packages/runtime/test/agentic/host-recovery.test.ts` | 1 | 1 |
| `packages/runtime/test/agentic/polyglot-core.test.ts` | 1 | 1 |
| `packages/runtime/test/agentic/runner-detection.test.ts` | 1 | 0 |

Final non-document diff content SHA-256: `8811610360140b818b706b3b57f10e2100d32ee74072f012ef6b00b9d08f544d`
(sorted changed/new paths, each path + NUL + file bytes + NUL; excludes `.md`).

Final ownership diff:

```text
packages/runtime/README.md
packages/runtime/TEST-INTEGRITY-VALIDATION.md
packages/runtime/package.json
packages/runtime/src/agentic/host-test-integrity.ts
packages/runtime/src/agentic/host-verification.ts
packages/runtime/src/agentic/host.ts
packages/runtime/src/agentic/journal.ts
packages/runtime/src/agentic/runtime.ts
packages/runtime/src/agentic/test-integrity.ts
packages/runtime/test/agentic/fast-path-run.test.ts
packages/runtime/test/agentic/fast-path.integration.test.ts
packages/runtime/test/agentic/host-test-integrity.test.ts
packages/runtime/test/agentic/integration.test.ts
packages/runtime/test/agentic/test-integrity-authority.test.ts
packages/runtime/test/agentic/test-integrity.test.ts
pnpm-lock.yaml
```

Environment: Node `v24.16.0`, pnpm `12.5.1`, Linux local POSIX test fixtures.
No public contract decision or migration is requested. No generated output is committed.

## Local integration authorization

After the implementation handoff above, the project owner explicitly requested
"Merge main đi". This supersedes the earlier prohibition on implementation commits
for the local commit/merge only. The pre-integration test evidence and failure
comparison above remain historical observations; no remote push or PR is authorized.
