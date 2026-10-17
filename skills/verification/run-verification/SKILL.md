---
name: run-verification
description: "Use to gather task or workflow verification evidence against accepted criteria at an exact revision without bypassing independent gates."
---

## Supported roles

coordinator, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Accepted criteria and a current TestStrategy.
- An exact candidate revision and authorized verification assignment.

## Trigger conditions

- Implementation candidate ready for checks.
- Post-integration workflow verification requested.

## Required inputs

- Task/run and verification cycle identifiers.
- Criterion IDs, revision, allowed checks and iteration budget.

## Expected outputs

- A criterion-to-evidence verification report.
- Passed, failed, inconclusive or blocked findings for Runtime evaluation.

## Procedure

1. Choose task-level or post-integration workflow scope from the assignment. Read package scripts and build before subprocess/worker tests that import dist.
2. Run the authorized deterministic checks and preserve exact commands, exit codes, pass/fail/skip counts and tested revision. Developer checks do not replace independent Reviewer and QA.
3. Compare observed behavior with each accepted criterion, report unsupported/live evidence separately, and submit artifact proposals. Runtime owns cycle limits, gate evaluation and conclusive transitions.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every pass has objective criterion-linked evidence at the candidate revision.
- Changed revision invalidates prior pass unless the existing verifier establishes applicability.

## Error handling

Missing tools or unavailable browser/provider access produce blocked or inconclusive evidence, never a passing substitute. A transport done event cannot establish acceptance.

## Escalation rules

Return failed criteria and bounded repair recommendations to Runtime; exhausted maxIterations, default three where configured, escalates through Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

