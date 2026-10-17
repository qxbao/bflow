---
name: report-task-result
description: "Use at the end of an assigned attempt to submit correlated outcome evidence without claiming independent acceptance."
---

## Supported roles

coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Current Runtime assignment and execution correlation.
- Recorded verification outcomes and artifact proposals.

## Trigger conditions

- An implementation or analysis attempt finishes.
- An attempt is blocked, cancelled or cannot establish a conclusive result.

## Required inputs

- Run/task/request/attempt/execution identifiers.
- Exact revision, changed paths, checks and known limitations.

## Expected outputs

- A correlated result proposal for host validation.
- Artifact proposals and an honest outcome/verification distinction.

## Procedure

1. Summarize the result against accepted criteria, including exact revision, changed scope and remaining gaps. Distinguish source implementation, local checks, live probes and full SDLC acceptance.
2. Attach proposals for patch, test results and relevant sanitized logs. Only ArtifactStore ingestion can turn proposals into trusted artifact references; never invent artifact URIs or checksums as authority.
3. Submit through the authorized Runtime result channel with current correlation. Let the host authenticate and validate the exported AgentResult; a model-written success sentence or Herdr done is insufficient.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Identity and evidence refer to the same task attempt and candidate revision.
- Pass/fail/skip counts, exit codes and limitations are explicit.

## Error handling

If result delivery is uncertain, preserve request/idempotency identity and reconcile. Do not submit a new attempt merely because no acknowledgment arrived.

## Escalation rules

Unverified correlation, missing artifacts or disputed outcomes require Runtime review and Conversation routing where a human decision is needed.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
