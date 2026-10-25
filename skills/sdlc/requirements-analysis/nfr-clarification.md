# Clarifying verifiable non-functional requirements

Use this reference when an affected behavior is described as “fast”, “stable” or
“secure”. Ask only about outcomes or risks relevant to this change. Reuse accepted
constraints and measurements before requesting more information; an unrelated NFR
checklist adds no value. This is guidance, not a new gate or benchmark requirement.

For each relevant NFR, capture a short measurement/observation brief in ordinary
requirement prose:

| Element | Clarify |
| --- | --- |
| Outcome/risk | Whose outcome improves; what failure or exposure must be controlled? |
| Observable | Metric, unit and comparator, or an explicit allowed/denied behavior. |
| Target/source | Threshold or expected behavior; accepted source and rationale. Mark unconfirmed values **proposed**, missing values **unknown**. |
| Conditions | Workload/operation mix, data scale, concurrency, environment and relevant dependency/config versions. |
| Measurement | Window, warm-up/exclusions, aggregation (including percentile population), tool and exact repository-supported command or authorized operation. |
| Decision/evidence | Pass/fail oracle; raw observations, command/exit status, candidate revision, fixture/environment identity and sanitized logs to retain. |

No universal SLA or default percentile target applies. A number from an example,
prior benchmark or tool default is a proposal until the appropriate project authority
confirms it. Record its source and why it fits this workload. Security can be
behavioral: a request from another tenant is denied without disclosing protected
data. Do not turn that into an arbitrary security score.

Write these details in the existing AcceptanceCriterion description and supporting
Specification prose; use category non_functional, security or performance and an
existing verificationMethod appropriate to the actual check. These are prose slots,
not new JSON fields or a machine-readable metadata protocol. See the
specification-driven-development skill's NFR examples when forming criterion records.

If target, environment or authority is unresolved, retain the draft and criterion as
pending with no evidence IDs. Name the exact missing decision and its impact. Route
necessary clarification through Runtime → Herdr → Conversation (via Coordinator as
required by the assignment), preserving correlation and waiting state. Do not ask
natively, infer agreement from silence or implement a guessed product commitment.
Dependent work waits for the existing specification flow; unrelated authorized work
can continue. Do not invent an approval gate.

Keep four facts separate in the handoff:

1. **Described:** the criterion has a measurable/observable oracle and conditions.
2. **Ready:** the authorized runner, tools, fixtures and environment are available.
3. **Executed:** a measurement ran on the identified candidate and produced observations.
4. **Confirmed:** independent verification checked those observations against the accepted criterion.

A threshold, script or green unrelated test proves none of the later facts. Missing
tool access is a readiness gap: report the prerequisite, do not install tools or
invent commands. Missing results remain pending; invalid/incomplete measurements
are reported as gaps for the existing verification flow, never silently passed or
waived. Only actual evidence ingestion supplies artifact IDs; do not fabricate them.
Test design and criterion-to-check mapping belong to the existing test-planning /
TestStrategy flow. This brief supplies the oracle and conditions, not another test
plan, monitoring platform, benchmark suite or change to TddDecision.
