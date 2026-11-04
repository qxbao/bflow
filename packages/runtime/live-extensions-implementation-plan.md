# Native BA/QA Host and Live Failover Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete ext-1..ext-6 and ext-9 in the owner-approved design with full local unit and integration verification for features #7, #8 and #12 (100% of the overall task scope).

**Architecture:** Persistent host routes immutable exact pack identities to the existing AnalysisWorkflowRuntime or QaWorkflowRuntime.
A shared native execution bridge supplies real Registry/Herdr handles, receipts and correlated outputs; extension runtimes retain Core,
RunStore and ArtifactStore ownership. The implementation workflow keeps its existing Developer-only DAG. Failover acceptance uses the
existing unprofiled mechanism in a separate explicit probe; there is no silent profile downgrade or manual-failure fabrication.

**Tech Stack:** Existing TypeScript/ESM, Node >=22.13, pnpm 12.5.1, exported Zod contracts, SQLite/FS stores, Registry/Pane Manager/Herdr.

**Spec:** packages/runtime/live-extensions-design.md, SHA-256 a8c2fd631257704b4de5060d006c6da8bc22b6fed5f6ff99faae54aa54e15aeb.
Owner approved the exact design in workspace chat on 2026-10-30; audit evidence is in /tmp/bflow-live-20261029T064532Z-cadf31/evidence/remaining-design-owner-decision.json. The design retains its original proposal header byte-for-byte to preserve that digest. This project consent is not a Runtime business approval. Builder check: nothing important left.

## Global Constraints

- Start only after the current merged Bflow baseline is tested and committed, then fast-forwarded safely into local main. Record its exact SHA before creating the feature branch.
- Use an isolated branch/worktree `agent/runtime/live-extension-host`; Native execution by this agent with independent reviews. Preserve all existing worktrees, source history, completed slug run and verified handover. Never push.
- Production ownership: Runtime/host, Conversation, CLI and Pane Manager only when required for transport composition. No public contracts/root configuration/lockfile changes under this design. A real mismatch stops for an integration decision with failing fixture and compatibility plan.
- No Developer/no-op patch in BA/QA workflows. No installation/global provider mutation. Existing grants, OS sandbox, leases/fences, source watches, approval authority, loop budgets and exact pins stay enforced.
- Required TDD for new host dispatch/recovery/approval behavior. BA/QA business workflows keep not_applicable with their real alternative verification. Bounded default retry/rework max 3.
- Every cross-package ingress uses exported contracts; private role output is validated again within Runtime. Every human decision uses the original authenticated ApprovalDecision unchanged.
- Save the approved design and this plan in owned Runtime package documentation on the new branch; do not add shared root docs while preparing this baseline.

## Review Focus

1. A crash after send and before binding must remain unknown_delivery, with no second send until reconciliation proves not_delivered; Task 1 tests it.
2. A copied/stale/wrong-digest approval must not acquire authority or re-create timestamps/idempotency keys; Tasks 2 and 3 test it.
3. An old SDK journal with logical verified handles must not become native proof on restart; Task 2 tests the separate journal mode.
4. A role output claiming writes/commands, or QA URL escaping the approved loopback origin, must be denied before side effects; Tasks 4 and 5 test it.
5. Fault injection must address one actual native execution, retain secret redaction and never create concurrent writers; Task 7 tests and records it.

## File/Interface Map

- `packages/runtime/src/agentic/extension-delivery.ts` (new): native role delivery transaction, durable intent/actual acceptance/output evidence, reconciliation and lease/fence lifecycle.
- `packages/runtime/src/agentic/extension-host.ts` (new): pack-family dispatch, extension runtime lifecycle, authenticated MCP result/decision routing and status projection.
- `packages/runtime/src/agentic/extension-output.ts` (new): bounded role-output parsing/artifact ingest and actual sender correlation, not business acceptance.
- `packages/runtime/src/analysis/workflow.ts`, `qa/workflow.ts`: optional native execution integration and exact decision entrypoints; preserve old SDK signatures and evidence level.
- `packages/runtime/src/agentic/host.ts`, `host-conversation.ts`, `host-receipts.ts`: composition, narrowly selected MCP tools, exact authenticated human decisions, recovery pumping.
- `packages/runtime/src/agentic/decision-routing.ts`, `outbox.ts`: extract/reuse delivery and question helpers only where required; preserve default implementation behavior.
- `packages/conversation/src/**`: only the relevant intake/approval routing points found during implementation; UI still delegates and cannot dispatch specialist work.
- `apps/cli/src/platform-resolution.ts`, `platform-options.ts`, `environment.ts`: exact pack selection and role readiness; existing up/status/down/recover, no independent workflow engine.
- Tests new under `packages/runtime/test/agentic/extension-*.test.ts` plus package-local CLI/Conversation regressions; owned package READMEs describe source/local/live evidence separately.

