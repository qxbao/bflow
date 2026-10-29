# Bflow Runtime Maintenance Handoff: Policy-Required Manual Review

Date: 2026-10-29.
Scope: Resolve proposal rejection before Spec design approval caused by policy-added `manual_review` on high-risk proposals, and establish verified, independent phase-review evidence for Conditional TDD.

## 1. Root Cause Verified

High-risk or critical-risk workflows and tasks in Bflow are assigned `manual_review` and `static_analysis` by P16 Conditional TDD policy (`packages/test-strategy/src/policy.ts:evaluatePolicy`) in addition to any acceptance criterion methods (e.g., 4 `integration_test` criteria in Việc #3).

1. **Ingress capability assertion failure**: `HostVerification.assertPolicyMethods` previously required runner-command capabilities for every method in the resolved strategy. It treated `manual_review` as a command runner rather than an independent QA/Reviewer review obligation, rejecting valid proposals before design approval with `unsupported_method: ["manual_review"]`.
2. **Phase evidence deadlock**: Under Conditional TDD (`required` or `recommended` mode), successful phases (`green`, `refactor`, or `verification`) require proof of all strategy methods. Runtime lacked an authenticated protocol for QA to inspect committed work and submit explicit criteria judgments before minting phase evidence.
3. **Artifact and authority lifecycle**: Reusing review gates across phases violates P16 rules forbidding repeated artifact IDs and stale observation timestamps. Each phase requires an independently bound observation and artifact.

Primary artifacts: `proposal.redacted.json`, `original-assessment-result.json`, `policy-resolution.json` in `/tmp/bflow-manual-review-maintenance/`.

## 2. Implemented Architecture and Code Changes

- **`packages/runtime/src/agentic/policy-phase-review.ts`** (NEW):
  - Defines `policyPhaseReviewAssignment` and `PolicyReviewSubmissionSchema`.
  - Implements QA review inspection via `inspect_alternative_verification` returning observation metadata and criteria checklist.
  - Requires explicit criteria judgment submission via `record_behavioral_verification.review = { observationId, criteria }`.
  - Enforces strict cryptographic/identity binding: `requestId`, `attempt`, `executor` independence, lease/fencing token, Spec fingerprint, `sourceRevision`, and `phase`.
  - Generates unique host-stored artifacts per phase; prevents reuse of `green` review for `refactor`.
- **`packages/runtime/src/agentic/host-verification.ts`**:
  - Distinguishes automated command-runner obligations from independent review obligations in `assertPolicyMethods`.
  - Integrates `inspectAlternative` and binds submitted reviews into `behavioralEvidence`.
- **`packages/runtime/src/agentic/runtime.ts`**:
  - Handles policy verification failure after submission by preserving the failure receipt and routing to Coordinator manual recovery via Conversation instead of awakening a terminal Developer execution.
  - Aligns `phaseFailureReply` messaging with manual Coordinator recovery.
- **`packages/runtime/src/agentic/host.ts`**:
  - Preserves full human design approval gate (`humanApprovalRequired`) for high-risk proposals.
  - Ensures design approval advances only the design gate and does not fabricate implementation/delivery acceptance.
- **`packages/runtime/README.md`**:
  - Documents the policy-required manual review protocol, QA inspection lifecycle, binding requirements, and evidence rules.
- **`packages/runtime/test/agentic/host.test.ts`**:
  - Fixed test isolation in `blocks prepare without launch material when a required provider is not ready...` by isolating codex home/process directories from ambient machine credentials.

## 3. Baseline, Worktree and Dirty State

- **Base commit**: `e9b0cf2e91f9f3fc9edbee40cf707d61cc5a4b12` (equal to `origin/main`, descendant of P24 `8dbb056` and historical survey `6c4dc68`).
- **Worktree**: `/home/DUCLH/orca/workspaces/bflow/fix-runtime-manual-review-policy`
- **Branch**: `fix/runtime/manual-review-policy`
- **Tracked modified files**:
  - `packages/runtime/README.md`
  - `packages/runtime/src/agentic/host-verification.ts`
  - `packages/runtime/src/agentic/host.ts`
  - `packages/runtime/src/agentic/runtime.ts`
  - `packages/runtime/test/agentic/host.test.ts`
  - `packages/runtime/test/helpers/agentic-integration-fixture.ts`
- **Untracked files**:
  - `packages/runtime/manual-review-maintenance-handoff.md` (this handoff)
  - `packages/runtime/manual-review-maintenance-plan.md`
  - `packages/runtime/src/agentic/policy-phase-review.ts`
  - `packages/runtime/test/agentic/manual-review-policy.test.ts`
  - `packages/runtime/test/agentic/manual-review-runtime.test.ts`
- **Contract / Migration impact**: None. Zero changes to `@bflow/contracts`, zero database migrations, zero changes to root configuration or dependencies.

## 4. Verification Evidence and Test Results

Working directory for all tests: `/home/DUCLH/orca/workspaces/bflow/fix-runtime-manual-review-policy`.

| Command | Exit Code | Result Summary |
| --- | :---: | --- |
| `pnpm check:deps` | 0 | PASSED. 0 dependency violations across packages. |
| `pnpm typecheck` | 0 | PASSED. 0 type errors in source. |
| `pnpm exec vitest run packages/runtime/test/agentic/manual-review-policy.test.ts` | 0 | PASSED (20/20 tests). Full Red→Green→Refactor lifecycle, recommended mode, 15 fencing checks. |
| `pnpm exec vitest run packages/runtime/test/agentic/manual-review-runtime.test.ts` | 0 | PASSED (4/4 tests). Real Runtime proposal ingress, authenticated human design approval gate, stale approval invalidation on Spec update. |
| `pnpm exec vitest run packages/runtime/test/agentic/host.test.ts -t "blocks prepare without launch material"` | 0 | PASSED (1/1 test). Isolated provider preflight. |
| `pnpm exec vitest run packages/runtime/test/agentic/integration-p19-approval-verification.test.ts -t "starts a dependent task from its dependency's verified head" --testTimeout 60000` | 0 | PASSED (1/1 test). Verified branch integration and dependent task dispatch. |
| `pnpm exec vitest run packages/runtime/test/agentic/manual-review-policy.test.ts packages/runtime/test/agentic/manual-review-runtime.test.ts packages/runtime/test/agentic/host-verification.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot` | 0 | PASSED (54/54 tests, duration 335s). Comprehensive focused regression suite for modified/added modules. |

## 5. Acceptance Status Matrix (A–F)

- **A. Regression reproducing pre-approval rejection**: **PASSED**. Initial baseline RED reproduced exact `unsupported_method: ["manual_review"]`.
- **B. Valid proposal reaches human review/approval**: **PASSED**. High-risk proposal reaches authenticated human design approval; pending decision blocks Developer dispatch; valid decision advances only its gate.
- **C. Automated capabilities and runner errors preserved**: **PASSED**. Unsupported command runners or missing mappings reject with actionable errors.
- **D. Fencing against missing, forged, or stale review/approval**: **PASSED**. 15 explicit test cases verify that changes to Spec, revision, role, lease, attempt, or executor invalidate prior authority.
- **E. High-risk policy preserved**: **PASSED**. 4 original criteria and high-risk classification remain untouched; no risk downgrade or self-approval shortcuts.
- **F. Validation reporting & limits**: **PASSED**. Dependencies, types, and focused unit tests verified with exact commands and exits. No live dbt/warehouse acceptance claimed.

## 6. Host Rollout and Retry Instructions

1. **Authorization**: Project owner reviews the diff and authorizes integration of branch `fix/runtime/manual-review-policy` into host.
2. **Build**: Run `pnpm --filter @bflow/runtime build` in the host checkout.
3. **Retry Việc #3**:
   - Re-propose Việc #3 draft v5 through the official Bflow Coordinator/Conversation protocol (`propose_workflow`).
   - The proposal will cleanly pass ingress validation and pause at the required human Spec approval gate.
   - Authorize the design through the official Conversation approval interface.
   - When implementation reaches Green/Refactor phases, assigned QA performs independent inspection and submits review evidence via the new protocol.
