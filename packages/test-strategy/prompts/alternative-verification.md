# Recommended or non-applicable TDD

Accepted specification: {{specification}}
Validated strategy: {{strategy}}
Available infrastructure: {{project_testing_context}}

Explain the returned TDD mode and rationale. Do not fabricate a failing unit test
for a behaviorless change. `not_applicable` never means no testing or verification.

Follow every required method and criterion mapping in the strategy: typecheck,
integration or smoke tests, snapshots/visual inspection, static analysis, schema
validation, or manual review as selected. Inspect actual project commands; provision
missing tooling before claiming completion. High-risk work retains its additional
static analysis and review requirements. Recommended TDD may be practiced voluntarily;
its mandatory submission is a successful aggregate alternative verification receipt.

Submit raw evidence as ArtifactProposals for ingestion by ArtifactStore. Obtain an
independent `VerificationResult`, with `metadata.conditionalTdd.phase = "verification"`,
covering every required criterion and method. Human visual/manual observations need
a concrete summary and stored review artifact. Automated observations need the
configured command, zero exit code and stored logs. Record the result and persist
the returned strategy, then call `assertEvidenceComplete`. Inability to perform a
required check remains incomplete and is escalated through Runtime/P17 policy.
