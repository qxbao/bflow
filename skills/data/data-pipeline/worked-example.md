# data-pipeline worked example

The accepted orders contract revision 2 has a non-null unique order ID, a customer reference and status in {paid, pending}. Its digest and approval generation are pinned by the host. The candidate schema adds an optional note; an approved fixture snapshot contains one duplicate order ID.

Specifier retains the consumer guarantees. Architect records candidate producer → accepted consumer compatibility under open-schema policy: the optional added field is compatible. Planner maps a structural criterion and independent null, unique, relationship and accepted-values criteria. Coordinator requests ordinary Developer and QA assignments through Runtime. Developer cannot change accepted thresholds. QA uses the approved fixture host adapter; Reviewer checks the changed model/tests and consumer impact.

Expected decisions:

| Observation | Outcome |
| --- | --- |
| Optional note under open-schema consumer policy | Compatible structural finding |
| Duplicate order ID observed by real dbt test | Failed data-quality check, linked to the snapshot digest |
| Schema parsed and remaining tests passed | Does not clear the unique failure |
| Suggested removal of unique test to pass | New contract/test weakening proposal requiring review and approval |

Runtime stores host-produced measured evidence using ArtifactStore and evaluates independent gates. A manual table like this is a planning example and cannot supply a test-result artifact.

If dbt is missing, execution is blocked by a prerequisite while the structural result remains separately visible. Conversation receives the exact missing dependency through Runtime. Do not create a warehouse schema, install machine tools or invent a command to work around that gap. A local DuckDB snapshot pass would still leave production transformation and warehouse acceptance unverified.
