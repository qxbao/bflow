---
name: inspect-repository
description: "Use before planning, implementation or review to establish repository structure, ownership, baseline and local verification commands."
---

## Supported roles

coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Read access to the assigned repository.
- An explicit assigned scope or analysis request.

## Trigger conditions

- A new repository or unfamiliar module.
- A changed baseline or ownership boundary.

## Required inputs

- Canonical repository path and current revision.
- Assigned paths and requested behavior.

## Expected outputs

- A repository map with relevant source and test locations.
- Verified baseline, ownership constraints and applicable checks.

## Procedure

1. Inspect HEAD, working tree/index, worktrees, refs, ancestry and patch equivalence. Preserve existing uncommitted work; do not switch another agent worktree.
2. Read applicable AGENTS.md files, package manifests and package README instructions. Search narrowly with rg and inspect actual source before drawing architecture conclusions.
3. Identify source ingress validation, existing tests and integration seams. Report shared-file changes to their owner; do not make a local implementation easier by changing contracts.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every architecture claim cites an observed source location or is labeled an assumption.
- Record the exact package scripts rather than guessing build or test commands.

## Error handling

An inaccessible directory or unresolved baseline is a blocked observation. Do not create a replacement repository or discard another agent changes.

## Escalation rules

If the approved baseline or ownership is ambiguous, send the concrete refs, paths and proposed scope to Runtime for the owning decision.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
