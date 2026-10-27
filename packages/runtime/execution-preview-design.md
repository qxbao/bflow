# Execution preview — specification and integration decision proposal

Status: project owner approved EP-01 and Specification/TDD in the conversation on 2026-10-27; also authorized expanding ownership to support successful custom skills. No commits, remote writes or PRs authorized.
Baseline: `85753125982cf8d4df33916abf3f0dde4fa64d8a` (local main equals origin/main; P24 ancestor verified).
Worktree: `/tmp/bflow-execution-preview-8575312`, branch `agent/runtime/execution-preview-design`.
The user's requested acceptance criteria and tests are normative. This proposal records implementation choices and the shared-contract decision needed to implement them.

## Source findings

- `apps/cli/src/platform-options.ts`: `buildHostPlatformOptions`, `resolveRepositoryToolPolicy`, `resolveToolGrants`, role selection and exact skill pin binding are the current startup resolution path. `loadHostPlatformContext` also performs platform/executable inspection: preview must use a separate read-only snapshot loader, not call it blindly.
- `selectedProfileName` selects role `profile-name` over provider-specific `environment.defaults`; model/effort are role-local. Missing developer configuration inherits the coordinator provider/profile/model/effort. Explain those actual rules, not a fabricated universal precedence.
- `apps/cli/src/skill-catalog.ts` currently rejects custom catalogDir/bindingsPath without an approved resolver. Preview must report that rejection with its field source; it must not pretend custom skills are supported in execution.
- `packages/runtime/src/platform/service.ts` validates tool requirements/grants before launch. Extract/reuse that policy function rather than duplicate it.
- `packages/runtime/src/platform/skills-session.ts` calls `sync` and persists records. `packages/skills/src/manager.ts` has separate resolve, verify, sync and recover operations. Audit resolve/verify dependencies for writes before exposing them to preview.
- `packages/runtime/src/agentic/runtime.ts` proposes/reviews specifications and workflows, evaluates fast path, creates approval requests and saves state. Preview cannot invoke proposeWorkflow/reviewSpec as a shortcut. Extract pure policy calculation from acceptance orchestration; leave artifact ingestion, approval creation and persistence in execution.
- `apps/cli/src/high-level/commands/task-plan.ts` derives a graph from traceability; this is not proof that a DAG was accepted. Accepted-plan preview must read authoritative accepted Runtime state and validate specification/DAG correlation and revision.
- `apps/cli/src/bin.ts`, `parser.ts`, `types.ts` and high-level dispatch must all support the new syntax. HighLevelCliFacade alone is insufficient.
- No workflow-pack schema/resolver was found in contracts, Runtime or CLI. Existing AgentRoleProfile and provider isolator profiles are distinct; neither is a workflow pack.

## Integration decision EP-01 (owner approved)

Motivation: a strict, versioned preview and drift document crosses Runtime/CLI boundaries; repository rules require exported contracts at these boundaries. Packs also need semantics used by execution, not preview-only configuration.

Affected owners: Contracts/integration, Runtime, CLI; Skills only if custom-catalog execution support is requested. No provider launch signature changes are proposed.

Approve additive strict version-3 schemas in `packages/contracts`: ExecutionPlanInput, ExecutionPlan, PlanDecision, PlanObservation, PlanDiff, and ExecutionPlanExpectation. Export Zod schemas and validate all ingress. Preserve existing RuntimeService, RoleMessage, SessionManifest, launch and approval signatures. New preview APIs are additive and separate from task success evidence.

Pack decision: introduce a pinned declarative WorkflowPack selection (id, version, digest) with allowlisted defaults and locked fields. Effective precedence for these new fields is builtin default -> selected pack defaults -> project -> explicit override, subject to existing policy restrictions and pack locks. Preserve the existing per-field profile, skill union/replacement, and tool-policy rules described above. A pack cannot grant permissions, supply credentials, weaken mandatory gates, or approve work. No executable hooks, remote fetching or automatic installation. An invalid override returns a decision with rejected source/value and the enforcing rule's source. A selected but unavailable pack is blocked, never silently replaced. An absent pack is explicitly `not_selected` and retains current behavior. Pack loading uses one shared resolver for preview and execution.

