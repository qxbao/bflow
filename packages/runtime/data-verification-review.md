# DC-01 second review and fixes

Owner request: review the implementation again and fix bugs. Worktree/branch remain `agent/runtime/dbt-contract-fixture`, HEAD `2041d7efa860981833eb6bd58fd9023ce8a727d3` plus the uncommitted diff. No commit/push/PR, shared contracts/root config/lockfile changes or warehouse writes.

## Findings fixed

1. **Accepted-values false pass.** Actual isolated dbt accepted text `None` for an approved enum `[null]` because the built-in macro quotes Python `None`. Reproduced with dbt1.10.15/dbt-duckdb1.10.0/DuckDB1.4.1. Null enum entries are now explicitly unsupported; enum values must also match their field scalar type and integer range. Null policy stays in field nullability/`not_null`, without automatic conversion or threshold changes. The fixture and enum validator share one type-domain function.
2. **Constraint semantics silently dropped.** Unknown column/model constraints, SQL expressions embedded even in supported `not_null`/`unique` constraints, contradictory meta/constraints and invalid key declarations could escape structural rejection. The vetted column constraint schema now rejects unsupported semantics; real dbt name/warning/null/empty-reference defaults remain accepted. Unsupported model-level constraints are rejected rather than ignored.
3. **Mutable candidate input escaped the approved pin.** A deterministic artifact-IO repro temporarily restored a missing required test in the caller's manifest, then reverted it before later hash checks. The old code returned structural `passed` for the pinned breaking manifest. Host ingress now takes an owned JSON copy of contract, candidate manifest and snapshot before any await; the regression returns `failed` with `required_test_missing`.

All fixes followed observed RED then GREEN under the existing accepted required-TDD decision. Independent reviewer reproduced the dbt null false pass and the supported-type expression gap, reviewed the final input-copy/scalar/schema fixes and ran25 focused cases PASS with0 skips and no remaining findings in the reviewed changes. No source files were edited by the reviewer.

## Validation

| Command | Exit | Results |
| --- | ---: | --- |
| `BFLOW_TEST_DBT_TOOLCHAIN=/tmp/bflow-dc01-tools pnpm exec vitest run packages/runtime/test/data` | 0 | **5 files,105 passed,0 failed/skipped**; actual valid/violating dbt fixtures enabled |
| `pnpm check:deps` | 0 | Existing dependency graph/boundaries valid |
| `pnpm typecheck` | 0 | Workspace build/typecheck |
| `git diff --check` | 0 | No whitespace errors |
| `pnpm test:affected --base 2041d7efa860981833eb6bd58fd9023ce8a727d3 --run` with real dbt env | 1 | Full scope:355 files passed/1 failed/6 skipped;6153 tests passed/1 failed/84 skipped,1057.48s. Only failure is the preexisting host readiness expectation at host.test.ts:368. All105 data cases passed inside the full run. `/tmp/bflow-dc01-review2-affected.log` |
| `pnpm test:e2e --maxWorkers=2 --minWorkers=2` on final source | 0 | 16 files passed;84 tests passed/7 skipped/0 failed,115.24s. `/tmp/bflow-dc01-review2-e2e.log` |

The baseline `packages/runtime/test/agentic/host.test.ts:368` readiness expectation failed before DC-01 implementation; it remains a separate existing host issue, not a data verification acceptance claim. Earlier initial-delivery counts/artifacts in `data-verification-evidence.md` are historical and do not replace this review's final-source validation.

Raw RED logs: `/tmp/bflow-dc01-review2-red.log`, `/tmp/bflow-dc01-review2-expression-red.log`, `/tmp/bflow-dc01-review2-input-red.log`. Final focused GREEN: `/tmp/bflow-dc01-review2-green.log`. New regression corpus: `test/data/review-round2.test.ts` and the input ownership case in `test/data/host.test.ts`.

Scope stays dbt/DuckDB snapshot validation in an owned Bubblewrap fixture. It does not run arbitrary candidate SQL, add daemon/CLI wiring, authenticate a human from arbitrary JSON, or establish warehouse/live workflow acceptance. Real approval authenticity/current version history remain the host-private authority reader's responsibility.

Source/test/skill freeze:30 files, digest `459dfd78c41ac0da324362fb00b48e2800453540964572c7c668a074abf2503f`, `/tmp/bflow-dc01-review2-source-freeze.json`; verified unchanged throughout final runs. Remaining global host failure was not hidden by changing readiness logic, assertions or timeouts.

Final real dbt smoke exit0: [('good', 'passed', 'passed'), ('bad', 'passed', 'failed')]. Report and real ArtifactStore catalog retained at `/tmp/bflow-dc01-evidence-zTDOfg/results.json` and `/tmp/bflow-dc01-evidence-zTDOfg/artifacts`; synthetic fixture approvals stay explicitly labeled. Toolchain remains dbt1.10.15/dbt-duckdb1.10.0/DuckDB1.4.1. Final dependency/type/diff checks exit0; no source/test/skill freeze drift.
