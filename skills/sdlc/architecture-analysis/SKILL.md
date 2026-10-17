---
name: architecture-analysis
description: "Use to analyze an accepted requirement against existing component boundaries and propose a compatible design."
---

## Supported roles

architect.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Accepted requirement/specification context.
- Read access to current architecture and implemented source.

## Trigger conditions

- A cross-component change needs design.
- A compatibility or recovery risk needs architecture review.

## Required inputs

- Criterion IDs and approved baseline.
- Existing public interfaces, constraints and risk observations.

## Expected outputs

- A source-grounded architecture proposal.
- Compatibility impacts, alternatives and required owner decisions.

## Procedure

1. Map the relevant existing components and actual exported interfaces. Preserve established Core/Runtime/Herdr/ArtifactStore responsibilities.
2. Trace state, data ingress validation, persistence and recovery ordering. Use approved graph tooling where available, verifying results against source.
3. Propose the smallest compatible design, documenting invariants and migration needs. A public contract change needs the explicit owner integration decision, affected agents and compatibility plan before implementation.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Design claims match current exports and source.
- Failure/restart paths preserve identity, ordering, approval and artifact trust.

## Error handling

If source contradicts design documents, record the mismatch rather than rebuilding implemented modules from an old bootstrap.

## Escalation rules

Public contract changes, cross-owner wiring and unresolved design approvals route through Runtime to the proper owner.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

