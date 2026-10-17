---
name: implement-task
description: "Use for an authorized Developer task to make scoped changes against accepted criteria and submit objective evidence."
---

## Supported roles

developer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Accepted specification and assigned task revision.
- Current lease/fencing, owned worktree and resolved TestStrategy.

## Trigger conditions

- Runtime dispatches an authorized implementation task.
- An authorized bounded rework assignment arrives.

## Required inputs

- Assignment and accepted criterion references.
- Owned paths, baseline, TddDecision and existing evidence.

## Expected outputs

- Scoped source changes and a precise change summary.
- Artifact proposals containing verification and patch evidence.

## Procedure

1. Confirm task identity, current lease/fence, worktree baseline and permitted paths before changes. Read implementation and tests at the actual ingress boundaries.
2. Follow conditional-tdd according to the supplied decision. Reuse implemented modules and exported schemas; report contract gaps instead of weakening public contracts.
3. Implement the smallest complete behavior satisfying the accepted criteria. Run required checks, inspect the final diff and report evidence through Runtime without declaring the workflow accepted.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Changed files remain in the assigned scope.
- Required checks pass for the exact resulting revision; failures and skips remain explicit.

## Error handling

On ownership conflict or a required public-contract change, stop the dependent edit and preserve current work. Never reset unrelated changes to obtain a clean test result.

## Escalation rules

Blocked prerequisites, scope expansion or exhausted rework go to Runtime for Conversation routing; Developer cannot approve its own result.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

