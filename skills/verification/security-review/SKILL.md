---
name: security-review
description: "Use when performing an independent security assessment of a candidate diff and its security/boundary tests with concrete threat and authority evidence."
---

## Supported roles

security, reviewer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An independent authorized security/review assignment.
- Accepted specification, resolved `TestStrategy` / `TddDecision`, candidate revision and relevant trust/permission profiles.

## Trigger conditions

- A change touches files, tools, providers, leases, secrets, authentication/authorization or approval gates.
- A mandatory security finding or security criterion needs independent verification.

## Required inputs

- Diff, criterion/specification, `TestStrategy` / `TddDecision` and candidate revision.
- Trust boundaries, allowed scope and safe non-secret test fixtures.

## Expected outputs

- Prioritized security findings with reproducible scenarios and test-gap analysis.
- Explicit verified protections, unit-vs-entrypoint coverage boundaries and unverified assumptions.

## Procedure

1. Trace untrusted inputs through ingress schemas, filesystem/resource containment, role/owner authorization and side effects. Load [the security test viewpoints reference](references/security-test-viewpoints.md) on demand to verify that security checks trace `criterion → risk → check/test identity → environment/prerequisite → expected evidence` rather than relying on `AC-*` labels in test names or happy-path admin tests.
2. Evaluate only the conditional security viewpoints applicable to the diff: role vs owner/tenant/repository/session isolation, boundary/empty/Unicode/traversal canonicalization, replay/double-submit/stale fencing token rejection, partial failure/timeout containment, and real side-effect entrypoint wiring. Use bounded non-secret fixtures; never expand access or extract real credentials.
3. Preserve the approved `TestStrategy` and `TddDecision`. State clearly what isolated unit tests prove versus what requires integration/entrypoint verification, and report impact, trigger and affected boundary by distinguishing static reasoning, local tests and live evidence. Claims about hostile same-UID or OS isolation need separate proof.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every asserted protection is enforced and tested at the actual side-effect entrypoint, not only in an unreferenced helper.
- Findings and passing checks identify concrete boundary, ownership, Unicode/traversal or replay conditions and verify that denied requests leave target state unchanged.

## Error handling

Unavailable isolation, missing tool grants or inaccessible security fixtures produce `blocked`/unverified evidence. Do not downgrade a mandatory finding or accept a mock/unit-only substitute when entrypoint or sandbox proof is required.

## Escalation rules

Critical findings, policy re-resolution and new privilege requirements route through Runtime; security role does not itself grant broader rights.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

Load [the security test viewpoints reference](references/security-test-viewpoints.md) for conditional security test criteria and [the worked example](worked-example.md) for analyzed scenarios, authorized steps, expected evidence and a failure branch. The examples are illustrative; they do not create approval or a live run.
