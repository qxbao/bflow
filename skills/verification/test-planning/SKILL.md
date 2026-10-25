---
name: test-planning
description: "Use when planning independent criterion-driven and risk-based checks, boundary test data or coverage matrices for an assigned verification cycle."
---

## Supported roles

tester, qa.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Accepted specification and resolved `TestStrategy` / `TddDecision`.
- Independent tester/QA assignment and candidate environment.

## Trigger conditions

- Verification needs a criterion-driven check plan.
- A changed criterion, candidate diff or risk surface invalidates prior coverage.

## Required inputs

- Criterion IDs, candidate revision, affected paths and `TddDecision` (`required`, `recommended`, `not_applicable`).
- Allowed tools/data, environments and verification budget.

## Expected outputs

- A traceability matrix linking `criterion → risk & viewpoint (or N/A reason) → check/test identity & method → environment/prerequisite → expected evidence`.
- Explicit separation of what `unit_test` proves, what requires `integration_test` / `e2e_test` / `manual_review`, and any declared prerequisite gaps.

## Procedure

1. Obey the approved `Specification`, `TestStrategy` and `TddDecision`. Do not impose TDD on every change (`recommended` and `not_applicable` follow their resolved verification path), do not add mandatory tests outside policy, and do not modify acceptance criteria.
2. Map each criterion through `criterion → risk → check/test identity → environment/prerequisite → expected evidence`. Load [the conditional risk viewpoints reference](references/risk-viewpoints.md) on demand and apply only viewpoints triggered by the criterion and changed surfaces; record `N/A — <reason>` for inapplicable viewpoints instead of inflating every task with a full checklist.
3. State what `unit_test` proves (isolated logic, parser rules, state transitions) versus what remains unproven without `integration_test` or `e2e_test` (real entrypoint wiring, cross-component contracts, durable storage, built `dist/` execution). Never require browser or live provider checks unless a criterion needs them and the role holds the grant/lease; if a criterion requires unavailable browser/live access, report a `blocked` prerequisite gap instead of substituting static HTML parsing or a fake runner.
4. For an affected NFR, carry the accepted oracle, target source, workload, data scale, concurrency, environment, window and aggregation from the specification into the existing criterion-to-check matrix. Reuse the conditional risk viewpoints reference above; do not duplicate its test selection method or change TddDecision. Report proposed/unknown targets, missing tools and missing evidence separately. A script or numeric target is not a result; an executed measurement still requires independent checking against the accepted criterion.
5. Submit the plan for the existing verification cycle with bounded scope and independence. Missing mandatory evidence blocks the affected criterion instead of being replaced with a fake runner.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every accepted criterion maps to falsifiable checks or an explicit prerequisite gap; placing an `AC-*` tag in a test name or comment alone never proves coverage.
- Each planned check binds to the exact candidate revision, configured method command, environment prerequisites and evidence level.

## Error handling

If required test access, browser lease or live provider environment is missing, report the exact prerequisite gap (`blocked` or `inconclusive`) and continue independent permitted planning. Do not invent an unsupported test command or fake runner.

## Escalation rules

New environments, data permissions, policy re-resolution or unavailable required live proof route through Runtime/Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

Load [the conditional risk viewpoints reference](references/risk-viewpoints.md) for viewpoint selection rules and [the worked example](worked-example.md) for analyzed scenarios, authorized steps, expected evidence and a failure branch. The examples are illustrative; they do not create approval or a live run.
