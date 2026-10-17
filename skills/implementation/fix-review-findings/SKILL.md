---
name: fix-review-findings
description: "Use for Runtime-authorized review rework to repair specific findings and preserve traceable verification."
---

## Supported roles

developer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A bounded rework assignment from Runtime.
- Current candidate and authenticated review findings.

## Trigger conditions

- Review or QA requests scoped changes.
- A previously fixed finding needs an authorized correction.

## Required inputs

- Finding IDs and acceptance criteria.
- Task revision/generation, remaining iteration budget and owned paths.

## Expected outputs

- A finding-to-change resolution map.
- Updated patch and focused verification proposals.

## Procedure

1. Read each finding and reproduce its concrete failure on the assigned revision. Confirm the Runtime rework generation and task scope.
2. Repair the root cause while retaining accepted requirements and the existing TddDecision. If a finding requires a public contract change, request the owner decision before touching that boundary.
3. Run the discriminating checks plus affected required checks. Report each finding as addressed, disputed with evidence, or blocked; independent Reviewer/QA confirms resolution.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every addressed finding has a corresponding change and verification result.
- The final revision and rework generation accompany all evidence.

## Error handling

If a finding is stale or cannot be reproduced, preserve that evidence and ask Runtime to resolve applicability rather than silently marking it fixed.

## Escalation rules

Escalate incompatible findings, scope changes or exhausted iterations through Runtime; never self-clear a mandatory gate.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

