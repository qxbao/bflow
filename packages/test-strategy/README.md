# Conditional TDD policy engine (P16)

`@bflow/test-strategy` resolves risk-based TDD policy without executing tests,
editing source, managing workflows, or accepting tasks. Its only workspace
dependency is `@bflow/contracts`.

```ts
import {
  TestStrategyResolver, recordEvidence,
  assertReadyToImplement, assertEvidenceComplete
} from "@bflow/test-strategy";

const resolver = new TestStrategyResolver();
let strategy = resolver.resolve(specification);
resolver.validateAgainstSpecification(strategy, specification);
// For required TDD: obtain an independent Red VerificationResult first.
strategy = recordEvidence(strategy, redResult);
assertReadyToImplement(strategy);
// Runtime allows implementation; independent verification supplies later phases.
strategy = recordEvidence(strategy, greenResult);
strategy = recordEvidence(strategy, refactorResult);
assertEvidenceComplete(strategy);
// Persist the returned TestStrategy using existing Runtime persistence ports.
```

For `recommended`/`not_applicable`, record one successful aggregate
`VerificationResult` with phase `verification`, then assert completion. Recommended
TDD can be practiced voluntarily; an alternative verification receipt remains its
mandatory submission. The phase APIs validate a policy dossier, not task acceptance.

## Contract boundary and input

`resolve(unknown)` parses `SpecificationSchema`, requires `runId` and at least one
required acceptance criterion, then parses `metadata.conditionalTdd` with the
exported `AssessmentSchema`. Other metadata, including P15's `metadata.sdd`, can
coexist. See [the complete input example](examples/domain-logic.spec.json).

The private, versioned metadata payload supplies all seven assessment inputs:

| Input | Source |
| --- | --- |
| Task type | `taskType`, `taskId` |
| Acceptance criteria | Contract `Specification.acceptanceCriteria` |
| Change impact | `changeImpact.surfaces`, behavior/determinism/regression flags, security/data impact and scope; `Specification.affectedPaths` |
| Existing infrastructure | `infrastructure.readiness` and actual method/command pairs |
| Testability | `testability.level` and concrete rationale (minimum 10 characters) |
| Risk | Maximum of declared assessment/spec risk and security/migration signals |
| Project conventions | `conventions.tdd`, required methods and suggested levels |

Task/impact surfaces cover domain logic, bugs, contracts, validation,
transformation, state machines, integration, refactoring, layout, infrastructure,
configuration, documentation, formatting and exploration. Multiple impact surfaces
take precedence over an innocuous task label. Behavioral criteria and non-document
paths also contradict a documentation-only claim. This is structured assessment,
not a semantic diff classifier: P19/P17 must compare assessments with actual changes.

Policy may be resolved before specification approval. Runtime must separately
enforce accepted specifications and approvals before implementation. A full SDD
specification already needs its contract-required strategy/decision; resolve a
lightweight planning specification first, then compose the full document through
P15. This package does not weaken full-SDD contract invariants.

## Policy and output

The return value is the existing contract `TestStrategy`, embedding a contract
`TddDecision`. No new shared schema, port, migration or public wire shape is added.

| Mode | Typical assessment | Mandatory verification |
| --- | --- | --- |
| `required` | Repeatable logic, regression, API/validation/transformation/workflow behavior; feasible high-risk behavior or required project convention | Spec-derived Red, unchanged tests Green, successful rerun after refactor, all selected methods |
| `recommended` | Integration/refactoring/exploration; behavior with incomplete infrastructure/testability | Successful independent alternative checks; explicit provisioning obligations for absent commands |
| `not_applicable` | Pure documentation, formatting, layout, wiring or simple configuration with no behavioral target | Appropriate manual, visual, lint, schema, smoke or integration evidence |

These are contextual defaults. Mixed behavior can require TDD regardless of label.
Incomplete infrastructure prevents pretending that a runnable Red phase exists.
Every selected behavioral method must have a configured command before TDD can be
required. Existing regression checks for a behaviorless formatting/documentation
change remain mandatory without manufacturing a failing-test-first target.
Characterization work whose affected paths are only test files (`*.test.*`, `*.spec.*`,
`test/`, `tests/`, `__tests__/`, `__fixtures__/`), with no logic, bugfix or regression
surface, resolves to `not_applicable` and requires a successful record that the tests
pass on the current code. Domain-logic characterization (still test files only, no regression)
resolves to `recommended` with the same evidence, so no impossible Red phase blocks it.
A regression reproduction keeps `required`, and any production path keeps the normal policy.
Domain logic and bug fixes never resolve to `not_applicable` (the contract also rejects it
without `humanOverrideApproved`); this resolver does
not manufacture or honor an unverified human-override boolean. High risk adds
static analysis and review, and integration checks for behavioral work. Missing
commands are exposed as provisioning conditions, never invented or silently waived.

