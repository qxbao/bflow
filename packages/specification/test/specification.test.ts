import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRoleProfileSchema,
  ApprovalDecisionSchema,
  RoleMessageSchema,
  SpecificationSchema,
  WorkflowDefinitionSchema,
  type AcceptanceCriterion,
  type ArtifactQuery,
  type ArtifactReference,
  type ArtifactStore,
  type ArtifactWrite,
  type OperationOptions,
  type OperationResult,
  type Page,
  type VerificationResult
} from "@bflow/contracts";
import {
  ANALYST_ROLE_PROFILE,
  ARCHITECT_ROLE_PROFILE,
  SpecificationEngine,
  addCriterionToDraft,
  assertNoCriteriaWeakeningOnFailure,
  buildSpecRoleMessage,
  buildTraceabilityMatrix,
  classifyChange,
  classifyChangeSafe,
  createSpecificationArtifactProposal,
  detectSpecChanges,
  evaluateCriteriaFromVerification,
  getRequiredSpecSections,
  hasDataSchemaPathHint,
  hasPublicApiPathHint,
  hasSecurityPathHint,
  parseContractOrP15Specification,
  parseSpecification,
  policyDetails,
  removeCriterionFromDraft,
  renderSpecialistSpecificationPrompt,
  renderSpecification,
  updateCriterionInDraft,
  validateChangedFilesScope,
  validateSpecificationDocument,
  validateTraceability
} from "../src/index.js";
import { draft, now, later, workflow } from "./fixtures.js";

export interface TestArtifactStore extends ArtifactStore {
  close(): Promise<void> | void;
}

