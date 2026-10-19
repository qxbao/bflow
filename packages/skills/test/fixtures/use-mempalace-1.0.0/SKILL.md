---
name: use-mempalace
description: "Use approved MemPalace retrieval to recover engineering context without treating remembered text as current authority."
---

## Supported roles

coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A MemPalace MCP server (`mempalace`) registered by the operator and available to the role.
- A repository/session memory policy excluding secrets.

## Trigger conditions

- Prior design context may explain a current decision.
- An assignment explicitly requests a durable non-secret engineering note.

## Required inputs

- Repository identity and narrow query/topic.
- Current task scope and permitted memory operations.

## Expected outputs

- Relevant provenance-bearing context or an authorized memory proposal.
- A clear distinction between remembered context and verified current state.

## Procedure

1. Discover the authorized MemPalace tools and the wing that belongs to this repository before reading. Do not assume the server grants access to other wings or repositories, and do not mine, repair or modify the palace unless the assignment permits it.
2. Retrieve only relevant notes and check provenance, timestamp and repository. Validate any claimed specification, approval, contract or command against current authoritative records.
3. Write only when explicitly permitted, using concise non-secret engineering facts and revision context. Memory is not Runtime transport, an approval ledger or ArtifactStore.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Returned context belongs to the assigned repository and permitted audience.
- No secret, human approval proof or unverified current-state claim is copied into durable notes.

## Error handling

A missing service or denied operation is reported as unavailable. An uncertain memory write must be reconciled; do not replay it automatically.

## Escalation rules

Broader memory scope, new write authority or uncertain service state goes to Runtime/Conversation.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
