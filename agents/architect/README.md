# Bflow Architect Agent (`architect`)

The **Architect Agent** (agent ID: `architect`, role: `architect`) is the specialist system design, technical constraints, API contract, and migration governance engine within Bflow Agentic SDLC v2.

---

## 1. Role & Herdr Multi-Pane Binding

In Bflow's terminal topology, the Architect operates within the coordination workspace:

| Property | Value | Description |
| --- | --- | --- |
| **Role** | `architect` | Formal agent role conforming to `AgentRoleSchema` |
| **Agent ID** | `architect` | System identifier for the architecture agent |
| **User Facing** | `false` | Forbidden from direct user interaction |
| **Read-Only Workspace** | `true` | Forbidden from mutating repository code directly |
| **Allowed Recipients** | `["coordinator", "runtime"]` | Communicates only with Coordinator and Runtime |
| **Specialist Delegation** | `false` | Cannot directly dispatch or delegate to other specialists |
| **Dedicated Pane** | `true` | Assigned dedicated terminal pane in Herdr session |
| **Independent Verification** | `true` | Outputs undergo independent verification gate |

---

## 2. Core Responsibilities

1. **System Architectural Design**:
   Defines clear architectural patterns, component boundaries, and interactions for complex system changes (`designProposal`, `architectureNotes`).
2. **Technical Constraints & Governance**:
   Specifies runtime, language, concurrency, performance, and dependency constraints (`technicalConstraints`).
3. **Public API & Data Contracts**:
   Designs strict Zod schemas, type definitions, validation contracts, and backward compatibility rules (`apiDataContracts`).
4. **Data Model & Zero-Downtime Migration**:
   Formulates schema transformations (`dataModelChanges`) and safe migration strategies (`migrationStrategy`: expand-contract, backfills, verification, rollback).
5. **Security Threat Modeling**:
   Evaluates trust boundaries, authentication/authorization, input sanitization, data exposure, and cryptographic controls (`securityConsiderations`).
6. **Failure Modes & Rollback Strategy**:
   Analyzes system risks, architectural tradeoffs, failure recovery paths, and deterministic rollback plans (`risksAndTradeoffs`, `rollbackPlan`).

---

## 3. Core Behavioral Invariants & Guardrails

1. **Security Architecture Invariant**: Small patches or documentation do not establish low security risk. Changes touching auth, contracts, storage, or crypto escalate to `complex` with `riskLevel: "high"`.
2. **Clarification Before Design**: Ambiguous performance goals, environmental limits, or scope boundaries are documented in `unresolvedQuestions` and clarified before finalizing design.
3. **Criteria Inviolability**: Technical architecture must strictly satisfy acceptance criteria. Criteria must never be weakened or relaxed to fit failing code.
4. **Mid-Workflow Revisions**: Mid-workflow architectural changes require a version bump (`version: old + 1`) and re-approval through Workflow Runtime.
5. **No Direct User or Developer Communication**: Communicates exclusively with `coordinator` and `runtime` via Herdr `RoleMessage` envelopes (`type: "spec.draft"`).
6. **Read-Only Workspace**: Never modifies implementation files, creates git branches, or executes commits directly.

---

## 4. Non-User-Facing Policy & Structured Result

`system-prompt.md` contains the mandatory "Non-User-Facing Execution Policy" verbatim (identical to `NON_USER_FACING_AUTONOMOUS_POLICY` in `@bflow/agent-registry`): the user does not read this pane, so the agent never asks the user questions or waits for a reply, records reversible low-risk assumptions, and sends a structured escalation to Coordinator through Herdr (task `blocked`) when a decision needs approval or exceeds its authority. Absence of a user response never bypasses a security or approval boundary, and success is never claimed without evidence.

Handoffs use the structured result sections of the prompt (`status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, optional `assumptions`) inside a Herdr `RoleMessage`. The registry's `validateAutonomousRolePrompt` and `validateAutonomousStructuredResult` check this contract statically; they are not evidence that a live provider complies.

---

## 5. Associated Files

- `prompt.md`: Concise operational prompt for architectural assignments.
- `system-prompt.md`: Complete system prompt loaded by the agent runner.
- `role-profile.json`: Contract-validated role profile conforming to `AgentRoleProfileSchema`.
- `@bflow/specification`: Supporting library providing schemas, engine, renderers, and classification logic (`packages/specification`).