export async function openTestArtifactStore(options: { root: string; storeId: string }): Promise<OperationResult<TestArtifactStore>> {
  const { root, storeId } = options;
  await mkdir(root, { recursive: true });

  const store: TestArtifactStore = {
    async put(write: ArtifactWrite, _options?: OperationOptions): Promise<OperationResult<ArtifactReference>> {
      const { artifactId, kind, mediaType, runId, taskId, metadata, idempotencyKey } = write.options as any;
      const chunks: Buffer[] = [];
      for await (const chunk of write.content) {
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      const hash = createHash("sha256").update(data).digest("hex");
      const refPath = join(root, `${artifactId}.meta.json`);
      const dataPath = join(root, `${artifactId}.data`);

      try {
        const stored = JSON.parse(await readFile(refPath, "utf8")) as { ref: ArtifactReference; idempotencyKey?: string };
        if (idempotencyKey && stored.idempotencyKey === idempotencyKey) {
          return { ok: true, value: stored.ref };
        }
      } catch {
        // file doesn't exist yet, proceed
      }

      const ref: ArtifactReference = {
        trust: "stored",
        artifactId,
        runId,
        uri: `artifact://${storeId}/${artifactId}`,
        kind,
        mediaType,
        sizeBytes: data.length,
        checksum: { algorithm: "sha256", value: hash },
        createdAt: new Date().toISOString(),
        metadata: metadata ?? {},
        ...(taskId ? { taskId } : {})
      };

      await writeFile(dataPath, data);
      await writeFile(refPath, JSON.stringify({ ref, idempotencyKey }), "utf8");
      return { ok: true, value: ref };
    },

    get(reference: ArtifactReference, _options?: OperationOptions): AsyncIterable<OperationResult<Uint8Array>> {
      return (async function* () {
        const dataPath = join(root, `${reference.artifactId}.data`);
        try {
          const data = await readFile(dataPath);
          yield { ok: true, value: new Uint8Array(data) };
        } catch (err: any) {
          yield {
            ok: false,
            error: {
              code: "not_found",
              message: `Artifact ${reference.artifactId} not found`,
              retryable: false
            }
          };
        }
      })();
    },

    async resolve(artifactId: string, _options?: OperationOptions): Promise<OperationResult<ArtifactReference | null>> {
      const refPath = join(root, `${artifactId}.meta.json`);
      try {
        const stored = JSON.parse(await readFile(refPath, "utf8")) as { ref: ArtifactReference };
        return { ok: true, value: stored.ref };
      } catch {
        return { ok: true, value: null };
      }
    },

    async find(query: ArtifactQuery, _options?: OperationOptions): Promise<OperationResult<Page<ArtifactReference>>> {
      try {
        const files = await readdir(root);
        const metaFiles = files.filter(f => f.endsWith(".meta.json"));
        const items: ArtifactReference[] = [];
        for (const f of metaFiles) {
          const stored = JSON.parse(await readFile(join(root, f), "utf8")) as { ref: ArtifactReference };
          const meta = stored.ref;
          if (query.runId && meta.runId !== query.runId) continue;
          if (query.kind && meta.kind !== query.kind) continue;
          items.push(meta);
        }
        return { ok: true, value: { items, total: items.length } };
      } catch (err: any) {
        return {
          ok: false,
          error: {
            code: "internal",
            message: err.message,
            retryable: false
          }
        };
      }
    },

    async delete(artifactId: string, _options?: OperationOptions): Promise<OperationResult<boolean>> {
      const refPath = join(root, `${artifactId}.meta.json`);
      const dataPath = join(root, `${artifactId}.data`);
      try {
        await unlink(refPath);
      } catch {}
      try {
        await unlink(dataPath);
      } catch {}
      return { ok: true, value: true };
    },

    close() {
      // noop
    }
  };

  return { ok: true, value: store };
}

let directory: string;
let realStore: TestArtifactStore;
let currentWrapper: TestArtifactStore | undefined;
let store: TestArtifactStore;
let engine: SpecificationEngine;
let clockTime: string;
let testSeq = 0;
let firstWriteTestSeq: number | undefined;

function createNamespacedStore( getBacking: () => TestArtifactStore, seq: number): TestArtifactStore {
  const getPrefix = () => {
    if (firstWriteTestSeq === undefined) {
      firstWriteTestSeq = seq;
    }
    return firstWriteTestSeq === seq ? "" : `t${seq}-`;
  };
  const toPhysicalId = (id: string, prefix: string) => (prefix === "" || id.startsWith(prefix) ? id : `${prefix}${id}`);
  const toLogicalId = (id: string, prefix: string) => (prefix !== "" && id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const toLogicalRef = (ref: ArtifactReference, prefix: string): ArtifactReference => {
    if (prefix === "") return ref;
    const logicalId = toLogicalId(ref.artifactId, prefix);
    return {
      ...ref,
      artifactId: logicalId,
      uri: ref.uri.replace(`/${ref.artifactId}`, `/${logicalId}`)
    };
  };
  const toPhysicalRef = (ref: ArtifactReference, prefix: string): ArtifactReference => {
    if (prefix === "") return ref;
    const physicalId = toPhysicalId(ref.artifactId, prefix);
    return {
      ...ref,
      artifactId: physicalId,
      uri: ref.uri.replace(`/${ref.artifactId}`, `/${physicalId}`)
    };
  };
  return {
    async put(input, options) {
      const prefix = getPrefix();
      const physicalId = toPhysicalId(input.options.artifactId, prefix);
      const res = await getBacking().put(
        {
          ...input,
          options: {
            ...input.options,
            artifactId: physicalId,
            idempotencyKey: `${prefix}${input.options.idempotencyKey}`
          }
        },
        options
      );
      return res.ok ? { ok: true, value: toLogicalRef(res.value, prefix) } : res;
    },
    async resolve(artifactId, options) {
      const prefix = getPrefix();
      const res = await getBacking().resolve(toPhysicalId(artifactId, prefix), options);
      return res.ok && res.value ? { ok: true, value: toLogicalRef(res.value, prefix) } : res;
    },
    async find(query, options) {
      return getBacking().find(query, options);
    },
    get(reference, options) {
      const prefix = getPrefix();
      return getBacking().get(toPhysicalRef(reference, prefix), options);
    },
    async delete(artifactId, options) {
      const prefix = getPrefix();
      return getBacking().delete(toPhysicalId(artifactId, prefix), options);
    },
    close() {
      getBacking().close();
    }
  };
}

async function initStoreAndEngine(): Promise<void> {
  // No-op: initialized in beforeAll / beforeEach
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bflow-spec-"));
  const opened = await openTestArtifactStore({ root: join(directory, "artifacts"), storeId: "spec-tests" });
  if (!opened.ok) throw new Error(opened.error.message);
  realStore = opened.value;
});

afterAll(async () => {
  if (store && store !== currentWrapper) {
    realStore = store;
  }
  if (realStore) {
    realStore.close();
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

beforeEach(() => {
  if (store && currentWrapper && store !== currentWrapper) {
    realStore = store;
  }
  clockTime = now;
  testSeq += 1;
  currentWrapper = createNamespacedStore(() => realStore, testSeq);
  store = currentWrapper;
  engine = new SpecificationEngine({
    artifactStore: store,
    clock: () => new Date(clockTime),
    authorizeApprover: (decision, humanRequired) =>
      humanRequired ? decision.decidedBy === "human-owner" : ["human-owner", "coordinator"].includes(decision.decidedBy)
  });
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
  beforeEach(async () => {
    await initStoreAndEngine();
  });

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
    const reopened = await openTestArtifactStore({ root: join(directory, "artifacts"), storeId: "spec-tests" });
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
  beforeEach(async () => {
    await initStoreAndEngine();
  });

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

describe("canonical specification examples (all 4 pairs)", () => {
  it.each(["trivial", "standard", "complex", "api"] as const)(
    "validates %s.json against SpecificationSchema, parseSpecification, and matches %s.md via renderSpecification",
    async name => {
      const jsonRaw = JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), "utf8"));
      const mdRaw = await readFile(new URL(`../examples/${name}.md`, import.meta.url), "utf8");

      expect(SpecificationSchema.safeParse(jsonRaw).success).toBe(true);
      const parsed = parseSpecification(jsonRaw);
      expect(parsed.specId).toBeDefined();

      const rendered = renderSpecification(jsonRaw);
      expect(rendered).toBe(mdRaw);
    }
  );
});

describe("classification helpers and safe validators", () => {
  it("classifyChangeSafe returns success with valid assessment", () => {
    const assessment = policyDetails(draft()).assessment;
    const result = classifyChangeSafe(assessment, ["guide.md"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complexity).toBe("trivial");
      expect(result.value.level).toBe("lightweight");
      expect(result.value.riskLevel).toBe("low");
    }
  });

  it("classifyChangeSafe returns structured error on invalid input", () => {
    const result = classifyChangeSafe({ invalid: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("getRequiredSpecSections returns mandatory sections per complexity", () => {
    const trivialSections = getRequiredSpecSections("trivial");
    expect(trivialSections).toEqual([
      "title",
      "summary",
      "problemStatement",
      "scope",
      "acceptanceCriteria",
      "affectedPaths"
    ]);

    const standardSections = getRequiredSpecSections("standard");
    expect(standardSections).toEqual([
      "title",
      "summary",
      "problemStatement",
      "scope",
      "acceptanceCriteria",
      "affectedPaths",
      "functionalRequirements",
      "proposedTestStrategy"
    ]);

    const complexNoMigration = getRequiredSpecSections("complex", false);
    expect(complexNoMigration).toContain("designProposal");
    expect(complexNoMigration).toContain("technicalConstraints");
    expect(complexNoMigration).toContain("apiDataContracts");
    expect(complexNoMigration).toContain("risksAndTradeoffs");
    expect(complexNoMigration).toContain("architectureNotes");
    expect(complexNoMigration).toContain("securityConsiderations");
    expect(complexNoMigration).toContain("rollbackPlan");
    expect(complexNoMigration).toContain("testStrategy");
    expect(complexNoMigration).toContain("tddDecision");
    expect(complexNoMigration).not.toContain("dataModelChanges");
    expect(complexNoMigration).not.toContain("migrationStrategy");

    const complexWithMigration = getRequiredSpecSections("complex", true);
    expect(complexWithMigration).toContain("dataModelChanges");
    expect(complexWithMigration).toContain("migrationStrategy");
  });

  it("evaluates conservative path hints accurately", () => {
    expect(hasSecurityPathHint(["packages/auth/token.ts"])).toBe(true);
    expect(hasSecurityPathHint(["src/crypto/aes.ts"])).toBe(true);
    expect(hasSecurityPathHint(["src/secret.ts"])).toBe(true);
    expect(hasSecurityPathHint(["docs/readme.txt"])).toBe(false);

    expect(hasPublicApiPathHint(["packages/contracts/src/index.ts"])).toBe(true);
    expect(hasPublicApiPathHint(["proto/sdlc.proto"])).toBe(true);
    expect(hasPublicApiPathHint(["api/openapi.json"])).toBe(true);
    expect(hasPublicApiPathHint(["packages/core/src/runner.ts"])).toBe(false);

    expect(hasDataSchemaPathHint(["db/migrations/001.sql"])).toBe(true);
    expect(hasDataSchemaPathHint(["src/schema.ts"])).toBe(true);
    expect(hasDataSchemaPathHint(["data/query.sql"])).toBe(true);
    expect(hasDataSchemaPathHint(["src/components/button.tsx"])).toBe(false);
  });

  it("validateSpecificationDocument validates and returns OperationResult", () => {
    const validResult = validateSpecificationDocument(draft());
    expect(validResult.ok).toBe(true);
    if (validResult.ok) {
      expect(validResult.value.specId).toBe("spec-1");
    }

    const invalidResult = validateSpecificationDocument({ ...draft(), version: undefined });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.error.code).toBe("validation");
    }
  });
});

describe("specification artifact proposal and RoleMessage egress", () => {
  it("creates a JSON artifact proposal with accurate checksum and size", () => {
    const spec = draft();
    const { proposal, bytes, checksum } = createSpecificationArtifactProposal(spec, {
      proposalId: "proposal-json-1"
    });
    expect(proposal.proposalId).toBe("proposal-json-1");
    expect(proposal.runId).toBe(spec.runId);
    expect(proposal.kind).toBe("document");
    expect(proposal.mediaType).toBe("application/json");
    expect(proposal.logicalName).toBe(`${spec.specId}-v1.json`);
    expect(proposal.expectedIntegrity.checksum.value).toBe(checksum);
    expect(proposal.expectedIntegrity.sizeBytes).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("creates a Markdown artifact proposal when requested", () => {
    const spec = draft();
    const markdown = renderSpecification(spec);
    const { proposal, bytes, checksum } = createSpecificationArtifactProposal(spec, {
      proposalId: "proposal-md-1",
      format: "markdown",
      renderedMarkdown: markdown
    });
    expect(proposal.proposalId).toBe("proposal-md-1");
    expect(proposal.mediaType).toBe("text/markdown");
    expect(proposal.logicalName).toBe(`${spec.specId}-v1.md`);
    expect(proposal.expectedIntegrity.checksum.value).toBe(checksum);
    expect(bytes.toString("utf8")).toBe(markdown);
  });

  it("supports custom logicalName option", () => {
    const spec = draft();
    const { proposal } = createSpecificationArtifactProposal(spec, {
      proposalId: "proposal-custom-1",
      logicalName: "custom-spec.json"
    });
    expect(proposal.logicalName).toBe("custom-spec.json");
  });

  it("rejects proposal creation when runId is missing", () => {
    const spec = draft();
    delete spec.runId;
    expect(() => createSpecificationArtifactProposal(spec, { proposalId: "p-1" }))
      .toThrow(/run ID is required/);
  });

  it("rejects markdown proposal when renderedMarkdown is empty", () => {
    const spec = draft();
    expect(() => createSpecificationArtifactProposal(spec, {
      proposalId: "p-1",
      format: "markdown",
      renderedMarkdown: "   "
    })).toThrow(/renderedMarkdown must not be empty/);
  });

  it("builds a valid spec.draft RoleMessage envelope", () => {
    const spec = draft();
    const message = buildSpecRoleMessage({
      messageId: "msg-draft-1",
      correlationId: "corr-1",
      causationId: "cause-1",
      runId: spec.runId!,
      senderRole: "specifier",
      senderAgentId: "analyst-agent",
      senderPaneId: "pane-1",
      type: "spec.draft",
      spec
    });

    expect(RoleMessageSchema.safeParse(message).success).toBe(true);
    expect(message.type).toBe("spec.draft");
    expect(message.sender.role).toBe("specifier");
    expect(message.recipient.role).toBe("coordinator");
    expect(message.payload).toMatchObject({
      specId: spec.specId,
      specLevel: spec.level,
      title: spec.title,
      authorRole: "specifier"
    });
  });

  it("builds a valid spec.approved RoleMessage envelope with notes", async () => {
    const { pending, request, decision } = await review();
    const approved = await engine.approve(pending, request, decision);
    const message = buildSpecRoleMessage({
      messageId: "msg-approved-1",
      correlationId: "corr-2",
      runId: approved.runId!,
      senderRole: "coordinator",
      type: "spec.approved",
      spec: approved,
      notes: "Approved for execution"
    });

    expect(RoleMessageSchema.safeParse(message).success).toBe(true);
    expect(message.type).toBe("spec.approved");
    expect(message.sender.role).toBe("coordinator");
    expect(message.recipient.role).toBe("conversation");
    expect(message.payload).toMatchObject({
      specId: approved.specId,
      approvedBy: "human-owner",
      notes: "Approved for execution"
    });
  });
});

describe("acceptance criteria draft mutations", () => {
  it("adds a criterion to draft and updates traceability and test strategy", () => {
    const spec = draft("api");
    const newCriterion: AcceptanceCriterion = {
      id: "ac-2",
      description: "Additional security assertion",
      category: "security",
      verificationMethod: "e2e_test",
      required: true,
      status: "pending",
      evidenceArtifactIds: []
    };
    const updated = addCriterionToDraft(spec, newCriterion, ["task-sec"]);
    expect(updated.acceptanceCriteria).toHaveLength(2);
    expect(updated.acceptanceCriteria.some(c => c.id === "ac-2")).toBe(true);
    expect(updated.traceabilityTaskIds).toEqual(["implement", "task-sec"]);
    expect(updated.testStrategy?.criterionMappings.some(m => m.criterionId === "ac-2")).toBe(true);
  });

  it("rejects adding criterion to non-draft specification", async () => {
    const { pending } = await review();
    const newCriterion: AcceptanceCriterion = {
      id: "ac-2",
      description: "Another criterion",
      category: "functional",
      verificationMethod: "unit_test",
      required: true,
      status: "pending",
      evidenceArtifactIds: []
    };
    expect(() => addCriterionToDraft(pending, newCriterion)).toThrow(/non-draft/);
  });

  it("rejects adding criterion with non-pending status or evidence", () => {
    const spec = draft();
    expect(() => addCriterionToDraft(spec, {
      id: "ac-2",
      description: "Invalid start",
      category: "functional",
      verificationMethod: "manual_review",
      required: true,
      status: "satisfied",
      evidenceArtifactIds: []
    })).toThrow(/pending/);
  });

  it("rejects duplicate criterion ID", () => {
    const spec = draft();
    expect(() => addCriterionToDraft(spec, {
      id: "ac-1",
      description: "Duplicate",
      category: "functional",
      verificationMethod: "unit_test",
      required: true,
      status: "pending",
      evidenceArtifactIds: []
    })).toThrow(/Duplicate/);
  });

  it("updates a criterion in draft including mapped tasks", () => {
    const spec = draft();
    const updated = updateCriterionInDraft(spec, "ac-1", {
      description: "Updated verifiable description",
      verificationMethod: "integration_test",
      mappedTaskIds: ["new-task"]
    });
    expect(updated.acceptanceCriteria[0]?.description).toBe("Updated verifiable description");
    expect(updated.acceptanceCriteria[0]?.verificationMethod).toBe("integration_test");
    expect(updated.traceabilityTaskIds).toEqual(["new-task"]);
  });

  it("rejects updating criterion on non-draft or unknown criterion ID", async () => {
    const { pending } = await review();
    expect(() => updateCriterionInDraft(pending, "ac-1", { description: "change" })).toThrow(/non-draft/);
    expect(() => updateCriterionInDraft(draft(), "non-existent", { description: "change" })).toThrow(/not found/);
  });

  it("removes a criterion from draft and cleans up mappings", () => {
    const spec = draft();
    const withTwo = addCriterionToDraft(spec, {
      id: "ac-2",
      description: "Second criterion",
      category: "functional",
      verificationMethod: "unit_test",
      required: false,
      status: "pending",
      evidenceArtifactIds: []
    }, ["task-2"]);
    const removed = removeCriterionFromDraft(withTwo, "ac-2");
    expect(removed.acceptanceCriteria).toHaveLength(1);
    expect(removed.acceptanceCriteria[0]?.id).toBe("ac-1");
    expect(removed.traceabilityTaskIds).toEqual(["implement"]);
  });

  it("rejects removing the last required criterion or non-existent criterion", () => {
    const spec = draft();
    expect(() => removeCriterionFromDraft(spec, "non-existent")).toThrow(/not found/);
    expect(() => removeCriterionFromDraft(spec, "ac-1")).toThrow(/at least one criterion must be required/);
  });
});

describe("assertNoCriteriaWeakeningOnFailure", () => {
  function makeFailedVerification(criterionId = "ac-1"): VerificationResult {
    const artRef = {
      artifactId: "art-test-1",
      runId: "run-1",
      kind: "test-result" as const,
      trust: "stored" as const,
      mediaType: "application/json",
      checksum: { algorithm: "sha256" as const, value: "a".repeat(64) },
      sizeBytes: 100,
      createdAt: now,
      uri: "artifact://run-1/art-test-1"
    };
    return {
      schemaVersion: 2,
      verificationId: "ver-1",
      runId: "run-1",
      taskId: "implement",
      cycleNumber: 1,
      attemptId: "att-1",
      status: "failed",
      independentExecution: true,
      evaluatedCriteria: [
        {
          criterionId,
          passed: false,
          evidenceArtifactId: "art-test-1",
          summary: "Assertion failed in unit test"
        }
      ],
      qualityGateResults: [],
      evidenceArtifacts: [artRef],
      findings: [],
      verifiedBy: "tester",
      startedAt: now,
      completedAt: later
    };
  }

  function draftWithTwoRequired(): ReturnType<typeof draft> {
    const base = draft("bugfix");
    return addCriterionToDraft(base, {
      id: "ac-2",
      description: "Second required criterion",
      category: "functional",
      verificationMethod: "unit_test",
      required: true,
      status: "pending",
      evidenceArtifactIds: []
    }, ["implement"]);
  }

  it("blocks removal of a failed acceptance criterion", () => {
    const prev = draftWithTwoRequired();
    const failedVer = makeFailedVerification("ac-1");
    const proposed = removeCriterionFromDraft(prev, "ac-1");

    expect(() => assertNoCriteriaWeakeningOnFailure(prev, proposed, failedVer))
      .toThrow(/Cannot weaken or remove failed acceptance criterion ac-1/);
  });

  it("blocks downgrading a failed criterion from required: true to required: false", () => {
    const prev = draftWithTwoRequired();
    const failedVer = makeFailedVerification("ac-1");
    const proposed = updateCriterionInDraft(prev, "ac-1", { required: false });

    expect(() => assertNoCriteriaWeakeningOnFailure(prev, proposed, failedVer))
      .toThrow(/Cannot weaken or remove failed acceptance criterion ac-1/);
  });

  it("blocks weakening verification method rigor on a failed criterion", () => {
    const prev = draftWithTwoRequired();
    const failedVer = makeFailedVerification("ac-1");
    const proposed = updateCriterionInDraft(prev, "ac-1", { verificationMethod: "manual_review" });

    expect(() => assertNoCriteriaWeakeningOnFailure(prev, proposed, failedVer))
      .toThrow(/Cannot weaken or remove failed acceptance criterion ac-1/);
  });

  it("blocks description edit on a failed criterion", () => {
    const prev = draftWithTwoRequired();
    const failedVer = makeFailedVerification("ac-1");
    const proposed = updateCriterionInDraft(prev, "ac-1", { description: "Reworded to match what failed code does" });

    expect(() => assertNoCriteriaWeakeningOnFailure(prev, proposed, failedVer))
      .toThrow(/Cannot weaken or remove failed acceptance criterion ac-1/);
  });

  it("allows criteria modifications when explicitUserRequirementChangeAuthorized is true", () => {
    const prev = draftWithTwoRequired();
    const failedVer = makeFailedVerification("ac-1");
    const proposed = removeCriterionFromDraft(prev, "ac-1");

    expect(() => assertNoCriteriaWeakeningOnFailure(prev, proposed, failedVer, {
      explicitUserRequirementChangeAuthorized: true
    })).not.toThrow();
  });
});

describe("evaluateCriteriaFromVerification", () => {
  function makeVerificationResult(
    criteriaEvals: { criterionId: string; passed: boolean }[],
    runId = "run-1"
  ): VerificationResult {
    const artRef = {
      artifactId: "art-ev-1",
      runId,
      kind: "test-result" as const,
      trust: "stored" as const,
      mediaType: "application/json",
      checksum: { algorithm: "sha256" as const, value: "b".repeat(64) },
      sizeBytes: 150,
      createdAt: now,
      uri: `artifact://${runId}/art-ev-1`
    };
    const allPassed = criteriaEvals.every(c => c.passed);
    return {
      schemaVersion: 2,
      verificationId: "ver-eval-1",
      runId,
      taskId: "implement",
      cycleNumber: 1,
      attemptId: "att-eval-1",
      status: allPassed ? "passed" : "failed",
      independentExecution: true,
      evaluatedCriteria: criteriaEvals.map(c => ({
        criterionId: c.criterionId,
        passed: c.passed,
        evidenceArtifactId: "art-ev-1",
        summary: c.passed ? "All tests passed" : "Test failed"
      })),
      qualityGateResults: [],
      evidenceArtifacts: [artRef],
      findings: [],
      verifiedBy: "tester",
      startedAt: now,
      completedAt: later
    };
  }

  it("evaluates all satisfied criteria correctly without mutating spec", () => {
    const spec = draft();
    const specSnapshot = JSON.stringify(spec);
    const verification = makeVerificationResult([{ criterionId: "ac-1", passed: true }]);

    const summary = evaluateCriteriaFromVerification(spec, verification);
    expect(summary.allRequiredSatisfied).toBe(true);
    expect(summary.evaluations).toHaveLength(1);
    expect(summary.evaluations[0]).toMatchObject({
      criterionId: "ac-1",
      required: true,
      status: "satisfied",
      evidenceArtifactIds: ["art-ev-1"]
    });
    expect(JSON.stringify(spec)).toBe(specSnapshot);
  });

  it("evaluates failed criteria and leaves unverified criteria pending", () => {
    const spec = draft();
    const withOptional = addCriterionToDraft(spec, {
      id: "ac-opt",
      description: "Optional criterion",
      category: "non_functional",
      verificationMethod: "lint",
      required: false,
      status: "pending",
      evidenceArtifactIds: []
    });
    const verification = makeVerificationResult([{ criterionId: "ac-1", passed: false }]);
    const summary = evaluateCriteriaFromVerification(withOptional, verification);
    expect(summary.allRequiredSatisfied).toBe(false);

    const ac1 = summary.evaluations.find(e => e.criterionId === "ac-1");
    expect(ac1?.status).toBe("failed");

    const acOpt = summary.evaluations.find(e => e.criterionId === "ac-opt");
    expect(acOpt?.status).toBe("pending");
  });

  it("throws when verification runId does not match specification runId", () => {
    const spec = draft();
    const verification = makeVerificationResult([{ criterionId: "ac-1", passed: true }], "other-run");
    expect(() => evaluateCriteriaFromVerification(spec, verification))
      .toThrow(/Verification runId does not match specification runId/);
  });
});

describe("traceability matrix, changed files scope, and DAG change detection", () => {
  it("buildTraceabilityMatrix produces complete bidirectional mapping and checks validity", () => {
    const spec = draft();
    const wf = workflow();

    const validMatrix = buildTraceabilityMatrix(spec, wf);
    expect(validMatrix.valid).toBe(true);
    expect(validMatrix.orphanCriterionIds).toHaveLength(0);
    expect(validMatrix.unmappedWorkflowTaskIds).toHaveLength(0);
    expect(validMatrix.unknownMappedTaskIds).toHaveLength(0);
    expect(validMatrix.criterionToTasks["ac-1"]).toEqual(["implement"]);
    expect(validMatrix.taskToCriteria["implement"]).toEqual(["ac-1"]);

    const orphanSpec = structuredClone(spec);
    orphanSpec.acceptanceCriteria.push({
      id: "ac-orphan",
      description: "Orphan",
      category: "functional",
      verificationMethod: "unit_test",
      required: false,
      status: "pending",
      evidenceArtifactIds: []
    });
    const orphanMatrix = buildTraceabilityMatrix(orphanSpec, wf);
    expect(orphanMatrix.valid).toBe(false);
    expect(orphanMatrix.orphanCriterionIds).toContain("ac-orphan");

    const extraTaskWf = workflow(["implement", "task-extra"]);
    const extraMatrix = buildTraceabilityMatrix(spec, extraTaskWf);
    expect(extraMatrix.valid).toBe(false);
    expect(extraMatrix.unmappedWorkflowTaskIds).toContain("task-extra");
  });

  it("validateChangedFilesScope checks exact, directory prefix, glob, and out of scope paths", () => {
    const spec = draft();
    spec.affectedPaths = ["packages/core/**", "docs/guide.md", "src/index.ts"];

    expect(validateChangedFilesScope(spec, ["docs/guide.md", "src/index.ts"]))
      .toEqual({ withinScope: true, outOfScopePaths: [] });

    expect(validateChangedFilesScope(spec, ["packages/core/src/runner.ts"]))
      .toEqual({ withinScope: true, outOfScopePaths: [] });

    const outResult = validateChangedFilesScope(spec, [
      "packages/core/src/runner.ts",
      "packages/runtime/src/service.ts",
      "apps/cli/bin.ts"
    ]);
    expect(outResult.withinScope).toBe(false);
    expect(outResult.outOfScopePaths).toEqual([
      "packages/runtime/src/service.ts",
      "apps/cli/bin.ts"
    ]);
  });

  it("detectSpecChanges with multi-task DAG calculates transitivelyAffectedTaskIds, changedFields, and unchangedCriterionIds", () => {
    const oldSpec = draft();
    oldSpec.acceptanceCriteria.push({
      id: "ac-2",
      description: "Stable independent criterion",
      category: "functional",
      verificationMethod: "unit_test",
      required: false,
      status: "pending",
      evidenceArtifactIds: []
    });
    oldSpec.metadata = {
      sdd: {
        ...policyDetails(oldSpec),
        traceability: [
          { criterionId: "ac-1", taskIds: ["task-A"] },
          { criterionId: "ac-2", taskIds: ["task-D"] }
        ]
      }
    };
    oldSpec.traceabilityTaskIds = ["task-A", "task-D"];

    // Criterion-only change: preserve top-level requirements and summary so globalRequirementsChanged remains false
    const nextSpec = revision(oldSpec);
    nextSpec.summary = oldSpec.summary;
    nextSpec.acceptanceCriteria[0]!.description = "Changed criterion 1";

    const dagWorkflow = {
      schemaVersion: "1" as const,
      id: "dag-flow",
      name: "DAG Flow",
      version: "1.0.0",
      tasks: [
        {
          id: "task-A", title: "Task A", role: "developer", instruction: "Do A",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed" as const, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" as const },
          requiresApproval: false, qualityGates: []
        },
        {
          id: "task-B", title: "Task B", role: "developer", instruction: "Do B",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed" as const, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" as const },
          requiresApproval: false, qualityGates: []
        },
        {
          id: "task-C", title: "Task C", role: "developer", instruction: "Do C",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed" as const, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" as const },
          requiresApproval: false, qualityGates: []
        },
        {
          id: "task-D", title: "Task D", role: "developer", instruction: "Do D",
          acceptanceCriteria: ["ac-2"],
          retry: { maxAttempts: 1, strategy: "fixed" as const, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" as const },
          requiresApproval: false, qualityGates: []
        }
      ],
      dependencies: [
        { taskId: "task-B", dependsOnTaskId: "task-A", condition: "succeeded" as const },
        { taskId: "task-C", dependsOnTaskId: "task-B", condition: "succeeded" as const }
      ],
      qualityGates: [],
      maxConcurrency: 2,
      failurePolicy: "block" as const,
      recovery: { checkpoint: "task-boundary" as const, resumeStrategy: "checkpoint-then-replay" as const, staleExecution: "reconcile" as const }
    };

    const changes = detectSpecChanges(oldSpec, nextSpec, dagWorkflow);

    expect(changes.changedCriterionIds).toEqual(["ac-1"]);
    expect(changes.unchangedCriterionIds).toEqual(["ac-2"]);
    expect(changes.affectedTaskIds).toEqual(["task-A"]);
    expect(changes.transitivelyAffectedTaskIds).toEqual(["task-A", "task-B", "task-C"]);
    expect(changes.transitivelyAffectedTaskIds).not.toContain("task-D");

    // Also verify changedFields when a top-level requirement is modified
    const nextSpecWithFieldChange = revision(oldSpec);
    nextSpecWithFieldChange.summary = "A distinctly modified summary";
    const changesWithField = detectSpecChanges(oldSpec, nextSpecWithFieldChange, dagWorkflow);
    expect(changesWithField.changedFields).toContain("summary");
  });
});

describe("engine reject and supersede lifecycle", () => {
  beforeEach(async () => {
    await initStoreAndEngine();
  });

  it("rejects with decision 'rejected' transitioning spec to 'rejected' status", async () => {
    const { pending, request, decision } = await review();
    const rejectDecision = {
      ...decision,
      decision: "rejected" as const,
      reason: "Security concerns"
    };

    const result = await engine.reject(pending, request, rejectDecision);
    expect(result.specification.status).toBe("rejected");
    expect(result.specification.artifactRef).toEqual(pending.artifactRef);
    expect(result.specification.updatedAt).toBe(rejectDecision.decidedAt);
  });

  it("rejects with decision 'changes_requested' reverting spec to clean 'draft' status", async () => {
    const { pending, request, decision } = await review();
    const reworkDecision = {
      ...decision,
      decision: "changes_requested" as const,
      reason: "Clarify error handling"
    };

    const result = await engine.reject(pending, request, reworkDecision);
    expect(result.specification.status).toBe("draft");
    expect(result.specification.artifactRef).toBeUndefined();
    expect(result.specification.approvedBy).toBeUndefined();
    expect(result.specification.updatedAt).toBe(reworkDecision.decidedAt);
  });

  it("supersedes an approved v1 specification when approved v2 is presented", async () => {
    const { pending: pendingV1, request: requestV1, decision: decisionV1 } = await review();
    const approvedV1 = await engine.approve(pendingV1, requestV1, decisionV1);
    expect(approvedV1.status).toBe("approved");

    clockTime = later;
    const nextDraft = revision(draft());
    const { specification: draftV2 } = await engine.revise(
      approvedV1,
      nextDraft,
      "Requirement update for v2"
    );

    const pendingV2 = await engine.submitForReview(draftV2);
    const requestV2 = await engine.requestApproval(pendingV2, {
      approvalId: "approval-v2",
      requestedBy: "coordinator"
    });
    const decisionV2 = ApprovalDecisionSchema.parse({
      schemaVersion: 2,
      approvalId: requestV2.approvalId,
      runId: requestV2.runId,
      sessionId: requestV2.sessionId,
      target: requestV2.target,
      revision: requestV2.revision,
      generation: 0,
      decision: "approved",
      decidedBy: "human-owner",
      decidedAt: later,
      feedbackArtifacts: [],
      idempotencyKey: "decision-v2"
    });
    const approvedV2 = await engine.approve(pendingV2, requestV2, decisionV2);
    expect(approvedV2.status).toBe("approved");
    expect(approvedV2.version).toBe(2);

    const supersededV1 = await engine.supersede(approvedV1, approvedV2);
    expect(supersededV1.status).toBe("superseded");
    expect(supersededV1.version).toBe(1);
    expect(supersededV1.updatedAt).toBe(approvedV2.updatedAt);
  });

  it("rejects supersede if specifications are not approved or versions are not consecutive", async () => {
    const { pending } = await review();
    await expect(engine.supersede(pending, pending)).rejects.toThrow(/approved/);
  });
});

describe("analyst and architect role profiles and prompts", () => {
  it("ANALYST_ROLE_PROFILE conforms to AgentRoleProfileSchema and defines expected boundaries", () => {
    expect(AgentRoleProfileSchema.safeParse(ANALYST_ROLE_PROFILE).success).toBe(true);
    expect(ANALYST_ROLE_PROFILE.role).toBe("specifier");
    expect(ANALYST_ROLE_PROFILE.readOnlyWorkspace).toBe(true);
    expect(ANALYST_ROLE_PROFILE.userFacing).toBe(false);
    expect(ANALYST_ROLE_PROFILE.requiresDedicatedPane).toBe(true);
    expect(ANALYST_ROLE_PROFILE.allowedRecipients).toEqual(["coordinator", "runtime"]);
  });

  it("ARCHITECT_ROLE_PROFILE conforms to AgentRoleProfileSchema and defines expected boundaries", () => {
    expect(AgentRoleProfileSchema.safeParse(ARCHITECT_ROLE_PROFILE).success).toBe(true);
    expect(ARCHITECT_ROLE_PROFILE.role).toBe("architect");
    expect(ARCHITECT_ROLE_PROFILE.readOnlyWorkspace).toBe(true);
    expect(ARCHITECT_ROLE_PROFILE.userFacing).toBe(false);
    expect(ARCHITECT_ROLE_PROFILE.requiresDedicatedPane).toBe(true);
    expect(ARCHITECT_ROLE_PROFILE.allowedRecipients).toEqual(["coordinator", "runtime"]);
  });

  it("matches agents/analyst/role-profile.json and agents/architect/role-profile.json on disk", async () => {
    const analystJson = JSON.parse(
      await readFile(new URL("../../../agents/analyst/role-profile.json", import.meta.url), "utf8")
    );
    expect(AgentRoleProfileSchema.safeParse(analystJson).success).toBe(true);
    expect(analystJson.role).toBe("specifier");

    const architectJson = JSON.parse(
      await readFile(new URL("../../../agents/architect/role-profile.json", import.meta.url), "utf8")
    );
    expect(AgentRoleProfileSchema.safeParse(architectJson).success).toBe(true);
    expect(architectJson.role).toBe("architect");
  });

  it("renders specialist prompt for analyst in drafting mode", () => {
    const prompt = renderSpecialistSpecificationPrompt({
      role: "specifier",
      title: "Analyze User Authentication Flow",
      objective: "Formulate acceptance criteria and scope for JWT login",
      affectedPaths: ["packages/auth/**"]
    });

    expect(prompt).toContain("Analyst (`specifier`)");
    expect(prompt).toContain("Analyze User Authentication Flow");
    expect(prompt).toContain("Formulate acceptance criteria and scope for JWT login");
    expect(prompt).toContain("`packages/auth/**`");
    expect(prompt).toContain("New Specification Draft (v1)");
    expect(prompt).toContain("Requirement Analysis");
  });

  it("renders specialist prompt for architect in revision mode with existing spec", () => {
    const spec = draft("api");
    const prompt = renderSpecialistSpecificationPrompt({
      role: "architect",
      title: "Revise API Contract Schema",
      objective: "Extend public endpoints with pagination",
      affectedPaths: ["packages/contracts/src/api.ts"],
      existingSpec: spec
    });

    expect(prompt).toContain("Architect (`architect`)");
    expect(prompt).toContain("Specification Revision");
    expect(prompt).toContain("Existing: spec-1 v1");
    expect(prompt).toContain("**Target Next Version**: `2`");
    expect(prompt).toContain("Architecture & Constraints");
    expect(prompt).toContain("Revision Rules");
  });
});

describe("Argon 4 High Review Remediation regressions", () => {
  it("buildSpecRoleMessage validates runId, sender role, approval status, and draft status", async () => {
    const draftSpec = draft();
    const { pending, request, decision } = await review();
    const approvedSpec = await engine.approve(pending, request, decision);

    // 1. rejecting unapproved spec for spec.approved
    expect(() => buildSpecRoleMessage({
      messageId: "msg-fail-1",
      correlationId: "corr-1",
      runId: draftSpec.runId!,
      senderRole: "coordinator",
      type: "spec.approved",
      spec: draftSpec
    })).toThrow("spec.approved message requires an approved specification with approvedBy and artifactRef");

    // 2. non-coordinator sender for spec.approved
    expect(() => buildSpecRoleMessage({
      messageId: "msg-fail-2",
      correlationId: "corr-2",
      runId: approvedSpec.runId!,
      senderRole: "specifier" as any,
      type: "spec.approved",
      spec: approvedSpec
    })).toThrow("Only coordinator may emit spec.approved RoleMessage");

    // 3. mismatched runId
    expect(() => buildSpecRoleMessage({
      messageId: "msg-fail-3",
      correlationId: "corr-3",
      runId: "run-different",
      senderRole: "coordinator",
      type: "spec.approved",
      spec: approvedSpec
    })).toThrow("Specification runId must match RoleMessage runId");

    // 4. non-draft/review_pending spec for spec.draft (e.g. approved spec)
    expect(() => buildSpecRoleMessage({
      messageId: "msg-fail-4",
      correlationId: "corr-4",
      runId: approvedSpec.runId!,
      senderRole: "specifier",
      type: "spec.draft",
      spec: approvedSpec
    })).toThrow("spec.draft message requires a draft or review_pending specification");

    // non-draft/review_pending spec for spec.draft (e.g. rejected spec)
    const rejectedSpec = { ...draftSpec, status: "rejected" as const };
    expect(() => buildSpecRoleMessage({
      messageId: "msg-fail-5",
      correlationId: "corr-5",
      runId: rejectedSpec.runId!,
      senderRole: "specifier",
      type: "spec.draft",
      spec: rejectedSpec
    })).toThrow("spec.draft message requires a draft or review_pending specification");

    // Ensure artifactReferences has at least 1 reference for spec.approved when options.artifactReferences is not passed
    const msg = buildSpecRoleMessage({
      messageId: "msg-ok-1",
      correlationId: "corr-ok",
      runId: approvedSpec.runId!,
      senderRole: "coordinator",
      type: "spec.approved",
      spec: approvedSpec
    });
    expect(msg.artifact_references.length).toBeGreaterThanOrEqual(1);
    expect(msg.artifact_references[0]).toEqual(approvedSpec.artifactRef);
  });

  it("createSpecificationArtifactProposal accepts standard contract spec without metadata.sdd", () => {
    const rawContractsSpec = {
      schemaVersion: 2,
      specId: "spec-1",
      runId: "run-1",
      sessionId: "session-1",
      level: "lightweight",
      complexity: "trivial",
      riskLevel: "low",
      version: 1,
      title: "Contracts-only spec",
      summary: "Summary of changes",
      problemStatement: "Problem description",
      scope: { inScope: ["Example"], outOfScope: [] },
      acceptanceCriteria: [{
        id: "ac-1",
        description: "Criterion description",
        category: "functional",
        verificationMethod: "unit_test",
        required: true,
        status: "pending",
        evidenceArtifactIds: []
      }],
      affectedPaths: ["src/index.ts"],
      traceabilityTaskIds: ["implement"],
      status: "draft",
      createdBy: "analyst",
      createdAt: now,
      updatedAt: now,
      metadata: {} // missing sdd!
    };

    const result = createSpecificationArtifactProposal(rawContractsSpec, {
      proposalId: "prop-1"
    });
    expect(result.proposal.proposalId).toBe("prop-1");
    expect(result.proposal.runId).toBe("run-1");
    expect(result.proposal.kind).toBe("document");
    expect(result.checksum).toBeDefined();
  });

  it("functions accepting Specification handle standard contract spec without metadata.sdd", () => {
    const rawContractsSpec = {
      schemaVersion: 2,
      specId: "spec-1",
      runId: "run-1",
      sessionId: "session-1",
      level: "lightweight",
      complexity: "trivial",
      riskLevel: "low",
      version: 1,
      title: "Contracts-only spec",
      summary: "Summary of changes",
      problemStatement: "Problem description",
      scope: { inScope: ["Example"], outOfScope: [] },
      acceptanceCriteria: [{
        id: "ac-1",
        description: "Criterion description",
        category: "functional",
        verificationMethod: "unit_test",
        required: true,
        status: "pending",
        evidenceArtifactIds: []
      }],
      affectedPaths: ["src/index.ts"],
      traceabilityTaskIds: ["implement"],
      status: "draft",
      createdBy: "analyst",
      createdAt: now,
      updatedAt: now,
      metadata: {}
    };

    // 1. evaluateCriteriaFromVerification
    const artRef: ArtifactReference = {
      trust: "stored",
      artifactId: "art-ev-1",
      runId: "run-1",
      kind: "log",
      uri: "artifact://spec-tests/art-ev-1",
      mediaType: "text/plain",
      sizeBytes: 10,
      checksum: { algorithm: "sha256", value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      createdAt: now
    };

    const verification: VerificationResult = {
      schemaVersion: 2,
      verificationId: "ver-1",
      runId: "run-1",
      taskId: "implement",
      cycleNumber: 1,
      attemptId: "att-1",
      status: "passed",
      independentExecution: true,
      evaluatedCriteria: [{
        criterionId: "ac-1",
        passed: true,
        evidenceArtifactId: "art-ev-1",
        summary: "Unit test passed"
      }],
      qualityGateResults: [],
      evidenceArtifacts: [artRef],
      findings: [],
      verifiedBy: "tester",
      startedAt: now,
      completedAt: now
    };
    const evalSummary = evaluateCriteriaFromVerification(rawContractsSpec, verification);
    expect(evalSummary.allRequiredSatisfied).toBe(true);
    expect(evalSummary.evaluations).toHaveLength(1);

    // 2. buildTraceabilityMatrix
    const wf = workflow(["implement"]);
    const matrix = buildTraceabilityMatrix(rawContractsSpec, wf);
    expect(matrix.valid).toBe(true);
    expect(matrix.criterionToTasks["ac-1"]).toContain("implement");

    // 3. validateTraceability
    expect(() => validateTraceability(rawContractsSpec, wf)).not.toThrow();

    // 4. validateChangedFilesScope
    const scopeCheck = validateChangedFilesScope(rawContractsSpec, ["src/index.ts"]);
    expect(scopeCheck.withinScope).toBe(true);

    // 5. renderSpecification
    const rendered = renderSpecification(rawContractsSpec);
    expect(rendered).toContain("# Contracts-only spec");
    expect(rendered).toContain("[ac-1] Criterion description");
  });

  it("buildTraceabilityMatrix correctly maps multi-task workflow criteria for contract specs without metadata.sdd", () => {
    const rawMultiTaskSpec = {
      schemaVersion: 2,
      specId: "spec-multi-1",
      runId: "run-1",
      sessionId: "session-1",
      level: "lightweight",
      complexity: "standard",
      riskLevel: "medium",
      version: 1,
      title: "Multi-task spec without sdd",
      summary: "Multi-task test",
      problemStatement: "Problem description",
      scope: { inScope: ["Example"], outOfScope: [] },
      acceptanceCriteria: [
        {
          id: "ac-1",
          description: "First criterion",
          category: "functional",
          verificationMethod: "unit_test",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        },
        {
          id: "ac-2",
          description: "Second criterion",
          category: "functional",
          verificationMethod: "unit_test",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        }
      ],
      affectedPaths: ["src/index.ts"],
      traceabilityTaskIds: ["task-a", "task-b"],
      status: "draft",
      createdBy: "analyst",
      createdAt: now,
      updatedAt: now,
      metadata: {} // No sdd!
    };

    const multiTaskWf = {
      schemaVersion: "1",
      id: "flow-multi",
      name: "Multi-Task Flow",
      version: "1.0.0",
      tasks: [
        {
          id: "task-a",
          title: "Task A",
          role: "developer",
          instruction: "Implement ac-1",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" },
          requiresApproval: false,
          qualityGates: []
        },
        {
          id: "task-b",
          title: "Task B",
          role: "developer",
          instruction: "Implement ac-2",
          acceptanceCriteria: ["ac-2"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" },
          requiresApproval: false,
          qualityGates: []
        }
      ],
      dependencies: [],
      qualityGates: [],
      maxConcurrency: 2,
      failurePolicy: "block",
      recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
    };

    const matrix = buildTraceabilityMatrix(rawMultiTaskSpec, multiTaskWf);
    expect(matrix.valid).toBe(true);
    expect(matrix.criterionToTasks["ac-1"]).toEqual(["task-a"]);
    expect(matrix.criterionToTasks["ac-2"]).toEqual(["task-b"]);
    expect(matrix.taskToCriteria["task-a"]).toEqual(["ac-1"]);
    expect(matrix.taskToCriteria["task-b"]).toEqual(["ac-2"]);

    expect(() => validateTraceability(rawMultiTaskSpec, multiTaskWf)).not.toThrow();
  });

  it("validateChangedFilesScope rejects path traversal and does not treat file pattern as directory prefix", () => {
    const spec = draft();
    spec.affectedPaths = ["packages/core/**", "src/index.ts"];

    // 1. Path traversal attacks
    const traversalResult = validateChangedFilesScope(spec, [
      "packages/core/../../packages/contracts/src/index.ts",
      "/etc/passwd",
      "../secret.ts"
    ]);
    expect(traversalResult.withinScope).toBe(false);
    expect(traversalResult.outOfScopePaths).toEqual([
      "packages/core/../../packages/contracts/src/index.ts",
      "/etc/passwd",
      "../secret.ts"
    ]);

    // 2. Exact file pattern must not match nested file
    const nestedResult = validateChangedFilesScope(spec, ["src/index.ts/nested.ts"]);
    expect(nestedResult.withinScope).toBe(false);
    expect(nestedResult.outOfScopePaths).toEqual(["src/index.ts/nested.ts"]);

    // 3. Exact file match succeeds
    const validResult = validateChangedFilesScope(spec, ["src/index.ts"]);
    expect(validResult.withinScope).toBe(true);
    expect(validResult.outOfScopePaths).toEqual([]);

    // 4. Ingress Zod validation rejects invalid changedPathsInput
    expect(() => validateChangedFilesScope(spec, ["   "])).toThrow();
    expect(() => validateChangedFilesScope(spec, "not-array" as any)).toThrow();
  });

  it("assertNoCriteriaWeakeningOnFailure checks identity, category change, and addCriterionToDraft rejects blank taskIds", () => {
    const base = draft("bugfix");
    const prev = addCriterionToDraft(base, {
      id: "ac-2",
      description: "Second required criterion",
      category: "functional",
      verificationMethod: "unit_test",
      required: true,
      status: "pending",
      evidenceArtifactIds: []
    }, ["implement"]);

    const artRef = {
      artifactId: "art-test-1",
      runId: "run-1",
      kind: "test-result" as const,
      trust: "stored" as const,
      mediaType: "application/json",
      checksum: { algorithm: "sha256" as const, value: "a".repeat(64) },
      sizeBytes: 100,
      createdAt: now,
      uri: "artifact://run-1/art-test-1"
    };
    const failedVer: VerificationResult = {
      schemaVersion: 2,
      verificationId: "ver-1",
      runId: "run-1",
      taskId: "implement",
      cycleNumber: 1,
      attemptId: "att-1",
      status: "failed",
      independentExecution: true,
      evaluatedCriteria: [{
        criterionId: "ac-1",
        passed: false,
        evidenceArtifactId: "art-test-1",
        summary: "Test assertion failure"
      }],
      qualityGateResults: [],
      evidenceArtifacts: [artRef],
      findings: [],
      verifiedBy: "tester",
      startedAt: now,
      completedAt: later
    };

    // Identity mismatches
    expect(() => assertNoCriteriaWeakeningOnFailure({ ...prev, specId: "spec-other" }, prev, failedVer))
      .toThrow("Criteria weakening check requires matching specification, session and run identity");

    expect(() => assertNoCriteriaWeakeningOnFailure({ ...prev, sessionId: "session-other" }, prev, failedVer))
      .toThrow("Criteria weakening check requires matching specification, session and run identity");

    expect(() => assertNoCriteriaWeakeningOnFailure({ ...prev, runId: "run-other" }, prev, failedVer))
      .toThrow("Criteria weakening check requires matching specification, session and run identity");

    const mismatchedVerRunId = {
      ...failedVer,
      runId: "run-other",
      evidenceArtifacts: [{ ...artRef, runId: "run-other", uri: "artifact://run-other/art-test-1" }]
    };
    expect(() => assertNoCriteriaWeakeningOnFailure(prev, prev, mismatchedVerRunId))
      .toThrow("Verification runId does not match specification runId");

    // Category change on a failed criterion
    const categoryChanged = updateCriterionInDraft(prev, "ac-1", { category: "security" });
    expect(() => assertNoCriteriaWeakeningOnFailure(prev, categoryChanged, failedVer))
      .toThrow(/Cannot weaken or remove failed acceptance criterion ac-1/);

    // Explicit user requirement change authorization bypasses category check
    expect(() => assertNoCriteriaWeakeningOnFailure(prev, categoryChanged, failedVer, {
      explicitUserRequirementChangeAuthorized: true
    })).not.toThrow();

    // addCriterionToDraft & updateCriterionInDraft reject blank mappedTaskIds
    expect(() => addCriterionToDraft(base, {
      id: "ac-blank",
      description: "Blank task mapping test",
      category: "functional",
      verificationMethod: "unit_test",
      required: false,
      status: "pending",
      evidenceArtifactIds: []
    }, ["   "])).toThrow();

    expect(() => updateCriterionInDraft(base, "ac-1", { mappedTaskIds: ["  "] })).toThrow();
  });

  it("engine.supersede rejects superseding spec whose updatedAt precedes previous.updatedAt", async () => {
    const { pending: pendingV1, request: requestV1, decision: decisionV1 } = await review();
    const approvedV1 = await engine.approve(pendingV1, requestV1, decisionV1);

    clockTime = later;
    const nextDraft = revision(draft());
    const { specification: draftV2 } = await engine.revise(
      approvedV1,
      nextDraft,
      "Requirement update for v2"
    );

    const pendingV2 = await engine.submitForReview(draftV2);
    const requestV2 = await engine.requestApproval(pendingV2, {
      approvalId: "approval-v2-regr",
      requestedBy: "coordinator"
    });
    const decisionV2 = ApprovalDecisionSchema.parse({
      schemaVersion: 2,
      approvalId: requestV2.approvalId,
      runId: requestV2.runId,
      sessionId: requestV2.sessionId,
      target: requestV2.target,
      revision: requestV2.revision,
      generation: 0,
      decision: "approved",
      decidedBy: "human-owner",
      decidedAt: later,
      feedbackArtifacts: [],
      idempotencyKey: "decision-v2-regr"
    });
    const approvedV2 = await engine.approve(pendingV2, requestV2, decisionV2);

    // Previous with later timestamp, next with earlier timestamp (valid per-schema since updatedAt >= createdAt)
    const prevWithLater = { ...approvedV1, updatedAt: later };
    const nextWithNow = { ...approvedV2, createdAt: now, updatedAt: now };

    await expect(engine.supersede(prevWithLater, nextWithNow))
      .rejects.toThrow("Superseding specification timestamp cannot precede previous specification");
  });
});
