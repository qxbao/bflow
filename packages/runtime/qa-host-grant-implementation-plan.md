# Runtime HTTP Grant Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, with the existing worktree and one fresh whole-branch review before live acceptance. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue honest session grants for Runtime HTTP execution and unblock native QA without pretending it is CLI/MCP activity.

**Architecture:** Two additive exported schemas separate repository policy from session grant. CLI pins/validates owner config and resolves a host grant; Runtime intersects it with approved QA intake, revalidates authority and fences every request. Existing CLI/MCP schemas and Gateway behavior stay unchanged.

**Tech Stack:** Existing TypeScript/Zod v3, contracts, CLI config/platform resolution, Runtime native QA and SQLite/artifact/lease ports.

**Spec:** `packages/runtime/qa-host-grant-integration-proposal.md`, SHA-256 `c3f4edfb16b80b1afb2779c5b96cd0e4e1f2cc05f395b080735579d184387f66`; owner approved option 1 with “Sử dụng phương án 1 đi”. This is the authorized amendment to Task 5 of `live-extensions-implementation-plan.md`.

## Global Constraints

- Work in `agent/runtime/live-extension-host`; preserve root checkout and completed run. No push or remote integration.
- Public changes are additive `RuntimeHttpPolicySchema`/`RuntimeHttpGrantSchema` and type exports only. Core/approval/events/CLI-MCP tool schemas remain compatible. No lockfile or root configuration edits for convenience.
- First live probe grants only `http_read` on anonymous loopback fixture. No provider network permission, automatic policy elevation, copied grant IDs, fabricated executable/service identity or fake readiness.
- Native inline execution remains authorized. Preserve SDD/TDD, original human receipts and required independent review; no repeated owner approval for this exact amendment.
- Finish/record the running immutable pre-amendment regression before product source changes; its results apply only to that prior tree.

## Review Focus

- Wrong session/repository/policy digest/origin/action must deny before network (Tasks 1–3).
- Removal/malformed policy between readiness and a case must revoke authority; new policy requires new resolution, not hot reload (Tasks 2–3).
- QA assets written by Runtime must not become policy drift exemptions for arbitrary files (Task 3 and parent Task 6).
- Authority/fence loss after mutation intent means provably not delivered, with no network/replay (Task 3).
- Old SDK grants retain their local compatibility but cannot prove native host HTTP authority (Task 3).

### Task 1: Additive contracts

**Files:** create `packages/contracts/src/runtime-http.ts`, `packages/contracts/test/runtime-http.test.ts`; export from `src/index.ts`.

**Interfaces:** `RuntimeHttpPolicySchema` / `RuntimeHttpPolicy`: strict schemaVersion3, kind `runtime_http`, toolId `qa-http`, role `qa`, repositoryId, repository scope, digest, exact unique HTTP(S) origins, unique operations `http_read | http_mutate`. `RuntimeHttpGrantSchema` / `RuntimeHttpGrant`: strict version3, same kind/tool/role/origins/operations, session scope, grantId, policyDigest. No CLI/MCP fields. Origin normalization requires exact origin equality and no wildcard/credentials/path/query/fragment.

- [ ] Write contract tests via dynamic exports: valid policy/grant, repository/session scope confusion, unknown versions/fields, wildcard/credential origins, duplicate operations, identity mismatch and unchanged legacy tool schemas.
- [ ] Run `pnpm exec vitest run packages/contracts/test/runtime-http.test.ts`: expected Red on missing exports.
- [ ] Implement the schemas and export them; build contracts and run new plus existing tool-policy/tool-identity tests. Expected Green; commit the additive contract decision with approved proposal/evidence fixture.

### Task 2: CLI policy admission and grant producer

**Files:** `apps/cli/src/environment-config.ts`, `platform-options.ts`; new `runtime-http-policy.ts`; tests `runtime-http-policy.test.ts`; Runtime `src/platform/host-options.ts`.

**Interfaces:** `resolveRuntimeHttpPolicy(input, machineId): RuntimeHttpPolicy | undefined`, `resolveRuntimeHttpGrant(policy, {sessionId, repositoryId, workspaceRoot,machineId}): RuntimeHttpGrant | undefined`. Private host options carry optional `runtimeHttpPolicy`/`runtimeHttpGrants`, parsed by exported schemas. Startup grant is policy upper bound, independent of intake. Stable grant ID binds exact policy/session/repository. Config field `environment.runtimeHttpPolicy` uses the new schema; empty/missing gives no grant, never implicit access.

- [ ] Write failing tests for config roundtrip and exact producer scope/digest, no service/inventory lookup, no CLI/MCP grant pollution, wrong scope/digest and missing policy.
- [ ] Run new CLI tests and observe Red. Implement identity/digest validation using existing canonical policy digest utility and exported schemas; wire host options and immutable execution-resolution source handling.
- [ ] Build and run new tests plus platform-options/config/preview compatibility. Expected Green; commit scoped CLI/host admission.

### Task 3: Native Runtime authorization and recovery verification

**Files:** `packages/runtime/src/qa/workflow.ts`, new `agentic/runtime-http-authority.ts`, extension composition/workspace/host; `test/extension-qa.test.ts`, new `test/agentic/runtime-http-authority.test.ts`; owned Runtime/CLI READMEs and shared integration decision reference as needed.

**Interfaces:** `createRuntimeHttpAuthority({policy, grants, sessionId, repositoryId, machineId, workspaceRoot, revalidate}): (input:{runId,toolId,action,origin})=>Promise<void>`. Native direct-fetch execution must use these real grants and exact approved intake intersection; legacy SDK port remains usable only as local compatibility. `beforeTargetAction` carries exact origin and method/action before target effect, then final lease check. Never forward runtime grants to Gateway or give them to native roles.

- [ ] Write failing tests for exact policy+grant+session+intake approval, no grant despite legacy MCP fixture, revocation between requests, off-origin redirect, policy removal, replay, and fence loss after mutation intent. Add real HTTP fixture assertions for zero denied calls and unchanged protected source.
- [ ] Observe Red, implement minimum authority/wiring and safe failure bookkeeping. Pin policy/config sources; expected Runtime outputs cannot waive unrelated source/config drift. Validate whole policy/grant at ingress and every role-supplied input using existing schemas.
- [ ] Build, check dependencies/types, run new and SDK/native/CLI compatibility tests and GitNexus selection. Fix failures without weakening assertions/timeouts; record exact tested tree and local evidence limits.
- [ ] Commit verified Task5 amendment; resume parent Tasks6–7. Fresh whole-branch review before live; full validation before local integration. Human business/design approvals still occur per live run.

Self-review: contract, producer and consumer names match; startup-vs-intake timing and revocation source resolved in approved spec. Task1→2→3 dependencies are sequential; no implementation delegation needed. Remaining native lifecycle and fault campaigns stay in parent plan, with no claimed live closure here.
