# DC-01 data contract and snapshot verification

Source plus local tests; the supported execution adapter is **dbt Core 1.10 + dbt-duckdb 1.10 + DuckDB 1.4 on Linux Bubblewrap**. The local evidence toolchain is pinned in `test/data/requirements.txt`. No existing warehouse adapter, arbitrary candidate model SQL, dbt macros/hooks/packages, remote profiles or destructive migration is supported. Missing tools/dependencies/sandbox return a prerequisite gap, never an artificial pass. No CLI or persistent agentic daemon configuration has been added.

## Entry point and authority

`DataVerificationHost` is an opt-in Runtime library host entry point exported by `@bflow/runtime`. Its constructor receives the real `ArtifactStore`, an owner-approved Python virtualenv directory and a **host-private** `readAuthority()` callback. Do not expose construction/configuration of that callback to role messages, repository candidate files or a Developer-produced report. Caller-owned approval authenticity and current status come from that authority source; parsing an approval document alone does not authenticate a human.

The reader returns `{ specification, request, decision }` using existing exported `@bflow/contracts` schemas. It must supply the *current* request/status, not an archived receipt. Host checks approved state, expiry, run/session/specification target, approval ID, revision and generation. Specification must be approved, include version and approvedBy, and reference a stored immutable document also present in approval-request evidence. Store `dataSpecificationContent(specification)` as canonical JSON before adding approval envelope fields. The host reads it back through ArtifactStore and checks content/integrity. `dataVerificationDigest(value)` uses canonical sorted-object JSON and SHA-256; `dataContractDigest(contract)` validates the strict private contract before digesting.

`Specification.metadata.dataVerification` is a strict version-1 private object:

```json
{
  "schemaVersion": 1,
  "contractId": "orders_fixture", "contractRevision": 1, "contractDigest": "<sha256>",
  "candidateSchemaDigest": "<sha256 of input manifest JSON>",
  "snapshotId": "fixture_snapshot_1", "snapshotDigest": "<sha256 of snapshot JSON>",
  "declaredModelRevision": "<40 or 64 lowercase hexadecimal characters>",
  "structuralCriterionIds": ["schema"], "qualityCriterionIds": ["quality"]
}
```

Every listed quality criterion requires the complete accepted contract check set; per-criterion subsets and prose-derived extra checks are unsupported. Required criteria must be fully covered by these distinct IDs, with `static_analysis` and `integration_test` methods respectively. Host re-reads authority before and after awaited measurement/storage, after artifact reads, and immediately before each subprocess launch. Any contract, threshold, snapshot or schema change requires the corresponding new immutable specification revision and matching approval. A request marked expired/superseded or changed while execution runs blocks acceptance; there is no auto-relaxation.

Call `host.verify({ runId, attemptId, taskId?, contract, candidateManifest, snapshot })`. The host takes an owned JSON copy of contract, candidate manifest and snapshot before awaited IO, so caller mutations cannot change the document measured under an approved digest. An `OperationResult` contains independent `structural` and `quality` `QualityGateResult`s plus trusted artifact references in `evidence`. Both gates are required for acceptance. A structural failure does not erase actual data observations; a data pass does not override a structural failure. `producedArtifacts` remains proposal-only per the existing contract; measured references are stored by ArtifactStore and linked in metadata. An agent-authored success report is not an input to this host path.

## Private contract and schema ingress

Runtime-private schemas live in `src/data/`; no `@bflow/contracts`, journal or persistent database migration was made. The contract has `schemaVersion:1`, an ID/revision/model, fields `{name,type,nullable,unique}`, a list of **single-column** keys, checks, consumer policy and integer-conversion policy. Identifiers for SQL are lowercase ASCII letters/digits/underscore starting with a letter (maximum 63 characters). Supported types: `smallint`, `integer`, `bigint`, `double`, `text`, `boolean`, `timestamp`. Snapshot text must round-trip UTF-8; lone UTF-16 surrogate code units are rejected before launch, rather than measured as replacement characters. Integer snapshot cells are safe JS integers; larger bigint values and implicit coercions are unsupported.

Accepted-values strings containing apostrophes or Jinja opener syntax are unsupported by this first built-in dbt adapter and rejected, rather than interpolated into test SQL. Snapshot text itself is emitted through UTF-8 hex decoding so Jinja-looking data stays literal. Accepted-values must match their field scalar type/range; null enum entries are unsupported because dbt renders Python `None` as text. Use field nullability and a `not_null` check for null policy. Checks are `{id,kind,column,maxFailures}` plus `values` for `accepted_values` or `reference:{model,column}` for `relationships`. Null/unique guarantees require corresponding declared checks. Thresholds are nonnegative integer counts of dbt failing result rows/groups (dbt uniqueness counts duplicate groups, not all duplicate rows). Freshness, volume/distribution, arbitrary SQL constraints and composite keys are unsupported: an accepted requirement for those must be surfaced as a gap, not omitted.

