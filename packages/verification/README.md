# @bflow/verification

Independent, bounded verification for the frozen Bflow v2 contracts. The package builds a verification plan from an approved `Specification`, a matching `TestStrategy`, and explicit quality checks. It evaluates evidence against every acceptance criterion and returns contract-validated `VerificationResult` and `VerificationCycle` values. A Developer's self-assessment or Herdr `done` signal cannot establish success.

## API

```ts
import {
  createVerificationPlan,
  VerificationEngine,
} from "@bflow/verification";

const plan = createVerificationPlan({
  runId,
  taskId,
  scope: "task",
  specification,
  strategy,
  checks,
  implementerIds: [developerId],
  maxIterations: 3,
});

const engine = new VerificationEngine({
  artifactStore,
  gates,
  loadSpecification,
});
const cycle = engine.start(plan, cycleId);
const outcome = await engine.verify(plan, cycle, changeSet);
// outcome.result: VerificationResult; outcome.cycle: VerificationCycle
```

The outcome also contains validated `RoleMessage` values for `verification.result` and, when needed, `verification.escalation`; Runtime delivers them.

The constructor accepts contract ports `artifactStore` and `gates`, a host callback `loadSpecification`, and an optional `clock` callback. The host supplies actual implementations; the package does not depend on sibling implementation packages. Plan construction rejects unapproved or inconsistent specifications, conflicting strategy/TDD decisions, unsafe paths, incomplete criterion mappings, missing target commands or test levels, and plans without an independent Reviewer or QA check. The maximum iteration count is configurable from 1 to 10 and defaults to 3.

`VerificationPlan`, `CheckConfigurationSchema`, and `ObservationSchema` are package-local codecs. They do not amend the shared contracts or introduce a new Herdr message variant.

## Checks and evidence

Each required `QualityGateDefinition.configuration` must parse with `CheckConfigurationSchema`:

| Field | Meaning |
| --- | --- |
| `kind` | `deterministic` or `review` |
| `method` | Acceptance criterion verification method |
| `command` | Required for deterministic checks; identifies the host-approved command binding |
| `criterionIds` | Explicit criteria evaluated by this check |
| `testNames` | Test names corresponding to the strategy criterion mappings |
| `role` | `quality_gate`, `tester`, `reviewer`, or `qa`; review requires Reviewer or QA |
| `levels` | Covered test levels from the test strategy |
| `measuresCoverage` | Optional aggregate coverage measurement; required on a deterministic check when the strategy has a coverage threshold |
| `dependsOnPaths` | Optional exhaustive impact declaration using safe literal repository paths |

The engine invokes the supplied `QualityGate` port with validated `QualityGateContext` values. A gate must return a contract-valid `QualityGateResult` with `metadata.verification` matching `ObservationSchema`. The observation binds the evidence to the check, run, task, attempt, Git revision, specification fingerprint, and verification scope. It declares an independent, isolated execution, identifies the executor and role, and provides criterion outcomes, test names, summary, and deterministic command/exit status when applicable. The executor must be distinct from every listed implementer. Passing review cannot override a failing deterministic check. A configured coverage measurement must report `coveragePercent`; a missing measurement is inconclusive and a value below the accepted strategy threshold fails verification.

Gate output artifacts are proposals. Trusted references originate only from `ArtifactStore`; the engine persists its verification audit reports through that port and validates artifact content/checksums. When gates produce proposals, the host supplies `readProposal(proposal)` to open their materialized bytes. The engine ingests them through ArtifactStore, verifies integrity, and includes the stored references in its result. Proposals without materialized bytes prevent acceptance. Each criterion outcome points to an evidence artifact, including an explicit explanation when evidence is missing. A report recording insufficient evidence proves that verification was inconclusive; it does not prove the requirement passed.

Specifications are loaded before and after verification. A changed specification, unresolved requirement conflict, unavailable dependency, invalid observation, or insufficient evidence prevents a passing result. Verification never edits the specification or repairs source code.

## Outcomes and rework

| Result | Cycle behavior |
| --- | --- |
| `passed` | Completes the cycle only after all required checks and criteria pass |
| `failed` | Requests scoped rework while iterations remain; escalates at the limit |
| `inconclusive` | Escalates immediately because evidence cannot establish a conclusion |
| `blocked` | Escalates immediately because verification cannot proceed |

Specification/scope conflicts return `escalated`, as allowed by the existing v2 contract. Escalation otherwise preserves the underlying result status and records the escalation on the cycle. It does not turn a failure into success. A failed cycle can be verified again only with a repair record identifying `taskId`, responsible `role: "developer"`, `changeSetId`, and `summary`, plus a new attempt and changed Git head. Supply the repair record through `verify(..., { repair })`. Every completed verification appends a structured result to the returned cycle history. Findings retain task/role responsibility for the Coordinator to route; a fix outside the accepted scope requires a separately authorized task.

Task checks may reuse successful prior check evidence only when the host provided an exhaustive `dependsOnPaths` declaration, the prior gate audit is valid, and the linear Git diff starts from the previously verified head and affects none of those paths. Reuse records its reason. Missing impact declarations cause checks to run again.

Workflow plans require integration, regression, or E2E coverage. After Git integration, invoke verification with `scope: "workflow"` and `verify(..., { integration })`, supplying `{ headCommitHash, integratedTaskIds }` matching the current head. The workflow `GitChangeSet.taskId` identifies its verification task; the integrated task list is separate provenance. Workflow checks run again on the integrated revision; task results never substitute for this verification.

## Host responsibilities and limitations

The supplied gate runner must map configured commands to host-approved capabilities and isolated check execution. This package provides no shell runner and does not automatically execute arbitrary command strings. Schema validation and distinct executor IDs cannot authenticate an OS process or prove physical isolation. The host must establish reviewer identity, independent execution, actual Git snapshots/diffs, and artifact provenance.

Runtime remains responsible for leases/fencing, safe capabilities, dispatch, durable state and crash recovery, cancellation, and approval handling. Persist the returned cycle and evidence before dispatching repairs. Runtime must supply the latest authoritative cycle and enforce optimistic versions/single-writer ownership: a stateless engine cannot distinguish an authentic older snapshot from the latest state. Persisted receipt comparisons reject edits to supplied history; they do not prevent replay of an older authentic snapshot. An exception during storage leaves the durable intent for Runtime reconciliation and must not trigger automatic redispatch. The engine does not dispatch Developer, Reviewer, or QA agents, mutate Git, merge branches, or deliver escalation messages. The Coordinator requests those actions exclusively through Workflow Runtime using validated existing `RoleMessage` variants.

The package has no live Herdr E2E verification and does not implement P19 Runtime integration. Fake-runner unit tests verify engine policy; they cannot establish live command execution, authenticated independent agents, or integrated system correctness. Shared root TypeScript references and lockfile wiring require the integration owner; this package does not edit them.

## Validation

From the repository root, with the workspace dependencies available:

```sh
pnpm --filter @bflow/verification test
```

This builds the package before its unit tests. Repository handoff also requires `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, `git diff --check`, and `git status --short`. Record actual results and the tested commit in handoff evidence; do not interpret a package test run as integration or remote closure.
