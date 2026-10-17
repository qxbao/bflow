# Specification Engine (P15)

`@bflow/specification` implements adaptive change classification, contract-backed validation, immutable specification revisions, acceptance criterion management, criterion/task traceability, requirement change impact analysis, approval policy, and human-readable document rendering. It is a leaf package depending on `@bflow/contracts` and `zod`. It neither dispatches agents nor chooses TDD policy.

The public document format is `@bflow/contracts.Specification` (schemaVersion 2). `SpecificationDocumentSchema` parses that exported schema and validates P15's private, versioned `metadata.sdd` with `PolicyDetailsSchema`. No shared contract changes or upcasters are introduced. `version`, `complexity`, `riskLevel`, and `traceabilityTaskIds` are explicit for P15 documents. Legacy specs missing P15 metadata require an explicit assessment and a new draft; they are not silently upgraded or approved.

---

## Architecture Overview

```
                      ┌──────────────────────────────────────────────┐
                      │              Coordinator Agent               │
                      └──────────────────────┬───────────────────────┘
                                             │ Task Delegation (RoleMessage)
                                             ▼
                 ┌────────────────────────────────────────────────────────┐
                 │                  Specialist Agents                     │
                 │   - Analyst (specifier): Requirements, Criteria        │
                 │   - Architect (architect): Constraints, API/Data       │
                 └───────────────────────────┬────────────────────────────┘
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      ▼                      ▼                      ▼
           ┌──────────────────────┐┌──────────────────┐┌──────────────────────┐
           │ 1. Classification    ││ 2. Schema        ││ 3. Versioning &      │
           │    & Assessment      ││    Validation    ││    Approval Engine   │
           └──────────────────────┘└──────────────────┘└──────────────────────┘
                      │                      │                      │
                      ▼                      ▼                      ▼
           ┌──────────────────────┐┌──────────────────┐┌──────────────────────┐
           │ 4. Criteria Mgmt     ││ 5. Traceability  ││ 6. Change Detection  │
           │    & Inviolability   ││    Matrix        ││    & DAG Impact      │
           └──────────────────────┘└──────────────────┘└──────────────────────┘
                      │                      │                      │
                      └──────────────────────┼──────────────────────┘
                                             │
                                             ▼
           ┌──────────────────────────────────────────────────────────────┐
           │ 7. Artifact Proposal & Protocol 22 RoleMessage Egress        │
           │    - JSON / Markdown Proposals via Content-Addressed Hash    │
           │    - spec.draft / spec.approved RoleMessage Envelopes        │
           │    - Rendered Markdown via renderSpecification               │
           └──────────────────────────────────────────────────────────────┘
```

---

## 8 P15 Specification Components

### 1. Specification Classification

Change classification is driven by explicit impact assessment rather than code diff size. Even a one-line change to authentication, public contracts, or database migrations can introduce critical security or architectural risks.

- **`ChangeAssessmentSchema`**: Structured impact assessment supplied by Analyst or Architect:
  - `kind`: `"documentation"` | `"formatting"` | `"feature"` | `"bugfix"` | `"refactoring"` | `"configuration"`
  - `behaviorChange`: boolean
  - `modules`: non-empty array of affected module names
  - `securityImpact`, `publicApiImpact`, `dataSchemaImpact`, `architectureImpact`, `migrationRequired`: boolean flags
  - `risk`: `"low"` | `"medium"` | `"high"` | `"critical"`
  - `unresolvedQuestions`: array of open ambiguities blocking review/implementation
- **`classifyChange(assessment, affectedPaths)`**: Evaluates assessment flags and conservative path hints:
  - Promotes to `complexity: "complex"`, `level: "full"`, `riskLevel: "high"`, `humanApprovalRequired: true` if any impact flag is true, multiple modules are touched, risk is high/critical, or path hints match.
  - Promotes to `complexity: "standard"`, `riskLevel: "medium"` if behavior change occurs or risk is medium.
  - Limits `complexity: "trivial"`, `level: "lightweight"`, `riskLevel: "low"` to non-behavioral, low-risk changes without security/API/data/architecture impact.
