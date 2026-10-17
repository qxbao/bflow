---
name: recover-execution
description: "Use after interruption or uncertain delivery to reconcile durable execution state before resuming an attempt."
---

## Supported roles

coordinator, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- Recoverable Runtime state and current assignment.
- The original manifest, request and delivery receipts.

## Trigger conditions

- A session restarts mid-attempt.
- Submission or tool effect has uncertain delivery.

## Required inputs

- Persisted request/attempt/idempotency identity.
- Manifest digest, execution bindings, recovery cursors and cancellation intent.

## Expected outputs

- A reconciled execution observation or unresolved blocker.
- A safe resume proposal preserving original identity and pins.

## Procedure

1. Reload the exact persisted manifest and verify pinned bytes. Recover the Core aggregate checkpoint/event state, including approvals, cancellation, retries and command outcomes; a query projection alone is insufficient.
2. Reconcile delivery/handle and current lease/fence before any new effect. Preserve unknown_delivery until non-delivery is proven; a timeout or Herdr done does not prove the old agent stopped.
3. Ask Runtime to resume only the reconciled authorized attempt. Retain immutable skill generation and artifact evidence; missing/corrupt required content blocks recovery instead of silently updating to latest.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Resumption preserves idempotency, event ordering, binding and recovery cursor.
- Current cancellation, approvals, lease/fence and manifest integrity remain valid.

## Error handling

Corrupt receipts, missing aggregate state or uncertain side effects stay unresolved. Do not fabricate checkpoints, approvals or execution bindings.

## Escalation rules

Unreconcilable delivery, corrupt required content or missing historical proof requires Runtime/Conversation intervention.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

