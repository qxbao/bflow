# W02 Conversation owner handoff

Baseline: `9d563b90f3ade8f213bc7a09edd2eb96ee109c97`, the existing Runtime W02
foundation descendant of main `607d101`, W01 `114de68`, accepted W00 `2bd99d8`
and P24. Worktree `.worktrees/local-web-conversation-w02`, branch
`agent/conversation/w02`. Created a separate worktree with a clean index;
checked refs/worktrees/ancestry and `git cherry agent/runtime/w02 HEAD` before
implementation. No reset, other-worktree changes, fetch/push/PR/remote merge.

Source commits in dependency order:

1. `d685a5376447dc6bd036b129eb772fec5b1e54d6` — structured admission/records.
2. `3ecdd2b6de866c9bc20ab23eb1a83ef0a0339ba2` — preserve Conversation cancellation
   boundary and close answered clarifications.
3. `9e9b02b98a4ff07fb20008aee10987fc09ec95e7` — observe committed rejections.

Only `packages/conversation/src/{conversation-gateway,types}.ts` and
`packages/conversation/test/{structured-interaction.test.ts,W02-HANDOFF.md}`.
No public contracts/schema, root/build/lockfile/shared documentation, Runtime,
CLI, server or UI edits. Native UserTurnInput/MessageProvenance and physical
hook authority are unchanged. This is one owner portion of W02, not standalone
W02/full SDLC acceptance.

## Implemented API and composition requirements

`ConversationGateway.handleStructuredInteraction(commandInput:unknown,
principalInput:unknown): Promise<OperationResult<WebOperationResult>>` parses
the frozen exported WebCommand/WebPrincipal schemas. It checks command digest,
project/command/host session binding and requires the host callback to approve
the proof/current action. No default trust and no `authenticatedUser` shortcut.

Config callbacks (private owner composition; no new public codecs):

- `authorizeStructuredInteraction(command:WebCommand, principal:WebPrincipal):Promise<boolean>`:
  mandatory signature/registered issuer/live TTL/nonce/scope and current Runtime
  policy/version validation belongs to the host. Gateway cannot derive Runtime
  pending-action versions from Conversation's display projection. A callback
  returning true without those host checks is not a production configuration.
- `onStructuredApproval(decision:ApprovalDecision, command:WebCommand,
  principal:WebPrincipal):Promise<OperationResult<void>>`: host persists its
  accepted web human marker before queueing through the existing Runtime path.
  Native bridge/onHumanDecision remains separate and unchanged.
- `onStructuredResume(command:Extract<WebCommand,{kind:'resume'}>,
  principal:WebPrincipal):Promise<OperationResult<WebOperationResult>>`:
  Conversation-owned admission invokes the existing Runtime resume semantics;
  the host must validate exact action, cancellation/approval state and bounds.
- `config.now()` supplies host-accepted command timestamp during structured
  admission, making the derived decision deterministic on recovery. Signature
  verification uses the real ingress clock in the host, not this saved clock.

Decision exact shape agreed with Runtime owner: schemaVersion 2, command's
approvalId/runId/target/revision/generation/outcome, Conversation sessionId,
decidedBy principalId, decidedAt config.now(), reason exact command.reason or
`User approved`, feedbackArtifacts empty, idempotencyKey
`web-decision-${commandId}`. Metadata is absent unless selectedOption exists;
then it is exactly `{selectedOption}`. No native provenance or fake user turn.

`readStructuredInteraction(commandId:string)` loads committed context without
execution, queueing or writing. Applied returns persisted immutable result;
definitively failed returns persisted ContractError; unresolved intent/unknown
delivery/no record returns undefined. Store corruption is an error, not proof
of a failed effect. Host must reconcile unresolved effects from authoritative
outbox/Runtime evidence and must not resend.

## Admission and recovery behavior

Create/revise/clarification use the existing buildDelegationRequest and bridge,
not text intent classification or model calls. Model `agentBusy` does not block
them. Explicit criterion methods and constraints are retained; feature/security
requests keep full SDD policy, existing full SDD is not downgraded. Criteria
remain pending draft records, not accepted Specifications or success evidence.

Deterministic IDs: delegation messageId/idempotencyKey
`web-delegation-${commandId}`, delegationId `web-del-${commandId}`, initial
runId `run-web-${commandId}`. Metadata has `userInteractionCommandId` for host
observation and `constraints`. Requirement revisions preserve the existing run
and correlation at admission; Runtime retains follow-up/lineage authority.
The host must return actual post-effect lineage when its operation settles.

