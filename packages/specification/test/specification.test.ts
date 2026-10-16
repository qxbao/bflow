import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, SpecificationSchema, WorkflowDefinitionSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "../../artifact-store/src/index.js";
import {
  SpecificationEngine, classifyChange, detectSpecChanges, parseSpecification, policyDetails,
  renderSpecification, validateTraceability
} from "../src/index.js";
import { draft, now, later, workflow } from "./fixtures.js";

let directory: string;
let store: FilesystemArtifactStore;
let engine: SpecificationEngine;
let clockTime: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bflow-spec-"));
  const opened = await openFilesystemArtifactStore({ root: join(directory, "artifacts"), storeId: "spec-tests" });
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  clockTime = now;
  engine = new SpecificationEngine({ artifactStore: store, clock: () => new Date(clockTime),
    authorizeApprover: (decision, humanRequired) => humanRequired ? decision.decidedBy === "human-owner" : ["human-owner", "coordinator"].includes(decision.decidedBy) });
});
afterEach(async () => {
  await store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function review(kind: Parameters<typeof draft>[0] = "documentation") {
  const pending = await engine.submitForReview(engine.createDraft(draft(kind)));
  const request = await engine.requestApproval(pending, { approvalId: "approval-1", requestedBy: "coordinator" });
  const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId,
    runId: request.runId, sessionId: request.sessionId, target: request.target,
    revision: request.revision, generation: 0, decision: "approved", decidedBy: "human-owner", decidedAt: now,
    feedbackArtifacts: [], idempotencyKey: "decision-1" });
  return { pending, request, decision };
}

function revision(input = draft()) {
  return { ...structuredClone(input), version: input.version! + 1, updatedAt: later, summary: "A newly requested outcome" };
}

describe("adaptive classification and schema", () => {
  it.each([
    ["documentation", "trivial", "lightweight", "low"],
    ["bugfix", "standard", "lightweight", "medium"],
    ["feature", "standard", "full", "medium"],
    ["api", "complex", "full", "high"],
    ["database", "complex", "full", "high"]
  ] as const)("classifies %s and accepts the matching document", (kind, complexity, level, risk) => {
    const spec = parseSpecification(draft(kind));
    expect(spec).toMatchObject({ complexity, level, riskLevel: risk });
  });

  it.each(["securityImpact", "publicApiImpact", "dataSchemaImpact", "architectureImpact", "migrationRequired"])("small diff cannot bypass %s assessment", field => {
    const assessment = { ...policyDetails(draft()).assessment, [field]: true };
    expect(classifyChange(assessment)).toMatchObject({ complexity: "complex", humanApprovalRequired: true });
  });

  it("never downgrades an explicitly medium-risk change to trivial", () => {
    expect(classifyChange({ ...policyDetails(draft()).assessment, risk: "medium" }).complexity).toBe("standard");
  });

  it("rejects whitespace-only scope entries", () => {
    expect(() => parseSpecification({ ...draft(), scope: { inScope: [" "], outOfScope: [] } })).toThrow(/blank/);
  });

  it("escalates multiple modules and critical risk", () => {
    expect(classifyChange({ ...policyDetails(draft()).assessment, modules: ["a", "b"], risk: "critical" }))
      .toMatchObject({ complexity: "complex", level: "full", riskLevel: "critical" });
  });

  it.each(["docs/authentication.md", "packages/contracts/src/api.ts", "db/migrations/002.sql"])("uses conservative path hints: %s", path => {
    expect(classifyChange(policyDetails(draft()).assessment, [path]).complexity).toBe("complex");
  });

  it("rejects missing or duplicated acceptance criteria", () => {
    const spec = draft();
    expect(() => parseSpecification({ ...spec, acceptanceCriteria: [] })).toThrow();
    expect(() => parseSpecification({ ...spec, acceptanceCriteria: [...spec.acceptanceCriteria, ...spec.acceptanceCriteria] })).toThrow();
  });

  it("requires a mandatory completion criterion", () => {
    const spec = draft();
    spec.acceptanceCriteria[0]!.required = false;
    expect(() => parseSpecification(spec)).toThrow(/at least one criterion/);
  });

  it("rejects unknown fields and missing assessment", () => {
    expect(() => parseSpecification({ ...draft(), arbitrary: true })).toThrow();
    expect(() => parseSpecification({ ...draft(), metadata: {} })).toThrow();
  });

  it("rejects downgraded classification", () => {
    expect(() => parseSpecification({ ...draft("api"), complexity: "trivial", level: "lightweight", riskLevel: "low" })).toThrow(/classification/);
  });

  it.each(["functionalRequirements", "proposedTestStrategy"])("requires standard section %s", field => {
    const spec = draft("bugfix");
    const details = policyDetails(spec);
    spec.metadata = { sdd: { ...details, [field]: field === "functionalRequirements" ? [] : " " } };
    expect(() => parseSpecification(spec)).toThrow();
  });

  it.each(["designProposal", "technicalConstraints", "apiDataContracts", "risksAndTradeoffs"])("requires complex section %s", field => {
    const spec = draft("api");
    const details = policyDetails(spec);
    spec.metadata = { sdd: { ...details, [field]: field === "designProposal" ? " " : [] } };
    expect(() => parseSpecification(spec)).toThrow();
  });

  it("requires migration documentation when only a path hints at schema impact", () => {
    const spec = draft("api");
    spec.affectedPaths = ["db/migrations/003.sql"];
    expect(() => parseSpecification(spec)).toThrow(/migration/);
  });

  it("requires migration and data model explanation", () => {
    const spec = draft("database");
    const details = policyDetails(spec);
    delete details.migrationStrategy;
    spec.metadata = { sdd: details };
    expect(() => parseSpecification(spec)).toThrow(/migration/);
  });

  it("rejects cross-spec strategies, mismatched TDD decisions and orphan test mappings", () => {
    const spec = draft("api");
    spec.testStrategy!.specId = "other";
    spec.testStrategy!.tddDecision.specId = "other";
    expect(() => parseSpecification(spec)).toThrow();
    const orphan = draft("api");
    orphan.testStrategy!.criterionMappings = [{ criterionId: "missing", testNames: ["test"] }];
    expect(() => parseSpecification(orphan)).toThrow();
    const mismatch = draft("api");
    mismatch.tddDecision!.rationale = "A different rationale for this decision";
    expect(() => parseSpecification(mismatch)).toThrow(/decisions must agree/);
  });

  it("renders concise human readable goals, criteria and traceability", () => {
    expect(renderSpecification(draft())).toContain("[ac-1]");
    expect(renderSpecification(draft())).not.toContain("## Design proposal");
    expect(renderSpecification(draft("database"))).toContain("## Migration strategy");
  });
});

