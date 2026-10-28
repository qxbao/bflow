# DC-01 local implementation evidence and handoff

Initial-delivery results below are historical. The subsequent review/fix results are recorded in [data-verification-review.md](data-verification-review.md).

Worktree: `/home/DUCLH/orca/workspaces/bflow/agent-runtime-dbt-contract-fixture`.
Branch: `agent/runtime/dbt-contract-fixture`.
Tested baseline/HEAD: `2041d7efa860981833eb6bd58fd9023ce8a727d3`, plus the uncommitted scoped diff. No commit, push or PR was created. Original checkout stays on `duc` at `6c4dc68`; Orca refreshed the integration ref when creating this worktree, and ancestry was checked.

The project owner explicitly accepted DC-01 in the conversation. The approved development Specification is `data-verification.spec.json`, validated by both exported `SpecificationSchema` and P15 `SpecificationDocumentSchema`. Its immutable document was ingested by a real FilesystemArtifactStore (`artifact://dc01-development/dc01-development-spec-v1`, SHA-256 `d74ad9946c4ef05b0082114e4cabe974906db5e0e179d4fb725ca5457826aa2a`). Local development approval records/store are `/tmp/bflow-dc01-development-approval-xctoP4`. This development approval is separate from the deliberately synthetic authorities used by data test fixtures.

## Implemented and supported

- Runtime-private strict v1 data contract/snapshot models and dbt Core 1.10 manifest-v12 ingress. Directional structural findings distinguish type domains, nullability, uniqueness/keys, add/remove/explicit rename, schema policy and required test definition drift.
- `DataVerificationHost` runs independent structural and quality gates using the existing exported contract envelopes; current owner authority, immutable specification content, contract revision/digest, schema/snapshot pins and expiry are checked across awaited IO and immediately before subprocess launch.
- Real dbt Core + DuckDB fixture execution in Linux Bubblewrap, fixed host templates, no inherited warehouse credentials/network, DuckDB external access disabled. UTF-8 text is emitted inertly, never interpreted as Jinja. Fresh complete manifest/run-results are checked for selected models/tests, built-in invocation binding, definition, invocation/time/version, status/counts and exit outcome.
- Actual host measurements are ingested through ArtifactStore; no supplied agent report or process exit alone can produce an accepted quality result. Normal cleanup removes only the owned fixture. Deadline/signal retains resources for reconciliation, without asserting that a query stopped.
- Three optional pinned skills (`data-pipeline`, `data-contract`, `dbt-verification`) use standard roles and no new grants/default bindings. P28 worked in its own worktree at the same baseline; its diff was reviewed before integration. E11/E15 exact inventory/repair assertions were reconciled for the expanded catalog; no test timeout, failure threshold or production quality gate was relaxed.

Source plus local fixture evidence only. This library path adds no persistent daemon/CLI configuration command, warehouse adapter, arbitrary candidate transformation SQL, or full live provider/Herdr/SDLC acceptance. A declared model revision is a provenance label, distinct from supplied manifest and measured fixture schema digests. Host authority must authenticate real humans and preserve immutable approval/version history; parsing arbitrary approval JSON does not do so.

## Actual local dbt smoke

Command (exit 0):

```bash
BFLOW_TEST_DBT_TOOLCHAIN=/tmp/bflow-dc01-tools node packages/runtime/examples/dbt-data-fixture.mjs
```

Toolchain measured inside the sandbox: dbt Core **1.10.15**, dbt-duckdb **1.10.0**, DuckDB **1.4.1**; Python **3.13.15**, Node **22.23.2**, pnpm **12.5.1**, Linux Bubblewrap `/usr/bin/bwrap`. The optional fixture toolchain dependencies are pinned in `test/data/requirements.txt`; the runner installs nothing.

Retained real artifact catalog and result index: `/tmp/bflow-dc01-evidence-c63Zke/artifacts` and `/tmp/bflow-dc01-evidence-c63Zke/results.json`. Raw command stdout summary: `/tmp/bflow-dc01-smoke-delivery.log`. These machine-local paths are not portable release artifacts. The example explicitly marks synthetic fixture approvals and accepts only its included fixed fixture inputs.

| Fixture | Structural | Runtime data quality | Measured command duration |
| --- | --- | --- | --- |
| `fixture_good` | passed | passed | 3522 ms |
| `fixture_bad` | passed | failed | 3603 ms |

Actual dbt failure counts, read back through ArtifactStore integrity checks:

| Check | Good | Bad |
| --- | ---: | ---: |
| `id_null` | 0 | 1 |
| `id_unique` | 0 | 1 |
| `status_null` | 0 | 1 |
| `status_values` | 0 | 1 |
| `customer_fk` | 0 | 2 |

The dbt uniqueness count is duplicate groups, not all duplicate rows. Full executable/argv, model revision label, accepted contract revision/digest, schema and snapshot identities/digests, exact versions, timestamps, outcome, report digests and per-check results are in the stored measured evidence. Actual invocation is sandboxed Python `dbt.cli.main.cli()` with `build --project-dir /work --profiles-dir /work --no-partial-parse --no-use-colors` against `/work/fixture.duckdb` in the owned namespace. Both normal fixture trees were removed; the ArtifactStore remains for review.