Proposed pack allowlist: a local workflow definition reference (workflow id/version/content digest), per-governance-role provider/model/effort/native-profile defaults, exact skill selections, and tool/capability requirements. Workflow selection is a candidate template only until Runtime accepts the actual specification/DAG; it never manufactures accepted tasks. Existing mandatory gate/TDD/approval policy remains authoritative and is not overrideable by packs. Pack files are explicitly selected local repository inputs parsed by strict schemas, subject to normal project design approval; they do not become trusted credential or executable sources. Broader fields and custom governance roles are out of scope. Owner approved this configuration scope in the conversation.

Compatibility/migration: absent preview expectation or pack retains legacy behavior. Existing persisted documents remain readable without migration. Existing strict schemas are not loosened. New preview documents reject unknown versions. Shared documentation/config edits are limited to explaining the additive formats and actual binary syntax after approval. Owner approved EP-01 in the conversation; docs/adr/0005-execution-preview.md records the integration decision.

## Resolution architecture

1. Load bounded read-only snapshots of configuration, local pack/profile/skill definitions, policy and repository revision. Reject malformed/symlinked or special-file inputs using existing safe readers. Do not open mutable RunStore/Registry/Skill stores merely to observe them.
2. Refactor current resolution entrypoints into pure calculations accepting validated snapshots. Both preview and execution consume the same calculations. Existing execution wrappers retain probes, persistence and resource acquisition. Emit provenance during selection, not via a second explanatory resolver.
3. Produce two independent document sections: stable plan and observations. Each decision contains field path, candidate sources in actual precedence order, safe candidate value, accepted/rejected status, effective value, explanation and rule/source locator. Blockers reference decision IDs and specific prerequisite sources.
4. Intake mode exposes scope and known analysis/clarification policies; specification, accepted workflow and DAG remain unresolved. No synthesized tasks or claimed approvals. Accepted-plan mode requires accepted correlated specification/DAG from existing Runtime state, including identities, versions and approval binding; arbitrary user files are candidate input only.
5. Plan includes workflow/pack, tasks/dependencies when accepted, governance role separately from custom profile identity, provider/model or explicit provider-default-unknown, exact skill pins, tool/capability requirements and already observed grants, gates, TDD/alternative verification, conditional approval points, blockers and unresolved costs/actions. Do not invent token counts, prices, model responses, future reviewer findings or dynamic task allocations.
6. Observation states are observed, stale and not_checked, carrying evidence locator, checkedAt and applicable expiration/revision. Snapshot age alone cannot establish authenticated readiness. Preview never generates a grant/reservation or refreshes provider/model readiness. No installed executable or Herdr done observation establishes workflow success.

## Fingerprint, secrets and execution drift

Canonical SHA-256 over stable normalized inputs: resolver/policy version, scoped repository revision plus relevant dirty content digests, specification and accepted DAG identity/version/digests, pack/config/profile/skill content digests, rule versions and semantic overrides. Sort maps/sets only where order is semantically irrelevant. Exclude timestamps, lease IDs, ephemeral session grants and observation ages from the stable plan fingerprint. Record those only in observations.

Public output is allowlisted: never serialize environment variables, provider configuration blobs, credential paths/content, launch argv/env, tokens or raw exception text. Secret-bearing input snapshots remain private; public fingerprints use nonsecret plan-affecting identity/version projections. Authentication changes are revalidated prerequisites, not exposed secret hashes. Redact arbitrary user/spec descriptions before display or omit them from explain output; test both JSON and terminal paths.

Execution with a preview expectation re-reads inputs, resolves again and compares stable component digests immediately before the relevant side effect. Repeat the check across async preparation boundaries before launch, lease/worktree acquisition or dispatch. On meaningful drift return a structured diff (field, safe before/after, changed source and reason), without performing that side effect. Do not auto-apply a revised plan. A new invocation can explicitly use the new fingerprint. This retry acknowledgement is not a human approval.

Newly accepted plans also bind their resolution snapshot/component digests in Runtime-private persisted run state at acceptance, regardless of whether a CLI preview expectation was supplied. Every execution path revalidates against that accepted binding. Preview expectations additionally catch intake-to-acceptance drift. Old persisted runs without a binding must pass fresh prerequisite and approval-binding checks before an execution-time baseline is recorded; do not claim retroactive drift detection. That compatibility limitation must be explicit in output and tests.