describe("immutable artifacts and approval policy", () => {
  it("blocks review while core requirements remain unclear", async () => {
    const spec = draft();
    const details = policyDetails(spec);
    details.assessment.unresolvedQuestions = ["Which user group is in scope?"];
    spec.metadata = { sdd: details };
    expect(engine.createDraft(spec).status).toBe("draft");
    await expect(engine.submitForReview(spec)).rejects.toThrow(/clarification/);
  });

  it("blocks review of future-dated requirements", async () => {
    await expect(engine.submitForReview({ ...draft(), updatedAt: later })).rejects.toThrow(/future/);
  });

  it("requires run identity and version one for new specs", async () => {
    const spec = draft();
    delete spec.runId;
    await expect(engine.submitForReview(spec)).rejects.toThrow(/run ID/);
    expect(() => engine.createDraft({ ...draft(), version: 2 })).toThrow(/version 1/);
  });

  it("publishes an immutable real artifact idempotently and survives store reopen", async () => {
    const first = await engine.submitForReview(draft());
    const second = await engine.submitForReview(draft());
    expect(second.artifactRef).toEqual(first.artifactRef);
    await store.close();
    const reopened = await openFilesystemArtifactStore({ root: join(directory, "artifacts"), storeId: "spec-tests" });
    if (!reopened.ok) throw new Error(reopened.error.message);
    store = reopened.value;
    const recovered = new SpecificationEngine({ artifactStore: store, authorizeApprover: () => false });
    await expect(recovered.verifyArtifact(first)).resolves.toEqual(first.artifactRef);
  });

  it("approves a correlated spec and verifies traceability before implementation", async () => {
    const { pending, request, decision } = await review("api");
    const approved = await engine.approve(pending, request, decision);
    expect(approved.status).toBe("approved");
    await expect(engine.assertImplementationReady(approved, request, decision, workflow())).resolves.toBeUndefined();
    expect(pending.status).toBe("review_pending");
  });

  it("supports authorized automated acceptance of low risk documentation", async () => {
    const { pending, request, decision } = await review();
    await expect(engine.approve(pending, request, { ...decision, decidedBy: "coordinator" })).resolves.toMatchObject({ status: "approved" });
  });

  it("requires authenticated human approval for high risk API changes", async () => {
    const { pending, request, decision } = await review("api");
    await expect(engine.approve(pending, request, { ...decision, decidedBy: "coordinator", metadata: { human: true } })).rejects.toThrow(/human/);
  });

  it.each(["revision", "generation", "runId", "sessionId", "approvalId", "target", "decision"])("rejects mismatched approval decision %s", async field => {
    const { pending, request, decision } = await review();
    const mismatches: Record<string, unknown> = { revision: 2, generation: 1, runId: "other", sessionId: "other", approvalId: "other",
      target: { type: "specification", specId: "other" }, decision: "rejected" };
    await expect(engine.approve(pending, request, { ...decision, [field]: mismatches[field], reason: "Not approved" })).rejects.toThrow();
  });

  it.each(["rejected", "changes_requested", "expired", "cancelled", "superseded", "approved"])("rejects non-pending authoritative request %s", async status => {
    const { pending, request, decision } = await review();
    await expect(engine.approve(pending, { ...request, status }, decision)).rejects.toThrow(/request/);
  });

  it("rejects missing artifact evidence and a different version digest", async () => {
    const { pending, request, decision } = await review();
    await expect(engine.approve(pending, { ...request, evidence: [] }, decision)).rejects.toThrow(/request/);
    await expect(engine.approve(pending, { ...request, metadata: { specificationDigest: "wrong" } }, decision)).rejects.toThrow(/request/);
  });

  it("rejects expired requests and future or backdated decisions", async () => {
    const { pending, request, decision } = await review();
    await expect(engine.approve(pending, request, { ...decision, decidedAt: later })).rejects.toThrow(/time window/);
    await expect(engine.approve(pending, request, { ...decision, decidedAt: "2026-10-15T00:00:00.000Z" })).rejects.toThrow(/time window/);
    clockTime = later;
    await expect(engine.approve(pending, { ...request, expiresAt: later }, decision)).rejects.toThrow(/expired/);
  });

  it("retains a valid completed approval after request expiry", async () => {
    const { pending, request, decision } = await review();
    request.expiresAt = later;
    const approved = await engine.approve(pending, request, decision);
    clockTime = "2026-10-17T00:00:00.000Z";
    await expect(engine.assertImplementationReady(approved, request, decision, workflow())).resolves.toBeUndefined();
  });

  it.each(["criterion", "summary", "policy", "identity", "statusEvidence"])("detects unauthorized approved content edit: %s", async field => {
    const { pending, request, decision } = await review();
    const approved = await engine.approve(pending, request, decision);
    const edited = structuredClone(approved);
    if (field === "criterion") edited.acceptanceCriteria[0]!.description = "Weakened to fit failing implementation";
    if (field === "summary") edited.summary = "A different goal";
    if (field === "policy") edited.metadata = { ...edited.metadata, extra: "changed" };
    if (field === "identity") edited.specId = "other";
    if (field === "statusEvidence") edited.acceptanceCriteria[0]!.status = "satisfied";
    await expect(engine.assertImplementationReady(edited, request, decision, workflow())).rejects.toThrow(/modified/);
    expect(approved.acceptanceCriteria[0]!.status).toBe("pending");
  });

  it("rejects forged approval identity and unapproved implementation", async () => {
    const { pending, request, decision } = await review();
    await expect(engine.assertImplementationReady(pending, request, decision, workflow())).rejects.toThrow(/approved/);
    const approved = await engine.approve(pending, request, decision);
    await expect(engine.assertImplementationReady({ ...approved, approvedBy: "attacker" }, request, decision, workflow())).rejects.toThrow(/identity/);
  });

  it("prevents drafts from claiming acceptance or modifying approved versions in place", async () => {
    const spec = draft();
    spec.acceptanceCriteria[0]!.status = "satisfied";
    expect(() => engine.createDraft(spec)).toThrow(/pending/);
    const { pending, request, decision } = await review();
    const approved = await engine.approve(pending, request, decision);
    await expect(engine.submitForReview(approved)).rejects.toThrow(/draft/);
  });

  it("rejects cross-run or forged artifact references", async () => {
    const { pending } = await review();
    await expect(engine.verifyArtifact({ ...pending, artifactRef: { ...pending.artifactRef, runId: "other" } })).rejects.toThrow(/same run/);
    await expect(engine.verifyArtifact({ ...pending, artifactRef: { ...pending.artifactRef, checksum: { algorithm: "sha256", value: "0".repeat(64) } } })).rejects.toThrow();
  });

  it("propagates deleted artifact failure instead of accepting a stored flag", async () => {
    const { pending } = await review();
    await store.delete(pending.artifactRef!.artifactId);
    await expect(engine.verifyArtifact(pending)).rejects.toThrow(/get failed/);
  });

  it("rejects oversized specifications before storing them", async () => {
    await expect(engine.submitForReview({ ...draft(), summary: "x".repeat(1024 * 1024) })).rejects.toThrow(/size limit/);
  });
});

