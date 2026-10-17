---
name: agent-delegation
description: "Use to propose specialist assignments through Runtime while preserving role boundaries, task leases and correlation."
---

## Supported roles

coordinator.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Coordinator authority and an accepted task DAG.
- Available Registry capability observations.

## Trigger conditions

- A ready task needs a specialist.
- An authorized rework assignment requires a role.

## Required inputs

- Task/criterion scope and required role capabilities.
- Inputs, timeouts, idempotency policy and current generation.

## Expected outputs

- A validated assignment proposal.
- A Runtime-confirmed dispatch/binding observation or blocked reason.

## Procedure

1. Choose the specialist role from task needs and existing capability inventory. Registry resolution is not a capacity reservation or dispatch authority.
2. Submit an assignment with exact scope and trusted input references through Runtime. Runtime obtains/checks current lease/fence and persists dispatch intent before Herdr transport.
3. Preserve request, attempt, correlation and idempotency identities. Record accepted/bound versus rejected versus unknown_delivery without rewriting a returned submission handle.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Assignment role and task scope match the accepted plan.
- Execution binding/receipt is persisted before use as recoverable state.

## Error handling

If delivery is uncertain, wait for reconciliation and forbid automatic resend. A timeout does not prove the specialist stopped.

## Escalation rules

Missing capacity/capability, lease conflicts and uncertain bindings go to Runtime/Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