Approval validity uses existing specification/revision/evidence/target policy. Readiness expiration or equivalent config formatting changes do not create approvals. Scope, accepted specification/DAG or governed decision changes invalidate only the approvals whose binding/policy actually changed. Execution still performs live prerequisite checks, authenticated preflight, leases and fencing after successful revalidation. Preview is never an approval, reservation, readiness guarantee or success receipt.

## Proposed CLI

`bflow task preview [--run <id>] [--json]` uses the actual binary high-level parser and command dispatcher. Without an accepted run, returns intake mode. Add `--compare <preview-file>` for schema-validated read-only diff input. JSON has one versioned envelope; terminal output shows mode, identity/fingerprint, choices with source, blockers, unknowns and approval points. Do not dump secrets through generic step/error formatting.

Execution entrypoints receive an optional validated expectation containing fingerprint and stable component digests, not a whole launch plan. The implementation plan must enumerate every concrete execution ingress (agentic host and legacy CLI) and reject unsupported expectation use rather than imply coverage. Existing execution without expectations remains compatible but still uses the common resolver and existing prerequisite checks.

## Acceptance and Conditional TDD proposal

This is a security/policy-sensitive feature. Proposed TddDecision is required: first add failing tests for a shared-resolution parity case, forbidden mutation and drift-before-side-effect; then implement and refactor. Owner accepted this TddDecision with the specification. Documentation-only preparation uses diff/source review as alternative verification.

- Defaults, pack/project overrides and locked override denial produce identical effective execution/preview decisions with traceable sources.
- Native custom profiles retain governance roles. Unsupported custom catalogs are explicit blockers; supporting a new custom catalog resolver requires its owning integration scope, not a preview bypass.
- Required missing tool and stale readiness point to requirement/config and observation sources, while preview performs no refresh or acquisition.
- Intake never fabricates a DAG; accepted mode rejects unaccepted or mismatched graph/specification revisions.
- Canonical fingerprint is stable for equivalent inputs, changes for meaningful profile/skill/policy/spec changes, and excludes volatile observations.
- Diff includes changed decisions and sources; harmless observation drift does not create approvals. Governed drift invalidates only affected bindings.
- Both JSON and text, including rejected overrides/errors, pass secret canary tests.
- Test injected forbidden ports (launch, model/probe, install, store write, approval creation, reserve/lease, worktree, dispatch) and filesystem before/after snapshots for both successful and blocked preview, including absent state stores. Throwing sentinels must be reachable if preview regresses.
- Subprocess tests invoke built `apps/cli/dist/bin.js`, in an isolated HOME/BFLOW_HOME/repository. Cover normal text, JSON, malformed compare input and intake/accepted modes.
- Execution tests mutate config/profile/skill after preview and during awaited preparation, asserting structured drift before the next side effect. Explicitly test legacy compatibility and unsupported expectation ingress.

## Work sequence after acceptance

1. Integrator adds approved contracts and pack decision; schema compatibility tests first. No lockfile/dependency changes expected.
2. Runtime/CLI extract shared resolution and provenance, keeping existing execution behavior covered by characterization tests.
3. Implement snapshot-only preview, fingerprints/redaction and accepted-state access.
4. Wire execution revalidation and policy-specific approval validity.
5. Wire real binary parser/dispatch/formatters and subprocess tests; update owned package READMEs.
6. Run targeted tests, pnpm check:deps, pnpm typecheck, pnpm test, git diff --check and git status --short. Record exact HEAD, commands, exit codes, counts, paths and generated files. Local tests do not establish live provider/Herdr or full SDLC acceptance. No commit, push, PR or external service writes.

## Builder review and remaining owner decisions

A fresh builder reviewed this proposal. The missing accepted-plan drift binding was resolved above. Owner approved EP-01 including the new declarative pack allowlist and successful custom-catalog execution. The accepted scope implements that path, using the existing Skills resolver with explicit pinned local inputs and existing approval checks; that expands authorized implementation ownership to `packages/skills/**` and CLI catalog composition. It must share resolution with execution and must not add installs to preview. Owner accepted that expanded scope in the conversation.