describe("versioning, acceptance management and impact analysis", () => {
  it("creates a new draft without altering approved criteria or version", async () => {
    const { pending, request, decision } = await review();
    const approved = await engine.approve(pending, request, decision);
    const next = revision(draft());
    const result = await engine.revise(approved, next, "User changed the required outcome");
    expect(result.specification).toMatchObject({ version: 2, status: "draft" });
    expect(result.specification.artifactRef).toBeUndefined();
    expect(result.specification.approvedBy).toBeUndefined();
    expect(result.impact.affectedTaskIds).toEqual(["implement"]);
    expect(approved.version).toBe(1);
    clockTime = later;
    const pendingV2 = await engine.submitForReview(result.specification);
    await expect(engine.approve(pendingV2, request, decision)).rejects.toThrow(/request/);
  });

  it("detects additions, removals and changed criteria with affected task IDs", () => {
    const old = draft();
    old.acceptanceCriteria.push({ ...old.acceptanceCriteria[0]!, id: "ac-removed" });
    old.metadata = { sdd: { ...policyDetails(old), traceability: [
      { criterionId: "ac-1", taskIds: ["implement"] }, { criterionId: "ac-removed", taskIds: ["old-task"] }
    ] } };
    old.traceabilityTaskIds = ["implement", "old-task"];
    const next = revision(draft());
    next.summary = old.summary;
    next.acceptanceCriteria[0]!.description = "Changed outcome";
    next.acceptanceCriteria.push({ ...next.acceptanceCriteria[0]!, id: "ac-added" });
    next.metadata = { sdd: { ...policyDetails(next), traceability: [
      { criterionId: "ac-1", taskIds: ["implement"] }, { criterionId: "ac-added", taskIds: ["new-task"] }
    ] } };
    next.traceabilityTaskIds = ["implement", "new-task"];
    const changes = detectSpecChanges(old, next);
    expect(changes).toMatchObject({ addedCriterionIds: ["ac-added"], removedCriterionIds: ["ac-removed"], changedCriterionIds: ["ac-1"],
      affectedTaskIds: ["implement", "new-task", "old-task"], requiresReapproval: true });
  });

  it("limits criterion-only changes to mapped tasks", () => {
    const old = draft();
    old.acceptanceCriteria.push({ ...old.acceptanceCriteria[0]!, id: "ac-2" });
    old.metadata = { sdd: { ...policyDetails(old), traceability: [
      { criterionId: "ac-1", taskIds: ["implement"] }, { criterionId: "ac-2", taskIds: ["unaffected"] }
    ] } };
    old.traceabilityTaskIds = ["implement", "unaffected"];
    const next = revision(old);
    next.summary = old.summary;
    next.acceptanceCriteria[0]!.description = "Changed criterion one";
    expect(detectSpecChanges(old, next)).toMatchObject({ globalRequirementsChanged: false, affectedTaskIds: ["implement"] });
  });

  it("rejects skipped versions, identity changes, no-op edits and absent revision reasons", async () => {
    await expect(engine.revise(draft(), { ...revision(), version: 3 }, "New request")).rejects.toThrow(/increment/);
    await expect(engine.revise(draft(), { ...revision(), sessionId: "other" }, "New request")).rejects.toThrow(/identity/);
    await expect(engine.revise(draft(), { ...revision(), summary: draft().summary }, "New request")).rejects.toThrow(/must change/);
    await expect(engine.revise(draft(), revision(), " ")).rejects.toThrow();
  });

  it("validates a real workflow and rejects orphan tasks and unmapped criteria", () => {
    expect(WorkflowDefinitionSchema.safeParse(workflow()).success).toBe(true);
    expect(() => validateTraceability(draft(), workflow())).not.toThrow();
    expect(() => validateTraceability(draft(), workflow(["other"]))).toThrow(/traceability/);
    const spec = draft();
    spec.acceptanceCriteria.push({ ...spec.acceptanceCriteria[0]!, id: "unmapped" });
    expect(() => validateTraceability(spec, workflow())).toThrow(/Every/);
  });

  it("rejects unknown, duplicated or inconsistent traceability bindings", () => {
    const spec = draft();
    spec.traceabilityTaskIds = ["other"];
    expect(() => parseSpecification(spec)).toThrow(/mapped task/);
    const unknown = draft();
    unknown.metadata = { sdd: { ...policyDetails(unknown), traceability: [{ criterionId: "missing", taskIds: ["implement"] }] } };
    expect(() => parseSpecification(unknown)).toThrow(/unknown/);
  });

  it.each(["trivial", "standard", "complex"])("example artifact %s satisfies the exported contract and P15 policy", async name => {
    const raw = JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), "utf8"));
    expect(SpecificationSchema.safeParse(raw).success).toBe(true);
    expect(() => parseSpecification(raw)).not.toThrow();
  });
});
