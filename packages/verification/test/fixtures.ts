import { createHash } from "node:crypto";
import {
  ArtifactReferenceSchema, ArtifactWriteOptionsSchema, GitChangeSetSchema,
  QualityGateResultSchema, SpecificationSchema, TestStrategySchema,
  type ArtifactReference, type ArtifactStore, type ArtifactWrite,
  type ArtifactQuery, type OperationResult, type Page, type QualityGate,
  type QualityGateContext, type QualityGateResult, type Specification
} from "@bflow/contracts";
import {
  CheckConfigurationSchema, ObservationSchema, createVerificationPlan,
  type Observation, type VerificationPlan
} from "../src/model.js";

export const now = "2026-10-16T01:00:00Z";
export const success = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const failure = (message: string): OperationResult<never> => ({ ok: false,
  error: { code: "corruption", retryable: false, message } });

/** Actual byte storage and integrity checks in a test double, never a production backend. */
export class FakeArtifactStore implements ArtifactStore {
  readonly records = new Map<string, { reference: ArtifactReference; bytes: Uint8Array }>();
  readonly writes: ArtifactWrite["options"][] = [];
  readonly reads: string[] = [];
  rejectWrites = false;
  async put(write: ArtifactWrite): Promise<OperationResult<ArtifactReference>> {
    const options = ArtifactWriteOptionsSchema.parse(write.options);
    this.writes.push(options);
    if (this.rejectWrites) return failure("Storage unavailable");
    const chunks: Uint8Array[] = [];
    for await (const chunk of write.content) chunks.push(Uint8Array.from(chunk));
    const bytes = Buffer.concat(chunks);
    const checksum = { algorithm: options.expectedIntegrity.checksum.algorithm,
      value: createHash(options.expectedIntegrity.checksum.algorithm).update(bytes).digest("hex") };
    if (checksum.value !== options.expectedIntegrity.checksum.value ||
        (options.expectedIntegrity.sizeBytes !== undefined && options.expectedIntegrity.sizeBytes !== bytes.length))
      return failure("Input integrity mismatch");
    const reference = ArtifactReferenceSchema.parse({
      trust: "stored", artifactId: options.artifactId, runId: options.runId,
      ...(options.taskId ? { taskId: options.taskId } : {}), kind: options.kind,
      uri: `artifact://test/${options.artifactId}`, mediaType: options.mediaType,
      sizeBytes: bytes.length, checksum, createdAt: now,
      ...(options.metadata ? { metadata: options.metadata } : {})
    });
    const previous = this.records.get(reference.artifactId);
    if (previous && previous.reference.checksum.value !== checksum.value) return failure("Immutable artifact conflict");
    this.records.set(reference.artifactId, { reference, bytes: Uint8Array.from(bytes) });
    return success(structuredClone(reference));
  }
  async *get(reference: ArtifactReference): AsyncIterable<OperationResult<Uint8Array>> {
    this.reads.push(reference.artifactId);
    const record = this.records.get(reference.artifactId);
    if (!record) { yield failure("Missing artifact"); return; }
    const checksum = createHash(reference.checksum.algorithm).update(record.bytes).digest("hex");
    if (checksum !== reference.checksum.value) { yield failure("Stored bytes corrupted"); return; }
    yield success(Uint8Array.from(record.bytes));
  }
  async resolve(artifactId: string): Promise<OperationResult<ArtifactReference | null>> {
    return success(structuredClone(this.records.get(artifactId)?.reference ?? null));
  }
  async find(query: ArtifactQuery): Promise<OperationResult<Page<ArtifactReference>>> {
    const items = [...this.records.values()].map(record => record.reference).filter(reference =>
      (!query.runId || query.runId === reference.runId) && (!query.taskId || query.taskId === reference.taskId) &&
      (!query.kind || query.kind === reference.kind));
    return success({ items: structuredClone(items) });
  }
  async delete(artifactId: string): Promise<OperationResult<boolean>> { return success(this.records.delete(artifactId)); }
  async seed(artifactId: string, kind: ArtifactReference["kind"], content: unknown, taskId = "task-1") {
    const bytes = Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
    const stored = await this.put({ options: { artifactId, runId: "run-1", taskId, kind,
      mediaType: "application/json", idempotencyKey: `seed-${artifactId}`,
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
        sizeBytes: bytes.length } }, content: (async function* () { yield bytes; })() });
    if (!stored.ok) throw new Error(stored.error.message);
    return stored.value;
  }
}

export type FakeMode = "passed" | "failed" | "blocked" | "malformed" | "missing" | "done";

/** A trusted host tool/reviewer boundary; it never executes a subprocess. */
export class FakeToolRunner implements QualityGate {
  readonly calls: QualityGateContext[] = [];
  mode: FakeMode = "passed";
  executorId = "independent-verifier";
  rewriteObservation?: (observation: Observation) => unknown;
  rewriteResult?: (result: QualityGateResult) => unknown;
  constructor(readonly id: string) {}
  async evaluate(context: QualityGateContext): Promise<OperationResult<QualityGateResult>> {
    this.calls.push(structuredClone(context));
    const config = CheckConfigurationSchema.parse(context.definition.configuration);
    const input = context.input as Record<string, unknown>;
    const passed = this.mode !== "failed";
    const observation = ObservationSchema.parse({
      schemaVersion: 2, checkId: this.id, runId: context.runId, taskId: context.taskId,
      attemptId: context.attemptId, sourceRevision: input.sourceRevision,
      specFingerprint: input.specFingerprint, scope: input.scope,
      independentExecution: true, isolated: true, executorId: this.executorId,
      role: config.role, method: config.method,
      ...(config.command ? { command: config.command, exitCode: passed ? 0 : 1 } : {}),
      testNames: config.testNames,
      criteria: config.criterionIds.map(criterionId => ({ criterionId, passed,
        summary: passed ? "Expected behavior independently observed" : "Expected behavior absent" })),
      summary: passed ? "Independent check passed" : "Independent check failed"
    });
    let verification: unknown = this.rewriteObservation?.(observation) ?? observation;
    if (this.mode === "malformed") verification = { ...observation, exitCode: "zero" };
    if (this.mode === "done") verification = { state: "done", summary: "Developer says done" };
    const result = QualityGateResultSchema.parse({
      gateId: this.id, runId: context.runId, taskId: context.taskId,
      evaluationId: `${this.id}-${context.attemptId}-${this.calls.length}`,
      status: this.mode === "blocked" ? "blocked" : passed ? "passed" : "failed",
      findings: this.mode === "failed" ? [{ code: "TARGET_BEHAVIOR", severity: "error", message: "Target assertion failed" }] : [],
      producedArtifacts: [], evaluatedAt: now,
      metadata: this.mode === "missing" ? {} : { verification }
    });
    // Deliberately permit malformed boundary data for ingress-validation tests.
    return success((this.rewriteResult?.(result) ?? result) as QualityGateResult);
  }
}

