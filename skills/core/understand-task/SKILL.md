---
name: understand-task
description: "Use at intake or when requirements change to clarify intent, constraints and observable acceptance before delegation."
---

## Supported roles

conversation, coordinator, specifier, planner, architect.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- The original user request or an authenticated delegated request.
- Current conversation/run correlation.

## Trigger conditions

- New user intent.
- Ambiguous acceptance criteria or requirement change.

## Required inputs

- Requested outcome and available context.
- Known constraints and unresolved assumptions.

## Expected outputs

- A bounded task understanding with explicit unknowns.
- A clarification request or delegation proposal preserving correlation.

## Procedure

1. Restate the user outcome in concrete observable behavior. Separate an action request from an audit-only request and preserve explicit constraints.
2. Identify missing information that affects correctness, authority, scope or acceptance. Continue independent read-only analysis without manufacturing the answer.
3. Conversation handles clarification and creates the delegation request; other roles submit missing questions through Runtime and keep the task waiting until authenticated answers arrive.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Each proposed criterion can be observed or checked.
- User answers are associated with the exact pending request and current requirement revision.

## Error handling

If received context conflicts with accepted requirements, record the conflict and request a versioned change instead of silently changing scope.

## Escalation rules

Escalate unresolved scope, approval authority or material ambiguity through Runtime; a specialist never opens native user elicitation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

