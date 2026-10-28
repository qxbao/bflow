# DC-01: Data contract drift and isolated dbt verification

Status: accepted by the project owner in the current conversation on 2026-10-28 ("tôii phê duyệt bạn triển khai đi"). No commit/push/PR authority.
Baseline: `2041d7efa860981833eb6bd58fd9023ce8a727d3` (integration descendant of the initial checkout `6c4dc68af6dcb7920320afd058bfb5a9a10ec688` and P24).

## Intent and scope

Implement the owner's eleven requirements and acceptance criteria for a complete local dbt fixture flow. Structural compatibility and actual data quality produce separate outcomes. Neither parsing schema nor a successful process exit proves data quality. This first adapter is dbt Core with DuckDB, operating only on an owned temporary fixture database. No existing warehouse adapter, production migration, custom role, remote delivery, or public contract migration is included.

Runtime owns production code, local tests, fixture assets and this package documentation under `packages/runtime/**`. A separate P28 owner will deliver canonical instructions under `skills/**` with package-local catalog tests under `packages/skills/**`, in an isolated worktree from the same baseline. Integrate that scoped diff only after owner/integration review, without commits. Shared contracts, root configuration, lockfile, README, AGENTS and `docs/**` stay unchanged. CLI owner wiring remains a separately reviewed integration proposal: do not advertise a new `bflow` command or silently make `.bflow/verification.json` accept unsupported configuration.

## Accepted authority

The existing exported `Specification`, `TddDecision`, `TestStrategy`, `ApprovalRequest`/`ApprovalDecision`, `QualityGateContext`/`QualityGateResult` and `ArtifactStore` interfaces remain authoritative. New data models are Runtime-private, strict versioned Zod schemas, not new `@bflow/contracts` interfaces. A validated data contract contains model/schema fields, keys, nullability, constraints, required data tests, consumer expectations and an explicit compatibility policy.

Acceptance uses an owner-supplied approval decision tied to an immutable specification revision and canonical SHA-256 digest. Request and decision must match approval ID, run ID, target, revision and generation. A host-owned authority reader supplies the current request/status/expiry and accepted pin; recheck it before launch and after execution so supersession during a run cannot pass. `Specification.metadata.dataVerification` pins contract revision/digest, candidate schema digest and approved snapshot identity/digest. The runner receives the expected accepted revision/digest from host authority; it never trusts approval flags embedded by a Developer in the candidate. Expired, superseded, mismatched or stale pins block verification. Changes to thresholds, schema expectations or policy create a new digest/revision requiring corresponding approval. Test fixture approvals are explicitly synthetic fixtures, never evidence of real human acceptance.

## Structural checker

Compare accepted contract with candidate dbt schema/model metadata without executing queries. Emit per-field findings with code, accepted/candidate values, consumer direction and compatible/breaking/unsupported classification. Missing required tests are failures even if all tests present happen to pass.

Consumer directions are explicit: candidate producer serving accepted consumers, accepted producer serving candidate consumers, or both. For example, widening producer nullability violates an existing non-null consumer guarantee, while tightening it preserves that guarantee. A widening numeric domain can serve wider producer input but may exceed an old consumer domain. An explicit adapter type-compatibility table handles integer widening; unknown or lossy conversions are unsupported/breaking according to approved policy, never guessed compatible. Added fields follow the policy for open versus exact schema consumers. Removed columns fail their consumers; an explicit rename mapping records rename findings but never silently makes an old consumer understand the new name. Keys and unique guarantees are compared independently from declared tests.

The schema ingress is dbt manifest JSON (dbt Core 1.10, manifest schema v12), not a new YAML parser. The reader supports the reviewed subset needed by the fixture: model columns/types and test nodes for `not_null`, `unique`, `relationships`, and `accepted_values`. Unsupported/malformed or ambiguous definitions fail closed. Generated dbt `schema.yml` uses JSON (a YAML subset), avoiding a new JavaScript YAML dependency. Schema evolution is reported explicitly rather than repaired by the checker. Freshness and volume/distribution checks are included only when an accepted criterion defines the measurement and threshold; this fixture does not invent such requirements.

## Runtime execution and evidence

Provide a Runtime-owned `DataVerificationHost.verify` entry point which orchestrates the structural gate and runtime gate, calls the fixture runner, ingests measured evidence into the injected `ArtifactStore`, and returns independently validated `QualityGateResult` values. Test the entire host → gate → subprocess → trusted artifact path. This is an opt-in library host entry point; persistent agentic daemon/CLI configuration wiring remains outside this owned patch. Host authority selects an approved fixture input and accepted criteria; role output cannot supply evidence reports or executable argv. Use the existing command runner/process cleanup patterns. dbt and the DuckDB adapter must actually be installed and probed; absent tools/dependencies/sandbox capability produce prerequisite gaps, not successful reports.

