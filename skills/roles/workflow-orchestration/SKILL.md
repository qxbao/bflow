---
name: workflow-orchestration
description: "Use to advance an authorized SDLC workflow exclusively through existing Runtime arbitration and independent gates."
---

## Supported roles

coordinator.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Authenticated Coordinator assignment.
- Accepted specification and Runtime-owned workflow state.

## Trigger conditions

- A delegation needs technical execution.
- Task completion or verification permits a policy-governed next phase.

## Required inputs

- Current DAG and aggregate state.
- Concurrency, lease/fence, retry/rework limits and approvals.

## Expected outputs

- Authorized Runtime operation requests.
- A truthful progress or waiting/escalation observation.

## Procedure

1. Read current workflow state and compute the next permitted operation from dependencies and required gates.
2. Request execution through Runtime only. Runtime validates transitions, maxConcurrency, current lease/fence, persisted intent and transport receipts before dispatch.
3. Sequence independent verification, review and human approval without treating provider done or a stored artifact as success. Escalate exhausted bounded loops rather than starting another hidden run.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every transition has Runtime acceptance and preserved event ordering.
- No pending dependency, approval or verification gate is bypassed.

## Error handling

Conflicts or unknown delivery require reconciliation of authoritative state. Never launch a direct provider process or write workflow success state yourself.

## Escalation rules

Unresolvable policy, resource or approval blockers route through Runtime to Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

