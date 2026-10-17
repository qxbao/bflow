import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SpecificationSchema, type Specification } from "@bflow/contracts";
import {
  runCli,
  executeHighLevelCommand,
  CLI_EXIT_CODES,
  environmentProcessRunner,
  type CliContext,
  type HighLevelFacadePorts,
  type HighLevelCommandOutput,
  type HighLevelParsedCliCommand
} from "../src/index.js";

function createValidSpecification(taskId: string = "task-1"): Specification {
  return SpecificationSchema.parse({
    schemaVersion: 2,
    specId: `spec-${taskId}`,
    runId: "run-1",
    sessionId: "session-test",
    level: "lightweight",
    title: `Specification for ${taskId}`,
    summary: `Summary of requirements for ${taskId}`,
    problemStatement: `Implement feature for ${taskId}`,
    scope: { inScope: ["core"], outOfScope: [] },
    affectedPaths: ["src/index.ts"],
    traceabilityTaskIds: [taskId],
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "Criterion 1 must pass tests",
        category: "functional",
        verificationMethod: "unit_test",
        required: true,
        status: "pending",
        evidenceArtifactIds: []
      }
    ],
    status: "approved",
    createdBy: "operator",
    approvedBy: "human:operator",
    artifactRef: {
      trust: "stored",
      artifactId: `art-spec-${taskId}`,
      runId: "run-1",
      kind: "document",
      uri: `artifact://default/art-spec-${taskId}`,
      mediaType: "application/json",
      sizeBytes: 100,
      checksum: { algorithm: "sha256", value: "0".repeat(64) },
      createdAt: new Date().toISOString()
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      conditionalTdd: {
        policyVersion: 1,
        taskId,
        taskType: "domain_logic",
        changeImpact: {
          surfaces: ["domain_logic", "transformation"],
          behaviorChanged: true,
          deterministic: true,
          regressionReproducible: true,
          securitySensitive: false,
          dataMigration: false,
          scope: "local"
        },
        infrastructure: {
          readiness: "ready",
          commands: [
            {
              method: "unit_test",
              command: "pnpm test",
              level: "unit"
            }
          ]
        },
        testability: {
          level: "automated",
          rationale: "Domain logic is deterministic and testable via automated unit tests."
        },
        riskClassification: "medium",
        conventions: {
          tdd: "contextual",
          requiredMethods: [],
          suggestedLevels: ["unit"]
        }
      }
    }
  });
}

function createValidVerificationResult(opts?: { status?: "passed" | "failed" }): any {
  const status = opts?.status ?? "passed";
  const isPassed = status === "passed";
  const art = {
    trust: "stored" as const,
    artifactId: "art-ev-1",
    runId: "run-1",
    kind: "test-result" as const,
    uri: "artifact://run-1/art-ev-1",
    mediaType: "application/json",
    sizeBytes: 100,
    checksum: { algorithm: "sha256" as const, value: "0".repeat(64) },
    createdAt: new Date().toISOString()
  };

  return {
    schemaVersion: 2,
    verificationId: "verif-1",
    runId: "run-1",
    taskId: "task-1",
    cycleNumber: 1,
    attemptId: "att-1",
    status,
    independentExecution: true,
    evaluatedCriteria: [
      {
        criterionId: "AC-1",
        passed: isPassed,
        evidenceArtifactId: "art-ev-1",
        summary: isPassed ? "Criterion passed unit tests" : "Criterion failed unit tests"
      }
    ],
    qualityGateResults: [],
    evidenceArtifacts: [art],
    findings: isPassed
      ? []
      : [
          {
            code: "TEST_FAILURE",
            severity: "error" as const,
            message: "Unit test assertion failed"
          }
        ],
    verifiedBy: "tester" as const,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString()
  };
}