Read `mode`/`rationale` from `tddDecision`; read required methods, suggested levels
and evidence requirements from `metadata.conditionalTdd`. Contract
`requiredTestLevels` represent selected method levels; extra project suggestions
and regression/property suggestions remain in `suggestedTestLevels`. Required
acceptance methods and project checks are preserved. All criteria receive stable
spec-derived names; waived criteria do not silently remove verification obligations.

`validate` re-evaluates policy against its stored assessment, rejecting mode,
rationale, method, command and mapping downgrades. `validateAgainstSpecification`
additionally binds it to an authoritative specification. Use the latter at
integration ingress: self-consistency alone cannot authenticate an assessment.
`validateAgainstSpecification(strategy, specification, decision?)` also accepts an
optional `TddDecision` and rejects it when its `decisionId` or `mode` differs from
the strategy's. Verification methods follow the contract `AcceptanceCriterion`
`verificationMethod` enum (`smoke_test`, `visual_review`, `snapshot_test` and
`schema_validation` are no longer separate methods; configuration and
infrastructure changes use `typecheck`/`static_analysis`/`integration_test`, and UI
layout uses `manual_review`). Existing valid per-criterion test-name mappings on a
specification are preserved; otherwise mappings are derived from criterion IDs.
The resolver rejects duplicate criterion IDs, and full-level or approved
specifications that lack their required sections or approval metadata.
Decision IDs are deterministic hashes of the relevant specification and assessment.

## Evidence and persistence

`recordEvidence(unknown, unknown)` parses `TestStrategySchema` and
`VerificationResultSchema`, validates all prior receipts, and returns a new
`TestStrategy` with immutable-by-convention receipts in `metadata.tddEvidence`.
It never mutates inputs. Identical receipt retries are idempotent; conflicting
receipt IDs fail. The caller persists this contract value through existing ports.
No polling directory, in-memory persistence adapter or fabricated artifact is used.

Each result must supply `metadata.conditionalTdd` matching `EvidenceDetailsSchema`:

```json
{
  "phase": "red",
  "decisionId": "tdd-<resolver digest>",
  "specId": "price-rounding",
  "sourceRevision": "<pre-implementation commit or content hash>",
  "testRevision": "<immutable test content hash>",
  "testNames": ["round-1: A total of 10.125 becomes 10.13"],
  "failureKind": "target_behavior",
  "observations": [{
    "method": "unit_test",
    "criterionId": "round-1",
    "evidenceArtifactId": "<ArtifactStore result id>",
    "summary": "Expected 10.13 but received 10.125",
    "command": "pnpm test:pricing",
    "exitCode": 1
  }]
}
```

Green/refactor phases omit `failureKind`, use zero exit codes and retain Red test
revision/names/commands on an implementation revision. Refactor may retain Green's
source revision when no cleanup is needed. Timestamps must follow the decision and
preceding phase; attempts and stored artifacts must be distinct. Every required
behavioral criterion must have Red evidence. Successful phases must cover every
required criterion with its declared method, every required method globally, and
every configured target command, including multiple suites at the same test level.

Observations reference the evaluated criterion's stored artifact. When multiple
checks share one criterion, its evaluation can omit the aggregate `command` and
`exitCode`; each automated observation still needs its own command and exit code.
Red must include a failed behavioral observation and its nonzero evaluation exit
code. Existing behavioral criteria and other checks may already pass in the Red
suite; forcing those checks to fail is not TDD. Phase receipts must stay in the
same verification cycle. Manual/visual observations require
concrete summaries and stored artifacts. Infrastructure or unrelated failures cannot
establish Red. All referenced artifacts must match the run/task and be ingested
after the observation starts.

Only ArtifactStore may originate trusted references. This package validates receipt
shape, binding, sequence and declared outcomes; it does not read artifact bytes,
authenticate a caller, execute commands or inspect Git revisions. P17 must independently
verify logs and revisions, and P19 must use the authoritative spec, persist receipts
and enforce these checks through Runtime. `assertEvidenceComplete` is not an
acceptance gate or a substitute for the bounded Verification Loop.

## Prompts and validation

Integration prompt templates are in [prompts/](prompts/): assessment, required TDD,
and alternative verification. They are assets for P19 integration and are not
installed into another role's prompt ownership here.

```bash
pnpm --filter @bflow/test-strategy typecheck
pnpm --filter @bflow/test-strategy test
pnpm check:deps
pnpm typecheck
TMPDIR=/tmp pnpm test
git diff --check
git status --short
```

Build precedes package tests. The package is registered in root TypeScript references
and the workspace lockfile, so root build/typecheck commands include P16. See
[REVIEW.md](REVIEW.md) for review fixes and integration evidence;
[HANDOFF.md](HANDOFF.md) preserves the original implementation handoff.
