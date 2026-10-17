---
name: use-git-worktree
description: "Use when preparing an isolated task workspace to preserve the approved baseline and another agent work."
---

## Supported roles

developer, coordinator, planner.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Authorized Git/worktree capability through the existing host.
- An approved integration baseline and branch/worktree naming policy.

## Trigger conditions

- A Developer task needs isolation.
- A task worktree must be inspected or safely retired.

## Required inputs

- Repository identity and exact approved baseline.
- Task branch name, owned paths and worktree destination.

## Expected outputs

- A task-specific branch/worktree identity.
- Baseline and cleanup safety evidence.

## Procedure

1. Inspect HEAD, index, worktrees, refs, ancestry and equivalent patches before selecting the approved baseline. A phase label or hash comparison alone does not prove predecessors.
2. Request the existing Git orchestration capability through Runtime to create the scoped branch/worktree. Do not use an invented Bflow subcommand or direct shell creation to bypass managed ownership.
3. Confirm canonical path, branch and baseline before edits. Cleanup requires proven ownership and preservation of uncommitted work, artifacts and resumable state.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- The task worktree is separate from every other active agent worktree.
- The recorded baseline contains the required approved predecessor implementation.

## Error handling

A dirty or unexpected destination is a conflict. Preserve it and return the observed identities; never force-remove a worktree or switch someone else branch.

## Escalation rules

Unknown baseline, cleanup safety or cross-owner changes require a Runtime/integrator decision.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