function createValidVerificationCycle(opts?: { status?: "passed" | "rework_required"; result?: any }): any {
  const result = opts?.result ?? createValidVerificationResult();
  const status = opts?.status ?? (result.status === "passed" ? "passed" : "rework_required");

  return {
    schemaVersion: 2,
    cycleId: "cycle-1",
    runId: "run-1",
    taskId: "task-1",
    specId: "spec-1",
    currentIteration: 1,
    maxIterations: 3,
    status,
    tddDecision: {
      schemaVersion: 2,
      decisionId: "tdd-1",
      runId: "run-1",
      specId: "spec-1",
      mode: "recommended" as const,
      rationale: "Standard change",
      verifiableConditions: ["Must pass tests"],
      changeClassification: "domain_logic" as const,
      requiresFailingTestFirst: false,
      decidedBy: "coordinator" as const,
      decidedAt: new Date().toISOString()
    },
    history: [result],
    startedAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createMockPorts(
  tempDir: string,
  overrides?: Partial<HighLevelFacadePorts>
): HighLevelFacadePorts {
  return {
    identifyRepository: async () => ({
      root: tempDir,
      gitDir: join(tempDir, ".git"),
      id: "repo-test-id",
      sessionName: "test-session"
    }),
    git: {
      inspect: vi.fn(async () => ({
        head: "0123456789abcdef0123456789abcdef01234567",
        branch: "feature/test",
        dirty: false,
        statusLines: [],
        worktrees: [tempDir]
      })),
      prepareTask: vi.fn(async (args: any) => ({
        worktreePath: join(tempDir, `wt-${args.taskId}`),
        branchName: `task/${args.taskId}`,
        baseCommitHash: "0123456789abcdef0123456789abcdef01234567"
      })),
      getTask: vi.fn(async () => null),
      collectTask: vi.fn(async (taskKey: string) => ({
        taskId: taskKey,
        changedFiles: ["src/index.ts"],
        commits: ["abc1234"]
      })),
      beginIntegration: vi.fn(async (args: any) => ({
        key: args.integrationId ?? "int-1",
        branchName: `integration/${args.runId}`,
        status: "clean",
        requests: []
      })),
      getIntegration: vi.fn(async () => null)
    },
    runtime: {
      getRun: vi.fn(async (runId: string) => ({
        ok: true,
        value: {
          runId,
          workflowId: "wf-1",
          status: "running",
          tasks: [{ id: "task-1", taskId: "task-1", status: "pending" }]
        }
      }))
    },
    specification: {
      classifyChange: vi.fn(() => ({
        kind: "feature",
        complexity: "standard",
        level: "lightweight",
        requiredArtifacts: []
      })),
      validateTraceability: vi.fn(() => ({
        valid: true,
        coveragePercentage: 100,
        uncoveredCriterionIds: [],
        danglingTaskIds: [],
        errors: []
      })),
      buildTraceabilityMatrix: vi.fn(() => ({
        criteriaMappings: [],
        taskMappings: []
      }))
    },
    strategy: {
      resolve: vi.fn((opts: any) => ({
        strategyId: "strat-1",
        runId: opts.runId,
        taskId: opts.taskId,
        tddDecision: {
          mode: "recommended",
          requiresFailingTestFirst: false,
          reason: "Standard task"
        },
        phases: []
      })),
      assertReadyToImplement: vi.fn()
    },
    verification: {
      createVerificationPlan: vi.fn((opts: any) => ({
        planId: `plan-${opts.taskId}`,
        runId: opts.runId,
        taskId: opts.taskId,
        scope: opts.scope,
        checks: []
      })),
      start: vi.fn((plan: any, cycleId: string) => ({
        schemaVersion: 2,
        cycleId,
        runId: plan.runId,
        taskId: plan.taskId,
        specId: "spec-1",
        iteration: 1,
        maxIterations: 3,
        status: "in_progress",
        startedAt: new Date().toISOString()
      })),
      verify: vi.fn(async () => {
        const result = createValidVerificationResult({ status: "passed" });
        const cycle = createValidVerificationCycle({ status: "passed", result });
        return {
          result,
          cycle,
          messages: ["Verification completed successfully"]
        };
      })
    },
    mcpManager: {
      inspect: vi.fn(async () => [
        {
          schemaVersion: 3,
          serviceId: "test-mcp",
          status: "ready",
          capabilities: ["tools"],
          observedAt: new Date().toISOString()
        }
      ])
    },
    toolCatalog: [
      { toolId: "git", name: "git", required: true },
      { toolId: "node", name: "node", required: true },
      { toolId: "pnpm", name: "pnpm", required: true },
      { toolId: "herdr", name: "herdr", required: true }
    ],
    probeTools: vi.fn(async () => [
      { toolId: "git", status: "present", required: true },
      { toolId: "node", status: "present", required: true },
      { toolId: "pnpm", status: "present", required: true },
      { toolId: "herdr", status: "present", required: true }
    ]),
    toolCapabilities: {
      listCapabilities: vi.fn(async () => [])
    },
    skillStore: {
      get: vi.fn(async () => null),
      list: vi.fn(async () => [])
    },
    skillManager: {
      installBundle: vi.fn(async () => {}),
      sync: vi.fn(async (params: any) => ({
        manifest: {
          schemaVersion: 3,
          manifestId: params.manifestId,
          environmentId: params.environmentId,
          scope: params.scope,
          role: params.role,
          provider: params.provider,
          digest: "0".repeat(64),
          generatedAt: new Date().toISOString(),
          skills: []
        },
        rendered: { promptInstructions: "test instructions" }
      }))
    },
    providerRegistry: {
      checkHealth: vi.fn(async (req: any) => ({
        ok: true,
        value: {
          schemaVersion: 3,
          environmentId: req.environment.environmentId,
          provider: req.environment.provider,
          role: req.environment.role,
          configFingerprint: req.environment.configFingerprint,
          stage: req.stage,
          status: "ready",
          checkedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 60000).toISOString(),
          checks: [
            "binary",
            "version",
            "authentication",
            "environment",
            "mcp",
            "launch_arguments",
            "permissions",
            "skills"
          ].map(c => ({
            check: c,
            status: "passed",
            code: "ok",
            message: `${c} available`
          }))
        }
      }))
    },
    contextService: {
      analyzeRepositoryStructure: vi.fn(async () => ({
        totalFiles: 10,
        directories: ["src", "test"],
        packageManagers: ["pnpm"]
      })),
      loadProjectDocumentation: vi.fn(async () => ({
        readme: true,
        contributing: false,
        docsCount: 1
      })),
      prepareRoleTaskContext: vi.fn(async () => ({
        taskId: "task-1",
        contextFiles: []
      }))
    },
    ...overrides
  };
}

describe("High-Level Commands Test Suite", () => {
  let tempDir: string;
  let specPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bflow-cli-hl-test-"));
    const specsDir = join(tempDir, ".bflow", "specs");
    await mkdir(specsDir, { recursive: true });
    specPath = join(specsDir, "spec-task-1.json");
    await writeFile(specPath, JSON.stringify(createValidSpecification("task-1"), null, 2), "utf8");
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("Category 1: Command Success (all 9 commands)", () => {
    it("1.1 repo inspect succeeds and returns structured repository details", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["repo", "inspect"], { cwd: tempDir, highLevel: ports });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("repo inspect");
      const data = result.data as HighLevelCommandOutput;
      expect(data.schemaVersion).toBe(3);
      expect(data.status).toBe("succeeded");
      expect(data.details.repository).toBeDefined();
      expect(data.details.git).toBeDefined();
      expect(data.details.structure).toBeDefined();
      expect(result.stdout).toContain("Repository Summary");
    });

    it("1.2 task plan succeeds and derives workflow from specification", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["task", "plan", "--spec", specPath], {
        cwd: tempDir,
        highLevel: ports
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("task plan");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.details.workflow).toBeDefined();
      expect(data.details.classification).toBeDefined();
      expect(result.stdout).toContain("Planned Tasks");
    });

    it("1.3 task implement succeeds and tracks all 5 pipeline steps", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["task", "implement", "--task-id", "task-1", "--run-id", "run-1"], {
        cwd: tempDir,
        highLevel: ports
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("task implement");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.steps.length).toBe(5);
      expect(data.steps.every(s => s.status === "succeeded")).toBe(true);
      expect(data.steps.map(s => s.stepId)).toEqual([
        "verify_task_and_permissions",
        "load_spec_and_context",
        "resolve_tdd_policy",
        "prepare_worktree",
        "prepare_assignment_and_track"
      ]);
      expect(result.stdout).toContain("Implementation Summary");
    });

    it("1.4 verify succeeds and produces passed verification result", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["verify", "--task-id", "task-1", "--run-id", "run-1", "--cycle", "cycle-1"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("verify");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect((data.details.result as any).status).toBe("passed");
      expect(result.stdout).toContain("Verification");
    });

    it("1.5 git prepare succeeds and creates clean integration plan", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["git", "prepare", "--run-id", "run-1", "--task", "task-1"], {
        cwd: tempDir,
        highLevel: ports
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("git prepare");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.details.conflictsDetected).toBe(false);
      expect(result.stdout).toContain("Git Integration Summary");
    });

    it("1.6 mcp status succeeds and reports healthy services", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["mcp", "status"], { cwd: tempDir, highLevel: ports });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("mcp status");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.details.healthy).toBe(true);
      expect(result.stdout).toContain("MCP Services");
    });

    it("1.7 tool status succeeds and probes catalog tools", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["tool", "status"], { cwd: tempDir, highLevel: ports });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("tool status");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.details.healthy).toBe(true);
      expect(result.stdout).toContain("Pinned Tools");
    });

    it("1.8 skills sync succeeds and generates skill manifests", async () => {
      const ports = createMockPorts(tempDir);
      const catalogDir = existsSync(join(process.cwd(), "skills"))
        ? join(process.cwd(), "skills")
        : resolve(process.cwd(), "../../skills");
      const result = await runCli(["skills", "sync", "--provider", "claude", "--catalog-dir", catalogDir], {
        cwd: tempDir,
        highLevel: ports
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("skills sync");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(Array.isArray(data.details.syncedManifests)).toBe(true);
      expect(result.stdout).toContain("Skills Synchronization");
    });

    it("1.9 agent check succeeds and verifies provider preflight readiness", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["agent", "check", "--provider", "claude"], {
        cwd: tempDir,
        highLevel: ports
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("agent check");
      const data = result.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.details.healthy).toBe(true);
      expect(result.stdout).toContain("Agent Providers");
    });
  });

  describe("Category 2: Command Fails at Middle Step", () => {
    it("fails at resolve_tdd_policy when red evidence is required but missing", async () => {
      const ports = createMockPorts(tempDir, {
        strategy: {
          resolve: vi.fn(() => ({
            strategyId: "strat-strict",
            runId: "run-1",
            taskId: "task-1",
            tddDecision: {
              mode: "required",
              requiresFailingTestFirst: true,
              reason: "Strict TDD required"
            },
            phases: []
          })),
          assertReadyToImplement: vi.fn(() => {
            throw {
              code: "validation",
              retryable: false,
              message: "Missing failing test (red phase) evidence before implementation."
            };
          })
        }
      });

      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--require-red-evidence"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Missing failing test (red phase) evidence");

      const steps = (result.error?.details as any)?.steps;
      expect(Array.isArray(steps)).toBe(true);
      expect(steps[0].status).toBe("succeeded"); // verify_task_and_permissions
      expect(steps[1].status).toBe("succeeded"); // load_spec_and_context
      expect(steps[2].status).toBe("failed"); // resolve_tdd_policy
      expect(steps[3].status).toBe("skipped"); // prepare_worktree
      expect(steps[4].status).toBe("skipped"); // prepare_assignment_and_track
    });

    it("records earlier steps as succeeded, failed step as failed/unknown, and skips later steps", async () => {
      const ports = createMockPorts(tempDir, {
        git: {
          prepareTask: vi.fn(async () => {
            throw new Error("Disk full: cannot create worktree");
          }),
          getTask: vi.fn(async () => null)
        } as any
      });

      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);

      const steps = (result.error?.details as any)?.steps;
      expect(Array.isArray(steps)).toBe(true);
      expect(steps[0].status).toBe("succeeded");
      expect(steps[1].status).toBe("succeeded");
      expect(steps[2].status).toBe("succeeded");
      expect(steps[3].status).toBe("unknown"); // prepare_worktree is mutating, so failure becomes unknown
      expect(steps[4].status).toBe("skipped");
    });

    it("verify fails when verification engine throws during cycle execution", async () => {
      const ports = createMockPorts(tempDir, {
        verification: {
          createVerificationPlan: vi.fn((opts: any) => ({
            planId: `plan-${opts.taskId}`,
            runId: opts.runId,
            taskId: opts.taskId,
            scope: opts.scope,
            checks: []
          })),
          start: vi.fn(() => {
            throw new Error("Verification harness crashed");
          }),
          verify: vi.fn()
        }
      });

      const result = await runCli(
        ["verify", "--task-id", "task-1", "--run-id", "run-1", "--cycle", "c1"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Verification harness crashed");
    });
  });

  describe("Category 3: Idempotent Retry", () => {
    it("returns reusedReceipt: true and identical result on exact same idempotency key", async () => {
      const ports = createMockPorts(tempDir);
      const idempotencyKey = "idemp-test-retry-1";

      const firstRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: ports }
      );

      expect(firstRun.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(firstRun.ok).toBe(true);
      const firstData = firstRun.data as HighLevelCommandOutput;
      expect(firstData.reusedReceipt).toBe(false);

      // Re-run with the exact same idempotency key and arguments
      const secondRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: ports }
      );

      expect(secondRun.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(secondRun.ok).toBe(true);
      const secondData = secondRun.data as HighLevelCommandOutput;
      expect(secondData.reusedReceipt).toBe(true);
      expect(secondData.commandId).toBe(firstData.commandId);
      expect(secondData.idempotencyKey).toBe(idempotencyKey);
    });

    it("rejects retry with conflict error when parameters change for the same idempotency key", async () => {
      const ports = createMockPorts(tempDir);
      const idempotencyKey = "idemp-test-conflict-1";

      const firstRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--developer-id", "dev-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: ports }
      );
      expect(firstRun.ok).toBe(true);

      // Re-run with changed parameters under the same idempotency key
      const secondRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--developer-id", "dev-different", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: ports }
      );

      expect(secondRun.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(secondRun.ok).toBe(false);
      expect(secondRun.error?.code).toBe("conflict");
      expect(secondRun.error?.message).toContain("already used with different command parameters");
    });
  });

  describe("Category 4: Uncertain Mutation State Protection", () => {
    it("marks mutating step as unknown when it fails with timeout or uncertain error", async () => {
      let callCount = 0;
      const ports = createMockPorts(tempDir, {
        git: {
          prepareTask: vi.fn(async () => {
            callCount++;
            throw {
              code: "timeout",
              message: "Network/lock timeout during git worktree creation",
              uncertain: true,
              retrySafety: "not_started"
            };
          }),
          getTask: vi.fn(async () => null)
        } as any
      });

      const idempotencyKey = "idemp-uncertain-test-1";
      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(callCount).toBe(1);

      const steps = (result.error?.details as any)?.steps;
      expect(steps[3].stepId).toBe("prepare_worktree");
      expect(steps[3].status).toBe("unknown");
    });

    it("blocks subsequent retries without --resume when prior run left mutating step in uncertain state", async () => {
      const idempotencyKey = "idemp-uncertain-block-1";
      const portsFailing = createMockPorts(tempDir, {
        git: {
          prepareTask: vi.fn(async () => {
            throw {
              code: "timeout",
              message: "Network lock timeout",
              uncertain: true,
              retrySafety: "not_started"
            };
          }),
          getTask: vi.fn(async () => null)
        } as any
      });

      // 1. Initial run fails leaving mutating step in uncertain state
      const firstRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: portsFailing }
      );
      expect(firstRun.ok).toBe(false);

      // 2. Retry without --resume must be blocked
      const retryPorts = createMockPorts(tempDir);
      const retryRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: retryPorts }
      );

      expect(retryRun.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(retryRun.ok).toBe(false);
      expect(retryRun.error?.code).toBe("conflict");
      expect(retryRun.error?.message).toContain("left mutating step 'prepare_worktree' in an uncertain/interrupted state");
      expect(retryRun.error?.message).toContain("Reconcile state using '--resume'");
    });
  });

  describe("Category 5: Resume (--resume)", () => {
    it("resumes from interrupted step when --resume is specified, skipping completed steps", async () => {
      const idempotencyKey = "idemp-resume-success-1";

      // 1. Fail at step 4 (prepare_worktree)
      const portsFailing = createMockPorts(tempDir, {
        git: {
          prepareTask: vi.fn(async () => {
            throw {
              code: "timeout",
              message: "Network lock timeout",
              uncertain: true,
              retrySafety: "not_started"
            };
          }),
          getTask: vi.fn(async () => null)
        } as any
      });

      const firstRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey],
        { cwd: tempDir, highLevel: portsFailing }
      );
      expect(firstRun.ok).toBe(false);

      // 2. Now resume with working ports
      const step1Spy = vi.fn();
      const portsWorking = createMockPorts(tempDir, {
        runtime: {
          getRun: vi.fn(async (runId: string) => {
            step1Spy();
            return {
              ok: true,
              value: {
                runId,
                workflowId: "wf-1",
                status: "running",
                tasks: [{ id: "task-1", taskId: "task-1", status: "pending" }]
              }
            };
          })
        }
      });

      const resumedRun = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", idempotencyKey, "--resume"],
        { cwd: tempDir, highLevel: portsWorking }
      );

      expect(resumedRun.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(resumedRun.ok).toBe(true);
      const data = resumedRun.data as HighLevelCommandOutput;
      expect(data.status).toBe("succeeded");
      expect(data.resumedFromStep).toBe("prepare_worktree");
      // Step 1 was already completed, so it was skipped on resume!
      expect(step1Spy).not.toHaveBeenCalled();
    });

    it("fails with not_found when --resume is specified but no prior execution receipt exists", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--idempotency-key", "non-existent-idemp-key", "--resume"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(result.error?.message).toContain("No prior command execution state found to resume");
    });
  });

  describe("Category 6: Non-Existent Task", () => {
    it("task implement fails at step 1 (verify_task_and_permissions) with not_found when task is missing in runtime", async () => {
      const ports = createMockPorts(tempDir, {
        runtime: {
          getRun: vi.fn(async (runId: string) => ({
            ok: true,
            value: {
              runId,
              workflowId: "wf-1",
              status: "running",
              tasks: [{ id: "task-other", taskId: "task-other", status: "pending" }]
            }
          }))
        }
      });

      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(result.error?.message).toContain("Task 'task-1' not found in run 'run-1'");

      const steps = (result.error?.details as any)?.steps;
      expect(steps[0].stepId).toBe("verify_task_and_permissions");
      expect(steps[0].status).toBe("failed");
    });

    it("task implement fails with not_found when taskId is prefixed with nonexistent- or missing-", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["task", "implement", "--task-id", "missing-task-99", "--run-id", "run-1"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(result.error?.message).toContain("not found");
    });
  });

  describe("Category 7: Permission, Role Boundaries & Protected Branch Guard", () => {
    it("blocks mutating command when permissionMode is restricted", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--permission-mode", "restricted"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("validation");
      expect(result.error?.message).toContain("Permission denied: 'restricted' permission mode is read-only");
    });

    it("blocks unattended_isolated mode when session ID or container isolation is missing", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--permission-mode", "unattended_isolated"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("validation");
      expect(result.error?.message).toContain("requires explicit --session-id and OS/container isolation");
    });

    it("blocks conversation role from mutating codebase or running verification", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--role", "conversation"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("validation");
      expect(result.error?.message).toContain("Role boundary violation: 'conversation' role is the user interface only");
    });

    it("blocks auto-approval on protected branches (main/prod)", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["git", "prepare", "--run-id", "run-1", "--task", "task-1", "--target-branch", "main", "--auto-approve"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("validation");
      expect(result.error?.message).toContain("cannot auto-approve protected branch merge");
    });

    it("blocks git prepare targeting protected branch without human approval", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        ["git", "prepare", "--run-id", "run-1", "--task", "task-1", "--target-branch", "main"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("validation");
      expect(result.error?.message).toContain("requires explicit human approval");
    });

    it("allows git prepare targeting protected branch with valid human approver", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(
        [
          "git",
          "prepare",
          "--run-id",
          "run-1",
          "--task",
          "task-1",
          "--target-branch",
          "main",
          "--approved-by",
          "human:operator"
        ],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.command).toBe("git prepare");
    });
  });

  describe("Category 8: Invalid Arguments & Usage Errors", () => {
    it("task plan returns exitCode 2 when --spec is missing", async () => {
      const result = await runCli(["task", "plan"], { cwd: tempDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Option '--spec' (or positional spec path) is required");
    });

    it("task implement returns exitCode 2 when --task-id is missing", async () => {
      const result = await runCli(["task", "implement", "--run-id", "run-1"], { cwd: tempDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Task identifier is required");
    });

    it("task implement returns exitCode 2 when --run-id is missing", async () => {
      const result = await runCli(["task", "implement", "--task-id", "task-1"], { cwd: tempDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Option '--run-id' is required");
    });

    it("git prepare returns exitCode 2 when --run-id is missing", async () => {
      const result = await runCli(["git", "prepare", "--task", "task-1"], { cwd: tempDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Option '--run-id' is required");
    });

    it("returns exitCode 2 when unknown flags are provided", async () => {
      const result = await runCli(["repo", "inspect", "--unknown-flag-xyz"], { cwd: tempDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Unknown option '--unknown-flag-xyz'");
    });
  });

  describe("Category 9: JSON Contract Validation & Concurrent Locks", () => {
    it("emits valid JSON envelope on stdout with --json flag for successful command", async () => {
      const ports = createMockPorts(tempDir);
      const result = await runCli(["repo", "inspect", "--json"], { cwd: tempDir, highLevel: ports });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("repo inspect");
      expect(parsed.data.schemaVersion).toBe(3);
      expect(parsed.data.details.repository).toBeDefined();
    });

    it("emits valid JSON envelope on stdout with exitCode 1 when domain check reports failure/conflicts", async () => {
      const failedResult = createValidVerificationResult({ status: "failed" });
      const failedCycle = createValidVerificationCycle({ status: "rework_required", result: failedResult });

      const ports = createMockPorts(tempDir, {
        verification: {
          createVerificationPlan: vi.fn((opts: any) => ({
            planId: `plan-${opts.taskId}`,
            runId: opts.runId,
            taskId: opts.taskId,
            scope: opts.scope,
            checks: []
          })),
          start: vi.fn((plan: any, cycleId: string) => ({
            schemaVersion: 2,
            cycleId,
            runId: plan.runId,
            taskId: plan.taskId,
            specId: "spec-1",
            iteration: 1,
            maxIterations: 3,
            status: "in_progress",
            startedAt: new Date().toISOString()
          })),
          verify: vi.fn(async () => ({
            result: failedResult,
            cycle: failedCycle,
            messages: ["Verification completed with failure"]
          }))
        }
      });

      const result = await runCli(
        ["verify", "--task-id", "task-1", "--run-id", "run-1", "--cycle", "cycle-1", "--json"],
        { cwd: tempDir, highLevel: ports }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("verify");
      expect(parsed.data.details.result.status).toBe("failed");
    });

    it("emits valid JSON error envelope on stderr with --json flag when usage validation fails", async () => {
      const result = await runCli(["task", "plan", "--json"], { cwd: tempDir });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      expect(result.ok).toBe(false);

      const parsed = JSON.parse(result.stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe("task plan");
      expect(parsed.error.code).toBe("validation");
    });

    it("prevents concurrent command invocations on the same scope with conflict lock error", async () => {
      let releaseLockStep: (() => void) | undefined;
      const stepHoldPromise = new Promise<void>(resolve => {
        releaseLockStep = resolve;
      });

      const portsSlow = createMockPorts(tempDir, {
        contextService: {
          analyzeRepositoryStructure: vi.fn(async () => {
            await stepHoldPromise;
            return { totalFiles: 1, directories: [], packageManagers: [] };
          }),
          loadProjectDocumentation: vi.fn(async () => ({ readme: true, contributing: false, docsCount: 0 })),
          prepareRoleTaskContext: vi.fn(async () => ({ taskId: "t1", contextFiles: [] }))
        }
      });

      const cmdParsed: HighLevelParsedCliCommand = {
        command: "repo inspect",
        json: false,
        help: false,
        correlationId: "corr-lock-1",
        idempotencyKey: "idemp-lock-1",
        resume: false,
        dir: undefined,
        includeFiles: false,
        maxFiles: undefined
      };

      const context: CliContext = {
        cwd: tempDir,
        highLevel: portsSlow
      };

      // Launch first command which holds lock
      const p1 = executeHighLevelCommand(cmdParsed, context);

      // Give event loop tick to acquire lock
      await new Promise(r => setTimeout(r, 20));

      // Launch second command for same scope
      const p2 = executeHighLevelCommand(cmdParsed, context);

      // Now release first command
      if (releaseLockStep) {
        releaseLockStep();
      }

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1.ok).toBe(true);
      expect(res1.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

      expect(res2.ok).toBe(false);
      expect(res2.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(res2.error?.code).toBe("conflict");
      expect(res2.error?.message).toContain("Concurrent command invocation in progress");
    });
  });

  describe("Category 10: Real Engine Integration Tests (No Mock Ports)", () => {
    let realRepoDir: string;
    let specPath: string;

    beforeEach(async () => {
      const rawDir = await mkdtemp(join(tmpdir(), "bflow-cli-real-"));
      await chmod(rawDir, 0o700);
      realRepoDir = await realpath(rawDir);
      await chmod(realRepoDir, 0o700);

      // Initialize real git repo with clean commit
      await environmentProcessRunner.run({
        executable: "git",
        args: ["init", "-b", "main"],
        cwd: realRepoDir
      });
      await environmentProcessRunner.run({
        executable: "git",
        args: ["config", "user.name", "Integration Tester"],
        cwd: realRepoDir
      });
      await environmentProcessRunner.run({
        executable: "git",
        args: ["config", "user.email", "tester@example.com"],
        cwd: realRepoDir
      });

      // Write .gitignore so .bflow artifacts/logs are ignored by git status
      await writeFile(join(realRepoDir, ".gitignore"), ".bflow\n");
      await writeFile(join(realRepoDir, "README.md"), "# Real Integration Repo\n");
      await mkdir(join(realRepoDir, "src"), { recursive: true });
      await writeFile(join(realRepoDir, "src", "index.ts"), "export const value = 42;\n");

      // Write valid specification
      const spec = createValidSpecification("task-1");
      specPath = join(realRepoDir, "spec.json");
      await writeFile(specPath, JSON.stringify(spec, null, 2));

      await environmentProcessRunner.run({
        executable: "git",
        args: ["add", "."],
        cwd: realRepoDir
      });
      await environmentProcessRunner.run({
        executable: "git",
        args: ["commit", "-m", "Initial commit"],
        cwd: realRepoDir
      });
    });

    afterEach(async () => {
      await rm(realRepoDir, { recursive: true, force: true });
    });

    it("runs repo inspect --json without mock ports against a real git repo", async () => {
      const result = await runCli(["repo", "inspect", "--json"], { cwd: realRepoDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("repo inspect");
      const data = parsed.data;
      expect(data.schemaVersion).toBe(3);
      expect(data.command).toBe("repo inspect");
      expect(data.status).toBe("succeeded");
      expect(data.executionResult.status).toBe("succeeded");
      expect(data.executionResult.output.root).toBe(realRepoDir);
      expect(data.executionResult.output.dirty).toBe(false);
      expect(data.details.structure).toBeDefined();
      expect(data.details.documentation).toBeDefined();
    });

    it("runs task plan --spec <specPath> --json without mock ports against real engines", async () => {
      const result = await runCli(["task", "plan", "--spec", specPath, "--json"], {
        cwd: realRepoDir
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("task plan");
      const data = parsed.data;
      expect(data.schemaVersion).toBe(3);
      expect(data.command).toBe("task plan");
      expect(data.status).toBe("succeeded");
      expect(data.details.specification.specId).toBe("spec-task-1");
      expect(data.details.workflow).toBeDefined();
      expect(data.details.traceability.valid).toBe(true);
    });

    // The production P18 integration journal requires Linux flock.
    it.skipIf(process.platform !== "linux")("runs task implement task-1 --run-id run-1 --spec <specPath> --json without mock ports against real engines", async () => {
      const result = await runCli(
        ["task", "implement", "--task-id", "task-1", "--run-id", "run-1", "--spec", specPath, "--json"],
        { cwd: realRepoDir }
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("task implement");
      const data = parsed.data;
      expect(data.schemaVersion).toBe(3);
      expect(data.command).toBe("task implement");
      expect(data.status).toBe("succeeded");
      expect(data.executionResult.status).toBe("succeeded");
      expect(data.executionResult.output.taskId).toBe("task-1");
      expect(data.details.worktree).toBeDefined();
      expect(data.details.worktree.worktreePath).toBeDefined();
      expect(data.details.testStrategy).toBeDefined();
    });

    it("runs skills list and skills sync without mock ports", async () => {
      const repoSkillsDir = existsSync(join(process.cwd(), "skills"))
        ? join(process.cwd(), "skills")
        : resolve(process.cwd(), "../../skills");

      const listResult = await runCli(
        ["skills", "list", "--catalog-dir", repoSkillsDir, "--json"],
        { cwd: realRepoDir }
      );
      expect(listResult.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(listResult.ok).toBe(true);

      const parsedList = JSON.parse(listResult.stdout);
      expect(parsedList.ok).toBe(true);
      expect(parsedList.command).toBe("skills sync");
      const listData = parsedList.data;
      expect(listData.command).toBe("skills sync");
      expect(listData.status).toBe("succeeded");
      expect(listData.executionResult.output.mode).toBe("list");
      expect(listData.executionResult.output.catalogCount).toBeGreaterThan(0);

      const syncResult = await runCli(
        ["skills", "sync", "--catalog-dir", repoSkillsDir, "--json"],
        { cwd: realRepoDir }
      );
      expect(syncResult.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(syncResult.ok).toBe(true);

      const parsedSync = JSON.parse(syncResult.stdout);
      expect(parsedSync.ok).toBe(true);
      expect(parsedSync.command).toBe("skills sync");
      const syncData = parsedSync.data;
      expect(syncData.command).toBe("skills sync");
      expect(syncData.status).toBe("succeeded");
      expect(syncData.executionResult.output.mode).toBe("sync");
      expect(syncData.executionResult.output.catalogCount).toBeGreaterThan(0);
    // Two real CLI processes over the full skills catalog; the 30 s default timed out under full-suite load.
    }, 120_000);

    it("runs mcp status --json without mock ports", async () => {
      const result = await runCli(["mcp", "status", "--json"], { cwd: realRepoDir });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("mcp status");
      const data = parsed.data;
      expect(data.schemaVersion).toBe(3);
      expect(data.command).toBe("mcp status");
      expect(data.status).toBe("succeeded");
      expect(data.details.healthy).toBe(true);
    });
  });
});
