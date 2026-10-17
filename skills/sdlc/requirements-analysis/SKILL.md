---
name: requirements-analysis
description: "Use to turn clarified intent into measurable requirements and identify contradictions before specification approval."
---

## Supported roles

specifier.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A correlated requirement request.
- Repository context and domain constraints.

## Trigger conditions

- A requirement needs analysis.
- A requirement revision changes acceptance behavior.

## Required inputs

- User outcome and known constraints.
- Existing criterion/specification revisions and unresolved questions.

## Expected outputs

- A requirements analysis with observable behaviors.
- Contradictions, risks and focused clarification requests.

## Procedure

1. Extract actors, triggers, state changes and observable outcomes. Identify non-goals and constraints already accepted by the project.
2. Compare the request with existing behavior and accepted requirements. Make acceptance examples concrete, including failure and recovery cases proportionate to risk.
3. Propose criterion records and requirement-impact notes to the specification flow. Route missing user information through Runtime instead of asking directly.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Each requirement is testable and distinct from an implementation preference.
- Changes identify affected criteria and downstream tasks/evidence.

## Error handling

Conflicting requirements remain explicit. Do not resolve them by inventing a user preference or silently deleting an older criterion.

## Escalation rules

Unresolved user intent or authority requires Runtime/Conversation clarification before dependent implementation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

