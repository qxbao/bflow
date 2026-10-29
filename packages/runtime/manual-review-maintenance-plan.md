# Manual-review policy maintenance implementation plan

**Goal:** Repair policy/ingress/evidence orchestration so a high-risk proposal can reach its required human Spec gate without weakening independent verification.
**Architecture:** Keep manual review in the existing Runtime/Host review and human-approval paths. Preserve exported contracts and P16 method obligations. Behavioral runners prove automated methods; authenticated, scope/revision-pinned review evidence proves review obligations. Design approval and final acceptance remain separate.
**Tech stack:** TypeScript, exported Zod contracts, Vitest, existing host receipts and runtime journal.
**Spec:** The project owner's maintenance request in this conversation, acceptance A–F. This document records that scope; it does not approve Việc #3, mint evidence, or change its accepted Specification.
**Execution:** User explicitly assigns coding to agy:implementer. Host owns diagnosis, plan and review; AGY executes tasks sequentially using Conditional TDD. No commits/push/PR/merge.

## Scope and acceptance

A. A failing regression reproduces `unsupported_method` for policy-added `manual_review` before design approval.
B. A valid proposal reaches the correct human approval/review step. Pending approval prevents gated dispatch.
C. Automated capabilities and exact test identities remain validated; genuinely unsupported methods retain actionable errors.
D. Missing/forged/stale review or approval cannot pass. Changed Spec invalidates prior authority; source revision, spec fingerprint, run/task, attempt and executor binding remain enforced as applicable.
E. High-risk policy retains mandatory static analysis, manual review and behavioral checks. No self approval, fabricated success, risk downgrade or AC-method substitution.
F. Run required repository checks and affected package tests, reporting exact commands, exits and counts; no dbt/warehouse/live acceptance claim.

Only `packages/runtime/**` is assigned implementation ownership. Read other packages to understand their contracts. Do not change contracts, root files, docs, lockfile, test-strategy, verification, conversation or agents. If a compatible Runtime-only fix cannot enforce the obligations, return the exact mismatch, failing fixture and proposed integration decision; do not silently weaken P16.
No live session mutation, transport dispatch, approval, setup/init/up/down, migration, dbt installation, warehouse access or local commits. No file mailbox. Local reports and immutable diagnostic artifacts are allowed.

## Baseline and primary evidence

- Base: `e9b0cf2e91f9f3fc9edbee40cf707d61cc5a4b12`, equal to observed `origin/main`, retaining both `6c4dc68af6dcb7920320afd058bfb5a9a10ec688` and P24 `8dbb056` by ancestry. Local `main` is older and must not be used as the comparison base.
- Worktree: `/home/DUCLH/orca/workspaces/bflow/fix-runtime-manual-review-policy`; branch `fix/runtime/manual-review-policy`.
- Read-only saved journal confirms run `run-7437707477615c8d631783b138d2eeaf9f568baca40253ba895f583e83e0752d`, delegation revision 4, `clarifying`, no admitted tasks/design approval, rejection at `2026-10-28T08:56:01.646Z`, code `unsupported_method`, methods `[manual_review]`.
- `/tmp/bflow-manual-review-maintenance/proposal.redacted.json`: proposal v5 reconstructed offline from exact Coordinator tool-call draft transformations and saved delegation r4, with tools replaced by inert stubs. Provenance includes call IDs/hashes. This is a reconstructed input, not a fresh live submission or provider acceptance proof. The original Runtime rejection is in the journal and matching tool-result transcript.
- All four AC methods are `integration_test`; ac-4 remains “Không claim warehouse/live acceptance từ fixture tests.” Four task IDs: dq-structural → dq-fixture → dq-adversarial → dq-evidence-boundary.
- Policy `packages/test-strategy/src/policy.ts:evaluatePolicy` adds static_analysis/manual_review for high risk. Its evidence validator requires every required method in successful phases and exempts manual_review from command capability.
- Runtime `host-verification.ts:assertPolicyMethods` instead always classifies manual_review as missing; `measureBehavioral` currently creates automated observations only. Simply skipping ingress validation leaves a later evidence deadlock.
- `runtime.ts:projectTaskSpecificationInput` narrows criteria/mappings and inherits assessment. `host.ts` validates strategy/capability before `proposeWorkflow`; Runtime separately validates per-task commands before publishing design approval.

## Review focus

1. Policy-level manual_review with four automated ACs is different from an explicit manual acceptance criterion; retain existing unsupported mixed-criterion restrictions unless intentionally proven compatible.
2. Spec design approval is human authority to implement; it is never a manual implementation review or final acceptance receipt.
3. Independent Reviewer/QA roles and human decisions have distinct authority; don't relabel an agent review as a human approval.
4. Green/refactor and recommended alternative phases must retain P16 method completeness. Red failing behavior does not require invented successful manual review.
5. Replays/restarts, spec changes and revision changes must not reuse stale review evidence; default and owner-configured checks must both fail closed when review capability is absent.

## Task 1 — Reproduction and causal trace (A, E)

