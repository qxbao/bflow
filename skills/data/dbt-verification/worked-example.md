# dbt-verification worked example

An accepted orders contract requires not-null and unique order IDs, customer references to the customers snapshot and status in {paid, pending}. The host approves fixture snapshot orders-local-1, pins its digest and records contract/approval identities. The declared model revision is a provenance label; this adapter measures snapshot rows using host templates.

The authorized host path generates a minimal project and private profile pointing only at its own DuckDB file, probes dbt/adapter and Bubblewrap, and executes real dbt inside the network-denied sandbox. It reads fresh manifest/run-results output, validates matching invocation metadata and selected tests, then ingests the measured evidence through ArtifactStore. A supplied manifest is only structural input and cannot become runtime evidence.

Expected fixture observations:

| Snapshot | Required measurement |
| --- | --- |
| Valid IDs, existing customer references, accepted statuses | Each selected real test passes with complete coverage |
| Null ID | Corresponding not-null test fails |
| Duplicate ID | Unique test fails |
| Unknown customer ID | Relationship test fails |
| Status outside the accepted set | Accepted-values test fails |

These rows are test-design expectations, not a generated pass report. The actual host report must include snapshot/model/schema identities, accepted contract and approval pin, dbt/adapter version, command, timing and measured per-check counts/statuses. Static drift and data-quality results remain separate if a candidate schema is compatible but its data violates uniqueness.

If dbt is absent, record a prerequisite gap and no data pass. If a report omits the unique test, reject incomplete evidence even when other tests passed. If a deadline interrupts execution, do not assume the query stopped or repeat a mutation; preserve uncertain owned resources for reconciliation. Cleanup may delete the runner-created fixture tree only after confirmed termination, never another database/schema or warehouse objects.

A request to allow duplicate IDs or add a freshness tolerance changes accepted expectations and needs a revised contract and approval. A passing DuckDB fixture remains local snapshot evidence; production transformation SQL, warehouse behavior and live SDLC acceptance remain unverified.
