---
name: test-planning
description: "Use to plan independent criterion-driven checks and test data for an assigned verification cycle."
---

## Supported roles

tester, qa.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Accepted specification and TestStrategy.
- Independent tester/QA assignment and candidate environment.

## Trigger conditions

- Verification needs a check plan.
- A changed criterion or candidate invalidates prior coverage.

## Required inputs

- Criterion IDs, candidate revision and TddDecision.
- Allowed tools/data, environments and verification budget.

## Expected outputs

- A criterion-to-check/evidence matrix.
- Required fixtures, environment prerequisites and explicit gaps.

## Procedure

1. Select checks that directly observe each criterion, including relevant failure/recovery cases. Follow the resolved strategy; tester advice cannot override conditional TDD.
2. Separate deterministic checks, reviewer analysis, browser evidence and live provider probes. Identify exact commands/authorized tool operations, data and resource leases required.
3. For an affected NFR, carry the accepted oracle, target source, workload, data scale, concurrency, environment, window and aggregation from the specification into the existing criterion-to-check matrix. Reuse the test-design reference selected by the manifest when available; do not duplicate its test selection method or change TddDecision. Report proposed/unknown targets, missing tools and missing evidence separately. A script or numeric target is not a result; an executed measurement still requires independent checking against the accepted criterion.
4. Submit the plan for the existing verification cycle with bounded scope and independence. Missing mandatory evidence blocks the affected criterion instead of being replaced with a fake runner.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every accepted criterion has a meaningful check or declared prerequisite gap.
- The plan binds results to exact revision, environment and evidence level.

## Error handling

If required test access is missing, report the prerequisite and continue independent permitted planning. Do not invent an unsupported test command.

## Escalation rules

New environments, data permissions or unavailable required live proof route through Runtime/Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
