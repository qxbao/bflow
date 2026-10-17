---
name: specification-driven-development
description: "Use for feature specification and requirement changes to produce risk-proportional criteria and traceability before implementation."
---

## Supported roles

specifier, architect, coordinator, planner.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A clarified requirement and repository evidence.
- Access to existing specification/version approval flow.

## Trigger conditions

- A feature requires implementation.
- Accepted requirements or design constraints change.

## Required inputs

- Requirement revision and risk context.
- Existing specification and criterion identifiers when present.

## Expected outputs

- A lightweight or full specification proposal.
- Explicit acceptance criteria, task traceability and required approval requests.

## Procedure

1. Classify change complexity and risk using existing policy. Lightweight means concise evidence, not permission to omit an accepted specification.
2. Describe behavior, non-goals, constraints and objective criteria; add design detail proportional to risk. Trace each planned task to criterion identifiers.
3. Submit the proposal through the existing specification/versioning flow. Implementation waits for the required accepted revision and design approvals; impact-analysis changes invalidate stale plans and evidence.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Each criterion names an observable behavior and expected evidence.
- Verify the required accepted specification revision exists before implementation dispatch.

## Error handling

If specification persistence or approval evidence is missing, retain a proposal and blocked reason. Do not self-approve or treat a document file as accepted state.

## Escalation rules

Unresolved design risk or requirement conflict requires a Runtime decision request through Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

