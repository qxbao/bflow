---
name: review-code
description: "Use when independently reviewing a candidate diff and its tests against accepted criteria, risk viewpoints, ownership and recovery/security invariants."
---

## Supported roles

reviewer, security, architect.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An independent reviewer assignment.
- Accepted specification, resolved `TestStrategy` / `TddDecision` and exact candidate diff/revision.

## Trigger conditions

- Runtime requests independent code and test review.
- A revised candidate needs prior review findings rechecked.

## Required inputs

- Candidate revision and base.
- Criterion IDs, `TestStrategy` / `TddDecision`, change summary and implementation/test evidence.

## Expected outputs

- Prioritized findings with source/test locations, concrete failure scenarios and impact.
- An evidence-backed review result for Runtime distinguishing proven coverage from unit-only or prerequisite gaps.

## Procedure

1. Read the complete affected behavior and candidate tests, including ingress validation and persistence/transport ordering. Load [the test and risk review reference](references/test-risk-review.md) on demand to verify that tests trace `criterion → risk → check/test identity → environment/prerequisite → expected evidence` instead of relying on `AC-*` tags in test names/comments or tautological assertions.
2. Evaluate only the conditional risk viewpoints triggered by the diff (EP/BVA, invalid/Unicode/empty data, role vs owner/tenant isolation, double-submit/idempotency/`unknown_delivery`, timeout/partial failure/recovery, brownfield field-by-field parity, real entrypoint/component wiring, and race/concurrency/lock/atomicity checks under the discriminating-evidence rule in §4 of the reference). Respect the approved `TestStrategy` and `TddDecision`: do not demand TDD when policy is `recommended` or `not_applicable`, do not invent mandatory tests or alter criteria, and state clearly what unit tests prove versus what remains unverified at integration/E2E level.
3. Submit specific findings with severity, trigger, consequence and suggested verification. If an accepted criterion requires browser or live provider evidence that is not granted or available, report a `blocked`/`inconclusive` prerequisite gap rather than demanding unauthorized tool execution or accepting static HTML/mock substitutes. Preserve independence: review does not directly accept a task or rewrite the developer branch.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Each blocking finding identifies a concrete failing use case, boundary defect or missing criterion-to-risk proof.
- Passing unit tests are never accepted as proof of real entrypoint wiring, cross-owner isolation or browser/live behavior when the criterion requires those levels.
- A resolved finding is checked against the exact revised candidate.

## Error handling

If the candidate or required evidence is inaccessible, report `blocked`/`inconclusive`. Do not infer approval from a clean summary, green happy-path unit tests or transport `done` status.

## Escalation rules

Route critical risk, scope disagreements, policy re-resolution or required contract decisions through Runtime; reviewers never request human approval directly.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

Load [the test and risk review reference](references/test-risk-review.md) for conditional review criteria and [the worked example](worked-example.md) for analyzed review scenarios, expected evidence and a failure branch. The examples are illustrative; they do not create approval or a live run.
