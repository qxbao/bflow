---
name: browser-inspection
description: "Use an approved browser capability to inspect an assigned UI with exclusive resource safety and reproducible evidence."
---

## Supported roles

tester, qa, reviewer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An approved scoped browser tool and permitted target origin.
- A current Gateway resource lease/fence when the browser resource is exclusive.

## Trigger conditions

- An acceptance criterion requires browser observation.
- An assigned UI failure needs reproduction.

## Required inputs

- Target environment, origin and test account policy.
- Criterion, candidate revision and bounded inspection steps.

## Expected outputs

- Reproducible UI observations and artifact proposals.
- Explicit passed, failed, inconclusive or blocked evidence.

## Procedure

1. Discover the authorized operations and verify the browser profile/context belongs to this repository. Acquire and retain the exclusive lease for the whole navigation/action/screenshot transaction.
2. Execute only criterion-relevant actions within allowed origin and data constraints. Recheck current lease/fence before effects; do not share cookies, tabs or credentials with another repository.
3. Capture sanitized observations/screenshots as artifact proposals with revision, environment and steps. Release the exact lease after reconciliation; an expired lease does not prove a late browser command stopped.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Evidence names the tested revision, target environment and reproducible actions.
- The resource lease and scope are valid for every mutating operation.

## Error handling

A busy browser is blocked, not permission to steal a lease. Timeout after a possible click/write is uncertain and must be reconciled before retry or reassignment.

## Escalation rules

Login, browser permissions, new origin access or ambiguous mutation routes through Runtime to Conversation; specialists never answer native dialogs.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