- **`classifyChangeSafe(assessment, affectedPaths)`**: Non-throwing variant returning `OperationResult<Classification>`.
- **Conservative Path Hints**:
  - `hasSecurityPathHint(paths)`: Matches security, auth, crypto, secret, permission, token, jwt, tls, etc.
  - `hasPublicApiPathHint(paths)`: Matches contracts, openapi, proto, graphql boundaries.
  - `hasDataSchemaPathHint(paths)`: Matches migrations, schema directories, or `.sql` files.
- **`getRequiredSpecSections(complexity, migrationOrSchemaImpact)`**: Returns the list of mandatory section names for the given complexity.

| Complexity | Minimum Content | SDD Level | Governance Gate |
| --- | --- | --- | --- |
| `trivial` | Title, summary, problem statement, scope, affected paths, >= 1 required criterion | `lightweight` | Authorized automated acceptance |
| `standard` | Trivial sections + functional requirements + proposed test strategy | `lightweight` (`full` for new features) | Authorized automated acceptance |
| `complex` | Standard sections + design proposal, technical constraints, API contracts, risks/tradeoffs, architecture notes, security considerations, rollback plan, test strategy, TDD decision (+ migration strategy & dataModelChanges if schema affected) | `full` | Authenticated human design approval |

---

### 2. Specification Schema Validation

`SpecificationDocumentSchema` refines `@bflow/contracts.Specification` by enforcing strict validation on P15's `metadata.sdd`:

- **`PolicyDetailsSchema`**: Defines the metadata schema:
  - `policyVersion: 1`
  - `assessment`: `ChangeAssessment`
  - `functionalRequirements`: array of non-empty strings
  - `proposedTestStrategy`: optional string
  - `designProposal`, `technicalConstraints`, `apiDataContracts`, `risksAndTradeoffs`: strings/arrays for complex changes
  - `migrationStrategy`: optional string for data schema changes
  - `traceability`: array of `{ criterionId, taskIds }`
  - `revisionReason`: optional string required on revisions
- **`parseContractOrP15Specification(input)`**: Accepts either a P15 `SpecificationDocumentSchema` document or a plain contract `Specification`; for the latter it synthesizes valid `metadata.sdd` policy details (defaults for assessment, requirements and traceability) so criteria, traceability and change-detection helpers also work on contract specs.
- **`parseSpecification(input)`**: Validates that:
  - Classification matches declared assessment and affected paths.
  - Scope items (`inScope`, `outOfScope`) are non-blank.
  - Version is an explicit number.
  - `updatedAt >= createdAt`.
  - At least one acceptance criterion is `required: true`.
  - Required sections for `standard` and `complex` changes are present and non-empty.
  - Traceability maps exist for all criteria and match `traceabilityTaskIds`.
  - If `testStrategy` or `tddDecision` are present, they reference the matching `specId` and `runId`.
- **`validateSpecificationDocument(input)`**: Safe validator returning `OperationResult<Specification>`.
- **`policyDetails(input)`**: Helper extracting parsed `PolicyDetails` from a valid specification.

---

### 3. Spec Versioning

Specifications follow an immutable, versioned lifecycle. Existing approved specifications are never mutated in place.

- **`SpecificationEngine.createDraft(input)`**:
  - Initializes a new specification at `version: 1` in `status: "draft"`.
  - Enforces that all acceptance criteria are in `status: "pending"` with empty `evidenceArtifactIds` and no `waiverReason`.
  - Forbids pre-existing `approvedBy` or `artifactRef`.
- **`SpecificationEngine.revise(previousApproved, proposedDraft, reason)`**:
  - Preserves specification identity: `specId`, `runId`, `sessionId`, and `createdAt` must match.
  - Enforces version increment: `proposed.version === previous.version + 1`.
  - Validates non-decreasing timestamps: `updatedAt >= previous.updatedAt`.
  - Attaches non-empty `revisionReason` in `metadata.sdd`.
  - Verifies artifact integrity of `previous` if an artifact reference exists.
  - Runs `detectSpecChanges` to ensure requirements or criteria actually changed (`requiresReapproval`).
  - Returns `{ specification: nextDraft, impact }` ready for fresh review.