Files to inspect: `src/agentic/host-verification.ts`, `host.ts`, `runtime.ts`, `host-policy.ts` and review/receipt helpers; read-only P16 policy/evidence and verification engine/model.
Test candidates: `test/agentic/auto-runner.test.ts`, `runner-proposal-remediation.test.ts`, `host-verification.test.ts`, `behavioral-runner-phases.test.ts`; create `test/agentic/manual-review-policy.test.ts` if a focused fixture is clearer.

- [ ] Parse the redacted Spec/definition with exported schemas and resolve actual policy. Record risk, generated required methods, TDD mode and task projections; separate any unrelated runner/setup blocker from this bug.
- [ ] Reduce real shape to a sanitized reusable fixture: high-risk full Spec, four integration criteria, auto:integration + auto:static and four dependency-ordered tasks. Don't add a manual AC or alter accepted ac-4.
- [ ] Test ingress under real configured/detected capability and expect admission to design approval rather than unsupported manual_review. Run BEFORE changing production; retain expected RED error, exact command and exit.
- [ ] Run relevant existing package tests on baseline; distinguish pre-existing failures from regression RED.

## Task 2 — Smallest compatible fix and proof of review (B, D, E)

Consumes: exported Specification/TestStrategy, unchanged P16 `recordEvidence` obligations and existing host-owned review receipts.
Produces: accepted proposal + honest waiting/review path, authenticated manual_review observations only after the correct independent judgment/decision.
Likely owned files: `src/agentic/host-verification.ts` and, only when required, Runtime-private orchestration/receipt helpers in `src/agentic/**`.

- [ ] Trace how default host-reviewer/host-qa definitions become available, how exact criteria and spec fingerprint are bound, how a reviewer is allocated and authenticated, and where successful P16 phases are recorded.
- [ ] Confirm whether the mandatory manual_review obligation denotes existing independent Reviewer/QA review or a human judgment. Preserve its actual policy meaning; retain all explicitly human gates via Conversation.
- [ ] Write regression(s) proving pending manual judgment cannot count as completed evidence and Spec approval alone cannot satisfy manual review.
- [ ] Implement real review capability/routing instead of a command-runner adapter. If automatic phase recording needs review evidence first, compose the existing authenticated review path; don't strip manual_review from the policy, manufacture a passed observation or mint receipts from caller JSON.
- [ ] If separate human evidence is necessary, use existing authenticated Runtime→Conversation decision mechanisms, bound to exact target/Spec revision. Do not add native direct questions or a new approval shortcut.
- [ ] Keep all automated runner, command, path and identity checks intact; keep public contracts and policy source untouched.
- [ ] Run RED regression to GREEN and record the smallest production diff.

## Task 3 — Guard and stale-authority matrix (B–E)

Tests: focused new file plus existing `integration-p19-approval-verification.test.ts`, requirement revision, host review and host evidence tests as appropriate.

- [ ] Valid high-risk input reaches design gate; tick/recover while pending never dispatches Developer. Valid authorized human decision can advance only its gate.
- [ ] Missing review; fake caller result/receipt; wrong role/executor/run/task; wrong Spec revision/fingerprint; changed source after inspection; replay after Spec change all fail closed. Exercise actual production validators/receipt checks rather than self-fulfilling mocks.
- [ ] A review for revision N cannot satisfy N+1; ensure approval invalidation is tested separately from source-review invalidation.
- [ ] Automated-only supported methods still work. Unsupported behavioral/static methods and missing automated mapping still reject clearly.
- [ ] High/critical risk continues requiring manual_review and static_analysis for workflow and projected tasks. Recommended/not-applicable evidence paths remain honest; required TDD keeps Red-Green-Refactor.
- [ ] Test real admission and real review/evidence APIs together sufficiently to catch a late verification deadlock, not merely the first validator.

## Task 4 — Validation and handoff (F)

From worktree root, after rebuilding source changes:

- [ ] `pnpm check:deps`
- [ ] `pnpm typecheck`
- [ ] `pnpm exec vitest run <focused tests and related Runtime suites>` — choose actual files, report exact full command.
- [ ] `pnpm test:affected --base e9b0cf2e91f9f3fc9edbee40cf707d61cc5a4b12 --run` — report printed selection/index widening, files/counts; if full, run full unit+E2E as repository instructions require. Don't refresh GitNexus through live repository setup.
- [ ] `git diff --check`; `git status --short`; `git diff --stat`; `git rev-parse HEAD`.
- [ ] Add Runtime-owned maintenance evidence/handoff with RED/GREEN commands, exits, pass/fail/skip counts, exact tested HEAD plus uncommitted diff identity, root cause, limitations, migration/config requirement (only if real), and coverage A–F. Never claim full acceptance from agent turn completion.
- [ ] Describe integration without doing it: owner reviews diff, authorizes integration/build in host checkout, schedules safe host lifecycle changes preserving authoritative state, then Conversation/Coordinator retries the original proposal through official Bflow tools and presents fresh human gates. No database edits, old approval replay or automatic retry now.
