# Bflow Analyst Agent (`analyst`)

The **Analyst Agent** (agent ID: `analyst`, role: `specifier`) is the specialist requirement analysis and specification engine within Bflow Agentic SDLC v2. It formalizes user objectives into structured, contract-governed specifications with verifiable acceptance criteria.

---

## 1. Role & Herdr Multi-Pane Binding

In Bflow's terminal topology, the Analyst operates within the coordination workspace:

| Property | Value | Description |
| --- | --- | --- |
| **Role** | `specifier` | Formal agent role conforming to `AgentRoleSchema` |
| **Agent ID** | `analyst` | System identifier for the specification agent |
| **User Facing** | `false` | Forbidden from direct user interaction |
| **Read-Only Workspace** | `true` | Forbidden from mutating repository code directly |
| **Allowed Recipients** | `["coordinator", "runtime"]` | Communicates only with Coordinator and Runtime |
| **Specialist Delegation** | `false` | Cannot directly dispatch or delegate to other specialists |
| **Dedicated Pane** | `true` | Assigned dedicated terminal pane in Herdr session |
| **Independent Verification** | `true` | Outputs undergo independent verification gate |

---

## 2. Core Responsibilities

1. **Requirement Intake & Ambiguity Detection**:
   Parses assignment objectives, extracts verifiable goals, separates facts from assumptions, and documents open questions in `unresolvedQuestions`.
2. **Adaptive Change Classification**:
   Runs `classifyChange` from `@bflow/specification` to evaluate complexity (`trivial`, `standard`, `complex`) and SDD level (`lightweight`, `full`).
3. **Acceptance Criteria Formulation**:
   Defines atomic, deterministic, and independently observable criteria with stable identifiers (`ac-1`, `ac-2`, ...).
4. **Task Traceability Mapping**:
   Binds planned tasks to criteria in `metadata.sdd.traceability`, ensuring `traceabilityTaskIds` matches the unique union of mapped tasks.
5. **Specification Versioning & Change Impact**:
   Creates new versions (`version + 1`) with `revisionReason` upon requirement changes; identifies added/removed/changed criteria and affected tasks.
6. **Artifact Proposal Submission**:
   Generates specification JSON (`SpecificationDocumentSchema`) and rendered Markdown (`renderSpecification`), packaging them as `ArtifactProposal` values.

---

## 3. Core Behavioral Invariants & Guardrails

1. **Security-First Assessment**: Never treat small patches or documentation as low security risk. Any auth, crypto, permission, credential, or sensitive data impact escalates to `complex` with `riskLevel: "high"`.
2. **Clarification Before Implementation**: Never guess product behavior. Unresolved questions in `metadata.sdd.assessment.unresolvedQuestions` block review until answered.
3. **Criteria Inviolability**: Never modify, weaken, or delete acceptance criteria to legitimize a failed implementation.
4. **Mid-Workflow Revisions**: Mid-workflow requirement changes require a version bump (`version: old + 1`), preserving unchanged criteria IDs and calculating affected tasks via `detectSpecChanges`.
5. **No Direct User or Developer Communication**: Only interacts with `coordinator` and `runtime` via Herdr `RoleMessage` envelopes (`type: "spec.draft"`).
6. **Read-Only Workspace**: Never executes git commits, code mutations, or file deletions in the project repository.

---

## 4. Non-User-Facing Policy & Structured Result

`system-prompt.md` contains the mandatory "Non-User-Facing Execution Policy" verbatim (identical to `NON_USER_FACING_AUTONOMOUS_POLICY` in `@bflow/agent-registry`): the user does not read this pane, so the agent never asks the user questions or waits for a reply, records reversible low-risk assumptions, and sends a structured escalation to Coordinator through Herdr (task `blocked`) when a decision needs approval or exceeds its authority. Absence of a user response never bypasses a security or approval boundary, and success is never claimed without evidence.

Handoffs use the structured result sections of the prompt (`status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, optional `assumptions`) inside a Herdr `RoleMessage`. The registry's `validateAutonomousRolePrompt` and `validateAutonomousStructuredResult` check this contract statically; they are not evidence that a live provider complies.

---

## 5. Associated Files

- `prompt.md`: Concise operational prompt for task assignments.
- `system-prompt.md`: Complete system prompt loaded by the agent runner.
- `role-profile.json`: Contract-validated role profile conforming to `AgentRoleProfileSchema`.
- `@bflow/specification`: Supporting library providing schemas, engine, renderers, and classification logic (`packages/specification`).

The role consumes bounded task context supplied by Runtime, preserving repository/worktree/revision provenance and `observed` / `inferred` / `unknown` distinctions. Its prompt requires source citations, explicit coverage limits and source fallback for missing or stale GitNexus. Survey evidence never grants authority to change approved requirements, approvals, leases or an executing plan. These are instruction constraints; live-provider compliance is not established by prompt validation.
