---
name: design-review
description: "Use to review a design proposal for criterion coverage, compatibility and enforceable security/recovery properties."
---

## Supported roles

architect, reviewer, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A versioned design proposal.
- Accepted requirements and current component contracts.

## Trigger conditions

- A design requires independent assessment.
- A revised architecture proposal changes risk or compatibility.

## Required inputs

- Design/specification revisions and criterion IDs.
- Alternatives, migration plan and approval requirements.

## Expected outputs

- Specific design findings and unresolved assumptions.
- A review recommendation for the existing approval flow.

## Procedure

1. Evaluate how the design satisfies each criterion and preserves ownership boundaries, contract ingress validation and existing host role prompts.
2. Inspect failure, restart, authorization and migration cases. Distinguish schema-valid data from authenticated proof and local tests from live evidence.
3. Submit findings with concrete failing scenarios and required evidence. Review recommendation is not human approval and cannot authorize implementation outside the accepted specification.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- The review covers normal, failure and recovery paths at the proposed boundary.
- Required compatibility/migration and human decisions are explicit.

## Error handling

An incomplete design yields concrete missing evidence, not an assumed pass. Do not modify shared architecture docs under review-only authority.

## Escalation rules

Unresolved high-risk design choices and public contract amendments require Runtime/owner approval via Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