The first execution adapter builds a minimal dbt project from validated fixture rows and accepted checks, with fixed host SQL templates and safe identifiers. It does not execute arbitrary candidate SQL, macros, hooks, package install commands or a caller's warehouse profile. A private temporary directory owns the generated project, profile, database, target reports and logs. On Linux, probe Bubblewrap before execution, read-only mount the approved isolated Python toolchain/system runtime, permit writes only to the owned fixture tree and deny the network. Never fall back to unsandboxed execution. dbt uses only this DuckDB file, with bounded commands and no inherited warehouse credentials. Baseline and candidate fixtures are tied to model revision and snapshot/data digests. A separate structural input identifies candidate schema; the generated fixture checks measure actual supplied snapshot rows, not production model SQL.

Host reads fresh dbt `manifest.json`/`run_results.json`, validates their structure, invocation identity, selected model/tests, complete result coverage, failures/status and process outcome, and maps each selected test to an accepted check. Missing, skipped, duplicated, malformed, stale, inconsistent or agent-submitted reports cannot pass. Static and runtime outcomes remain individually visible; a failed structural gate cannot be erased by a passing data run, and a valid schema cannot erase data violations.

Evidence explicitly labels this execution `snapshot_validation`. It includes `declaredModelRevision` (a provenance label, not proof that transformation SQL ran), measured candidate-schema digest, accepted contract revision/digest and approval identity, fixture snapshot identity/digest, adapter/dbt version, actual executable/argv, start/end/duration, per-check IDs/results/failure counts, process outcome and raw report digests. Trusted artifact references originate only from the ArtifactStore. The gate uses exported contract schemas at package boundaries and never marks transport completion as verification success.

Cleanup removes only the runner-created fixture directory after confirmed child/process-group termination. A deadline produces an inconclusive/blocked execution and retains uncertain resources for reconciliation if termination cannot be confirmed. No real warehouse query or outside-resource deletion is supported. Temporary setup uses an isolated Python environment with pinned dbt dependencies; no global provider/machine configuration changes.

## Specification acceptance criteria

| ID | Required behavior | Evidence |
| --- | --- | --- |
| DC-01 | Contract validation, exact revision/digest and matching approval; stale/mismatched input blocked | Unit and gate tests |
| DC-02 | Per-field remove/rename/type/nullability/key/schema-evolution findings with direction-specific compatibility | Table-driven unit tests |
| DC-03 | Missing required tests and changed thresholds cannot pass | Unit and gate tests |
| DC-04 | Separate structural and runtime outcomes; complete per-check report validation | Unit and malformed-report tests |
| DC-05 | Actual dbt Core/DuckDB subprocess on owned local fixture passes valid data and fails violating data | Real local runner tests with recorded commands and counts |
| DC-06 | At least null, unique, referential integrity and accepted-values checks when selected by contract | Real fixture tests |
| DC-07 | Missing tool/dependency, timeout and uncertain termination never count as data success; cleanup stays owned | Prerequisite/process/cleanup tests |
| DC-08 | Standard-role skill flow and honest adapter/evidence limits | P28 catalog tests and package documentation |
| DC-09 | Required repository validation; no commit, push, PR, shared-path edits or warehouse writes | Handoff commands/results and ownership diff |

## Conditional TDD decision

Accepted decision: `required`, classification `domain_logic`, `requiresFailingTestFirst: true`. Compatibility direction, approval matching and evidence interpretation are deterministic, security-relevant domain behavior; write failing table-driven tests first. Runner integration tests must observe a real dbt process, not fabricated success. If dbt is unavailable, record a prerequisite gap and keep the live-fixture criterion unmet until an isolated pinned toolchain is available. Instruction/documentation-only changes use catalog/schema validation and review; no artificial Red test for prose.

## Accepted execution plan

1. Validate an exported Specification/TestStrategy/TddDecision representation of DC-01 through DC-09; retain owner acceptance separately from synthetic test approvals. Establish dependency/typecheck baseline in the worktree.
2. Red/Green: Runtime-private data contract, approval/pin validation and directional structural checker; exercise compatible/breaking, rename/remove, required tests, stale contract and unsupported types.
3. Red/Green: strict dbt evidence parser; exercise incomplete/skipped/duplicate/malformed/stale/inconsistent reports and nonzero infrastructure outcomes.
4. Red/Green: owned dbt/DuckDB fixture runner plus contract-shaped gate/artifact integration. Execute real passing and violating fixtures, verify provenance and owned cleanup.
5. P28 owner adds standard-role pipeline/dbt/data-contract instructions without adding roles or permissions. Review the Runtime changes and P28 proposal independently before any integration across ownership.
6. Run `pnpm check:deps`, `pnpm typecheck`, targeted package tests, `pnpm test:affected --base 2041d7efa860981833eb6bd58fd9023ce8a727d3 --run`, `git diff --check` and `git status --short`. Report widening and exact pass/fail/skip counts, baseline plus uncommitted diff, adapter versions, migrations (none), prerequisites and live-acceptance limits. Do not commit/push/open a PR.

## Migration and limits

Additive Runtime-private implementation; no public schema, journal, database or root dependency migration. Existing behavior stays opt-in through the Runtime adapter. CLI/host-configuration wiring and external warehouse adapters require their owners' later review. Fixture execution proves only the supplied snapshot under dbt/DuckDB. It does not prove production SQL equivalence, warehouse behavior, provider/Herdr transport, or full live SDLC acceptance.
