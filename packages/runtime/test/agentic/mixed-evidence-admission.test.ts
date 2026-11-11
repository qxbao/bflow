import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptanceCriterionSchema,
  SpecificationSchema,
  WorkflowDefinitionSchema
} from "@bflow/contracts";
import type { AcceptanceCriterion, Specification, WorkflowDefinition } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { HostVerification, defaultHostChecks } from "../../src/agentic/host-verification.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { WorkflowProposalRejected } from "../../src/agentic/workflow-rejection.js";
import { parseBehavioralCommands, type RunnerDetection, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { projectTaskSpecificationInput, intersectPathsWithOwned } from "../../src/agentic/task-projection.js";
import { cleanups, fixture, automaticRunners, phaseTestName, git } from "../helpers/agentic-integration-fixture.js";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const fiveCriteria: AcceptanceCriterion[] = [
  {
    id: "ac-1",
    description: "CI GitHub Actions chạy trên push, pull_request và workflow_dispatch, dùng Java 17, Maven wrapper ở root và reactor com.clothshop/pom.xml, có cache Maven và hủy lượt cũ cùng nhánh.",
    category: "functional",
    verificationMethod: "static_analysis",
    required: true,
    status: "pending",
    evidenceArtifactIds: []
  },
  {
    id: "ac-2",
    description: "Có ít nhất hai shard test song song; các test được phân chia ổn định, mỗi test được chạy đúng một lần trên toàn bộ shard, không bỏ sót hoặc chạy lặp test dependency; có kiểm tra đối chiếu với chạy tuần tự.",
    category: "functional",
    verificationMethod: "integration_test",
    required: true,
    status: "pending",
    evidenceArtifactIds: []
  },
  {
    id: "ac-3",
    description: "Bộ unit test JUnit 5 ban đầu kiểm tra hành vi hiện có ở common/domain/client/admin với các ca bình thường, biên và lỗi phù hợp; dùng mocks khi cần và không phụ thuộc database, email, API bên ngoài hay bí mật.",
    category: "edge_case",
    verificationMethod: "unit_test",
    required: true,
    status: "pending",
    evidenceArtifactIds: []
  },
  {
    id: "ac-4",
    description: "Bất kỳ shard hoặc build nào thất bại đều làm CI thất bại; báo cáo Surefire được lưu cả khi lỗi, mỗi shard có tên artifact riêng, và bước tổng hợp không báo xanh khi shard bị lỗi hoặc bị hủy.",
    category: "functional",
    verificationMethod: "static_analysis",
    required: true,
    status: "pending",
    evidenceArtifactIds: []
  },
  {
    id: "ac-5",
    description: "Có hướng dẫn chạy test tuần tự và từng shard tại local, tăng giảm số shard, nêu rõ giới hạn của bộ test ban đầu và không cam kết tăng tốc khi chưa đo trên GitHub.",
    category: "functional",
    verificationMethod: "manual_review",
    required: true,
    status: "pending",
    evidenceArtifactIds: []
  }
].map(c => AcceptanceCriterionSchema.parse(c));

function makeMavenFixture(risk: "medium" | "high" | "critical" = "medium") {
  const spec = SpecificationSchema.parse({
    schemaVersion: 2,
    specId: "spec-maven-ci",
    runId: "run-maven-ci-1",
    sessionId: "session-maven-ci-1",
    title: "Maven CI and Testing Suite",
    summary: "Maven CI workflows with test sharding",
    problemStatement: "Need GitHub Actions CI with Maven and test sharding",
    scope: {
      inScope: ["CI workflows", "Maven reactor", "Sharding scripts", "Unit tests", "Documentation"],
      outOfScope: ["External database", "Third-party APIs"]
    },
    architectureNotes: "GitHub Actions workflow with Maven wrapper and parallel shard jobs",
    securityConsiderations: "Secrets are not logged; cache uses standard Maven local repo",
    rollbackPlan: "Revert commit to disable workflow",
    level: "full",
    complexity: "standard",
    status: "draft",
    riskLevel: risk,
    version: 1,
    acceptanceCriteria: fiveCriteria,
    affectedPaths: [
      "pom.xml",
      ".github/workflows/ci.yml",
      "scripts/shard.sh",
      "src/test/java/com/clothshop/AppTest.java",
      "docs/testing.md"
    ],
    testStrategy: {
      schemaVersion: 2,
      strategyId: "strategy-maven-ci-1",
      specId: "spec-maven-ci",
      tddDecision: {
        schemaVersion: 2,
        decisionId: "tdd-maven-ci-1",
        runId: "run-maven-ci-1",
        specId: "spec-maven-ci",
        taskId: "task-ci",
        mode: "required",
        rationale: "CI infrastructure testing requires automated verification",
        verifiableConditions: ["ac-1", "ac-2", "ac-3", "ac-4"],
        changeClassification: "configuration",
        requiresFailingTestFirst: true,
        decidedBy: "coordinator",
        decidedAt: "2026-11-11T00:00:00.000Z"
      },
      requiredTestLevels: ["unit", "integration"],
      targetCommands: ["auto:unit", "auto:integration", "auto:static"],
      independentVerificationRequired: true,
      criterionMappings: [
        { criterionId: "ac-1", testNames: ["CI workflow trigger tests"] },
        { criterionId: "ac-2", testNames: ["com.clothshop.AppTest.testSharding"] },
        { criterionId: "ac-3", testNames: ["com.clothshop.AppTest.testApp"] },
        { criterionId: "ac-4", testNames: ["Maven surefire failure reporting tests"] },
        { criterionId: "ac-5", testNames: ["Manual review of documentation"] }
      ],
      createdAt: "2026-11-11T00:00:00.000Z"
    },
    tddDecision: {
      schemaVersion: 2,
      decisionId: "tdd-maven-ci-1",
      runId: "run-maven-ci-1",
      specId: "spec-maven-ci",
      taskId: "task-ci",
      mode: "required",
      rationale: "CI infrastructure testing requires automated verification",
      verifiableConditions: ["ac-1", "ac-2", "ac-3", "ac-4"],
      changeClassification: "configuration",
      requiresFailingTestFirst: true,
      decidedBy: "coordinator",
      decidedAt: "2026-11-11T00:00:00.000Z"
    },
    createdBy: "coordinator",
    createdAt: "2026-11-11T00:00:00.000Z",
    metadata: {
      sdd: {
        assessment: {
          taskType: "infrastructure",
          surfaces: ["infrastructure"],
          riskClassification: risk
        }
      },
      conditionalTdd: {
        policyVersion: 1,
        taskId: "workflow-verification",
        taskType: "infrastructure",
        changeImpact: {
          surfaces: ["infrastructure"],
          behaviorChanged: true,
          deterministic: true,
          regressionReproducible: false,
          securitySensitive: false,
          dataMigration: false,
          scope: "cross_module"
        },
        infrastructure: {
          readiness: "ready",
          commands: [
            { method: "unit_test", command: "auto:unit", level: "unit" },
            { method: "integration_test", command: "auto:integration", level: "integration" },
            { method: "static_analysis", command: "auto:static" }
          ]
        },
        testability: {
          level: "automated",
          rationale: "Unit and integration tests run via Maven surefire and sharding scripts"
        },
        riskClassification: risk,
        conventions: {
          tdd: "preferred",
          requiredMethods: ["unit_test", "integration_test", "static_analysis"],
          suggestedLevels: ["unit", "integration"]
        }
      }
    },
    updatedAt: "2026-11-11T00:00:00.000Z"
  });

  const definition = WorkflowDefinitionSchema.parse({
    schemaVersion: "1",
    id: "def-maven-ci",
    name: "Maven CI and Testing Suite",
    version: "1.0.0",
    tasks: [
      {
        id: "task-ci",
        title: "Implement CI workflows and test sharding",
        role: "developer",
        instruction: "Implement CI workflows and test sharding",
        acceptanceCriteria: ["ac-1", "ac-2", "ac-3", "ac-4"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
        requiresApproval: true,
        qualityGates: [],
        metadata: {
          ownedPaths: [
            "pom.xml",
            ".github/workflows",
            "scripts",
            "src/test/java"
          ]
        }
      },
      {
        id: "task-docs",
        title: "Document CI test execution and local reproduction",
        role: "developer",
        instruction: "Document CI test execution and local reproduction",
        acceptanceCriteria: ["ac-5"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
        requiresApproval: true,
        qualityGates: [],
        metadata: {
          ownedPaths: [
            "docs/testing.md"
          ]
        }
      }
    ],
    dependencies: [
      { taskId: "task-docs", dependsOnTaskId: "task-ci", condition: "succeeded" }
    ],
    qualityGates: [],
    maxConcurrency: 1,
    failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
  });

  return { spec, definition };
}

function mavenProfiles(): RunnerProfile[] {
  const mavenAdapter = {
    adapterId: "maven",
    projectDirectory: ".",
    format: "junit" as const,
    nameRule: "classname.name (fully qualified Java/Kotlin test class, dot, method)",
    bind(identities: { testNames: readonly string[]; testPaths: readonly string[] }) {
      return {
        args: ["test"],
        reportPaths: ["target/surefire-reports/TEST-*.xml"]
      };
    }
  };
  return [
    {
      id: "auto-unit-maven",
      command: "auto:unit",
      method: "unit_test",
      levels: ["unit", "regression"],
      source: "detected",
      executable: "/usr/bin/mvn",
      args: ["test"],
      reporter: "node_tap",
      timeoutMs: 180_000,
      checkoutDependencyRoots: [],
      dependencySource: process.cwd(),
      adapter: mavenAdapter
    },
    {
      id: "auto-integration-maven",
      command: "auto:integration",
      method: "integration_test",
      levels: ["integration", "regression"],
      source: "detected",
      executable: "/usr/bin/mvn",
      args: ["test"],
      reporter: "node_tap",
      timeoutMs: 180_000,
      checkoutDependencyRoots: [],
      dependencySource: process.cwd(),
      adapter: mavenAdapter
    }
  ];
}

async function createHost(profiles: RunnerProfile[] = mavenProfiles()) {
  const detection: RunnerDetection = { status: "detected", profiles, notes: ["maven 3.9.6"] };
  const source = new TestRunnerSource([], process.cwd(), async () => detection);
  await source.refresh();
  return new HostVerification(
    () => { throw new Error("no runtime in unit test"); },
    () => { throw new Error("no store in unit test"); },
    undefined,
    source,
    undefined,
    undefined,
    [],
    { suites: [] },
    defaultHostChecks()
  );
}

function refusal(action: () => unknown) {
  let observed: unknown;
  try { action(); } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(WorkflowProposalRejected);
  return (observed as WorkflowProposalRejected).rejection;
}

describe("Mixed Evidence Admission and Task Projection (GĐ6)", () => {
  describe("path intersection and task projection", () => {
    it("intersects affectedPaths with literal ownedPaths correctly", () => {
      const affected = [
        "pom.xml",
        ".github/workflows/ci.yml",
        "scripts/shard.sh",
        "src/test/java/com/clothshop/AppTest.java",
        "docs/testing.md"
      ];
      // Docs task ownership
      expect(intersectPathsWithOwned(affected, ["docs/testing.md"])).toEqual(["docs/testing.md"]);
      // CI task directory and file ownership
      expect(intersectPathsWithOwned(affected, ["pom.xml", ".github/workflows", "scripts", "src/test/java"])).toEqual([
        "pom.xml",
        ".github/workflows/ci.yml",
        "scripts/shard.sh",
        "src/test/java/com/clothshop/AppTest.java"
      ]);
      // Subpath narrowing: affected has directory, owned has specific file
      expect(intersectPathsWithOwned(["docs", "src"], ["docs/testing.md", "src/App.java"])).toEqual([
        "docs/testing.md",
        "src/App.java"
      ]);
      // Legacy caller with empty or undefined ownedPaths keeps affectedPaths
      expect(intersectPathsWithOwned(affected, undefined)).toEqual(affected);
      expect(intersectPathsWithOwned(affected, [])).toEqual(affected);
    });

    it("projects task specification without contaminating doc task with code paths", () => {
      const { spec } = makeMavenFixture();
      const docCriteria = spec.acceptanceCriteria.filter(c => c.id === "ac-5");
      const projected = projectTaskSpecificationInput(
        spec,
        "task-docs",
        docCriteria,
        "task-docs",
        spec.metadata?.conditionalTdd,
        ["docs/testing.md"]
      );

      expect(projected.affectedPaths).toEqual(["docs/testing.md"]);
      expect(projected.acceptanceCriteria.map(c => c.id)).toEqual(["ac-5"]);
      expect(projected.traceabilityTaskIds).toEqual(["task-docs"]);
    });
  });

  describe("workflow and task admission enforcement", () => {
    it("legacy assertSupported rejects full-spec mixed criteria with task_evidence_mixed", async () => {
      const host = await createHost();
      const { spec } = makeMavenFixture();
      const strategy = new TestStrategyResolver().resolve(spec);

      // Caller without workflow definition receives task_evidence_mixed rejection
      const rej = refusal(() => host.assertSupported(spec, strategy));
      expect(rej.code).toBe("task_evidence_mixed");
      expect(rej.reason).toContain("Mixed manual and behavioral TDD criteria require separate tasks");
    });

    it("assertWorkflowSupported accepts properly separated DAG with 5 criteria", async () => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture();
      const strategy = new TestStrategyResolver().resolve(spec);

      // When definition is provided and tasks are separated, proposal is supported
      expect(() => host.assertWorkflowSupported(spec, strategy, definition)).not.toThrow();
    });

    it("rejects when a single task mixes manual and behavioral acceptance criteria", async () => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture();
      // Put ac-5 (manual_review) into task-ci along with behavioral criteria
      const mixedDef: WorkflowDefinition = {
        ...definition,
        tasks: [
          {
            ...definition.tasks[0]!,
            acceptanceCriteria: ["ac-1", "ac-2", "ac-3", "ac-5"]
          },
          {
            ...definition.tasks[1]!,
            acceptanceCriteria: ["ac-4"]
          }
        ]
      };
      const strategy = new TestStrategyResolver().resolve(spec);
      const rej = refusal(() => host.assertWorkflowSupported(spec, strategy, mixedDef));
      expect(rej.code).toBe("task_evidence_mixed");
      expect(rej.reason).toContain("task-ci");
      expect(rej.reason).toContain("ac-5");
    });

    it("rejects when a required criterion is omitted from all tasks (orphan criterion)", async () => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture();
      // Omit ac-4 from all tasks
      const orphanDef: WorkflowDefinition = {
        ...definition,
        tasks: [
          {
            ...definition.tasks[0]!,
            acceptanceCriteria: ["ac-1", "ac-2", "ac-3"]
          },
          definition.tasks[1]!
        ]
      };
      const strategy = new TestStrategyResolver().resolve(spec);
      const rej = refusal(() => host.assertWorkflowSupported(spec, strategy, orphanDef));
      expect(rej.code).toBe("missing_test_mapping");
      expect(rej.reason).toContain("ac-4");
    });

    it("rejects when workflow policy requires a method that no task covers (task_policy_gap)", async () => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture();
      // Drop task-docs entirely so manual_review required by policy is missing from union
      const gapDef: WorkflowDefinition = {
        ...definition,
        tasks: [definition.tasks[0]!],
        dependencies: []
      };
      // Also drop ac-5 from spec and strategy so it is not an orphan criterion, but policy still requires manual_review
      const gapSpec: Specification = {
        ...spec,
        acceptanceCriteria: spec.acceptanceCriteria.filter(c => c.id !== "ac-5"),
        testStrategy: spec.testStrategy ? {
          ...spec.testStrategy,
          criterionMappings: spec.testStrategy.criterionMappings.filter(m => m.criterionId !== "ac-5")
        } : undefined,
        metadata: {
          ...spec.metadata,
          conditionalTdd: {
            ...(spec.metadata?.conditionalTdd as Record<string, unknown>),
            conventions: {
              tdd: "preferred",
              requiredMethods: ["unit_test", "integration_test", "static_analysis", "manual_review"],
              suggestedLevels: ["unit", "integration"]
            }
          }
        }
      };
      const strategy = new TestStrategyResolver().resolve(gapSpec);
      const rej = refusal(() => host.assertWorkflowSupported(gapSpec, strategy, gapDef));
      expect(rej.code).toBe("task_policy_gap");
      expect(rej.methods).toContain("manual_review");
    });

    it("rejects when planned literal file has no available static analyzer (static_analyzer_missing)", async () => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture();
      // Add an unhandled file type (e.g. .toml or .unknown) to affectedPaths and task-ci ownedPaths
      const unhandledSpec: Specification = {
        ...spec,
        affectedPaths: [...spec.affectedPaths, "config.unknownext"]
      };
      const unhandledDef: WorkflowDefinition = {
        ...definition,
        tasks: [
          {
            ...definition.tasks[0]!,
            metadata: {
              ownedPaths: [...(definition.tasks[0]!.metadata!.ownedPaths as string[]), "config.unknownext"]
            }
          },
          definition.tasks[1]!
        ]
      };
      const strategy = new TestStrategyResolver().resolve(unhandledSpec);
      const rej = refusal(() => host.assertWorkflowSupported(unhandledSpec, strategy, unhandledDef));
      expect(rej.code).toBe("static_analyzer_missing");
      expect(rej.reason).toContain("config.unknownext");
    });

    it.each(["high", "critical"] as const)("admits %s-risk mixed workflow when all root policy methods and review are covered", async risk => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture(risk);
      const strategy = new TestStrategyResolver().resolve(spec);

      // High-risk spec requires all root policy methods across tasks
      expect(() => host.assertWorkflowSupported(spec, strategy, definition)).not.toThrow();

      // Code task projection preserves root high-risk floor
      const codeCriteria = spec.acceptanceCriteria.filter(c => c.id !== "ac-5");
      const projected = projectTaskSpecificationInput(
        spec,
        "task-ci",
        codeCriteria,
        "ci",
        spec.metadata?.conditionalTdd,
        definition.tasks[0]!.metadata!.ownedPaths as string[]
      );
      const tdd = projected.metadata?.conditionalTdd as any;
      expect(tdd.riskClassification).toBe(risk);
    });

    it.each(["high", "critical"] as const)("rejects when a code task downgrades %s workflow risk", async risk => {
      const host = await createHost();
      const { spec, definition } = makeMavenFixture(risk);
      const strategy = new TestStrategyResolver().resolve(spec);

      const downgradeDef: WorkflowDefinition = {
        ...definition,
        tasks: [
          {
            ...definition.tasks[0]!,
            metadata: {
              ...definition.tasks[0]!.metadata,
              conditionalTdd: {
                ...(spec.metadata?.conditionalTdd as any),
                riskClassification: "low"
              }
            }
          },
          definition.tasks[1]!
        ]
      };

      const rej = refusal(() => host.assertWorkflowSupported(spec, strategy, downgradeDef));
      expect(rej.code).toBe("task_policy_gap");
      expect(rej.reason).toContain(`attempts to downgrade risk (low) below workflow risk level (${risk})`);
    });
  });

  describe("connected workflow mixed-evidence admission and verification", () => {
    async function tickReviews(f: Awaited<ReturnType<typeof fixture>>) {
      let done = false;
      const ticking = f.runtime.tick().finally(() => { done = true; });
      void ticking.catch(() => undefined);
      let cursor = 0;
      const deadline = Date.now() + 60_000;
      while (!done) {
        if (Date.now() > deadline) {
          await f.runtime.cancel("run-1", "Stop timed-out test verification");
          await ticking.catch(() => undefined);
          throw new Error("Connected verification did not finish within deadline");
        }
        while (cursor < f.transport.sentRequests.length) {
          const delivered = f.transport.sentRequests[cursor++]!;
          const message = JSON.parse(delivered.instruction);
          if (message.type !== "verification.requested" || !message.payload.definition) continue;
          const out = { message };
          const binding = f.panes.bindings.find(pane => pane.paneId === delivered.target.paneId)!;
          const observed = await f.verification.inspectReview(binding, { messageId: out.message.message_id }) as any;
          const integrity = observed.context?.input?.hostTestIntegrityObservation?.report;
          const testIntegrityVerdicts = binding.role === "reviewer" && integrity?.findings?.length ? integrity.findings.map((finding: any) => {
            const revision = finding.side === "base" ? integrity.baseRevision : integrity.candidateRevision;
            const worktree = observed.context.target?.worktreePath ?? f.root;
            const excerpt = git(worktree, "show", `${revision}:${finding.path}`).split(/\r?\n/)[finding.line - 1]!.trim();
            return {
              findingId: finding.id,
              verdict: "equivalent",
              reason: "The committed test is valid and does not weaken the test oracle.",
              evidence: [{ revision, path: finding.path, line: finding.line, excerpt }]
            };
          }) : undefined;
          const completed = await f.verification.completeReview(binding, {
            reviewId: observed.reviewId,
            ...(observed.reworkResolution ? {
              findingVerdicts: observed.reworkResolution.reworkContext.findings.map((finding: { findingId: string }) => ({
                findingId: finding.findingId,
                verdict: "confirmed",
                summary: "Independently checked the exact repaired source"
              }))
            } : {}),
            summary: "Reviewed the exact committed implementation and acceptance criteria",
            ...(testIntegrityVerdicts ? { testIntegrityVerdicts } : {}),
            criteria: observed.context.definition.configuration.criterionIds.map((criterionId: string) => ({
              criterionId,
              passed: true,
              summary: `Independently verified criterion ${criterionId}`
            }))
          });
          await f.runtime.receiveHerdr(f.envelope("review.verdict", completed.result, {
            causation_id: out.message.message_id,
            sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId },
            artifact_references: [completed.artifact]
          }));
        }
        if (!done) await new Promise(resolve => setTimeout(resolve, 5));
      }
      await ticking;
    }

    it("admits mixed-spec DAG with separate task evidence, enforces manual negative checks, and reaches final integrated verification", async () => {
      const command = parseBehavioralCommands([{
        id: "real-regression",
        command: "auto:integration",
        executable: process.execPath,
        args: ["--test", "--test-reporter=tap", "test/double.test.cjs"],
        method: "integration_test",
        levels: ["integration", "regression"],
        testPaths: ["test/double.test.cjs"],
        testNames: [phaseTestName],
        timeoutMs: 10_000
      }])[0]!;

      const runners = await automaticRunners();
      const f = await fixture({ behavioral: command, runners, intake: false });

      const criteria = [
        AcceptanceCriterionSchema.parse({
          id: "ac-1",
          description: "Double function returns twice the input value",
          category: "functional",
          verificationMethod: "integration_test",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        }),
        AcceptanceCriterionSchema.parse({
          id: "ac-2",
          description: "Documentation describes the double function behavior accurately",
          category: "functional",
          verificationMethod: "manual_review",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        })
      ];

      const time = new Date().toISOString();
      const delegation = {
        schemaVersion: 2,
        delegationId: "delegation-mixed-1",
        messageId: "intake-mixed-1",
        correlationId: "correlation-1",
        sessionId: "session-1",
        runId: "run-1",
        requestedBy: "conversation",
        targetRole: "coordinator",
        title: "Mixed code and documentation workflow",
        objective: "Implement double function with tests and documentation",
        specificationId: "spec-mixed-1",
        sddLevel: "full",
        acceptanceCriteria: criteria,
        inputArtifacts: [],
        priority: "normal",
        requestedAt: time,
        idempotencyKey: "intake-mixed-1"
      };

      const spec: Specification = SpecificationSchema.parse({
        schemaVersion: 2,
        specId: "spec-mixed-1",
        runId: "run-1",
        sessionId: "session-1",
        title: "Mixed code and documentation workflow",
        summary: "Implement double function with tests and documentation",
        problemStatement: "Need double calculation and documentation",
        scope: { inScope: ["Calculation", "Documentation"], outOfScope: ["Floating point"] },
        architectureNotes: "Pure JavaScript implementation in CommonJS",
        securityConsiderations: "No secrets or external processes",
        rollbackPlan: "Revert git commit",
        level: "full",
        complexity: "standard",
        status: "draft",
        riskLevel: "medium",
        version: 1,
        acceptanceCriteria: criteria,
        affectedPaths: ["src/double.cjs", "test/double.test.cjs", "docs/guide.md"],
        traceabilityTaskIds: ["implement", "docs"],
        testStrategy: {
          schemaVersion: 2,
          strategyId: "strategy-mixed-1",
          specId: "spec-mixed-1",
          tddDecision: {
            schemaVersion: 2,
            decisionId: "tdd-mixed-1",
            runId: "run-1",
            specId: "spec-mixed-1",
            taskId: "implement",
            mode: "required",
            rationale: "Integration testing required for logic",
            verifiableConditions: ["ac-1"],
            changeClassification: "domain_logic",
            requiresFailingTestFirst: true,
            decidedBy: "coordinator",
            decidedAt: time
          },
          requiredTestLevels: ["integration"],
          targetCommands: ["auto:integration"],
          independentVerificationRequired: true,
          criterionMappings: [
            { criterionId: "ac-1", testNames: [phaseTestName] },
            { criterionId: "ac-2", testNames: ["Independent manual review"] }
          ],
          createdAt: time
        },
        tddDecision: {
          schemaVersion: 2,
          decisionId: "tdd-mixed-1",
          runId: "run-1",
          specId: "spec-mixed-1",
          taskId: "implement",
          mode: "required",
          rationale: "Integration testing required for logic",
          verifiableConditions: ["ac-1"],
          changeClassification: "domain_logic",
          requiresFailingTestFirst: true,
          decidedBy: "coordinator",
          decidedAt: time
        },
        metadata: {
          sdd: {
            policyVersion: 1,
            assessment: {
              kind: "feature",
              behaviorChange: true,
              modules: ["example"],
              securityImpact: false,
              publicApiImpact: false,
              dataSchemaImpact: false,
              architectureImpact: false,
              migrationRequired: false,
              risk: "medium",
              unresolvedQuestions: []
            },
            functionalRequirements: ["Deliver double function and documentation"],
            proposedTestStrategy: "Integration and manual review checks for changed behavior",
            traceability: [
              { criterionId: "ac-1", taskIds: ["implement"] },
              { criterionId: "ac-2", taskIds: ["docs"] }
            ]
          },
          conditionalTdd: {
            policyVersion: 1,
            taskId: "workflow-verification",
            taskType: "domain_logic",
            changeImpact: {
              surfaces: ["domain_logic"],
              behaviorChanged: true,
              deterministic: true,
              regressionReproducible: false,
              securitySensitive: false,
              dataMigration: false,
              scope: "local"
            },
            infrastructure: {
              readiness: "ready",
              commands: [
                { method: "integration_test", command: "auto:integration", level: "integration" }
              ]
            },
            testability: {
              level: "automated",
              rationale: "Unit and integration tests run via node test runner"
            },
            riskClassification: "medium",
            conventions: {
              tdd: "preferred",
              requiredMethods: ["integration_test", "manual_review"],
              suggestedLevels: ["integration"]
            }
          }
        },
        createdBy: "coordinator",
        createdAt: time,
        updatedAt: time
      });

      const def: WorkflowDefinition = WorkflowDefinitionSchema.parse({
        schemaVersion: "1",
        id: "def-mixed-1",
        name: "Mixed Workflow",
        version: "1.0.0",
        tasks: [
          {
            id: "implement",
            title: "Implement double function with test",
            role: "developer",
            instruction: "Implement double function with test",
            acceptanceCriteria: ["ac-1"],
            retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
            timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
            requiresApproval: false,
            qualityGates: [],
            metadata: {
              ownedPaths: ["src/double.cjs", "test/double.test.cjs"]
            }
          },
          {
            id: "docs",
            title: "Document double function",
            role: "developer",
            instruction: "Document double function",
            acceptanceCriteria: ["ac-2"],
            retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
            timeout: { executionTimeoutMs: 180_000, onTimeout: "block" },
            requiresApproval: false,
            qualityGates: [],
            metadata: {
              ownedPaths: ["docs/guide.md"]
            }
          }
        ],
        dependencies: [
          { taskId: "docs", dependsOnTaskId: "implement", condition: "succeeded" }
        ],
        qualityGates: [],
        maxConcurrency: 1,
        failurePolicy: "block",
        recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
      });

      // 1. Send intake delegation and propose workflow
      await f.runtime.receiveHerdr(f.envelope("delegation.request", delegation, { message_id: "intake-mixed-1", idempotency_key: "intake-mixed-1" }));
      await f.runtime.proposeWorkflow("run-1", spec, def);

      // Verify task projection separated the criteria
      const pendingRun = await f.inspect();
      expect(pendingRun.tasks).toHaveLength(2);
      expect(pendingRun.tasks[0].spec.specification.acceptanceCriteria.map((c: any) => c.id)).toEqual(["ac-1"]);
      expect(pendingRun.tasks[0].spec.strategy.tddDecision.mode).toBe("required");
      expect(pendingRun.tasks[1].spec.specification.acceptanceCriteria.map((c: any) => c.id)).toEqual(["ac-2"]);
      expect(pendingRun.tasks[1].spec.strategy.tddDecision.mode).toBe("not_applicable");

      const qa = f.panes.bindings.find(b => b.role === "qa")!;
      const development = new HostDevelopment(() => f.runtime, runners);
      const testSource = `const { test } = require("node:test"); const assert = require("node:assert/strict"); const double = require("../src/double.cjs"); test(${JSON.stringify(phaseTestName)}, () => assert.equal(double(2), 4));\n`;
      const currentHead = (p: string) => git(p, "rev-parse", "HEAD");

      // 2. Start execution
      await f.runtime.tick();
      const state1 = await f.runtime.inspect() as any;
      const implOutbound = state1.outbound.find((out: any) => out.message.type === "task.assignment" && out.taskId === "implement");
      expect(implOutbound).toBeDefined();
      const dev1 = f.panes.bindings.find(b => b.paneId === implOutbound.handle.target.paneId)!;
      const implWorktree = implOutbound.handle.target.worktreePath;

      const receipt1 = createSignedBindingReceipt({
        issuerId: "native-test-host",
        receiptId: randomUUID(),
        handle: implOutbound.handle,
        correlation: { token: implOutbound.message.message_id, provenance: "transport", verified: true },
        observedAt: new Date().toISOString(),
        privateKey: f.privateKey
      });
      await f.runtime.receiveHerdr(f.envelope("execution.receipt", receipt1, {
        causation_id: implOutbound.message.message_id,
        sender: { role: "developer", agent_id: dev1.agentId, pane_id: dev1.paneId }
      }));

      // Negative check: alternativeEvidence on code task throws behavioral runner required
      await expect(f.verification.alternativeEvidence(qa, {
        runId: "run-1",
        taskId: "implement",
        observationId: randomUUID(),
        criteria: [{ criterionId: "ac-1", passed: true, summary: "invalid" }]
      })).rejects.toThrow(/behavioral measurement runner required/i);

      // 3. Implement code task with behavioral TDD (Red -> Green -> Refactor)
      // Red phase
      await development.authorizeFileEdit(dev1, { tool_name: "Write", tool_input: { file_path: join(implWorktree, "test/double.test.cjs") } });
      await mkdir(join(implWorktree, "test"), { recursive: true });
      await writeFile(join(implWorktree, "test/double.test.cjs"), testSource);
      await development.commit(dev1, { runId: "run-1", taskId: "implement", expectedHead: currentHead(implWorktree), message: "Red: specify double" });

      const redHead = currentHead(implWorktree);
      const redQueued = await f.runtime.requestPhaseVerification(dev1, "run-1", "implement", "red", redHead) as any;
      await f.runtime.flushOutbound();
      const redPending = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === redQueued.messageId);
      const redMeasurement = await f.verification.behavioralEvidence(qa, { runId: "run-1", taskId: "implement", phase: "red" });
      expect(redMeasurement.result.status).toBe("failed");
      await f.runtime.receiveHerdr(f.envelope("verification.result", redMeasurement.result, {
        causation_id: redPending.message.message_id,
        sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId },
        artifact_references: redMeasurement.result.evidenceArtifacts
      }));
      await f.runtime.flushOutbound();

      // Green phase
      await development.authorizeFileEdit(dev1, { tool_name: "Write", tool_input: { file_path: join(implWorktree, "src/double.cjs") } });
      await mkdir(join(implWorktree, "src"), { recursive: true });
      await writeFile(join(implWorktree, "src/double.cjs"), "module.exports = (x) => x * 2;\n");
      await development.commit(dev1, { runId: "run-1", taskId: "implement", expectedHead: currentHead(implWorktree), message: "Green: implement double" });

      const greenHead = currentHead(implWorktree);
      const greenQueued = await f.runtime.requestPhaseVerification(dev1, "run-1", "implement", "green", greenHead) as any;
      await f.runtime.flushOutbound();
      const greenPending = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === greenQueued.messageId);
      const greenMeasurement = await f.verification.behavioralEvidence(qa, { runId: "run-1", taskId: "implement", phase: "green" });
      expect(greenMeasurement.result.status).toBe("passed");
      await f.runtime.receiveHerdr(f.envelope("verification.result", greenMeasurement.result, {
        causation_id: greenPending.message.message_id,
        sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId },
        artifact_references: greenMeasurement.result.evidenceArtifacts
      }));
      await f.runtime.flushOutbound();

      // Refactor phase
      const refactorHead = currentHead(implWorktree);
      const refactorQueued = await f.runtime.requestPhaseVerification(dev1, "run-1", "implement", "refactor", refactorHead) as any;
      await f.runtime.flushOutbound();
      const refactorPending = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === refactorQueued.messageId);
      const refactorMeasurement = await f.verification.behavioralEvidence(qa, { runId: "run-1", taskId: "implement", phase: "refactor" });
      expect(refactorMeasurement.result.status).toBe("passed");
      await f.runtime.receiveHerdr(f.envelope("verification.result", refactorMeasurement.result, {
        causation_id: refactorPending.message.message_id,
        sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId },
        artifact_references: refactorMeasurement.result.evidenceArtifacts
      }));
      await f.runtime.flushOutbound();

      // Submit implement task
      await f.submit("implement", null);
      await tickReviews(f);
      const runAfterImpl = await f.inspect();
      expect(runAfterImpl.tasks[0].cycle).toMatchObject({ status: "passed" });
      expect(runAfterImpl.tasks[0].result).toMatchObject({ status: "succeeded" });

      // 4. Dispatch docs task
      await f.runtime.tick();
      const state2 = await f.runtime.inspect() as any;
      const docsOutbound = state2.outbound.find((out: any) => out.message.type === "task.assignment" && out.taskId === "docs");
      expect(docsOutbound).toBeDefined();
      const dev2 = f.panes.bindings.find(b => b.paneId === docsOutbound.handle.target.paneId)!;
      const docsWorktree = docsOutbound.handle.target.worktreePath;

      const receipt2 = createSignedBindingReceipt({
        issuerId: "native-test-host",
        receiptId: randomUUID(),
        handle: docsOutbound.handle,
        correlation: { token: docsOutbound.message.message_id, provenance: "transport", verified: true },
        observedAt: new Date().toISOString(),
        privateKey: f.privateKey
      });
      await f.runtime.receiveHerdr(f.envelope("execution.receipt", receipt2, {
        causation_id: docsOutbound.message.message_id,
        sender: { role: "developer", agent_id: dev2.agentId, pane_id: dev2.paneId }
      }));

      // Authorize edit and write docs
      await development.authorizeFileEdit(dev2, { tool_name: "Write", tool_input: { file_path: join(docsWorktree, "docs/guide.md") } });
      await mkdir(join(docsWorktree, "docs"), { recursive: true });
      await writeFile(join(docsWorktree, "docs/guide.md"), "# Guide\nDouble function multiplies input by 2.\n");
      await development.commit(dev2, { runId: "run-1", taskId: "docs", expectedHead: currentHead(docsWorktree), message: "docs: add guide" });

      // Negative check 1: behavioralEvidence on docs task throws
      await expect(f.verification.behavioralEvidence(qa, {
        runId: "run-1",
        taskId: "docs",
        phase: "verification"
      })).rejects.toThrow();

      // Negative check 2: missing/uninspected manual observationId throws
      await expect(f.verification.alternativeEvidence(qa, {
        runId: "run-1",
        taskId: "docs",
        observationId: randomUUID(),
        criteria: [{ criterionId: "ac-2", passed: true, summary: "ok" }]
      })).rejects.toThrow("Inspect the assigned alternative evidence before submitting a judgment");

      // Negative check 3: foreign observation (observation for docs submitted to implement)
      const inspectedDocs = await f.verification.inspectAlternative(qa, { runId: "run-1", taskId: "docs" }) as any;
      await expect(f.verification.alternativeEvidence(qa, {
        runId: "run-1",
        taskId: "implement",
        observationId: inspectedDocs.observationId,
        criteria: [{ criterionId: "ac-1", passed: true, summary: "ok" }]
      })).rejects.toThrow();

      // Negative check 4: stale manual evidence (source changes after inspection)
      await development.authorizeFileEdit(dev2, { tool_name: "Write", tool_input: { file_path: join(docsWorktree, "docs/guide.md") } });
      await writeFile(join(docsWorktree, "docs/guide.md"), "# Guide\nDouble function multiplies input by 2. (Updated)\n");
      await development.commit(dev2, { runId: "run-1", taskId: "docs", expectedHead: currentHead(docsWorktree), message: "docs: update after inspect" });
      await expect(f.verification.alternativeEvidence(qa, {
        runId: "run-1",
        taskId: "docs",
        observationId: inspectedDocs.observationId,
        criteria: [{ criterionId: "ac-2", passed: true, summary: "ok" }]
      })).rejects.toThrow("Alternative evidence source changed after inspection");

      // 5. Valid manual review with freshly inspected evidence
      const freshDocs = await f.verification.inspectAlternative(qa, { runId: "run-1", taskId: "docs" }) as any;
      const altOutcome = await f.verification.alternativeEvidence(qa, {
        runId: "run-1",
        taskId: "docs",
        observationId: freshDocs.observationId,
        criteria: [{ criterionId: "ac-2", passed: true, summary: "Documentation independently reviewed and accurate" }]
      });
      expect(altOutcome.result.status).toBe("passed");
      await f.runtime.receiveHerdr(f.envelope("verification.result", altOutcome.result, {
        causation_id: docsOutbound.message.message_id,
        sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId },
        artifact_references: altOutcome.result.evidenceArtifacts
      }));

      // Submit docs task
      await f.submit("docs", null);
      await tickReviews(f);
      const runAfterDocs = await f.inspect();
      expect(runAfterDocs.tasks[1].cycle).toMatchObject({ status: "passed" });
      expect(runAfterDocs.tasks[1].result).toMatchObject({ status: "succeeded" });

      // Integrated workflow verification tick
      await tickReviews(f);

      // 6. Integrated final verification
      const finalRun = await f.inspect();
      expect(finalRun.tasks.every((t: any) => t.cycle?.status === "passed" && t.result?.status === "succeeded")).toBe(true);
      expect(finalRun.workflowCycle.status).toBe("passed");
      expect(finalRun.status).toBe("awaiting_approval");
      expect(finalRun.approvalKind).toBe("delivery");
    }, 180_000);
  });
});
