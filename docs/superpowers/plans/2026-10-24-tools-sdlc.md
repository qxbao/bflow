# Tools SDLC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: bflow-superpowers:subagent-driven-development. Root coordinates and accepts; Luna implements. Each task has its own worktree and commit.

**Goal:** Approved installed tools become scoped, observable actions in actual SDLC runs.

**Architecture:** Resolve repository policy against machine facts and role bindings. Runtime mediates task actions and evidence; Gateway enforces MCP scopes and operations. CLI commands retain raw evidence before RTK presentation.

**Tech Stack:** Existing Node >=22.13, pnpm 12.5.1, TypeScript, Zod, Vitest, filesystem ledgers and ArtifactStore.

**Spec:** `docs/superpowers/specs/2026-10-24-tools-sdlc-design.md` (owner approved, including D-TOOLS-01).

## Global constraints

- Preserve RoleMessage v2, SessionManifest v2, Core/checkpoint/event codecs and existing acceptance authority.
- User decisions through Conversation; no implicit tool authority from skills, no setup/global mutation.
- No automatic resend of unknown tool calls or Herdr deliveries. No fake receipts or live success claims from mocks.
- Separate worktree and branch per agent. Only root integrates shared configuration/docs after review.
- Regression Red before production fix, Green after rebuild; subprocess tests consume dist.

## Review focus

- Catalog tool ID colliding with operation names: per-service operation registration test.
- Missing policy in old config: workflow skills present, new tools default denied, migration diagnostics exact.
- Compression succeeds while original command failed: raw parser and original status must win.
- Crash after side effect but before result: restart remains unknown and cannot repeat mutation.
- Memory query without scope or forged provenance: reject before context consumption; log excludes body/query/token.

## Task 1 — freeze additive contracts

Owner: Luna Contracts. Files: new `packages/contracts/src/tool-policy.ts`, `tool-usage.ts`, export `src/index.ts`, new tests under contracts/test.

Produces exported schemas and inferred types:

- `ToolTrigger`: prior_context, routine_command, code_relationships, external_documentation, browser_inspection, explicit.
- `RoleToolRequirement`: toolId, requiredness, roles, triggers, operations; optional capabilityIds/serviceId/memoryScope/cliCommandProfiles.
- `RepositoryToolPolicy`: schemaVersion 3, repositoryId, repository TrustScope, digest, requirements.
- `ResolvedToolGrant`: schemaVersion 3, grantId, policyDigest, toolId, capabilityIds, kind, requiredness, role, session scope, triggers, operations; serviceId for MCP or cliIdentity for CLI; optional memoryScope/cliCommandProfiles.
- `ToolActionRequest`: schemaVersion 3, actionId, toolId, operation, input JsonValue. Authenticated identity comes from host.
- `ToolUsageRecord`: schemaVersion 3, runId/taskId optional, role/sessionId/generation/invocationId/toolId, optional serviceId/operation; status planned/denied/skipped/degraded/blocked/started/completed/failed/unknown; consumption separately records consumed/rejected/not_used with evidenceReferences; observedAt/startedAt/reasonCode/evidenceReferences.

- [ ] Add negative/positive ingress regression tests; run Red against missing schemas.
- [ ] Implement strict schemas, duplicate/nonempty/coherence rules. taskId requires runId; consumed requires completed + artifact evidence; unavailable outcomes require reasons.
- [ ] Build and focused tests, verify old contract tests unchanged; send exact export summary and commit.
- [ ] Root reviews diff and tests before freeze; all consumers use this exact commit.

## Task 2 — CLI policy and bindings composition

