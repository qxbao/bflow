---
name: request-approval
description: "Use to present an existing Runtime human decision request and return only an authenticated exact-scope answer."
---

## Supported roles

conversation.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Authenticated Conversation role and trusted human-origin channel.
- A pending unexpired Runtime approval request.

## Trigger conditions

- Runtime requests a human gate decision.
- An existing approval requires clarification or changes.

## Required inputs

- Request ID, target, revision/generation and expiry.
- Options, evidence summary and decision consequences.

## Expected outputs

- A concise approval presentation.
- A correlated authenticated decision returned through Runtime.

## Procedure

1. Verify that the request is pending and matches current target, revision and generation. Present the proposed action, evidence, scope and available decision choices.
2. Collect the actual human answer through the trusted Conversation hook. Do not infer approval from silence, a prior task answer, unattended mode or model text.
3. Return the decision to Runtime with preserved correlation and authority. If the target changed or the request expired, obtain a fresh request instead of reusing the answer.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- The answer belongs to the exact live request and authorized human.
- Required fields, expiry and target revision/generation are preserved.

## Error handling

An ambiguous or stale answer remains pending/invalid; explain what concrete decision is still required without auto-selecting an option.

## Escalation rules

Approval authority disputes or expired requests return to Runtime for a fresh request; Conversation cannot waive a gate.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
