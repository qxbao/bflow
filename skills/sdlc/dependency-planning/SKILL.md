---
name: dependency-planning
description: "Use to order scoped tasks and integration gates while identifying safe parallel work and exact prerequisites."
---

## Supported roles

planner, coordinator.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An accepted specification and candidate task set.
- Current ownership and approved baseline information.

## Trigger conditions

- A task DAG needs dependency validation.
- A new constraint or requirement revision changes ordering.

## Required inputs

- Task outputs/inputs and owned paths.
- Shared contracts, integration gates and concurrency limits.

## Expected outputs

- A dependency proposal with explicit gate nodes.
- A safe parallelization plan and identified conflicts.

## Procedure

1. Derive dependencies from actual consumed outputs, accepted contracts and shared paths rather than convenience or role names.
2. Keep sequential prerequisites and mandatory integration synchronization gates explicit. Parallel branches share the same approved baseline and retain their own isolated worktrees.
3. Submit the acyclic dependency proposal to Runtime. maxConcurrency and leases remain enforced by the engine; planner output cannot authorize early task dispatch.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Each dependency has a stated artifact, interface or approval reason.
- No parallel path writes another owner scope or begins before its integration prerequisite.

## Error handling

A cycle or unknown predecessor blocks the affected plan. Report the specific edges rather than deleting a dependency to force scheduling.

## Escalation rules

Cross-owner ordering conflicts or unclear accepted baseline need Runtime/integrator resolution.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
