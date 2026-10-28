# Provider failover integration decision

Status: owner approved the scope and direction in the implementation conversation; implementation and acceptance remain incomplete. This document does not authorize a provider switch on its own.

## Motivation and boundary

An accepted task may need to continue after a provider failure. The role configuration currently selects one provider, model and profile; `fallbackCli` handles a missing executable at startup and is not authority to transfer an active task. An approved ordered chain and a sanitized, execution-bound failure observation must cross the CLI, provider adapter and Runtime boundaries. These are additive contracts; absence of a chain means no automatic failover.

Affected owners: Contracts (schemas and compatibility), Agent Providers (provider-specific observations and provenance), CLI (configuration and approval projection), Runtime (decision, durable journal, reconciliation, audit and Conversation notice), and Pane Manager (bound process lifecycle). Each ingress must validate the exported schema. An assertion that data is structured does not establish its provenance; the receiving host must authenticate the source and bind it to the actual execution.

## Compatibility and migration

Existing configuration and launch behavior remain valid when no approved chain is present. Existing `fallbackCli` is not promoted to an active-task failover policy. New policy versions bind exact provider, model and profile; no implicit account or provider is added. Versioned failover records must be recovered without inventing history for old journals. Existing specification, task, approval, verification, lease and transport contracts remain authoritative. Changes to execution preview and approval binding must include the approved policy in drift detection before the feature can be enabled.

## Required implementation and evidence

Before dispatch, persist intent and switch budget, reconcile delivery and mutations, prove the old execution has stopped, and revalidate cancellation, lease, fencing, role policy, permissions, tools, readiness and independence. Reuse the host-validated task handover; do not accept pane text as provider failure evidence. Every interrupted step must recover without duplicate launch or resend. A failed or exhausted chain must yield an actionable Conversation blocker. Audit must omit credentials and raw provider output; unknown usage remains unknown.

The current worktree contains only an isolated decision evaluator and schemas. It has no trusted production observation source, host lifecycle wiring, configuration ingress, persistent failover recovery or controlled-host acceptance. These pieces must be implemented and verified before advertising or enabling failover. Live provider testing requires separate authority and budget and must be reported separately from controlled-adapter tests.
