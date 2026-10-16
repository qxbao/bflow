# Specification Engine (P15)

`@bflow/specification` implements adaptive classification, contract-backed validation, immutable specification revisions, acceptance criterion management, criterion/task traceability, requirement change impact, approval policy and readable documents. It is a leaf package depending on contracts and Zod. It neither dispatches agents nor chooses TDD policy.

The public document remains `@bflow/contracts.Specification` (schemaVersion 2). `SpecificationDocumentSchema` first parses that exported schema, then validates P15's private, versioned `metadata.sdd` with `PolicyDetailsSchema`. No shared contract changes or migration/upcaster are introduced. `version`, `complexity`, `riskLevel` and `traceabilityTaskIds` are explicit for P15 documents. Legacy specs missing P15 metadata require an explicit assessment and a new draft; they are not silently upgraded or approved.

## Classification and content

Supply every impact flag in `ChangeAssessmentSchema`; use `classifyChange(assessment, affectedPaths)` to populate complexity, level and risk. Classification uses structured impact rather than line counts. Security/API/schema path hints conservatively promote apparently small changes. This is a deterministic policy over an assessment, not a semantic code scanner; Analyst/Architect must report actual impacts and open questions.

| Complexity | Minimum content | SDD level | Acceptance |
| --- | --- | --- | --- |
| trivial | Brief goal and at least one required completion criterion | lightweight | Authorized acceptance |
| standard | Problem, in/out scope, criteria, functional requirements, proposed test strategy | lightweight; new features full | Authorized acceptance |
| complex | Standard sections, design proposal, constraints, API/data contracts, risks/tradeoffs, migration when relevant | full | Authenticated human design approval |

Declared medium risk cannot be downgraded to trivial. Multiple modules, public API, persistent schema, architecture, security, migration or high/critical risk force complex/full and human approval. Data schema changes require dataModelChanges and migrationStrategy. Full specs retain the frozen contract's architectureNotes, securityConsiderations, rollbackPlan, TestStrategy and TddDecision requirements. Coordinator/P16 supplies resolved TDD policy; P15 checks correlations and required criterion coverage. An unresolved core question allows drafting but blocks review and implementation.

Trivial documents still include the existing contract's mandatory problemStatement, scope and affectedPaths, which can be brief. See [examples](examples/) for valid JSON and matching Markdown for trivial documentation, a standard bugfix and a complex database change. These are draft document examples, not fabricated stored artifacts.

## API and lifecycle

```ts
import { SpecificationEngine, renderSpecification } from "@bflow/specification";

const engine = new SpecificationEngine({
  artifactStore, // actual @bflow/contracts.ArtifactStore
  authorizeApprover: async (decision, humanRequired) => {
    // Trusted Runtime checks the authenticated principal and required role.
    return authorization.canApprove(decision.decidedBy, { humanRequired });
  }
});
const draft = engine.createDraft(document); // version 1, pending criteria
const pending = await engine.submitForReview(draft);
const request = await engine.requestApproval(pending, {
  approvalId: "approval-1", requestedBy: "coordinator", expiresAt
});
// Runtime persists request and obtains a correlated, authenticated ApprovalDecision.
const approved = await engine.approve(pending, authoritativeRequest, decision);
await engine.assertImplementationReady(approved, authoritativeRequest, decision, workflow);
console.log(renderSpecification(approved));
```

All incoming exchanged documents, workflows, approval records and store responses pass exported contract schemas. Invalid documents throw ZodError; policy/storage failures throw Error. Caller inputs are parsed into owned values. Trusted Runtime provides `authorizeApprover`; agent-supplied actor strings or metadata do not prove a human identity. Every spec requires acceptance; an authorized automated approver may accept low-risk work. Complex work requires the authorization callback to establish human authority.

