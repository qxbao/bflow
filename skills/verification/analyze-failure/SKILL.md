---
name: analyze-failure
description: "Use after a failed or inconclusive check to isolate a reproducible cause and propose bounded rework."
---

## Supported roles

developer, tester, reviewer, qa, security, coordinator.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- The failed command or verification result.
- Read access to relevant sanitized logs and exact tested revision.

## Trigger conditions

- A deterministic check fails.
- A flaky, blocked or inconclusive verification outcome needs diagnosis.

## Required inputs

- Failure output, criterion and cycle identifiers.
- Environment, command, exit code and revision.

## Expected outputs

- A supported root-cause hypothesis with reproduction.
- A scoped repair proposal or an explicit evidence gap.

## Procedure

1. Reproduce the smallest relevant failure under the same revision and inputs. Separate product behavior, infrastructure failure, unavailable prerequisites and stale evidence.
2. Trace the failing boundary and compare expected versus observed behavior. Prefer one hypothesis and one discriminating check at a time; avoid speculative broad edits.
3. Submit the diagnosis and requested repair to Runtime with evidence and remaining cycle budget. Do not start a parallel unbounded repair loop or weaken the acceptance criterion.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- The proposed cause explains the observed failure.
- A repair recommendation names the exact criterion and a check that can falsify the hypothesis.

## Error handling

If reproduction fails, report variability and environment differences. Do not rerun until green and discard failed evidence.

## Escalation rules

Escalate an unresolved failure, uncertain remote mutation or exhausted iteration budget through Runtime.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
