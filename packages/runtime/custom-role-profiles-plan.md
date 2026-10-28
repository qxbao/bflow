# Custom specialist profiles Implementation Plan

> **For agentic workers:** Use subagent-driven-development for owned parallel tasks and TDD required. No commits, push or PR.

**Goal:** Implement approved RP-01 specialist profiles with pinned identity and narrowing permissions across actual execution/recovery.

**Architecture:** Governance roles remain fixed. Strict public profile documents and optional typed pins join immutable session snapshots, task assignments, environments and launches. Runtime computes and enforces narrowing policy before every existing side effect; old data stays unprofiled.

**Tech Stack:** TypeScript, exported Zod schemas, Node filesystem/crypto, Vitest, pnpm 12.5.1.

**Spec:** `packages/runtime/custom-role-profiles-design.md` (owner approved 2026-10-28).

## Global Constraints

- Keep AgentRoleSchema fixed; specialist only; no inheritance chains or Conversation/Coordinator replacement.
- Preserve existing governance, independence, grants/readiness, leases/fencing, Red-first, gates and unknown delivery.
- Exact profile/skill pins; no hot reload; source drift remains blocked by EP-01.
- Prefix shell commands with RTK. Workers use isolated worktrees; integrator imports patches without commits.
- Do not change root build configuration, dependency graph or lockfile unless essential to approved integration.

## Review Focus

- Missing pin/snapshot at restart must block profiled execution, never downgrade to legacy.
- Native shell, Git blobs and feedback runner must not escape profile read restrictions; unsupported if enforcement unavailable.
- Profile aliases/native rebinds must not reset executor implementation history.
- Profile defaults cannot override accepted assignment pins or pack locks.
- A tool/skill requirement is not a grant; missing readiness/approval fails before launch.

### Task 1: contracts (integrator)

Files: new `packages/contracts/src/role-profile.ts`, role enum extraction as needed; session/provider/workflow/index exports; `packages/contracts/test/role-profile.test.ts`.
Interfaces: CustomRoleProfile, RoleProfilePin, RoleProfileRestrictions, ResolvedRoleProfileSnapshot, SpecialistProfileSelection, ExecutorLineage; exported Zod schemas and digest/identity helpers; typed optional roleProfile on task/assignment/pane/environment, roleProfiles on manifest.
- [x] RED ingress/base-role/unknown-field/exact-pin/manifest mismatch/legacy tests.
- [x] Run Vitest and record expected failure, implement strict schemas, run GREEN/build; freeze interfaces for workers.

### Task 2: shared Runtime policy/platform (platform worker)

Files: new `packages/runtime/src/platform/role-profiles.ts`, host-options/ports/environment/service/skills-session/launch-journal/readiness/index and tests; provider permission restrictions as necessary.
Interfaces: resolveRoleProfile(snapshot, requirement), assertRoleProfilePin, appendRoleProfileInstructions, profilePathAllowed; validate at all package ingress. Catalog snapshots supplied by CLI; immutable launch pins consumed by scheduler/Pane Manager.
- [x] RED subset/unsupported read/skill conflict/provider compatibility/environment collision/prompt preservation/recovery tests.
- [x] Implement shared pure resolver, snapshot/pin joins, effective permissions and launch material binding; run scoped GREEN tests.

### Task 3: Pane Manager (pane worker)

Files: `packages/pane-manager/src/{types,role-pane-manager,manifest-store}.ts` and owned tests.
Interfaces: allocation requests accept roleProfile snapshot, provider/model overrides validated from Runtime; bindings contain typed pin; manifests retain snapshots. Add profiled specialist allocation/release with dedicated context and same base-role capacity.
- [x] RED profile pane isolation/reuse/mismatch/default behavior tests.
- [x] Implement append-only prompt binding, labels, pin-aware allocation/recovery and no role authority change; run scoped GREEN.

### Task 4: CLI config/preview (CLI worker)

Files: `apps/cli/src/{environment-config,config-format,platform-options,platform-resolution,execution-preview,execution-expectation}.ts`, new profile loader, tests and README within ownership.
Interfaces: environment.specialistProfiles [{path,pin}], role.specialistProfile pin; platform.roleProfiles snapshots and role defaults. Loader uses contracts, validates bounded safe local files/digests, supports exact pins, fingerprint/private source watches. Native profile-name unchanged.
- [x] RED config ingress/safe-loader/tamper/preview-execution parity/drift tests.
- [x] Implement catalog and actual binary/config composition; run scoped GREEN.

### Task 5: Runtime scheduler/host/enforcement (integrator)

Files: `packages/runtime/src/agentic/{runtime,journal,outbox,ports,host,host-platform,role-tool-schema,execution-binding}.ts`, new profile admission/lineage module and tests; agents coordinator docs.
Interfaces: typed task roleProfile, optional request_specialist profile pin; host catalog read summaries; pane policy allocation; per-assignment effective scope and immutable pin; lineage history bound to authenticated native receipts.
- [x] RED dispatch pin/scope rejection/identity history/recovery/cross-profile evidence tests using real policy paths.
- [x] Enforce before worktree/allocation/lease/send and every workspace/tool permission path; keep accepted spec and EP-01 authoritative.
- [x] Wire fresh profiled specialist lifecycle and pinned recovery, no fallback. Run GREEN integration tests.

### Task 6: integration and review

- [ ] Import only owned worker patches, check contracts/interface compatibility and all source joins; build before subprocess tests.
- [ ] Run affected selection/run with exact baseline, dependency check, typecheck, full unit suite, relevant E2E compatibility/profile tests, diff check.
- [ ] Independent security/spec/code review; fix reproducible findings through regression tests and rerun affected checks.
- [ ] Update actual status/evidence, limitations, tested HEAD/uncommitted diff. Preserve all original work. No commit/push/PR.

## Execution ledger

- Owner approval recorded; continuing autonomously as requested, no additional plan approval required.
- Baseline `e73dca70cb91bdd53fbe1fe9dfb69ccba8b6f8ff`, clean original checkout and isolated integration worktree verified.

## Resumed-session ledger (2026-10-28)

- Recovered original owner approval and all existing uncommitted implementations; did not repeat proposal approval or reset the branch. Tasks 1–5 source was present, then reviewed and hardened with reproducing tests.
- Cross-task joins checked: contracts→CLI/panes/platform→Runtime pins; role defaults→automatic QA/review; assignment history→lineage/settle; effective grants→Gateway/RTK; EP-01→awaited preparation and tools.
- Ruling: retain fixed provider template and return explicit unsupported for cross-provider preferences — native credential/ingress/grant bindings lack a safe switch; cost: a project needing this must configure the template or review the missing switch path. Model/effort override unlocked defaults and respect real pack locks.
- Ruling: preserve baseline daemon retirement rather than reconstruct live launch authority — snapshots prove pinned content, not secrets/native stop; cost: restart can require fresh up plus reconciliation.
- Root regressions verified RED→GREEN for default-selection drift, journal feature version, missing accepted pin/lineage, drift across skill/preparation awaits, and transport-only pane cleanup. Automatic QA uses the same dedicated pinned allocation as review.
- Intermediate full suite overlapped two new RED tests and exposed existing macOS symlink-temp fixture failures. Canonical TMPDIR fixes the environment without weakening production filesystem rules; affected 12 tests pass. Final integrated suite remains the completion gate.