`submitForReview` stores canonical JSON bytes through ArtifactStore with a SHA-256 digest, exact size and deterministic immutable artifact identity/idempotency key. Only the returned parsed store reference is attached. Documents are bounded to 1 MiB. `verifyArtifact` rereads the actual artifact, checks checksum/size and compares every reviewed content field. Content excludes status, approvedBy, artifactRef and updatedAt to avoid self-reference and separate governance from requirements; implementation readiness checks approval identity/time independently. The content artifact is not a serialized approved envelope. Criteria status/evidence remain reviewed content: verification results belong in separate P17 evidence and cannot rewrite approved criteria in place.

Approval binds request ID, spec ID, run/session, version (`revision`), generation 0, exact artifact and content digest. Rejections, changes_requested, superseded/cancelled/expired request states, stale versions, unauthorized actors and decisions outside their time window fail closed. A previously accepted decision remains valid after its request deadline, provided the authoritative request has not been cancelled/superseded. `approve` accepts only an approved decision; other decisions remain Runtime governance events, never permission to implement.

The engine is stateless and owns no in-memory repository. Runtime must durably persist the current spec version, returned pending/approved envelopes, requests and decisions; enforce optimistic versions/idempotency for concurrent commands; and supply the authoritative request lifecycle. Persist successful outcomes before dispatch. The original pending request is supplied with its current pending/superseded/cancelled state; the accepted decision is separate. Do not replace it with an arbitrary old copy or an ApprovalStatus `approved` projection. Artifact storage alone does not authorize execution. P19 integration, approval UI and live Herdr transport are outside P15.

## Revisions and traceability

```ts
const { specification: nextDraft, impact } = await engine.revise(
  approved, proposedDraftV2, "User changed the required behavior"
);
```

A revision preserves spec/run/session identity and creation time, increments version exactly once, uses nondecreasing time and a nonempty reason, and starts with no artifact/approval/evidence. New requirements must actually differ. The old document is never mutated or auto-superseded. Runtime atomically promotes the new current version and supersedes old approval requests when appropriate. Republishing and acceptance are required before implementation.

Acceptance criteria are managed by revising their explicit records: stable IDs identify unchanged criteria, newly introduced criteria get new IDs, removed/modified IDs appear in impact. Never modify criteria to legitimize failed implementation. P15 cannot infer whether a human requirement change is truthful from prose; Coordinator must authorize the change request and Verification must keep original failures.

`metadata.sdd.traceability` maps criterionId to nonempty taskIds. Its unique task union must match traceabilityTaskIds. Drafts/review may use empty mappings before planning. `validateTraceability(spec, workflow)` parses the complete WorkflowDefinition and requires every criterion to map and the workflow task set to match, rejecting omitted criteria and extra tasks before implementation. Task-local acceptance strings do not replace the spec's criterion definitions.

`detectSpecChanges(previous, next)` compares canonical requirements, classifies added/removed/changed criterion IDs, and reports their directly affected tasks across both versions. Changes to global requirements, scope, policy or mappings conservatively affect every mapped task. Runtime handles DAG-dependent invalidation and decides cancellation/rework generations; P15 never mutates a running task or fabricates a recovery cursor.

## Validation and integration handoff

From the repository root, build existing packages before tests that use their real stores:

```sh
pnpm check:deps
pnpm typecheck
pnpm exec tsc -b packages/specification --pretty false
pnpm test
pnpm exec vitest run packages/specification/test/specification.test.ts
```

Tests use the real filesystem ArtifactStore, including restart, idempotency, tamper checks and deleted artifacts, plus classification/schema/approval/revision/traceability cases. Fake transport tests are not live Herdr verification.

Integration owner must add this new package to root tsconfig references and regenerate the shared pnpm lockfile importer (`@bflow/contracts: workspace:*`, `zod: ^3.24.2`). Those review-gated shared files are intentionally outside P15 ownership. Until integrated, explicitly build/typecheck this package using the command above; root typecheck alone does not include it. Runtime/P19 wires the engine only after P12–P18 synchronization. Analyst and Architect prompts live under `agents/analyst/prompt.md` and `agents/architect/prompt.md`.
