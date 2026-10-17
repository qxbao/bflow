---
name: review-code
description: "Use for independent review of a candidate diff against accepted criteria, ownership and recovery/security invariants."
---

## Supported roles

reviewer, security, architect.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An independent reviewer assignment.
- Accepted specification and exact candidate diff/revision.

## Trigger conditions

- Runtime requests code review.
- A revised candidate needs review findings rechecked.

## Required inputs

- Candidate revision and base.
- Criterion IDs, change summary and implementation evidence.

## Expected outputs

- Prioritized findings with source locations and impact.
- An evidence-backed review result for Runtime.

## Procedure

1. Read the complete affected behavior and tests, including ingress validation and persistence/transport ordering. Check actual changes rather than trusting a summary.
2. Evaluate correctness, compatibility, ownership, permissions and recovery behavior. Distinguish reproducible defects from optional preferences and state assumptions.
3. Submit specific findings with severity, trigger, consequence and suggested verification. Preserve independence: review does not directly accept a task or rewrite the developer branch.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Each blocking finding identifies a concrete failing use case.
- A resolved finding is checked against the exact revised candidate.

## Error handling

If the candidate or evidence is inaccessible, report blocked/inconclusive. Do not infer approval from a clean summary or transport status.

## Escalation rules

Route critical risk, scope disagreements or required contract decisions through Runtime; reviewers never request human approval directly.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
