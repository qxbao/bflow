---
name: integrate-changes
description: "Use for authorized integration planning and execution through Runtime in dependency order with post-integration verification."
---

## Supported roles

coordinator.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Explicit integration authority and current Runtime assignment.
- Reviewed candidate branches and known dependency order.

## Trigger conditions

- Reviewed task branches are ready for integration.
- A merge conflict requires controlled resolution.

## Required inputs

- Approved baseline and candidate pins.
- Dependency DAG, review evidence and required workflow verification.

## Expected outputs

- An integration result with branch/revision provenance.
- Post-integration verification request and preserved conflict evidence.

## Procedure

1. Inspect branch ancestry and patch equivalence to avoid duplicate application. Confirm candidates include original implementation and accepted fixes.
2. Request integration via the existing Runtime/Git capability in dependency order using a dedicated integration worktree. Handle conflicts within authorized scope; preserve unresolved evidence rather than force a merge.
3. Trigger workflow-level verification on the integrated revision. Local merge completion does not close remote delivery or waive Reviewer/QA, human approval or publication authority.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every merged candidate has explicit approval and dependency evidence.
- Required dependency/type/full-test checks and workflow verification apply to the final integrated revision.

## Error handling

On conflict, stop dependent integrations and retain the conflicted worktree and diagnostics. Never force-push, rewrite shared history or pretend a partial merge succeeded.

## Escalation rules

Cross-owner conflict decisions and publication authority go through Runtime to Conversation/integrator.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
