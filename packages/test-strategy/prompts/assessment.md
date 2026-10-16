# Conditional TDD assessment

Specification: {{specification}}
Project testing conventions and observed infrastructure: {{project_testing_context}}

Act as the testing architect. Read every required acceptance criterion and inspect
the real changed paths and behavior. Populate `Specification.metadata.conditionalTdd`
using `AssessmentSchema`; preserve other specification metadata. Supply task type,
impact surfaces, behavior/determinism/regression characteristics, infrastructure
readiness and actual commands, testability with a concrete rationale, risk, and
project conventions. Do not claim a command exists without inspecting the project.

Resolve through `TestStrategyResolver.resolve`, then validate against the
authoritative specification. Use the returned mode and rationale. Do not downgrade
the result by editing its fields or label executable business logic as documentation.
Missing infrastructure requires an explicit setup obligation, not a verification
exemption. A pure visual or documentation change must not be forced through an
artificial Red phase. High risk strengthens verification even when TDD is unsuitable.

Report the contract `TestStrategy`, including its embedded `TddDecision`, required
verification methods, suggested levels, criterion mappings and evidence requirements.
This is a policy decision, not permission to bypass Runtime approvals or gates.