export async function fixture(options: { scope?: "task" | "workflow"; maxIterations?: number } = {}) {
  const store = new FakeArtifactStore();
  const scope = options.scope ?? "task";
  const level = scope === "workflow" ? "integration" : "unit";
  const method = scope === "workflow" ? "integration_test" : "unit_test";
  const testCommand = `pnpm test:${level}`;
  const strategy = TestStrategySchema.parse({
    schemaVersion: 2, strategyId: "strategy-1", specId: "spec-1",
    tddDecision: { schemaVersion: 2, decisionId: "decision-1", runId: "run-1", taskId: "task-1", specId: "spec-1",
      mode: "recommended", rationale: "Independent deterministic verification is available",
      verifiableConditions: ["Target behavior is covered by named test"], changeClassification: "domain_logic",
      requiresFailingTestFirst: false, decidedBy: "coordinator", decidedAt: now },
    requiredTestLevels: [level], targetCommands: [testCommand, "pnpm typecheck"],
    independentVerificationRequired: true,
    criterionMappings: [{ criterionId: "ac-1", testNames: ["target-behavior"] },
      { criterionId: "ac-types", testNames: ["types-valid"] },
      { criterionId: "ac-review", testNames: ["review-scope"] }], createdAt: now
  });
  const specDocument = {
    schemaVersion: 2, specId: "spec-1", runId: "run-1", sessionId: "session-1", level: "lightweight",
    title: "Verified behavior", summary: "Implement specified behavior", problemStatement: "Behavior missing",
    scope: { inScope: ["Target behavior"], outOfScope: ["Unrelated changes"] },
    acceptanceCriteria: [
      { id: "ac-1", description: "Target behavior matches expectation", category: "functional", verificationMethod: method },
      { id: "ac-types", description: "Types are valid", category: "non_functional", verificationMethod: "typecheck" },
      { id: "ac-review", description: "Independent review confirms scope", category: "non_functional", verificationMethod: "manual_review" }
    ].map(c => ({ ...c, required: true, status: "pending", evidenceArtifactIds: [] })),
    affectedPaths: ["packages/example"], status: "approved", createdBy: "architect", approvedBy: "human-1",
    createdAt: now, updatedAt: now, testStrategy: strategy, tddDecision: strategy.tddDecision
  };
  const artifactRef = await store.seed("spec-document", "document", specDocument);
  const specification = SpecificationSchema.parse({ ...specDocument, artifactRef });
  const makeCheck = (id: string, config: unknown) => ({ id, name: id, evaluator: id, required: true,
    timeout: { executionTimeoutMs: 1000, onTimeout: "block" }, configuration: config });
  const checks = [
    makeCheck("test-check", { kind: "deterministic", method, command: testCommand, criterionIds: ["ac-1"],
      testNames: ["target-behavior"], role: "tester", levels: [level] }),
    makeCheck("type-check", { kind: "deterministic", method: "typecheck", command: "pnpm typecheck", criterionIds: ["ac-types"],
      testNames: ["types-valid"], role: "quality_gate", levels: [] }),
    makeCheck("review-check", { kind: "review", method: "manual_review", criterionIds: ["ac-review"],
      testNames: ["review-scope"], role: "reviewer", levels: [] })
  ];
  const input = { runId: "run-1", taskId: "task-1", scope, specification, strategy, checks,
    implementerIds: ["developer-1"], ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}) };
  const plan: VerificationPlan = createVerificationPlan(input);
  const runners = checks.map(check => new FakeToolRunner(check.id));
  let currentSpecification: Specification = specification;
  const change = async (iteration = 1) => {
    const patchArtifact = await store.seed(`patch-${iteration}`, "patch", `diff --git a/packages/example/src/logic.ts b/packages/example/src/logic.ts\n+return ${iteration}\n`);
    return GitChangeSetSchema.parse({ schemaVersion: 2, changeSetId: `change-${iteration}`, runId: "run-1", taskId: "task-1",
      attemptId: `attempt-${iteration}`, worktreePath: "/tmp/example-task", branchName: "agent/example/task",
      baseCommitHash: "a".repeat(40), headCommitHash: iteration.toString(16).repeat(40), dirtyWorkingTree: false,
      filesChanged: [{ path: "packages/example/src/logic.ts", changeType: "modified", additions: 1, deletions: 1 }],
      patchArtifact, createdAt: now });
  };
  return { store, plan, input, specification, runners, change,
    ports: { artifactStore: store, gates: runners, loadSpecification: async () => structuredClone(currentSpecification), clock: () => now },
    setSpecification: (value: Specification) => { currentSpecification = value; } };
}