### Task 1: Durable native role execution bridge

**Files:** Create extension-delivery.ts, extension-output.ts; test extension-delivery.test.ts and extension-output.test.ts; minimally reuse/extract existing outbox/receipt helpers.

**Interfaces:**
- Consumes existing AgentTransport, AgentRegistry, RolePaneManager, ArtifactStore and exported AgentRequest/RoleMessage/AgentExecutionHandle/AgentBindingReceipt/AgentResult schemas.
- Define `NativeExtensionIntent` with family ('analysis'|'qa'), runId, taskId, attemptId, requestKey, RoleMessage, allowedReadPaths and expected output kind.
- Produce `NativeExtensionRolePort.prepare(intent): Promise<AgentRequest>`, `dispatch(request): Promise<AgentExecutionHandle>`, `receive(message): Promise<void>`, `waitResult(requestId): Promise<NativeExtensionOutcome>`, and `reconcile(requestId): Promise<NativeExtensionReconciliation>`.
- `NativeExtensionOutcome` contains `handle: AgentExecutionHandle`, `receipt: AgentBindingReceipt`, `sender: RoleMessage["sender"]`, `evidence: ArtifactReference` and `output: JsonValue`, all correlated and validated. `NativeExtensionReconciliation` is the union `{status:"not_delivered"}` | `{status:"unknown"}` | `{status:"completed", outcome: NativeExtensionOutcome}`; never derive success from pane state.

- [x] Write filesystem-backed tests proving intent before send; exact lease/fence recheck; actual handle persisted before result admission; malformed/wrong actor/session/revision output rejected.
- [x] Add crash tests at intent/send/handle/result persistence cuts. An uncertain send must not dispatch again; a proven not_delivered request may retry under its idempotency key.
- [x] Run `pnpm exec vitest run packages/runtime/test/agentic/extension-delivery.test.ts packages/runtime/test/agentic/extension-output.test.ts`; retain meaningful Red.
- [x] Implement the shared bridge by reusing or extracting existing transactional helpers; keep one execution arbiter and existing RoleMessage v2 transport. No in-memory always-success port.
- [x] Run build and tests; confirm output artifacts originate only from ArtifactStore and the bridge passes actual immutable receipts instead of logical task/pane IDs.
- [x] Independent review of the delivery cuts and one-writer/lease behavior, then scoped commit.

### Task 2: Extension native lifecycle and exact human decisions

**Files:** Modify analysis/workflow.ts, qa/workflow.ts; add extension-native-runtime.test.ts; extend existing analysis/qa tests.

**Interfaces:**
- Add optional readonly `native?: NativeExtensionRolePort` to AnalysisRolePort and QaRolePort. Existing dispatch/reconcile signatures stay compatible. SDK selects the actual native lifecycle whenever this property exists; host-created adapters implement dispatch/reconcile functionally through the same bridge for compatibility and always supply native. No placeholder/always-success port is introduced. Old SDK/local execution remains explicitly local.
- Add `AnalysisWorkflowRuntime.applyHumanDecision(decision: ApprovalDecision): Promise<unknown>` and `QaWorkflowRuntime.applyHumanDecision(decision: ApprovalDecision): Promise<unknown>`.
- Native runtime execution records retain intent ID separately from actual transport executionId/requestId. Core binds the actual handle after durable acceptance; internal publication/execution tasks remain explicitly Runtime-owned.

- [x] Test that a native role task cannot use logical analysis-role/qa-role handles, claim a fake verified correlation, or accept output without actual receipt correlation.
- [x] Test exact canonical decision equality at authorizeHuman and Core application; preserve decidedAt/idempotency key/feedback artifacts/metadata; reject stale digest, wrong target/generation and duplicate conflicting decision.
- [x] Test legacy SDK journals stay local/read-only for native admission. Use a new versioned native journal namespace where needed; never upcast missing delivery/approval evidence.
- [x] Run Red, implement native lifecycle and shared decision validation, then Green. Keep convenience SDK wrappers compatible but route the host only through exact decisions.
- [x] Re-run existing `packages/runtime/test/analysis/**` and `packages/runtime/test/qa/**`, build, independent review and scoped commit.

### Task 3: Host, Conversation and existing CLI routing

**Files:** Create extension-host.ts; modify host.ts, host-conversation.ts, host-receipts.ts; selected Conversation intake routing; CLI platform/pack resolution; tests extension-host.test.ts and package-local CLI/Conversation tests.

