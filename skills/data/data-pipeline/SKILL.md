---
name: data-pipeline
description: "Use when planning or changing a data pipeline with accepted data contracts and independent schema-drift and data-quality criteria."
---

## Supported roles

coordinator, specifier, architect, planner, developer, tester, reviewer, qa. Use the assigned standard role; this skill creates no data-engineer or dbt role.

## Prerequisites

An accepted Specification, Conditional TDD decision and authorized assignment. This instruction-only skill grants no tools, installation, warehouse access, approval or acceptance; preserve original role prompts and host policy.

## Trigger conditions

A pipeline/model change affects schema, consumers or data guarantees, or needs an approved fixture verification plan.

## Required inputs

Contract revision/digest and current approval, consumer direction/policy, candidate schema/revision, accepted check IDs, dataset/snapshot identity, environment authority and ownership/cleanup boundaries.

## Expected outputs

A criterion-to-task/evidence plan with separate structural-drift and runtime data-quality outcomes, prerequisite gaps, migration proposal when needed and stated evidence limits.

## Procedure

1. Specifier captures fields, keys, nullability, constraints and consumer expectations. Architect makes compatibility direction and migration implications explicit. Contract or threshold changes require a new revision/digest and corresponding approval.
2. Coordinator uses Runtime to schedule the accepted task DAG and independent checks; Planner maps criteria and prerequisites. Developer changes only assigned paths and follows the accepted TDD decision. Tester/QA gathers independent measurements; Reviewer assesses consumer impact and test/config weakening.
3. Select task-specific data-contract and dbt-verification skills through exact approved catalog pins when relevant. They are optional instructions, never global role replacements or permission grants.
4. Keep static/schema checks separate from execution on an approved fixture/snapshot/environment. A parsed schema, installed dbt or transport done event proves no data-quality pass. Missing required tests remain findings even when present tests pass.
5. Require host-measured evidence linking criteria, contract approval/digest, measured schema/snapshot digests, declared model revision, adapter/tool version, command, timing and each check outcome. Agent-authored reports cannot substitute for the host runner or trusted ArtifactStore ingress.

## Bflow commands

Use `bflow help` for installed capabilities. This catalog entry adds no CLI command; use only an authorized host adapter actually available to the assignment.

## Verification requirements

Check null/unique/referential integrity/accepted values when accepted criteria require them. Add freshness or volume/distribution checks only with relevant approved measures and thresholds. DuckDB fixture evidence is snapshot validation, not production SQL or warehouse/live acceptance.

## Error handling

Missing dbt, adapter, dependencies, warehouse authorization or sandbox is a prerequisite gap. Never invent a successful runner, weaken thresholds or migrate a real warehouse to clear a check. Isolate database/schema resources; clean only owned fixtures after confirmed process termination. Timeout does not prove a query stopped.

## Escalation rules

Return unresolved compatibility, authority, migration and cleanup uncertainty to Runtime; preserve leases/fencing, independent gates and bounded rework. Route human decisions through Runtime → Herdr → Conversation, with native direct questions disabled. Silence is not approval.

## Concrete examples

See [the worked example](worked-example.md) for role boundaries and separate outcomes. Its approvals and data are illustrative, not live evidence.
