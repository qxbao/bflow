# Execution preview implementation plan

Goal: implement the accepted execution-preview-design.md with shared deterministic resolution and pre-side-effect drift guards.
Architecture: strict additive contracts; Runtime pure resolution/plan/fingerprint/diff; CLI composes read-only inputs; execution persists and revalidates accepted resolution bindings. Existing launch and approval policy stays authoritative.
Stack: TypeScript, Zod, Vitest, Node 24, pnpm 12.5.1.
Spec: execution-preview-design.md, approved in conversation including successful custom-skill support.

Constraints: no commits/push/PR/external services; agents use separate worktrees from 8575312; no generated outputs in handoff; TDD required; no model/probe/install/write in preview. Preserve unrelated baseline failures.

## Task 1 — contracts and pure Runtime planning

Files: new packages/contracts/src/execution-plan.ts and exports/tests; new packages/runtime/src/planning/** and exports/tests.
Inputs: validated stable configuration/provenance, specification/DAG when accepted, separate observations. Outputs: strict ExecutionPlan, PlanDiff and expectation schemas; deterministic SHA256/canonical normalization; pure pack precedence resolver with rejected locked overrides; shared execution revalidation helper.
Steps: failing schema/resolution/fingerprint/redaction tests; observe red; implement minimal public API; build and targeted tests; report exact APIs and evidence before dependent integration.

## Task 2 — shared CLI resolution, custom skills and binary preview

Files: apps/cli/src/platform-options.ts, skill-catalog.ts, environment-config.ts, parser/types/bin/high-level dispatch/presentation and tests; packages/skills only where needed for a safe local custom-catalog resolver.
Outputs: actual `bflow task preview [--run <id>] [--json] [--compare <file>]`; pack loading and provenance used by existing execution platform-options path as well; zero-side-effect snapshot loader; custom pinned skills supported in execution/preview with existing trust checks.
Steps: failing no-write/parser/shared-resolution/custom tests; observe red; extract current resolution and wire pure planner from Task 1; build; targeted binary tests. Candidate workflow templates cannot become accepted DAGs.

## Task 3 — accepted Runtime binding and execution revalidation

Files: packages/runtime/src/agentic runtime/private state/host admission/platform orchestration and tests; distinct files from Task 1.
Outputs: accepted plan snapshot bound in private run state, readonly accepted preview access; revalidate config/profile/skills and prerequisites before relevant worktree/lease/launch/dispatch effects and after async boundaries. Return sourced diff; invalidate only approval bindings covered by existing policy. Old state explicitly lacks historical drift baseline.
Steps: failing acceptance-binding/drift-before-effect/no-new-approval tests; observe red; implement via Task 1 shared functions; build and targeted tests. Coordinate CLI snapshots with Task 2, without parallel planning logic.

## Integration and review

Root integrates uncommitted owned diffs from isolated worktrees without commits, resolves cross-task wiring, performs independent code review, and fixes reported defects through implementers. Run targeted tests, dependency/type/full tests, whitespace and status checks. Record baseline failures separately from feature regressions and document command behavior/limitations in owned READMEs.

Review focus: secret values in errors/provenance; unknown/unaccepted DAG input; stale grants changing effective skill selection; drift across async boundaries; legacy runs without snapshot. Each task must test the risks it introduces. Task interfaces must be fixed in messages before dependent implementation; no silent contract divergence.

Progress: baseline targeted 208/208 passed; full baseline suite running with pre-existing failures. EP-01 and custom-skill ownership approved. Task 1/2/3 not started.
