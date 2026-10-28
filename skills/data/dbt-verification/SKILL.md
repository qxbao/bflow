---
name: dbt-verification
description: "Use when gathering host-run dbt fixture or approved snapshot data-quality evidence separately from static schema and contract checks."
---

## Supported roles

coordinator, developer, tester, reviewer, qa. Use standard roles; Developer checks do not replace independent Reviewer/QA.

## Prerequisites

Accepted criteria/TestStrategy, exact contract and approval pins, approved snapshot/environment and available host adapter. This instruction-only skill installs nothing and grants no execution, credentials or warehouse permissions. Preserve host policy, Conditional TDD, original prompts, leases and bounded verification.

## Trigger conditions

Data-quality criteria need actual dbt execution, or a measured report must be interpreted against the accepted contract.

## Required inputs

Criterion/check IDs, contract revision/digest, declared model revision, candidate schema digest, approved snapshot identity/digest, toolchain version, deadline and fixture resource ownership/cleanup authority.

## Expected outputs

Separate structural and runtime outcomes; criterion-linked per-check pass/failure counts or explicit prerequisite/infrastructure gaps, with host-measured provenance and trusted ArtifactStore references.

## Procedure

1. Verify the host's supported adapter and toolchain. DC-01 is dbt Core 1.10, manifest schema v12 and DuckDB fixture snapshot validation. It does not execute arbitrary candidate SQL/macros/hooks or use caller warehouse profiles. Its library host path supplies no daemon/CLI configuration command.
2. Require the approved host to launch real dbt with fixed templates against the owned temporary DuckDB database. Linux Bubblewrap must pass readiness, deny network access and isolate toolchain/project writes; no unsandboxed fallback. A role cannot provide executable argv or an already-written success report as evidence.
3. Run only accepted null, unique, relationship and accepted-values checks supported by the adapter. Freshness or volume/distribution criteria require an actual supported measurement and approved threshold; unsupported required checks are gaps, never silently omitted.
4. Validate fresh host-collected dbt manifest/run-results metadata, invocation identity and complete selected model/test coverage. Reject missing, duplicate, skipped, stale, malformed or inconsistent results, non-assertion runtime errors and truncated/deadline outputs. Successful parse or process exit alone is insufficient.
5. Preserve exact tool/adapter version, executable/argv, start/end/duration, contract approval/digest, measured schema/snapshot digests and per-check outcomes. Label execution snapshot_validation; declaredModelRevision is a provenance label and does not prove transformation SQL ran. Runtime ingests measured artifacts; an agent-authored report never replaces them.

## Bflow commands

Use `bflow help` for actual installed commands and `bflow doctor --json` for supported prerequisite diagnostics. This skill adds no data/dbt CLI command and does not authorize installing tools or changing global configuration.

## Verification requirements

Observe a real passing fixture and a real data violation, keeping structural compatibility independently visible. Report exact checks and skips. Fixture success establishes neither warehouse/live acceptance nor production model equivalence.

## Error handling

Missing dbt/adapter/dependency/warehouse authority or sandbox blocks execution. Never synthesize success, weaken tests or change contract thresholds. Timeout does not prove query termination; retain uncertain resources for reconciliation, avoid automatic replay and clean only owned fixtures after confirmed process-group stop.

## Escalation rules

Send missing prerequisites, proposed threshold revisions, authority and uncertain cleanup through Runtime → Herdr → Conversation. Keep native direct questions disabled. No real warehouse write or destructive migration without specific authority; unattended mode is not approval.

## Concrete examples

See [the fixture example](worked-example.md) for expected observations and failure branches. The example is illustrative and cannot establish executed evidence.