Pre-run clarification uses the existing stable correlationId/intakeId and W01
question ID/version digest algorithm, removes only the named question and
retains explicit criteria. Missing criteria remain clarifying with a concrete
criterion question; answering that question supplies a pending manual-review
criterion rather than inventing approved work. Session unresolvedQuestions are
rebuilt; web decisions close matching native approval clarifications.

Cancellation builds the existing Conversation-to-Coordinator cancellation
delegation; CancellationRequest.requestedBy is **conversation**, as Runtime
requires, with signed user identity retained in userInteractionPrincipalId.
Queued cancellation is not a process-stop receipt. No direct stop or legacy CLI.

Private optional `structuredInteractions` map is additive to Conversation's
internal version-2 snapshot. Each record pins command, principalId, fingerprint,
acceptance time, immutable delegation/decision and intent/applied/failed/
unknown_delivery status. Strict schema validates command-map identity,
fingerprint and conclusive-state fields. Old snapshots without the map still
parse. This is not a public schema amendment or native receipt upcast. Pending
new records must not be silently discarded by downgrading to older code.

Intent is saved before bridge/callback effect. Matching replay returns saved
result; changed body/principal conflicts; interrupted intent/unknown delivery
cannot execute again. Gateway uses existing processing/queue boundary: active
native admission wins against a newly arriving structured mutation; native
arrivals queue during structured admission. Unresolved durable web approval
intents reserve the exact approval against contrary native answers after
restart. Host still owns native/web durable authority and Runtime settlement.

The snapshot merge also preserves structured receipts and corresponding latest
state when an earlier native busy-state write completes after admission.
This uses existing atomic context-store persistence; no power-loss/multi-host/
hostile-same-UID guarantee is added.

## Actual verification

Linux, Node v24.16.0, pnpm 12.5.1. No Node 22 execution or live provider probe.

- `pnpm install --frozen-lockfile`: PASS, no manifest/lockfile changes.
- Initial `pnpm --filter @bflow/conversation build`: PASS before RED tests.
- Initial structured test run: 4 RED (missing handleStructuredInteraction).
- Additional observed RED→GREEN regressions: corrupt private snapshot
  key/result/fingerprint; feature full-SDD policy; overlapping model-busy save
  losing receipt and workflow; Conversation cancellation requestedBy; stale
  session unresolvedQuestions; native approval clarification cleanup; committed
  failure observation. No assertion or timeout weakening.
- `TMPDIR=/tmp pnpm --filter @bflow/conversation test`: PASS after each final
  owner fix; last package run before the observation-only fix: 273/273,11 files.
- `pnpm run build`: PASS; root tsc, frontend check/resolver, production Vite.
- An initial affected selection refused because this fresh worktree had only
  built Conversation and no Runtime dist. Root build fixed that prerequisite;
  no selector or production source workaround was used.
- `pnpm test:affected --base 9d563b90f3ade8f213bc7a09edd2eb96ee109c97`: package
  scope, GitNexus unavailable/commit_mismatch, all 11 Conversation test files,
  zero E2E. Uses the delegated baseline to avoid re-testing ancestor Runtime work.
- `TMPDIR=/tmp VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm test:affected --base 9d563b90f3ade8f213bc7a09edd2eb96ee109c97 --run`:
  **PASS, 274/274 tests, 11 files**, including 18 new structured tests; build
  runs before tests. Tested source/test content exactly matches source commit
  9e9b02b (it was committed after verification; only this handoff follows).
- `git diff --check`: PASS before commits. No dist, test output, state, proof
  material, real receipts or credentials committed.

Evidence: source/local cryptographic-contract/Conversation policy and mocked
Herdr transport tests only. No live Herdr, provider, browser or real workflow
acceptance claim. Native/web callback race test uses actual Gateway queueing
with deferred local callback; it is not physical-hook proof.

## Integration follow-through

Runtime owner has integrated initial d685a53 as 930cbca and should integrate
3ecdd2b then 9e9b02b (checking patch equivalence first). Runtime owns proof IPC,
owner registration, operation ledger/human marker, actual action validators,
inbox settlement and authoritative effect reconciliation; it must run combined
host tests, native/web opposite decisions/cancel races, fault windows and affected
selection on the complete W02 branch. Callback true fixtures do not certify
those integrations. Full W02 remains the parent/integrator's acceptance decision.
