---
name: security-review
description: "Use for independent security assessment of an exact candidate with concrete threat and authority evidence."
---

## Supported roles

security, reviewer.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- An independent authorized security/review assignment.
- Candidate revision and relevant trust/permission profiles.

## Trigger conditions

- A change touches files, tools, providers, secrets or approval.
- A mandatory security finding needs re-verification.

## Required inputs

- Diff, criterion/specification and candidate revision.
- Trust boundaries, allowed scope and safe test fixtures.

## Expected outputs

- Prioritized security findings with reproducible scenarios.
- Explicit verified protections and unverified assumptions.

## Procedure

1. Trace untrusted inputs through schemas, filesystem/resource containment, role authorization and side effects. Inspect secret handling and authenticated receipt boundaries.
2. Use bounded non-secret fixtures to test cross-role/repository misuse, traversal, stale proof and permission denial. Do not expand access or extract real credentials for a demonstration.
3. Report impact, trigger and affected boundary, distinguishing static reasoning, local tests and live evidence. Claims about hostile same-UID or OS isolation need separate proof.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Every asserted protection is enforced at the actual side-effect boundary.
- Findings identify concrete input, authority or replay conditions.

## Error handling

Unavailable isolation or inaccessible security fixtures produce blocked/unverified evidence. Do not downgrade a mandatory finding to obtain a pass.

## Escalation rules

Critical findings and new privilege requirements route through Runtime; security role does not itself grant broader rights.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.

