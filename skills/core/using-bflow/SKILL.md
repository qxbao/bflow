---
name: using-bflow
description: "Use when starting authorized work in Bflow to discover current commands, workflow state and role boundaries."
---

## Supported roles

conversation, coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An authenticated Bflow role assignment and canonical repository identity.
- The original role prompt and accepted project instructions.

## Trigger conditions

- Starting a task or resuming an existing session.
- Uncertainty about the supported command surface.

## Required inputs

- Role and session identity.
- Task or run identifier when one exists.

## Expected outputs

- A concise record of the applicable role boundary and observed run state.
- A supported next operation or a precise blocked prerequisite.

## Procedure

1. Read the assigned role, task scope and current manifest references. Load only the skill needed for the next operation; retain the original role prompt.
2. Inspect existing command help and repository status before choosing an operation. Separate environment health, workflow state, human approval and transport completion.
3. Use the existing Runtime capability for authorized workflow mutations. A documented command remains subject to its own authority checks; discovering a command does not authorize running it.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Record the observed repository/run identity and command result.
- Check that the chosen action belongs to the assigned role and current permission profile.

## Error handling

If a command is absent or fails validation, retain the diagnostic and stop that action. Do not invent a replacement subcommand or use a direct provider process to bypass Runtime.

## Escalation rules

Route unavailable prerequisites, permissions and disputed ownership to Runtime. Conversation presents any required human decision.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