`candidateManifest` accepts dbt Core **1.10, manifest v12 JSON**. This is schema metadata inspection, not a new YAML parser. It reads exactly one named model, supported column `data_type`, `meta.nullable/unique/key` (or not-null/unique constraints), and generic test nodes linked to the model. Only pure column `not_null`/`unique` constraint objects are supported: decorative name/warning defaults are allowed, executable expressions, references, unknown fields/types and nonempty model-level constraints are rejected. Contradictory metadata/constraints and keys that are not existing non-null unique fields are rejected. An optional model `meta.bflow_renames` maps old names to candidate names; it explains drift without adapting old consumers. Selected tests must use the built-in dbt namespace/macros, allowed arguments and exact `get_where_subquery(ref(model))` binding. Selected test config needs `meta.bflow_check_id` matching accepted check IDs, severity ERROR and identical `error_if`/`warn_if` of `> N`. Disabled/filtered/limited/custom failure-calculation tests and unquoted accepted values cannot silently satisfy the accepted contract. Supported relationships use a local `ref('model')` and field; package/source/custom tests are unsupported. Missing nullability metadata means nullable; missing unique metadata means no declared unique guarantee. dbt tests do not change those declaration defaults.

Directional comparison checks candidate producer → accepted consumer, accepted producer → candidate consumer, or both. Candidate type domains must fit the receiving consumer: widening a producer integer can break an old narrower consumer, while the inverse direction can remain compatible. Nullability and uniqueness compare guarantees in the same direction; open/exact schema policy governs additions. Unknown/lossy conversions are unsupported and block structural acceptance. Explicit rename metadata never adapts old consumers automatically. Findings include field, code, direction, old/new values and compatibility. Required test definitions remain pinned exactly, including thresholds.

## Fixture execution and evidence

Snapshot input is `{schemaVersion:1,id,declaredModelRevision,model,rows,references}`. Rows follow accepted field order. References have `{model,fields,rows}`. The runner generates only fixed host SQL templates and JSON-as-YAML schema/profile files; it does not run candidate SQL. SQL strings are escaped and row widths/types/identifiers bounded before launch. `declaredModelRevision` is provenance supplied by the owner; it does not assert that the transformation at that revision ran. Supplied manifest digest and measured generated-fixture schema digest are separate.

The runner creates a private temporary project/profile/DuckDB database, denies network, mounts the approved Python distribution and virtualenv read-only, clears inherited environment/credentials and permits writes only inside its fixture namespace. DuckDB external access is disabled. dbt `build` executes actual null, unique, relationships and accepted-values tests. Fresh manifest/run-results must match invocation/version/time window, exact model/check coverage, accepted definitions, failure counts/status and exit code. Skipped, duplicate, stale, missing, malformed, infrastructure-error, deadline or truncated reports cannot pass.

Evidence labels `snapshot_validation` and records contract revision/digest, snapshot ID/digest, declared revision, measured fixture schema digest, tool/adapter versions, exact executable/argv, timestamps/duration, per-check outcomes/failures, exit outcome and raw report digests. Host adds candidate-manifest digest and approval identity/revision/generation before trusted artifact ingest.

Normal namespace exit permits deletion only of the owned fixture tree. Timeout/signal means `dbt_execution_uncertain`: retain the owned fixture path for operator process/namespace reconciliation. There is no retry, outside-resource deletion or inference that a real query stopped. Retained directories are not automatically cleaned by tests or recovery. Host-level independent gates are not a cross-process durable acceptance journal; daemon/CLI binding remains an owner integration follow-up.

## Reproduce local evidence

From repository root, with Node >=22.13 and pinned pnpm:

```bash
uv venv --python /usr/bin/python3 /tmp/bflow-dbt-tools
uv pip install --python /tmp/bflow-dbt-tools/bin/python -r packages/runtime/test/data/requirements.txt
pnpm build
BFLOW_TEST_DBT_TOOLCHAIN=/tmp/bflow-dbt-tools pnpm exec vitest run packages/runtime/test/data
pnpm --filter @bflow/skills test
```

Set `BFLOW_TEST_DBT_TOOLCHAIN` only to an operator-approved isolated virtualenv. The runner never installs it. Without that test variable, live fixture cases are explicitly skipped; prerequisite/parser/domain tests still run. Those skips cannot satisfy the local-run criterion. Test approvals and snapshots are synthetic fixtures; they do not create real warehouse authority. For a compact host example inspect `test/data/host.test.ts` and `examples/dbt-data-fixture.mjs` for a standalone smoke run once built.

Optional `data-pipeline`, `data-contract` and `dbt-verification` skills select existing standard roles through exact reviewed catalog pins. They are instruction-only and add no default bindings, grants or tool installation. Catalog/render checks prove distribution, not behavior or warehouse acceptance.