- **`SpecificationEngine.supersede(previousApproved, nextApproved)`**:
  - Transitions `previousApproved` from `status: "approved"` to `status: "superseded"` when `nextApproved` is approved.
  - Verifies both artifact references in `ArtifactStore` before updating status.

---

### 4. Acceptance Criteria Management & Inviolability

Acceptance criteria define verifiable preconditions for task completion. They are protected by strict anti-weakening guardrails:

- **Criteria Inviolability Invariant**: Criteria must **NEVER** be deleted, made optional, relaxed in verification method, or reworded to legitimize a failing implementation.
- **`addCriterionToDraft(spec, criterion, mappedTaskIds)`**: Adds a new pending criterion to a draft specification, updating traceability and test strategy mappings.
- **`updateCriterionInDraft(spec, criterionId, patch)`**: Updates criterion properties (`description`, `category`, `verificationMethod`, `required`, `mappedTaskIds`) on a draft specification.
- **`removeCriterionFromDraft(spec, criterionId)`**: Removes a criterion from a draft, cleaning up traceability and test strategy. Fails if removing the last required criterion.
- **`assertNoCriteriaWeakeningOnFailure(previousSpec, proposedSpec, failedVerification, options)`**:
  - Inspects failed criteria in `failedVerification.evaluatedCriteria`.
  - Throws an error if any failed criterion was:
    1. Removed in `proposedSpec`.
    2. Changed from `required: true` to `required: false`.
    3. Weakened in verification method rigor (e.g., `e2e_test` -> `manual_review`).
    4. Modified in description.
  - Bypass permitted **only** when `options.explicitUserRequirementChangeAuthorized === true`.
- **`evaluateCriteriaFromVerification(spec, verificationResult)`**:
  - Evaluates criteria against an independent `VerificationResult` from P17.
  - Returns `CriteriaEvaluationSummary` (`allRequiredSatisfied: boolean`, `evaluations: CriterionEvaluation[]`).
  - Leaves the approved specification immutable; verification results belong in separate evidence artifacts.

---

### 5. Spec-to-Task Traceability

Every requirement and criterion must trace forward to execution tasks, and every execution task must trace backward to requirements.

- **`validateTraceability(spec, workflow)`**:
  - Throws if workflow tasks reference unknown acceptance criteria, if any criterion has no mapped task, or if workflow tasks and traceability do not match exactly.
  - Validates that every acceptance criterion in `spec` maps to at least one task in `workflow`.
  - Validates that all tasks referenced in `metadata.sdd.traceability` exist in `workflow.tasks`, and no orphan workflow tasks exist without mapped criteria.
- **`buildTraceabilityMatrix(spec, workflow?)`**:
  - Returns `TraceabilityMatrix`:
    - `criterionToTasks`: Record mapping criterion IDs to task IDs.
    - `taskToCriteria`: Record mapping task IDs to criterion IDs.
    - `orphanCriterionIds`: Criteria with no assigned tasks.
    - `unmappedWorkflowTaskIds`: Workflow tasks with no mapped criteria.
    - `unknownMappedTaskIds`: Tasks in traceability that do not exist in the workflow.
    - `unknownCriterionIds` (optional): Criterion IDs referenced by workflow tasks that the spec does not define.
  - With explicit `metadata.sdd.traceability` on the spec, that mapping is authoritative; without it and with a workflow supplied, mappings are derived from each task's `acceptanceCriteria`.
    - `valid`: boolean indicator of complete bidirectional traceability.
- **`validateChangedFilesScope(spec, changedPaths)`**:
  - Validates whether changed files fall within `spec.affectedPaths`.
  - Supports exact path matches, directory prefix matches, and glob patterns (`**`, `*`, `?`).
  - Returns `{ withinScope: boolean, outOfScopePaths: string[] }`.