Owner: Luna CLI, branch agent/cli/tool-policy; only apps/cli/**.
Consumes Task 1 schemas, actual machine observations, existing authenticated Gateway catalog and P28 catalog loader.
Files: environment-config.ts, platform-options.ts, skill-catalog.ts, config-format.ts, setup-defaults.ts/setup-integration.ts, gateway-control.ts when needed for production wiring; new tool-policy resolver module and composition tests.

- [ ] Reproduce default config → buildHostPlatformOptions empty skills and legacy wrong-ID grant in tests before fixing.
- [ ] Add optional repository toolPolicy using exported schema; select built-in role bindings when role.skills absent. Explicit [] removes defaults only; mandatory requiredSkills cannot be removed.
- [ ] Default workflow skills required, tool skills conditional; required policy/skill dependency missing blocks. Optional unavailable gets reason, not silent removal.
- [ ] Build exact grants from explicit repo policy + verified machine inventory/service definitions. Requiredness retained; map catalog ID/service/operation deterministically; no skill-created rights.
- [ ] Keep legacy Context7 and requiredTools/service config explicit and deny ambiguous authority with migration patch.
- [ ] Pass policy/grants and digest to Runtime optional host fields using Task 1 schemas; old hosts/config fail closed where needed. Doctor displays installed/allowed/granted/ready separately.
- [ ] Production composition tests inspect real host wire and provider MCP config, scoped per role; tests cover config rendering roundtrip and old fixtures.
- [ ] Build; run apps/cli targeted suite; report exact exit/counts/commit and package README migration examples.

## Task 3 — Runtime actions, RTK and evidence

Owner: Luna Runtime, branch agent/runtime/tool-actions; only packages/runtime/**.
Consumes Task 1 schemas, CLI optional policy/grants, Gateway MCPToolCall/result existing contracts.
Files: platform/host-options.ts, platform/ports.ts, platform/service.ts, platform/gateway-control-client.ts or actual existing client file; agentic/host.ts, behavior runner, new tool-actions/usage modules and tests.

Local interfaces: `invoke_tool_action(ToolActionRequest)` is exposed in roleCall/roleTools/toolSchemas;
Runtime authenticates principal from native binding and resolves active assignment. Use per-service grants,
exact operation, input schema and assignment/approval/lease/fence checks immediately before dispatch.
CLI action descriptors choose already-authorized runner commands; no arbitrary command input.

- [ ] Reproduce registration/catalog ID misuse and missing production RTK invocation with integration tests; capture Red logs.
- [ ] Separate inventory toolIds for skill resolution from Gateway operations; required readiness blocks before launch/dispatch; optional degraded visible.
- [ ] Implement Runtime-controlled action dispatch; MCP calls via authenticated Gateway control, CLI via bound runner executable identity. Register one service per operation grant set.
- [ ] Store usage intent before side effect, call results before consumption; ArtifactStore gives trusted refs. Per-task usage read operation returns sanitized metadata.
- [ ] Trigger prior_context/code_relationships/docs/browser/routine actions from actual task needs. Return explicit denied/skipped/degraded reasons. Validate memory scope/provenance before including result in assignment context.
- [ ] Integrate RTK raw-preserving command route and stdin compression adapter in measureBehavior existing sandbox. Run command once; TAP/Vitest/RGR receive raw; compressor failure does not change command exit or replay command.
- [ ] Crash/recovery tests at intent/inflight/result/consumption; preserve original IDs/digest/unknown state. Prevent forged run/role/task claims, expired leases and wider grants after restart.
- [ ] Build; run platform/agentic runner/action tests plus existing policy/recovery tests; report exact evidence/commit and README.

## Task 4 — platform enforcement and conditional catalog

Owner: Luna Platform, branch agent/platform/tool-capabilities; owns packages/skills/**, skills/**, packages/mcp-gateway/**, packages/tool-installer/**, packages/machine-setup/**.
Consumes Task 1 schemas. Production tests must use real HTTP/stdio Gateway driver and filesystem ledger, not always-success stubs.

- [ ] Regression Red: all binding IDs are required today; adding tool skill without grant cannot result in usable manifest; unknown MCP call after restart can otherwise be replayed.
- [ ] Add approved binding metadata for conditional tool skills, preserve legacy binding shape compatibility; add use-mempalace to allowed role defaults conditionally. Unknown/pin/drift must fail explicitly.
- [ ] Publish exact verified inventory executable/capability/service mapping via existing setup observation path; RTK is cli_only. Alias browser explicitly, never infer capabilities from tool ID.
- [ ] Gateway validates per-service exact operation and input schema; persist uncertain receipt intent/results before returning and keep unknown across restart; scope rules restrict memory wing and browser resources. No mutation retry.
- [ ] RTK helper supplies cwd/env/stdin/timeout identity interfaces needed by runtime only through contracts or existing composition; do not make Runtime import leaf tool-installer.
- [ ] Tests verify secret/body redaction, memory write default deny, operation/schema drift, replay/reconciliation behavior and privilege boundaries.
- [ ] Build; run focused skills/Gateway/setup/tool-installer suites; report commits/counts and owned READMEs.

## Task 5 — integration and independent acceptance

Owner: root; Luna independent reviewer/fix implementers. No implicit ownership expansion.

- [ ] Review per-task contracts/security/quality and cherry-pick scoped commits sequentially; resolve shared wiring explicitly.
- [ ] Run end-to-end production composition from config through host/Gateway/runner, inspect invocation result linked to consumed evidence.
- [ ] Create isolated sample repo; use Codex personal only, input through actual Conversation transport. Use narrow MemPalace wing chosen under delegated owner authority; no writes.
- [ ] Probe required unavailable and optional degraded, RTK real raw/status parity, real MemPalace result provenance and downstream use; conditionally exercise catalog tools, record skips accurately.
- [ ] Test restart of owned host/Gateway and verify no widened/doubled action. Never kill shared service to test recovery without separate authority.
- [ ] Obtain separate concrete setup/memory write/human gate approval if necessary; continue all independent work while waiting.
- [ ] Run root check:deps/typecheck/test, package tests, git diff --check/status; classify baseline/environment regressions with exact evidence. Read CI only if auth exists.
- [ ] Final review against AC01–AC11 and evidence matrix; merge main locally only after passing acceptance, preserve unresolved worktree otherwise. No push.
