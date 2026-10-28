# DC-01 implementation ledger

Accepted spec: data-verification-design.md and data-verification.spec.json; owner approved in the current conversation on 2026-10-28. Baseline 2041d7efa860981833eb6bd58fd9023ce8a727d3. No commits/push/PR. Conditional TDD required for domain logic; prose/catalog validation for P28 instructions.

- [x] Survey and baseline: check:deps/typecheck exit0. Baseline affected Runtime selection exit1: 176 files pass,4 fail,2 skip;2762 tests pass,7 fail,72 skip. Existing failures: az-acceptance:522,host:368,integration-host-notices resolver timeout, integration-p19-conflicts-reviews (3 timeouts + lease escalation). No production changes preceded that run.
- [x] RED contract suite: module absent (exit1); GREEN 19 tests. Strict contract, directional fields/guarantees, required tests and dbt manifest v12 ingress.
- [x] RED report suite: module absent (exit1); GREEN 16 tests. Invocation/time/coverage/definition/status/exit validation.
- [x] RED fixture suite: module absent (exit1). Implement Linux Bubblewrap, actual dbt/DuckDB, owned cleanup and uncertainty retention; run passing/violating snapshots.
- [x] RED host/authority suite, then implement two contract-shaped gates, exact approval pins and trusted artifact evidence. Recheck authority across awaits.
- [x] Independently review and integrate P28 scoped skill diff; inventory assertions reconciled only during integration review.
- [x] Review, required dependency/type/affected checks, exact handoff evidence and limits (full unit run retains one documented baseline failure).

Ruling: Runtime's opt-in DataVerificationHost is the approved host → gate → subprocess → ArtifactStore entry point; no persistent daemon or CLI configuration support is claimed. Candidate revision is a declared provenance label; actual measured snapshot/schema have separate digests. No arbitrary candidate SQL executes.
Ruling: Python virtualenv layout can contain a UV interpreter alias. Mount only the verified real interpreter distribution at both its real root and validated virtualenv `home` alias (same realpath); never mount the whole home or tool cache.
Ruling: P28 skills are optional and do not change default role bindings. Catalog tests establish pinned distribution, not runtime obedience or warehouse acceptance.

Integration review: P28 scoped diff reviewed and applied without commits. E15 inventory assertions were reconciled from 33 to 36, retaining exact count plus asserting all three new data skill IDs. This is an integration-owned test expectation update for the expanded catalog, not a weakened production gate. No shared contracts/root config/lockfile/docs were edited.

Independent review: reproduced and fixed snapshot Jinja reinterpretation, final-artifact-read authority TOCTOU, custom/unbound test metadata, and nonliteral quote=false equivalents. RED regressions observed, final GREEN 75/75 across4files with real dbt. Snapshot text now uses inert UTF-8 hex decoding; built-in test metadata/model/macro/argument binding is checked in both static and result parsing; approval/time re-read follows artifact IO and precedes subprocess launch. Accepted-values strings that cannot be safely represented by the supported built-in macro are explicit unsupported input. Reviewer independently confirmed final55 structural/report tests and no remaining findings.

P28 validation:51 tests/9files pass,0fail/skip. Focused E15 integration validation:5pass/2skip/0fail. Final standalone smoke: good structuralpassed/qualitypassed; bad structuralpassed/qualityfailed. Real measured reports/artifacts retained at /tmp/bflow-dc01-evidence-scXdHu/results.json; synthetic fixture approvals are labeled and grant no warehouse authority. Development Specification acceptance uses actual owner-message authority, with stored document/approval record at /tmp/bflow-dc01-development-approval-xctoP4.

Required final validation running: BFLOW_TEST_DBT_TOOLCHAIN=/tmp/bflow-dc01-tools pnpm test:affected --base 2041d7efa860981833eb6bd58fd9023ce8a727d3 --run. Scope full (395 unit paths +20 E2E); three new skills/data/*/skill.json widen root. Full output /tmp/bflow-dc01-affected-final.log. Dependency graph/typecheck already exit0; final suite results pending. A final ingress-only UTF-8 round-trip guard/test was added while the widened run was active, after observing a RED for lone-surrogate replacement. Final targeted data suite and typecheck were rerun; report the widened run and this final-source targeted evidence separately. Documentation/evidence may be completed while tests run.

Ingress codec ruling: snapshot text must round-trip UTF-8; otherwise the runner could measure replacement bytes instead of the approved JSON value. One focused RED prerequisite test preceded the guard, and the final data suite now76/76 PASS with real dbt enabled; typecheck exit0. No other production changes after review.

Integration validation found additional E11 setup/repair inventory assertions still fixed at33. Observed RED in the full E2E run (expected33/received36), then reconciled exact full and one-missing-bundle counts to36/35. All setup/apply/check/repair behaviors and timeouts are preserved. E15's catalog case also timed out under concurrent broad-suite load despite its earlier isolated PASS; final E2E rerun will retain the original60s assertion deadline.

Final source freeze:29 source/test/fixture/skill files, digest ed5b2964acbe5fe91e8397504706039281a4e783f05b727f3f911a8585457f15 in /tmp/bflow-dc01-source-freeze.json. Last domain guards observed RED then GREEN: invalid required tests still referring to removed fields, and accepted-values text that cannot round-trip UTF-8/NUL. Final data suite79/79 PASS, dependency/type checks exit0; independent review found these appropriately scoped. E2E rerun after inventory correction:16 files PASS,84 tests PASS/7 SKIP,119.34s. Final widened full run uses /tmp/bflow-dc01-affected-stable.log with no source mutations; earlier in-flight run results are retained separately, not used as final-source proof.

Delivery: frozen full run exit1,354 files PASS/1FAIL/6SKIP;6127 tests PASS/1FAIL/84SKIP,1070.36s. Only failure host.test.ts:368 matches preimplementation baseline. All79 new data tests passed inside that same full run. Frozen E2E exit0,16 files PASS,84 tests PASS/7SKIP,116.15s. Final smoke exit0 with good passed/passed and bad passed/failed, five measured violation checks, artifacts at /tmp/bflow-dc01-evidence-c63Zke/results.json. Dependency/type/diff checks exit0; source freeze unchanged. No commit/push/PR, shared contract/root config/lockfile changes, or warehouse writes/migrations.

## Review round 2 (owner requested review and fixes)

- Actual dbt false pass confirmed independently: accepted_values [null] accepted snapshot text None. Contract/check validation now rejects null and mismatched scalar/range enums instead of implicit coercion.
- Static parser silently discarded unknown/model constraints, supported-type SQL expressions, contradictory metadata and invalid keys. Dedicated RED tests preceded strict constraint and key validation; real dbt decorative defaults remain accepted.
- A caller could temporarily repair the pinned manifest during artifact IO and restore it before later hash checks, producing a wrong structural pass. Dedicated RED test observed expectedfailed/receivedpassed. Input JSON is now owned before awaits.
- Local GREEN:105 tests across5files, real dbt enabled; independent reviewer final25-case schema check PASS with no skips/findings. No warehouse or remote writes, source commits, public contracts/root changes.
- Source will remain fixed for this review's mandatory validation; see data-verification-review.md for final results.

Review2 delivery: frozen full run exit1 with6153 PASS/1 preexisting host failure/84 SKIP; full E2E exit0 with84 PASS/7 SKIP; all105 data tests PASS. Real smoke exit0, report `/tmp/bflow-dc01-evidence-zTDOfg/results.json`. No source commits, public contract/root changes or warehouse writes.
