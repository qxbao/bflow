---
name: use-rtk
description: "Use an approved RTK CLI capability to reduce routine output while retaining exact verification evidence."
---

## Supported roles

developer, tester, qa, reviewer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A pinned approved RTK inventory entry and authorized command runner.
- Known package scripts and output/evidence policy.

## Trigger conditions

- A supported routine command produces large repetitive output.
- Implementation needs concise tool feedback.

## Required inputs

- The original authorized command and working directory.
- Required evidence and RTK supported-operation inventory.

## Expected outputs

- Concise routine output linked to the original operation.
- Unfiltered failure/test evidence when verification needs it.

## Procedure

1. Inspect the approved RTK capability and supported wrapping behavior. CLI-only RTK is not an MCP service; no invented tools/list or Bflow rtk subcommand is valid.
2. Use RTK only for an operation already authorized by the task/runner. Preserve underlying command, arguments, cwd and actual exit status; compression must not change semantics.
3. Capture raw or independently preserved evidence where filtering could omit a failure, skip, assertion or security diagnostic. Submit exact commands and counts for gate evaluation.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Underlying exit code survives output reduction.
- No omitted failure, skip or assertion is presented as a clean pass.

## Error handling

Unsupported wrapping or evidence loss means stop using the wrapper for that check and report the limitation. Do not install or update RTK as a side effect of skill loading.

## Escalation rules

Missing required RTK inventory/readiness is a blocked prerequisite routed through Runtime; installation requires explicit setup authority.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