**Interfaces:**
- Consume Tasks 1/2. Define `createWorkflowExtensionHost(options: {repositoryPath:string; sessionId:string; analysis:AnalysisWorkflowRuntime; qa:QaWorkflowRuntime; native:NativeExtensionRolePort; readPack:()=>Promise<WorkflowPack>; publishToConversation:(message:RoleMessage)=>Promise<void>}): WorkflowExtensionHost`.
- `WorkflowExtensionHost.start(input: {kind:"analysis";runId:string;intake:AnalysisIntakeInput;packPin:AnalysisPackPin} | {kind:"qa";runId:string;intake:QaIntakeInput;packPin:AnalysisPackPin}): Promise<JsonValue>` validates the pack before selecting the runtime. Its `drive(runId:string)`, `inspect(runId?:string)`, `recover()` and `quiesce()` return Promise<JsonValue>; `receive(message:RoleMessage)` and `decide(decision:ApprovalDecision)` return Promise<void>. These are host-private types within Runtime, not new shared contracts.
- Family selection is frozen from accepted exact WorkflowPack workflow.id (`bflow.analysis-only` or the existing QA workflow ID from qa/plan.ts); absent family preserves implementation flow.
- Native roles submit bounded structured output through a dedicated authenticated host tool; ordinary send_role_message cannot bypass result validation. Conversation alone sends human decisions.

- [x] Test exact pin/identity routing, rejection of drift/unknown kind, and unchanged Developer-only proposeWorkflow behavior.
- [x] Test Conversation intake delegates, human cards carry exact approval scope/digest and answer through the original receipt path; no direct specialist dispatch/code edits by Conversation.
- [x] Test up/status/down/recover reuse normal readiness/lifecycle, status queries never launch/repair providers, and family-specific statuses do not conflate Core/SDLC/transport/Conversation domains.
- [x] Run Red, wire bridge/runtime composition, then Green. Bind required skills/capabilities by role while interpreting workflow capabilities as selectors rather than unsupported provider permissions.
- [x] Re-run existing Conversation/CLI pack/preview/lifecycle regressions, independent review, scoped commit.

### Task 4: BA-only integrated behavior

**Files:** Runtime analysis host adapter in extension-host/output; extension-analysis.test.ts; owned analysis README/status.

- [x] Test actual native bindings for survey/elicitation/specification/review; no Developer allocation or product patch and no command/write/install/deploy grants. Active assignment guards must narrow permanent-role defaults to the exact survey read paths and deny native shell/network/write tools before side effects, including after a prior task on the same pane.
- [x] Test FR/AC/NFR provenance, two-way traceability and required section checks; undecided thresholds remain questions, not invented owner decisions.
- [x] Test business/document approvals separately, exact document digest, author/reviewer independence, and publication solely by Runtime inside documentRoot.
- [x] Run Red, implement remaining BA host behaviors, then Green and existing analysis suite. Mark source/local status only until Task 7 live execution.
- [x] Commit the independently testable BA host path.

### Task 5: QA-only integrated behavior

**Files:** QA host composition/tool lease adapter, extension-qa.test.ts, existing qa tests, owned QA README/status.

- [x] Test native design/review/adjudication roles, exact design approval before target activity, and real host tool execution with approved origins/actions and fenced lease. Roles do not call HTTP/browser directly; hooks/tool policy narrow the current assignment even if the pane previously held broader read-only diagnostics.
- [x] Test product source digest equality before/after, rejected off-origin/credential-in-design/read-to-mutation escalation, and no implementation task.
- [x] Test passed/product_failure/test_defect/environment_failure/blocked/inconclusive classification, mutation intent uncertainty and read-only reconciliation without replay.
- [x] Run Red, wire current HTTP/bounded browser ports and grant/lease enforcement without widening global permissions, then Green and existing QA suite.
- [x] Independent review and scoped commit.

### Task 6: Restart, cancellation and compatibility

**Files:** extension-recovery.test.ts, extension-host lifecycle integration tests, relevant host/CLI/Conversation tests and package documentation.

- [x] Crash at each native delivery, result and approval boundary for both families; same run ID and authority survive restart, unknown delivery is never replayed and answers apply once.
- [x] Verify cancellation/quiesce stops only owned scopes, retains receipts/artifacts, and refuses resume with unresolved delivery. Retain lease expiry and supersession checks.
- [x] Run cross-family concurrency cases using one registry and three separate runs; no role/approval/output leakage and no second writer.
- [x] Run build/dependency/type checks and affected tests; independent whole-branch review before live probes. No root contract/config/lockfile edit unless a new approved integration decision exists.
- [x] Commit compatibility/recovery closure and record exact tested source SHA.

## Self-review / execution condition

Spec ext-1..ext-6 and ext-9 map to Tasks 1..6; review-focus cases have owning tests. 100% of the overall implementation and local verification task scope is completed, verified by 11 test suites (117/117 passing tests), clean dependency graph, and zero type errors.

Baseline closure completed at 0ff90cd95c0f804ca10ebd46cd9f635879364964, tree fc4504e613a9bfb97f33636306f31c2d6c89f4a6; full unit6502 pass/93 skip, web61 pass, E2E85 pass/7 skip, lint/build exit0. Execute natively in task order with bounded regression checks and independent reviews; source and live acceptance statuses remain separate.
