---
name: data-contract
description: "Use when specifying or reviewing versioned data contracts and field-level schema drift against consumer compatibility expectations."
---

## Supported roles

coordinator, specifier, architect, planner, developer, tester, reviewer, qa. Stay within the assigned standard role and original prompt.

## Prerequisites

An accepted Specification and host-authorized comparison. Skills are instructions, not approval, permissions, tools or task acceptance; preserve Conditional TDD, independent gates, leases/fencing and iteration bounds.

## Trigger conditions

A model/schema or its tests change; a contract revision, consumer expectation or quality threshold needs review.

## Required inputs

Accepted schema, fields/types, keys, nullability, constraints and required checks; exact version/digest and current approval; candidate schema/digest; consumer direction, open/exact schema policy and explicit rename mapping if available.

## Expected outputs

Per-field findings with code, accepted/candidate values, consumer direction and compatible/breaking/unsupported classification. Return static test-coverage gaps separately from actual data-quality results.

## Procedure

1. Validate ingress with the available strict schema. Host authority must bind the contract digest/revision to the accepted specification and current approval. Match request/decision IDs, run, target, revision and generation; reject expired/superseded/stale pins, including supersession during measurement.
2. Compare removed/added/renamed fields, type domains, nullability, keys/unique guarantees, constraints and required tests. A rename map explains a removal/addition; it does not adapt consumers automatically.
3. Evaluate candidate producer → accepted consumer, accepted producer → candidate consumer, or both as the policy states. For a non-null consumer, making producer output nullable breaks the guarantee; the reverse direction can remain compatible. Integer widening can exceed an old consumer's type domain while an old narrower producer can satisfy a wider new consumer. Unknown/lossy conversions need an unsupported/breaking finding according to approved policy.
4. Apply explicit open/exact schema and consumer requirements to added/removed fields. Compare unique/key guarantees independently from declared tests. Missing required tests fail static coverage even if present tests pass. Parsing dbt metadata never proves null/unique or other checks passed on data.
5. Any expectation, threshold or policy change changes the accepted content digest and requires its corresponding revision/approval. Do not relax a contract to classify a violating candidate as compatible. Propose schema evolution/migration for owner review; do not apply warehouse migrations.

## Bflow commands

Use `bflow help` to inspect installed capabilities. There is no data-contract subcommand supplied by this skill; use the authorized structural checker host interface when available.

## Verification requirements

Test compatible and breaking directions, remove/rename, missing tests, stale pins and unknown types. Attach structural findings to exact contract/candidate schema digests. Runtime quality checks require separate host-measured evidence on the approved snapshot/environment.

## Error handling

Malformed/unsupported dbt metadata or absent compatibility policy cannot become a pass. Report the unsupported adapter/version and prerequisite or decision needed. Never manufacture approval flags or trusted artifact references.

## Escalation rules

Send unresolved consumer assumptions or proposed revisions through Runtime → Herdr → Conversation. Keep native direct questions disabled; only the authorized human can approve changes, and silence grants no authority.

## Concrete examples

See [directional examples](worked-example.md). They illustrate policy decisions, not executed data checks or approved contracts.
