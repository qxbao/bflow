---
name: mcp-tool-discovery
description: "Use when a tool is needed to discover only authorized Gateway capabilities and their actual input/output contracts."
---

## Supported roles

conversation, coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security.

Skills are instruction-only and model-neutral. They do not grant tools, permissions, install hooks, human approval or task acceptance. Preserve system/host policy, accepted project rules, original role prompts, specification gates, Conditional TDD, independent review/QA, leases/fencing and bounded loops.

## Prerequisites

- A current role/session registration and permission profile.
- An approved Gateway discovery surface.

## Trigger conditions

- An assignment requires an unfamiliar tool.
- A required tool is absent or its schema changed.

## Required inputs

- Requested engineering capability.
- Role, repository/session and allowed service requirements.

## Expected outputs

- A minimal set of authorized tool IDs and schemas.
- A blocked/unsupported diagnostic for missing required capability.

## Procedure

1. Read the current role manifest and approved service inventory. Distinguish CLI-only tools, external workers, remote MCP, bridged stdio and exclusive resources.
2. Discover the permitted operations through the registered Gateway and inspect negotiated schemas. A guessed hidden tool name remains forbidden; reachability alone does not establish protocol readiness.
3. Select only tools needed for the immediate task and validate input/output. Acquire required resource leases for exclusive effects and preserve call correlation; inter-role communication remains Runtime/Herdr.

## Bflow commands

Use `bflow help` to inspect the installed command surface. `bflow status run-42 --json` observes an existing run; `bflow doctor --json` diagnoses environment prerequisites. Substitute the assigned run ID. These commands are observations, not proof of workflow acceptance.

This baseline has no dedicated skill or verification command. Use the existing authorized Runtime/tool capability described above for workflow operations; if it is unavailable, report unsupported/blocked. Never infer a new CLI subcommand from the skill name.

## Verification requirements

- Required tool names and schemas were actually discovered for this role/session.
- No upstream credentials or another role registration are exposed.

## Error handling

Missing or denied tools produce a concrete diagnostic. Do not add an arbitrary URL, launch a second upstream worker or change global provider configuration.

## Escalation rules

New tool/service installation, credential binding, scope or elicitation requires Runtime/Conversation and explicit setup authority.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## Concrete examples

See [the worked example](worked-example.md) for inputs, authorized steps, expected evidence and a failure branch. The example is illustrative; it does not create approval or a live run.
