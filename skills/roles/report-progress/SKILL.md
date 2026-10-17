---
name: report-progress
description: "Use to give the user concise progress grounded in current Runtime observations and pending decisions."
---

## Supported roles

conversation.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Authenticated Conversation role.
- Current run or delegation correlation.

## Trigger conditions

- User asks for status.
- Runtime reports a meaningful milestone or blocker.

## Required inputs

- Observed task/run state and evidence level.
- Pending approval or clarification requests.

## Expected outputs

- A clear user-facing progress update.
- An accurate pending action and next observable milestone.

## Procedure

1. Read the current Runtime progress and distinguish transport, SDLC phase, conversation state and approval state.
2. Report what changed, what remains uncertain and the next check or required decision. Keep implementation detail relevant to the user outcome.
3. Preserve pending request identity and do not promise completion from a healthy pane, a local check or a provider done signal.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every stated milestone is supported by current Runtime evidence.
- No pending decision is silently answered or omitted.

## Error handling

If status cannot be refreshed, label the last observation and its uncertainty rather than presenting stale state as current.

## Escalation rules

Present a pending Runtime escalation to the human through Conversation; no independent specialist dispatch is permitted.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

