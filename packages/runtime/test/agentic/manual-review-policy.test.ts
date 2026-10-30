import { createHerdrAdapter } from "@bflow/herdr-adapter";
import { projectPolicyPhaseRequest } from "../../src/agentic/policy-prompt.js";
import { AgentRequestSchema, RoleMessageSchema } from "@bflow/contracts";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactReferenceSchema,
  PaneBindingSchema,
  QualityGateResultSchema,
  SpecificationSchema,
  TestStrategySchema,
  VerificationResultSchema,
  WorkflowDefinitionSchema,
  type ArtifactReference,
  type PaneBinding,
  type QualityGateResult,
  type Specification,
  type TestStrategy,
  type WorkflowDefinition
} from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AssessmentSchema, TestStrategyResolver, assertEvidenceComplete, assertReadyToImplement, recordEvidence } from "@bflow/test-strategy";
function assessment(taskType: string, overrides: Record<string, unknown> = {}) {
  return AssessmentSchema.parse({ policyVersion: 1, taskId: "task-1", taskType,
    changeImpact: { surfaces: [taskType], behaviorChanged: true, deterministic: true,
      regressionReproducible: true, securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [] },
    testability: { level: "automated", rationale: "Deterministic independent regression checks" },
    riskClassification: "low", conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }, ...overrides });
}
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification, defaultHostChecks } from "../../src/agentic/host-verification.js";
import { TestRunnerSource, resolveTaskCommands } from "../../src/agentic/task-commands.js";
import { WorkflowProposalRejected } from "../../src/agentic/workflow-rejection.js";
import { parseBehavioralCommands, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { digest } from "../../src/agentic/journal.js";
import { projectTaskSpecificationInput } from "../../src/agentic/runtime.js";
import { compactPolicyReviewDossier } from "../../src/agentic/mcp-output-views.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

function refusal(action: () => unknown) {
  let observed: unknown;
  try { action(); } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(WorkflowProposalRejected);
  return (observed as WorkflowProposalRejected).rejection;
}

const TEST_NAME_1 = "ac-1: Structural drift checks";

/** Sanitized fixture matching the exact shape of Việc #3 draft v5 (high-risk, 4 integration criteria, 4 tasks). */
function highRiskDataQualityProposal(): { specification: Specification; definition: WorkflowDefinition; strategy: TestStrategy } {
  const policyAssessment = assessment("domain_logic", {
    taskType: "domain_logic",
    riskClassification: "high",
    changeImpact: {
      surfaces: ["domain_logic", "api_contract", "validation", "integration", "infrastructure"],
      behaviorChanged: true,
      deterministic: true,
      regressionReproducible: true,
      securitySensitive: true,
      dataMigration: false,
      scope: "cross_module"
    },
    infrastructure: {
      readiness: "ready",
      commands: [
        { method: "integration_test", command: "auto:integration", level: "integration" },
        { method: "static_analysis", command: "auto:static" }
      ]
    },
    conventions: {
      tdd: "required",
      requiredMethods: [],
      suggestedLevels: ["integration", "regression"]
    }
  });

  const testPaths = [
    "packages/runtime/test/fixtures/dbt-data-quality/structural.test.cjs",
    "packages/runtime/test/fixtures/dbt-data-quality/fixture.test.cjs",
    "packages/runtime/test/fixtures/dbt-data-quality/adversarial.test.cjs",
    "packages/runtime/test/fixtures/dbt-data-quality/boundary.test.cjs"
  ];

  const specification = SpecificationSchema.parse({
    schemaVersion: 2,
    specId: "spec-dq-drift-v5",
    runId: "run-dq-1",
    sessionId: "conv-dq-1",
    level: "full",
    complexity: "complex",
    riskLevel: "high",
    title: "Data-contract drift and data-quality verification",
    summary: "High-risk data-contract drift verification proposal with four integration criteria",
    problemStatement: "Directional structural drift and isolated fixture quality verification.",
    scope: {
      inScope: ["Approved data contracts", "Structural drift policy", "Isolated fixture execution"],
      outOfScope: ["Production warehouse access", "Destructive migrations"]
    },
    acceptanceCriteria: [
      { id: "ac-1", description: "Structural drift and data-quality outcomes are separated.", category: "functional", verificationMethod: "integration_test", required: true, status: "pending", evidenceArtifactIds: [] },
      { id: "ac-2", description: "At least one local run on isolated fixture.", category: "functional", verificationMethod: "integration_test", required: true, status: "pending", evidenceArtifactIds: [] },
      { id: "ac-3", description: "Test compatible/breaking changes and violations.", category: "functional", verificationMethod: "integration_test", required: true, status: "pending", evidenceArtifactIds: [] },
      { id: "ac-4", description: "Do not claim warehouse/live acceptance from fixture tests.", category: "functional", verificationMethod: "integration_test", required: true, status: "pending", evidenceArtifactIds: [] }
    ],
    affectedPaths: [
      "packages/runtime/src/agentic/data-quality/contracts.ts",
      "packages/runtime/src/agentic/data-quality/structural.ts",
      ...testPaths
    ],
    architectureNotes: "Reuse existing host execution, ArtifactStore and independent gates.",
    securityConsiderations: "Untrusted dependencies execute only in existing sandbox.",
    rollbackPlan: "Disable new suite via reviewed configuration.",
    testStrategy: {
      schemaVersion: 2,
      strategyId: "strategy-dq-1",
      specId: "spec-dq-drift-v5",
      tddDecision: {
        schemaVersion: 2,
        decisionId: "tdd-dq-1",
        runId: "run-dq-1",
        specId: "spec-dq-drift-v5",
        taskId: "dq-structural",
        mode: "required",
        rationale: "High-risk domain change requires TDD.",
        verifiableConditions: ["ac-1", "ac-2", "ac-3", "ac-4"],
        changeClassification: "domain_logic",
        requiresFailingTestFirst: true,
        decidedBy: "coordinator",
        decidedAt: "2026-10-28T08:02:00.000Z"
      },
      requiredTestLevels: ["integration"],
      targetCommands: ["auto:integration", "auto:static"],
      independentVerificationRequired: true,
      criterionMappings: [
        { criterionId: "ac-1", testNames: [TEST_NAME_1] },
        { criterionId: "ac-2", testNames: ["ac-2: Fixture runner checks"] },
        { criterionId: "ac-3", testNames: ["ac-3: Adversarial test checks"] },
        { criterionId: "ac-4", testNames: ["ac-4: Evidence boundary checks"] }
      ],
      createdAt: "2026-10-28T08:02:00.000Z"
    },
    tddDecision: {
      schemaVersion: 2,
      decisionId: "tdd-dq-1",
      runId: "run-dq-1",
      specId: "spec-dq-drift-v5",
      taskId: "dq-structural",
      mode: "required",
      rationale: "High-risk domain change requires TDD.",
      verifiableConditions: ["ac-1", "ac-2", "ac-3", "ac-4"],
      changeClassification: "domain_logic",
      requiresFailingTestFirst: true,
      decidedBy: "coordinator",
      decidedAt: "2026-10-28T08:02:00.000Z"
    },
    version: 5,
    traceabilityTaskIds: ["dq-structural", "dq-fixture", "dq-adversarial", "dq-evidence-boundary"],
    status: "draft",
    createdBy: "coordinator",
    createdAt: "2026-10-28T08:02:00.000Z",
    updatedAt: "2026-10-28T08:55:00.000Z",
    metadata: {
      conditionalTdd: policyAssessment,
      sdd: {
        policyVersion: 1,
        assessment: {
          kind: "feature",
          behaviorChange: true,
          modules: ["contracts", "runtime"],
          securityImpact: true,
          publicApiImpact: true,
          dataSchemaImpact: true,
          architectureImpact: true,
          migrationRequired: false,
          risk: "high"
        }
      }
    }
  });

  const strategy = TestStrategySchema.parse({
    ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [
      { criterionId: "ac-1", testNames: [TEST_NAME_1] },
      { criterionId: "ac-2", testNames: ["ac-2: Fixture runner checks"] },
      { criterionId: "ac-3", testNames: ["ac-3: Adversarial test checks"] },
      { criterionId: "ac-4", testNames: ["ac-4: Evidence boundary checks"] }
    ]
  });

  const definition = WorkflowDefinitionSchema.parse({
    schemaVersion: "1",
    id: "def-dq-v5",
    name: "Data-contract drift and isolated real dbt fixture",
    version: "1.0.0",
    tasks: [
      {
        id: "dq-structural",
        title: "Structural drift checks",
        role: "developer",
        instruction: "Implement structural drift contracts",
        acceptanceCriteria: ["ac-1"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
        requiresApproval: true,
        qualityGates: [],
        metadata: { ownedPaths: ["packages/runtime/src/agentic/data-quality/contracts.ts", testPaths[0]!] }
      },
      {
        id: "dq-fixture",
        title: "Fixture runner checks",
        role: "developer",
        instruction: "Implement fixture execution",
        acceptanceCriteria: ["ac-2"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
        requiresApproval: true,
        qualityGates: [],
        metadata: { ownedPaths: ["packages/runtime/src/agentic/data-quality/structural.ts", testPaths[1]!] }
      },
      {
        id: "dq-adversarial",
        title: "Adversarial checks",
        role: "developer",
        instruction: "Implement adversarial tests",
        acceptanceCriteria: ["ac-3"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
        requiresApproval: true,
        qualityGates: [],
        metadata: { ownedPaths: [testPaths[2]!] }
      },
      {
        id: "dq-evidence-boundary",
        title: "Evidence boundary checks",
        role: "developer",
        instruction: "Verify evidence boundary",
        acceptanceCriteria: ["ac-4"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
        requiresApproval: true,
        qualityGates: [],
        metadata: { ownedPaths: [testPaths[3]!] }
      }
    ],
    dependencies: [
      { taskId: "dq-fixture", dependsOnTaskId: "dq-structural", condition: "succeeded" },
      { taskId: "dq-adversarial", dependsOnTaskId: "dq-fixture", condition: "succeeded" },
      { taskId: "dq-evidence-boundary", dependsOnTaskId: "dq-adversarial", condition: "succeeded" }
    ],
    qualityGates: [],
    maxConcurrency: 1,
    failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
  });

  return { specification, definition, strategy };
}

async function createTestWorkspace(readiness: "ready" | "partial" = "ready") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-manual-review-test-")));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await mkdir(join(cwd, "test"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.cjs"), "module.exports = x => x + 1;\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  const base = git("rev-parse", "HEAD");
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  const testSource = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const value=require('../source.cjs'); test(${JSON.stringify(TEST_NAME_1)},()=>assert.equal(value(2),4));\n`;
  await writeFile(join(cwd, "test/structural.test.cjs"), testSource);
  const redRevision = commit("failing acceptance test");

  const profiles: RunnerProfile[] = [
    {
      id: "auto-integration",
      command: "auto:integration",
      method: "integration_test",
      levels: ["integration", "regression"],
      source: "detected",
      executable: process.execPath,
      args: ["--test", "--test-reporter=tap"],
      reporter: "node_tap",
      timeoutMs: 180_000,
      checkoutDependencyRoots: [],
      dependencySource: cwd,
      definitionBlobs: {}
    }
  ];
  const source = new TestRunnerSource([], cwd, async () => ({ status: "detected", profiles, notes: [] }));
  await source.refresh();

  const openedStore = await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "manual-review-test" });
  if (!openedStore.ok) throw new Error(openedStore.error.message);
  const store = openedStore.value;
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const { specification: fullDraft } = highRiskDataQualityProposal();
  const taskDraft = projectTaskSpecificationInput(
    fullDraft,
    "dq-structural",
    [fullDraft.acceptanceCriteria[0]!],
    "structural"
  );
  const specBytes = Buffer.from(JSON.stringify(taskDraft));
  const specPut = await store.put({
    options: {
      artifactId: "accepted-spec-dq",
      runId: "run-dq-1",
      taskId: "dq-structural",
      kind: "document",
      mediaType: "application/json",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(specBytes).digest("hex") }, sizeBytes: specBytes.length },
      idempotencyKey: "accepted-spec-dq"
    },
    content: (async function* () { yield specBytes; })()
  });
  if (!specPut.ok) throw new Error(specPut.error.message);

  // Adjust paths to match this local fixture repo
  let specification = SpecificationSchema.parse({
    ...taskDraft,
    metadata: { ...taskDraft.metadata, conditionalTdd: { ...taskDraft.metadata!.conditionalTdd as object, infrastructure: { readiness, commands: [{ method: "integration_test", command: "auto:integration", level: "integration" }, { method: "static_analysis", command: "auto:static" }] } } },
    affectedPaths: ["source.cjs", "test/structural.test.cjs"],
    status: "approved",
    approvedBy: "architect",
    artifactRef: specPut.value
  });

  const strategy = new TestStrategyResolver().resolve(specification);

  const receiptsPath = join(root, "host-receipts");
  const journal = new HostReceiptJournal(receiptsPath, cwd, "session-dq-1");

  const binding = PaneBindingSchema.parse({
    schemaVersion: 2,
    bindingId: "tester-binding",
    sessionId: "session-dq-1",
    role: "qa",
    session: { source: "test", kind: "id", value: "independent-qa-native" },
    agentId: "independent-tester",
    paneId: "tester-pane",
    workspaceId: "workspace",
    tabId: "tab",
    provider: "test",
    agentKind: "test",
    cwd,
    isolationMode: "dedicated_pane",
    readOnlyWorkspace: true,
    transportState: "idle",
    boundAt: new Date().toISOString()
  });


  let currentStrategy = strategy;
  const target = { transport: "herdr", agentId: "developer", paneId: "developer-pane", workspaceId: "workspace", tabId: "tab", worktreePath: cwd,
    session: { source: "test", kind: "id", value: "implementer-native" } };
  const handle = { executionId: "dev-execution", requestId: "assignment-1", attemptId: "dev-attempt-1", runId: "run-dq-1", taskId: "dq-structural",
    idempotencyKey: "assignment-1", target, correlation: { token: "assignment-1", provenance: "transport", verified: true }, acceptedAt: new Date().toISOString() };
  const assignment = { status: "accepted", taskId: "dq-structural", message: { schema_version: 2, message_id: "assignment-1", correlation_id: "correlation-1",
    run_id: "run-dq-1", sender: { role: "coordinator" }, recipient: { role: "developer" }, type: "task.assignment", payload: {}, artifact_references: [] }, handle };
  let request: any;
  const runtime = {
    inspect: async (runId?: string) => runId ? {
      baseRevision: base, tasks: [{ taskId: "dq-structural", spec: { specification, strategy: currentStrategy } }]
    } : { outbound: [assignment, ...(request ? [request] : [])] },
    ports: { policies: { recordEvidence: (_s: unknown, r: unknown) => {
      currentStrategy = recordEvidence(currentStrategy, r); return currentStrategy;
    } } }
  } as unknown as AgenticWorkflowRuntime;
  const requestPhase = (phase: string) => {
    const id = randomUUID();
    request = { status: "accepted", lease: { leaseId: id, fencingToken: 1, version: 1, agentId: binding.agentId, runId: "run-dq-1", taskId: "phase-"+phase, attemptId: handle.attemptId, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString() }, message: { schema_version: 2, message_id: id, correlation_id: "correlation-1", run_id: "run-dq-1",
      sender: { role: "coordinator" }, recipient: { role: "qa" }, type: "verification.requested", artifact_references: [],
      payload: { kind: "conditional_evidence", runId: "run-dq-1", taskId: "dq-structural", phase, sourceRevision: git("rev-parse", "HEAD"),
        implementationAttemptId: handle.attemptId, specification, strategy: currentStrategy } },
      handle: { ...handle, executionId: id, requestId: id, taskId: "phase-"+phase, idempotencyKey: id,
        target: { ...target, agentId: binding.agentId, paneId: binding.paneId, session: binding.session } } };
    return request;
  };

  const hostChecks = defaultHostChecks();
  const host = new HostVerification(
    () => runtime,
    () => store,
    journal,
    source,
    undefined,
    undefined,
    [],
    { suites: [] },
    hostChecks
  );

  return { root, cwd, git, commit, get specification() { return specification; }, get strategy() { return currentStrategy; }, redRevision, base,
    binding, host, store, journal, requestPhase, assignment,
    changeSpec() { specification = SpecificationSchema.parse({ ...specification, version: (specification.version ?? 1) + 1, summary: "Revised accepted specification" }); },
    reopen() { return new HostVerification(() => runtime, () => store, new HostReceiptJournal(receiptsPath, cwd, "session-dq-1"), source,
      undefined, undefined, [], { suites: [] }, hostChecks); } };

}

describe("manual-review policy proposal ingress and evidence lifecycle", () => {
  it("reproduces unsupported_method rejection when review capability is absent (Acceptance A)", async () => {
    const { specification, definition, strategy } = highRiskDataQualityProposal();
    expect(strategy.metadata?.conditionalTdd?.requiredVerificationMethods).toEqual(
      expect.arrayContaining(["integration_test", "static_analysis", "manual_review"])
    );
    expect(specification.acceptanceCriteria.map(c => c.verificationMethod)).toEqual([
      "integration_test", "integration_test", "integration_test", "integration_test"
    ]);

    const profiles: RunnerProfile[] = [
      {
        id: "auto-integration", command: "auto:integration", method: "integration_test",
        levels: ["integration", "regression"], source: "detected", executable: process.execPath,
        args: ["node_modules/vitest/vitest.mjs", "run", "--reporter=json"], reporter: "vitest_json",
        timeoutMs: 180_000, checkoutDependencyRoots: [], dependencySource: process.cwd()
      }
    ];
    const source = new TestRunnerSource([], process.cwd(), async () => ({ status: "detected", profiles, notes: [] }));
    await source.refresh();

    // Without review capability configured, proposal must fail closed with unsupported_method for manual_review
    const hostWithoutReview = new HostVerification(
      () => ({}) as AgenticWorkflowRuntime,
      () => { throw new Error("unused"); },
      undefined,
      source,
      undefined,
      undefined,
      [],
      { suites: [] },
      [] // review capability explicitly absent
    );

    const rejection = refusal(() => hostWithoutReview.assertSupported(specification, strategy, definition));
    expect(rejection.code).toBe("unsupported_method");
    expect(rejection.methods).toEqual(["manual_review"]);
    expect(rejection.reason).toContain("manual_review");
  });

  it("admits high-risk proposal when review capability is present (Acceptance B)", async () => {
    const { specification, definition, strategy } = highRiskDataQualityProposal();
    const profiles: RunnerProfile[] = [
      {
        id: "auto-integration", command: "auto:integration", method: "integration_test",
        levels: ["integration", "regression"], source: "detected", executable: process.execPath,
        args: ["node_modules/vitest/vitest.mjs", "run", "--reporter=json"], reporter: "vitest_json",
        timeoutMs: 180_000, checkoutDependencyRoots: [], dependencySource: process.cwd()
      }
    ];
    const source = new TestRunnerSource([], process.cwd(), async () => ({ status: "detected", profiles, notes: [] }));
    await source.refresh();

    const hostChecks = defaultHostChecks();
    const hostWithReview = new HostVerification(
      () => ({}) as AgenticWorkflowRuntime,
      () => { throw new Error("unused"); },
      undefined,
      source,
      undefined,
      undefined,
      [],
      { suites: [] },
      hostChecks // review capability provided via host checks
    );

    // This should NOT throw unsupported_method: manual_review!
    expect(() => hostWithReview.assertSupported(specification, strategy, definition)).not.toThrow();
    // Tasks should also be supported
    expect(() => hostWithReview.assertTaskSupported(
      specification,
      strategy,
      definition.tasks[0]!.metadata!.ownedPaths as string[]
    )).not.toThrow();
  });

  it("validates automated capabilities and rejects genuinely unsupported methods (Acceptance C)", async () => {
    const { specification, definition, strategy } = highRiskDataQualityProposal();
    const source = new TestRunnerSource([], process.cwd(), async () => ({ status: "detected", profiles: [], notes: [] }));
    await source.refresh();

    const hostChecks = defaultHostChecks();
    const host = new HostVerification(
      () => ({}) as AgenticWorkflowRuntime,
      () => { throw new Error("unused"); },
      undefined,
      source,
      undefined,
      undefined,
      [],
      { suites: [] },
      hostChecks
    );

    // With no integration runner detected, integration_test must be rejected
    const rejection = refusal(() => host.assertSupported(specification, strategy, definition));
    expect(rejection.code).toBe("unsupported_method");
    expect(rejection.methods).toContain("integration_test");
  });

  const input = (phase: string) => ({ runId: "run-dq-1", taskId: "dq-structural", phase });
  const criteria = [{ criterionId: "ac-1", passed: true, summary: "Reviewed the actual diff and risk boundaries" }];
  async function implemented(readiness: "ready" | "partial" = "ready") {
    const f = await createTestWorkspace(readiness);
    if (readiness === "ready") { f.requestPhase("red"); await f.host.behavioralEvidence(f.binding, input("red")); }
    await writeFile(join(f.cwd, "source.cjs"), "module.exports = x => x * 2;\n"); f.commit("implement behavior");
    f.requestPhase(readiness === "ready" ? "green" : "verification"); return f;
  }
  it("keeps unique review requirements without duplicating prior raw measurement payloads", async () => {
    const f = await implemented(), strategy = structuredClone(f.strategy);
    const evidence = strategy.metadata!.tddEvidence as any[];
    evidence[0].metadata.largeRawOutput = "x".repeat(150000);
    const wire = RoleMessageSchema.parse({schema_version:2,message_id:"phase-presentation",correlation_id:"corr",run_id:"run-dq-1",sender:{role:"coordinator"},recipient:{role:"qa"},type:"verification.requested",artifact_references:[],occurred_at:"2026-01-01T00:00:00Z",idempotency_key:"phase-presentation",payload:{kind:"conditional_evidence",phase:"green",runId:"run-dq-1",taskId:"dq-structural",specification:f.specification,strategy}});
    const req = AgentRequestSchema.parse({requestId:"request-present",attemptId:"attempt-present",runId:"run-dq-1",taskId:"dq-structural",role:"qa",target:{transport:"herdr",agentId:"qa",paneId:"p1"},instruction:JSON.stringify(wire),context:wire,inputs:[],attempt:1,retry:{maxAttempts:1,strategy:"fixed",initialDelayMs:0,maxDelayMs:0,jitter:false},timeout:{executionTimeoutMs:1000,onTimeout:"block"},idempotency:{key:"phase-presentation",scope:"agent-request",fingerprint:"digest"},createdAt:"2026-01-01T00:00:00Z"});
    const presentation = projectPolicyPhaseRequest(req);
    expect(Buffer.byteLength(presentation.instruction)).toBeLessThan(60000);
    expect(presentation.context).toEqual(req.context);
    expect(presentation.idempotency).toEqual(req.idempotency);
    expect(JSON.parse(presentation.instruction).payload.specification.acceptanceCriteria).toEqual(f.specification.acceptanceCriteria);
    expect(req.instruction).toContain("largeRawOutput");
    let promptCalls = 0;
    const newAdapter = () => createHerdrAdapter({runner:{run:async ({args}:any)=>{
      const prompt=args[1]==="prompt"; if(prompt){promptCalls++;if(Buffer.byteLength(args[3])>131072)return {exitCode:null,stdout:"",stderr:"",failure:"spawn",started:false,cause:"spawn E2BIG"};}
      return {exitCode:0,stderr:"",stdout:JSON.stringify({id:"1",result:{type:prompt?"agent_prompted":"agent_info",agent:{agent:"claude",name:"qa",agent_status:"idle",workspace_id:"w1",tab_id:"t1",pane_id:"p1",terminal_id:"term1",revision:1,state_change_seq:2}}})};
    }}});
    expect((await newAdapter().send(req)).ok).toBe(false);
    // Recovery reopens the host after deploying the fix, so the old process idempotency cache is not reused.
    const adapter = newAdapter();
    const sent=await adapter.send(presentation);
    expect(sent, JSON.stringify(sent)).toMatchObject({ok:true,value:{status:"accepted"}});
    expect(await adapter.send(presentation)).toEqual(sent);
    expect(promptCalls).toBe(2);

    const result = compactPolicyReviewDossier(f.specification, strategy) as any;
    expect(JSON.stringify(result).length).toBeLessThan(30000);
    expect(result.specification.acceptanceCriteria).toEqual(f.specification.acceptanceCriteria);
    expect(result.specification.securityConsiderations).toBe(f.specification.securityConsiderations);
    expect(result.specification.metadata).toEqual(f.specification.metadata);
    expect(result.strategy.metadata.conditionalTdd.requiredVerificationMethods).toEqual((strategy.metadata!.conditionalTdd as any).requiredVerificationMethods);
    expect(result.strategy.metadata.tddEvidence).toBeUndefined();
    expect(result.priorEvidence[0].verificationId).toBe(evidence[0].verificationId);
    expect(result.priorEvidence[0].artifactReferences).toEqual(evidence[0].evidenceArtifacts);
    expect(evidence[0].metadata.largeRawOutput).toHaveLength(150000);
  });
  it("pages an oversized policy review losslessly before exposing its judgment observation", async () => {
    const f = await implemented();
    await writeFile(join(f.cwd, "source.cjs"), "/*" + "漢字λ🙂".repeat(10000) + "*/\nmodule.exports = x => x * 2;\n");
    f.commit("large committed review"); f.requestPhase("green");
    const first = await f.host.inspectAlternative(f.binding, input("green")) as any;
    expect(first.code).toBe("policy_review_paged");
    expect(first.observationId).toBeUndefined();
    const pages = [first.page]; let current = first;
    while (current.nextOffset !== null) {
      current = await f.host.inspectAlternative(f.binding, { ...input("green"), cursor: first.cursor, offset: current.nextOffset }) as any;
      expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(24000);
      pages.push(current.page);
    }
    const raw = pages.join(""), body = JSON.parse(raw);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(first.sha256);
    expect(body.observation.diff).toContain("漢字λ🙂".repeat(10000));
    expect(body.dossier.specification.acceptanceCriteria).toEqual(f.specification.acceptanceCriteria);
    expect(current.observationId).toEqual(expect.any(String));
    const completed = await f.host.behavioralEvidence(f.binding, { ...input("green"), review: { observationId: current.observationId, criteria } });
    expect(completed.result.status).toBe("passed");
  }, 120_000);
  it.each(["revision", "dirty", "replacement", "expired-lease"])("revalidates %s before serving a captured policy review page", async mode => {
    const f = await implemented();
    const request = f.requestPhase("green");
    const first = await f.host.inspectAlternative(f.binding, { ...input("green"), view: "page" }) as any;
    if (mode === "revision") { await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>2*x;\n"); f.commit("source advanced"); }
    if (mode === "dirty") await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>2*x;\n");
    if (mode === "replacement") f.binding.session = { ...f.binding.session!, value: "new-native" };
    if (mode === "expired-lease") request.lease.expiresAt = new Date(Date.now()-1000).toISOString();
    await expect(f.host.inspectAlternative(f.binding, { ...input("green"), cursor: first.cursor, offset: 0 })).rejects.toThrow(/cursor|review|assignment|lease|request/i);
  });
  it("completes Red Green Refactor through assigned QA inspection and explicit judgment without a task review gate", async () => {
    const f = await implemented();
    const artifacts = new Set<string>();
    for (const phase of ["green", "refactor"]) {
      if (phase === "refactor") f.requestPhase(phase); // same committed source, a new policy phase
      const inspected = await f.host.inspectAlternative(f.binding, input(phase)) as any;
      const completed = await f.host.behavioralEvidence(f.binding, { ...input(phase), review: { observationId: inspected.observationId, criteria } });
      expect(completed.result.status).toBe("passed");
      expect((completed.result.metadata!.conditionalTdd as any).observations).toContainEqual(expect.objectContaining({ method: "manual_review", criterionId: "ac-1" }));
      for (const a of completed.result.evidenceArtifacts) { expect(artifacts.has(a.artifactId)).toBe(false); artifacts.add(a.artifactId); }
    }
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
  });
  it("supports the real partial-readiness recommended verification mode without weakening the manual obligation", async () => {
    const f = await implemented("partial"); expect(f.strategy.tddDecision.mode).toBe("recommended");
    const inspected = await f.host.inspectAlternative(f.binding, input("verification")) as any;
    await f.host.behavioralEvidence(f.binding, { ...input("verification"), review: { observationId: inspected.observationId, criteria } });
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
  });
  it("requires manual judgment even with an approved Spec and rejects fabricated observations and failing judgments", async () => {
    const f = await implemented();
    await expect(f.host.behavioralEvidence(f.binding, input("green"))).rejects.toThrow(/review/i);
    await expect(f.host.behavioralEvidence(f.binding, { ...input("green"), review: { observationId: "forged", criteria } })).rejects.toThrow(/observation|review/i);
    const inspected = await f.host.inspectAlternative(f.binding, input("green")) as any;
    for (const judged of [[], [{ ...criteria[0]!, passed: false }], [criteria[0], criteria[0]]]) {
      await expect(f.host.behavioralEvidence(f.binding, { ...input("green"), review: { observationId: inspected.observationId, criteria: judged } })).rejects.toThrow(/review|criteria|criterion/i);
    }
  });
  it.each(["revision", "spec", "attempt", "request", "replacement", "phase", "self", "expired-lease", "lineage", "fence", "role", "scope", "missing-lease"])("fences %s changes after inspection before minting phase evidence", async mode => {
    const f = await implemented(); const request = f.requestPhase("green");
    const inspected = await f.host.inspectAlternative(f.binding, input("green")) as any;
    if (mode === "revision") { await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>2*x;\n"); f.commit("source advanced"); }
    if (mode === "spec") f.changeSpec();
    if (mode === "attempt") f.assignment.handle.attemptId = "different-attempt";
    if (mode === "request") f.requestPhase("green");
    if (mode === "replacement") f.binding.session = { ...f.binding.session!, value: "replacement-native" };
    if (mode === "phase") f.requestPhase("refactor");
    if (mode === "self") f.assignment.handle.target.session = f.binding.session!;
    if (mode === "expired-lease") request.lease.expiresAt = new Date(Date.now()-1000).toISOString();
    if (mode === "fence") request.lease.fencingToken++;
    if (mode === "role") f.binding.role = "tester";
    if (mode === "scope") request.message.payload.kind = "unrelated_verification";
    if (mode === "missing-lease") delete request.lease;
    if (mode === "lineage") {
      const lineage = { schemaVersion: 3, executorId: "implementation-executor", launchId: "launch", nativeSessionId: "native", bindingId: "binding", assignmentIds: [], freshContext: true, purpose: "implementation" };
      (f.assignment as any).executorLineage = lineage;
      request.executorLineage = { ...lineage, executorId: "successor", freshContext: false, purpose: "verification", predecessorExecutorId: lineage.executorId };
    }
    await expect(f.host.behavioralEvidence(f.binding, { ...input("green"), review: { observationId: inspected.observationId, criteria } })).rejects.toThrow(/review|revision|source|assignment|request|phase|implementer|implementation|spec|lease|executor/i);
  });
  it("retains a review observation across host restart and replays only the same immutable judgment", async () => {
    const f = await implemented(); const inspected = await f.host.inspectAlternative(f.binding, input("green")) as any;
    const host = f.reopen(), args = { ...input("green"), review: { observationId: inspected.observationId, criteria } };
    const first = await host.behavioralEvidence(f.binding, args);
    expect((await f.reopen().behavioralEvidence(f.binding, args)).result).toEqual(first.result);
    await expect(f.reopen().behavioralEvidence(f.binding, { ...args, review: { ...args.review, criteria: [{ ...criteria[0]!, summary: "Changed judgment" }] } })).rejects.toThrow(/conflict|judgment/i);
  });
});
