---
name: escalate-blocker
description: "Use when authorized progress depends on missing authority, information, resources or exhausted bounded recovery."
---

## Supported roles

conversation, coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A known run/task or intake correlation.
- A concrete observed blocker rather than a hypothetical risk.

## Trigger conditions

- A required prerequisite is unavailable.
- A mandatory decision, policy conflict or iteration limit blocks progress.

## Required inputs

- Observed blocker, affected criterion and task state.
- Safe diagnostics, attempted bounded actions and required decision.

## Expected outputs

- A structured correlated blocker/escalation request.
- A durable waiting or blocked state with a specific resume condition.

## Procedure

1. Describe what is blocked, why it matters and the exact decision or prerequisite that would unblock it. Preserve evidence and exclude credentials or private terminal output.
2. Send the request through Runtime. For non-Conversation roles, Runtime routes via Herdr to Conversation; keep native direct questions/elicitation disabled.
3. Record the waiting condition and stop only dependent work while continuing independent authorized work. Resume dependent work only on an authenticated current decision or verified prerequisite, not elapsed time.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- The request retains correlation, target and applicable revision/generation.
- The proposed resume condition preserves permissions, gates and bounded loop policy.

## Error handling

If escalation transport is uncertain, retain its identity and reconcile instead of flooding duplicate requests or polling artifacts as a mailbox.

## Escalation rules

Conversation presents the existing request to the human; no role may manufacture the answer or treat unattended mode as approval.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