---

### 6. Spec Change Detection & DAG Impact Analysis

When requirements change mid-workflow, `detectSpecChanges` determines the exact impact across criteria and the task DAG:

- **`detectSpecChanges(previousSpec, nextSpec, workflow?)`**:
  - Identifies added, removed, changed, and unchanged criteria:
    - `addedCriterionIds`: newly introduced criteria.
    - `removedCriterionIds`: deleted criteria.
    - `changedCriterionIds`: criteria whose description, category, verificationMethod, or required status changed.
    - `unchangedCriterionIds`: criteria whose canonical JSON is identical across versions.
  - Identifies changed fields:
    - `changedFields`: list of modified top-level and SDD policy fields (e.g. `summary`, `scope`, `functionalRequirements`, `designProposal`).
  - Identifies global changes:
    - `globalRequirementsChanged`: true if any top-level requirement or policy section changed beyond criteria.
  - Computes affected tasks:
    - `affectedTaskIds`: unique tasks directly mapped to changed criteria (or all mapped tasks if global requirements changed).
    - `transitivelyAffectedTaskIds`: downstream tasks in the `workflow.dependencies` DAG affected transitively.
  - Reapproval gate:
    - `requiresReapproval`: true if any criterion or requirement was altered.

---

### 7. Spec Approval Policy & Governance

The approval lifecycle manages formal transition from draft to approved status:

```
[ draft ] ──── submitForReview() ────► [ review_pending ]
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │ approve()                                         │ reject()
                    ▼                                                   ▼
              [ approved ]                                    [ rejected / draft ]
                    │
                    ▼ supersede()
              [ superseded ]
```

- **`SpecificationEngine.submitForReview(draft)`**:
  - Computes canonical JSON of reviewed requirements (excluding lifecycle metadata).
  - Verifies document size (`<= 1 MiB`).
  - Persists canonical JSON into `ArtifactStore` with SHA-256 checksum and exact size.
  - Attaches returned `ArtifactReference` and sets `status: "review_pending"`.
- **`SpecificationEngine.requestApproval(pending, options)`**:
  - Creates a formal `ApprovalRequest` targeting `{ type: "specification", specId }` at current `revision: spec.version`.
  - Binds content digest and artifact reference as evidence.
- **`SpecificationEngine.approve(pending, request, decision)`**:
  - Verifies artifact integrity via `verifyArtifact`.
  - Validates approval window, matching request IDs, revision, and generation.
  - Invokes `authorizeApprover(decision, humanRequired)`:
    - Low-risk/trivial changes allow authorized automated approvers (e.g., Coordinator).
    - Complex/high-risk changes mandate authenticated human owner approval.
  - Transitions specification to `status: "approved"`.
- **`SpecificationEngine.reject(pending, request, decision)`**:
  - For `decision.decision === "rejected"`: transitions specification to `status: "rejected"`.
  - For `decision.decision === "changes_requested"`: reverts specification to a clean `status: "draft"` (clearing artifactRef and approvedBy) for rework.
- **`SpecificationEngine.assertImplementationReady(approved, request, decision, workflow)`**:
  - Enforces that specification is approved, decision is verified, artifact is intact, and full workflow traceability matches.
- **`SpecificationEngine.verifyArtifact(spec)`**:
  - Reads stored artifact stream from `ArtifactStore`, recomputes SHA-256 digest, checks byte length, and compares canonical JSON to current spec requirements.

---

### 8. Artifact References, RoleMessage Protocol & Specialist Prompts

P15 standardizes communication across Herdr panes and external stores:

- **`createSpecificationArtifactProposal(spec, options)`**:
  - Formats: `"json"` (canonical JSON content) or `"markdown"` (rendered human-readable markdown).
  - Computes SHA-256 checksum and size.
  - Returns `{ proposal: ArtifactProposal, bytes: Buffer, checksum: string }`.
