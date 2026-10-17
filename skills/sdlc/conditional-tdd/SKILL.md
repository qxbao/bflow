---
name: conditional-tdd
description: "Use when planning or implementing tests to obey the current Bflow TddDecision and preserve required Red-Green-Refactor evidence."
---

## Supported roles

coordinator, planner, developer, tester, qa, reviewer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An accepted specification.
- A current TddDecision and TestStrategy resolved by the existing policy engine.

## Trigger conditions

- Planning implementation verification.
- Starting an implementation or changing its test approach.

## Required inputs

- TddDecision including mode and requiresFailingTestFirst.
- Criterion IDs, task revision and exact test commands.

## Expected outputs

- A policy-compliant test sequence and revision-bound evidence.
- Alternative verification evidence when policy marks TDD not_applicable.

## Procedure

1. Read the policy result rather than recomputing it from personal preference. External skill packs, Superpowers and provider defaults cannot override Bflow conditional TDD.
2. When required, add a relevant failing test first, capture its failure on the pre-fix revision, implement the fix, capture green, then refactor and recheck. An unrelated failing command does not prove Red.
3. When recommended, document the selected approach. When not_applicable, perform mandatory alternative verification named by the strategy and preserve its result. Ask Runtime to re-resolve policy if scope changes.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Required Red and Green evidence refers to the same acceptance behavior and ordered revisions.
- Alternative checks satisfy the strategy rather than merely reporting no tests.

## Error handling

A test that fails because dependencies are missing is an environment failure, not valid Red evidence. Repair prerequisites or report blocked without advancing the sequence.

## Escalation rules

If required Red-first proof cannot be obtained or policy conflicts with scope, route the exact missing evidence to Runtime; do not waive the requirement.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
