---
name: browser-inspection
description: "Use when an acceptance criterion requires authorized browser observation of a rendered UI with exclusive resource lease safety and risk-based evidence."
---

## Supported roles

tester, qa, reviewer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An acceptance criterion that genuinely requires rendered browser observation, plus an approved `TestStrategy` / `TddDecision`.
- An approved scoped `browser` tool grant, permitted target origin and a current Gateway resource lease/fence when the browser resource is exclusive.

## Trigger conditions

- An acceptance criterion requires browser DOM/visual/interaction observation that unit or API tests cannot establish.
- An assigned UI failure needs reproduction against the real served entrypoint.

## Required inputs

- Target environment, origin and test account policy.
- Criterion IDs, `TestStrategy` / `TddDecision`, candidate revision and bounded inspection steps.

## Expected outputs

- Reproducible UI observations and artifact proposals mapped via `criterion → UI risk → check/action identity → environment/lease prerequisite → expected evidence`.
- Explicit `passed`, `failed`, `inconclusive` or `blocked` evidence distinguishing rendered browser proof from unit/static checks.

## Procedure

1. Verify that the task and criterion actually require browser inspection and that the role holds the `browser` tool grant and exclusive resource lease/fence for the whole navigation/action/screenshot transaction. Never require browser inspection for non-UI tasks; if a UI criterion requires browser access that is not granted or reachable, report a `blocked` prerequisite gap instead of faking UI verification with static HTML parsing.
2. Load [the UI risk viewpoints reference](references/ui-risk-viewpoints.md) on demand and select only the viewpoints applicable to the changed UI controls and criteria (boundary/invalid/Unicode/empty inputs, double-submit protection, role/owner UI isolation, failure/timeout/empty state recovery, brownfield UI parity, and real served entrypoint/cross-screen wiring). Preserve the approved `TestStrategy` and `TddDecision`.
3. Interact through stable semantic locators (`data-testid`, ARIA role, label) and condition-based waits (`waitFor`, `toBeVisible`) without arbitrary sleeps or forced clicks (`force: true`) that hide layout overlap. Capture sanitized observations/screenshots as artifact proposals with revision, environment and steps, then release the exact lease after reconciliation.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Evidence traces `criterion → risk → check/action identity → environment/lease prerequisite → expected evidence` at the tested revision and real served origin.
- In-memory HTML parsing or isolated component unit tests are never relabeled as browser E2E evidence.
- The resource lease and scope are valid for every mutating operation.

## Error handling

A missing `browser` grant, unavailable origin or busy exclusive browser lease is `blocked`, never permission to steal a lease or substitute static HTML checks. Timeout after a possible click/write is uncertain and must be reconciled before retry or reassignment.

## Escalation rules

Login, browser permissions, new origin access or ambiguous mutation routes through Runtime to Conversation; specialists never answer native dialogs.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

Load [the UI risk viewpoints reference](references/ui-risk-viewpoints.md) for conditional browser checks and [the worked example](worked-example.md) for analyzed scenarios, authorized steps, expected evidence and a failure branch. The examples are illustrative; they do not create approval or a live run.