- **`buildSpecRoleMessage(options)`**:
  - Constructs Protocol 22 `RoleMessage` envelopes:
    - `type: "spec.draft"`: payload contains `specId`, `specLevel`, `title`, `authorRole`, `summary`, `affectedPaths`.
    - `type: "spec.approved"`: payload contains `specId`, `approvedBy`, `approvedAt`, optional `notes`.
  - Populates sender, recipient, correlation ID, causation ID, run ID, and attached artifact references.
- **`renderSpecification(spec)`**:
  - Formats specification into human-readable Markdown matching the canonical examples in `examples/`.
- **Analyst & Architect Specialist Prompts**:
  - `ANALYST_ROLE_PROFILE`: Specialist profile for Analyst (`role: "specifier"`, read-only workspace).
  - `ARCHITECT_ROLE_PROFILE`: Specialist profile for Architect (`role: "architect"`, read-only workspace).
  - `ANALYST_SYSTEM_PROMPT`: Complete system prompt defining Analyst boundaries and SDD responsibilities.
  - `ARCHITECT_SYSTEM_PROMPT`: Complete system prompt defining Architect boundaries and technical governance.
  - Both prompts include the mandatory non-user-facing execution policy (no user questions; reversible assumptions recorded; blockers and spec-changing decisions escalated to Coordinator via Herdr) and the seven-field structured result (`status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, optional `assumptions`). The shipped `agents/analyst` and `agents/architect` prompts carry the same sections.
  - `renderSpecialistSpecificationPrompt(options)`: Generates task assignment prompts for initial drafting or version revision.
- **Specification Examples** in `packages/specification/examples/`:
  - `trivial.json` / `trivial.md`: Local documentation update (lightweight, low risk).
  - `standard.json` / `standard.md`: Single-module bugfix (lightweight, medium risk).
  - `complex.json` / `complex.md`: Database schema change with migration (full, high risk).
  - `api.json` / `api.md`: Public contract extension with TDD decision and test strategy (full, high risk).

---

## Example Usage

```ts
import {
  SpecificationEngine,
  classifyChange,
  parseSpecification,
  renderSpecification,
  createSpecificationArtifactProposal,
  buildSpecRoleMessage
} from "@bflow/specification";

// 1. Classify change based on structured assessment
const assessment = {
  kind: "feature",
  behaviorChange: true,
  modules: ["auth"],
  securityImpact: true,
  publicApiImpact: true,
  dataSchemaImpact: false,
  architectureImpact: false,
  migrationRequired: false,
  risk: "high",
  unresolvedQuestions: []
};
const classification = classifyChange(assessment, ["packages/contracts/src/auth.ts"]);
console.log(classification.complexity); // "complex"
console.log(classification.humanApprovalRequired); // true

// 2. Initialize SpecificationEngine with trusted ArtifactStore
const engine = new SpecificationEngine({
  artifactStore,
  authorizeApprover: async (decision, humanRequired) => {
    return humanRequired ? decision.decidedBy === "human-owner" : true;
  }
});

// 3. Draft, submit for review, request approval, approve
const draft = engine.createDraft(specDocument);
const reviewed = await engine.submitForReview(draft);
const request = await engine.requestApproval(reviewed, {
  approvalId: "approval-1",
  requestedBy: "coordinator"
});
const approved = await engine.approve(reviewed, request, decision);

// 4. Assert implementation readiness against planned workflow DAG
await engine.assertImplementationReady(approved, request, decision, workflowDefinition);

// 5. Generate artifact proposal and protocol 22 RoleMessage
const { proposal } = createSpecificationArtifactProposal(approved, {
  proposalId: "proposal-1",
  format: "json"
});
const message = buildSpecRoleMessage({
  messageId: "msg-1",
  correlationId: "corr-1",
  runId: approved.runId,
  senderRole: "coordinator",
  type: "spec.approved",
  spec: approved
});
```

---

## Validation Commands

Run from the repository root:

```bash
# Typecheck specification package
pnpm --filter @bflow/specification typecheck

# Run all specification unit & integration tests
pnpm --filter @bflow/specification test
```
