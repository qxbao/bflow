---
name: escalation-resolution
description: "Use to resolve a Runtime escalation within existing authority or prepare a precise human decision through Conversation."
---

## Supported roles

coordinator.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A correlated escalation from Runtime.
- Current task state, policy and remaining bounded options.

## Trigger conditions

- A specialist is blocked.
- Verification or recovery exhausts its allowed automated path.

## Required inputs

- Blocker evidence and requested decision.
- Applicable authority, criteria, revision/generation and previous attempts.

## Expected outputs

- An authorized resolution proposal or human decision request.
- A durable waiting/resume condition.

## Procedure

1. Check the cause, policy boundary and existing authority. Separate a technical action already authorized from an approval that only the human can supply.
2. Resolve only actions within current policy through Runtime. For a human choice, prepare concrete options, consequences and exact scope for Runtime → Herdr → Conversation.
3. Retain waiting state and resume only after a validated decision or verified prerequisite. Do not reset counters, spawn a new hidden workflow or relax criteria to avoid escalation.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- The proposed resolution respects maxIterations and existing approvals.
- A returned decision matches the pending request and current target.

## Error handling

If information is insufficient, preserve the blocker and request the smallest missing fact; avoid speculative repair side effects.

## Escalation rules

Human authority, policy exceptions and unresolved cross-owner decisions always go through Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