## Verification commands and results

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm check:deps` | 0 | 22-package graph acyclic; existing 49 internal edges and ownership/import rules validated |
| `pnpm typecheck` | 0 | Full workspace typecheck/build, including final ingress guard |
| `BFLOW_TEST_DBT_TOOLCHAIN=/tmp/bflow-dc01-tools pnpm exec vitest run packages/runtime/test/data` | 0 | **4 files, 79 passed, 0 failed/skipped**; actual dbt cases enabled |
| `pnpm --filter @bflow/skills test` | 0 | **9 files, 51 passed, 0 failed/skipped** |
| Focused E15 before the broad runs | 0 | **1 file, 5 passed, 2 skipped**, preserving the original deadlines |
| `pnpm test:affected --base 2041d7efa860981833eb6bd58fd9023ce8a727d3 --run` with real-dbt test env | 1 | **Full scope:354 files passed/1 failed/6 skipped;6127 tests passed/1 failed/84 skipped**,1070.36s. Selection395 unit paths +20 E2E paths, index not queried. New skill manifests widen root. Unit failure stops the selector before E2E; E2E was run separately. `/tmp/bflow-dc01-affected-stable.log` |
| Full E2E initial integration run, 2 workers | 1 | **16 files:14 passed/2 failed;82 tests passed/2 failed/7 skipped**. E11 old inventory33 was exposed and corrected to36/35; E15 catalog hit the unchanged60s deadline under concurrent load. Resolved in the stable E2E run below |
| Full E2E after E11 inventory correction, 2 workers | 0 | **16 files passed;84 tests passed/7 skipped/0 failed**,119.34s. `/tmp/bflow-dc01-e2e-stable.log` |
| `pnpm test:e2e --maxWorkers=2 --minWorkers=2` on frozen source | 0 | **16 files passed;84 tests passed/7 skipped/0 failed**,116.15s. `/tmp/bflow-dc01-e2e-final-frozen.log` |
| `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` | 0 | E2E TypeScript validation |
| `git diff --check` | 0 | No whitespace errors (repeat at final handoff) |

Before any implementation, the Runtime-only baseline selection had **176 files passed,4 failed,2 skipped;2762 tests passed,7 failed,72 skipped** (exit1). Existing failures: az-acceptance automatic-resume timing; host provider-ready expectation; integration-host-notices resolver timeout; integration-p19-conflicts-reviews (three timeouts and a lease escalation). These are not claimed fixed. The frozen-source full run's only remaining failure is the same `packages/runtime/test/agentic/host.test.ts:368` provider readiness expectation (`ready` expected false, observed true), already present before implementation. No data verification test failed in that run: all79 passed. The broader existing host issue is not claimed fixed; full workspace validation is not green.

Conditional TDD: each new module suite first failed for the absent implementation. Independent review then reproduced concrete failing assertions for Jinja data reinterpretation, authority revocation during final artifact IO, custom/foreign test binding and nonliteral `quote` values; regressions were observed RED then GREEN. Lone-surrogate snapshot/accepted-value ingress and removed-field test coverage also had observed RED regressions before their guards. An earlier broad run was superseded because its cached module preceded the late UTF-8 test; the final run keeps source fixed. Reviewer independently verified 66 tests before the final quote boundary, then55 structural/report cases after that fix, with no remaining findings; E11 integration count changes were also reviewed independently.

## Migration, ownership and remaining limits

No exported `@bflow/contracts`, root config, pnpm lockfile, shared README/AGENTS/docs, persistent journal or warehouse schema was migrated. The fixed source/test/skill inventory is recorded in `/tmp/bflow-dc01-source-freeze.json` (29 files, digest `ed5b2964acbe5fe91e8397504706039281a4e783f05b727f3f911a8585457f15`). New models are additive private v1 inputs, used only by the opt-in host. Runtime owns `packages/runtime/**`; P28 owns `packages/skills/**` and `skills/**`; integration changes are confined to E11/E15 catalog inventory tests. Generated `dist`, caches, SQLite databases, logs and real artifact stores remain uncommitted outside the source diff.

Missing toolchain/adapter/dependency/sandbox is a blocked prerequisite. Supported static types and checks are deliberately bounded; freshness/distribution/volume/custom SQL checks and composite keys are unsupported and must not be silently substituted. Accepted-values strings with apostrophes/Jinja openers, nonliteral quote settings, and non-round-trippable snapshot text are rejected. Real warehouse authorization, remote query reconciliation and candidate SQL equivalence are outside this adapter. A timeout retains only owned resources for operator reconciliation; no automatic cleanup or replay infers termination. See `DATA-VERIFICATION.md` for exact input conventions and reproduction.

Final ownership inventory: Runtime: 21 files, P28 package: 3 files, P28 catalog: 10 files, Integration E2E: 2 files; 36 changed/untracked source-delivery paths total. No unexpected ownership paths. Integration E2E paths are E11/E15 inventory/repair checks only, reviewed independently.

Final source/test/skill freeze was verified unchanged after all runs. `pnpm check:deps`, `pnpm typecheck` and `git diff --check` were repeated at delivery and exited0. No pending feature implementation remains within the approved snapshot-only scope; the baseline host test failure and deferred daemon/CLI/warehouse integrations are explicit handoff limits.
