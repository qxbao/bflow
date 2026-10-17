---
name: task-decomposition
description: "Use to decompose an accepted specification into scoped criterion-linked tasks suitable for Runtime DAG scheduling."
---

## Supported roles

coordinator, planner.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Accepted specification and known repository ownership.
- Existing Runtime planning/decomposition capability.

## Trigger conditions

- A requirement is ready for implementation planning.
- A changed specification invalidates the current plan.

## Required inputs

- Specification revision and criterion IDs.
- Dependencies, ownership, risk and concurrency constraints.

## Expected outputs

- A proposed acyclic task DAG.
- Task scopes, criterion traceability and verification assignments.

## Procedure

1. Group work around observable deliverables and ownership boundaries. Give each task inputs, outputs, criteria and required evidence.
2. Identify dependencies and shared integration gates explicitly. Preserve staged prerequisites; parallel tasks must use separate approved worktrees and cannot mutate shared contracts.
3. Submit the plan to Runtime for validation, TDD strategy, leases and scheduling. Planning does not dispatch or authorize implementation on its own.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every task traces to accepted criteria and has a bounded owned scope.
- The proposed DAG is acyclic and integration/verification prerequisites are explicit.

## Error handling

Overlapping scopes or unresolved public boundaries block affected tasks. Do not create hidden dependencies in prose while marking tasks parallel.

## Escalation rules

Shared ownership, contract migration or prerequisite-gate uncertainty goes through Runtime for an owner decision.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

