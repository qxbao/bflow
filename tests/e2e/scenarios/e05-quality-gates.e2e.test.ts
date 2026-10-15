import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createQualityGateContext,
  createSafeSubprocessGate,
  expectOk
} from "../helpers/fixtures.js";
import {
  evaluateAutomatedVsHumanGovernance,
  CommandQualityGate,
  createDefaultSecurityPolicy,
  DEFAULT_ALLOWED_COMMANDS
} from "@ai-flow/quality-gates";
import type {
  QualityGateResult
} from "@ai-flow/contracts";

describe("Scenario E05 — Quality Gates & Policy Enforcement", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("evaluates real subprocess CommandQualityGate successfully (PASS) with verified evidence", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "review-gate-pass",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        console.log("Static code analysis passed: 0 vulnerabilities found");
        process.exit(0);
      `,
      outputExpectation: {
        mustContain: ["Static code analysis passed"],
        requireNonEmptyStdout: true
      }
    });

    const context = createQualityGateContext({
      runId,
      gateId: "review-gate-pass",
      taskId: "review"
    });

    const evalRes = await gate.evaluate(context);
    const result: QualityGateResult = expectOk(evalRes);

    expect(result.status).toBe("passed");
    expect(result.gateId).toBe("review-gate-pass");
    expect(result.runId).toBe(runId);
    expect(result.producedArtifacts.length).toBe(1);
    expect(result.producedArtifacts[0]!.expectedIntegrity.checksum.algorithm).toBe("sha256");
    expect(result.producedArtifacts[0]!.expectedIntegrity.sizeBytes).toBeGreaterThan(0);
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("evaluates real subprocess CommandQualityGate with non-zero exit code (FAIL) and records findings", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "qa-gate-fail",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        console.error("Critical vulnerability detected: SQL injection vulnerability in search query");
        process.exit(1);
      `
    });

    const context = createQualityGateContext({
      runId,
      gateId: "qa-gate-fail",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result: QualityGateResult = expectOk(evalRes);

    expect(result.status).toBe("failed");
    expect(result.findings.length).toBeGreaterThan(0);
    const nonZeroFinding = result.findings.find((f) => f.code === "NON_ZERO_EXIT_CODE");
    expect(nonZeroFinding).toBeDefined();
    expect(nonZeroFinding?.severity).toBe("error");
    expect(result.metadata?.exitCode).toBe(1);
  });

  it("enforces requireNonEmptyStdout: fails with MISSING_EXECUTION_EVIDENCE when command outputs nothing", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "evidence-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        // Exits 0 but produces nothing on stdout
        process.exit(0);
      `,
      outputExpectation: {
        requireNonEmptyStdout: true
      }
    });

    const context = createQualityGateContext({
      runId,
      gateId: "evidence-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result: QualityGateResult = expectOk(evalRes);

    expect(result.status).toBe("failed");
    const evidenceFinding = result.findings.find((f) => f.code === "MISSING_EXECUTION_EVIDENCE");
    expect(evidenceFinding).toBeDefined();
    expect(evidenceFinding?.severity).toBe("error");
  });

  it("enforces command timeout: terminates hanging command and records COMMAND_TIMEOUT error", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    // Subprocess with infinite busy loop
    const gate = createSafeSubprocessGate({
      gateId: "timeout-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        // Hang indefinitely
        setInterval(() => {}, 1000);
      `,
      timeoutMs: 300 // 300ms budget
    });

    const context = createQualityGateContext({
      runId,
      gateId: "timeout-gate",
      taskId: "qa",
      timeoutMs: 300
    });

    const evalRes = await gate.evaluate(context);
    const result: QualityGateResult = expectOk(evalRes);

    expect(result.status).toBe("error");
    const timeoutFinding = result.findings.find((f) => f.code === "COMMAND_TIMEOUT");
    expect(timeoutFinding).toBeDefined();
    expect(timeoutFinding?.severity).toBe("error");
    expect(result.metadata?.timedOut).toBe(true);
  });

  // =========================================================================
  // UPSTREAM DEFECT PROBES (Reproduction tests asserting safety invariants)
  // These tests assert TRUE SYSTEM SAFETY. If upstream P04 fails to uphold
  // the invariant, the test correctly fails (RED) to document the defect.
  // =========================================================================

  it("PROBE PM-01 (P04 DEFECT): Required quality gate must not be downgraded or skipped to passed", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    // Gate configured with skip: true in spec, but required in workflow definition
    const policyRes = createDefaultSecurityPolicy({
      allowedRootDirs: [harness.tmpDir],
      assignedWorktreePath: harness.tmpDir,
      maxExecutionTimeoutMs: 30000,
      allowedCommands: [...DEFAULT_ALLOWED_COMMANDS]
    });
    const policy = expectOk(policyRes);

    const gate = new CommandQualityGate({
      spec: {
        gateId: "probe-pm01-skip-gate",
        checkKind: "unit_test",
        command: { executable: "node", args: ["-e", "process.exit(0);"] },
        workingDirectory: harness.tmpDir,
        required: true,
        skip: true, // Evaluator spec requests skip
        skipReason: "Local skip requested"
      },
      securityPolicy: policy
    });

    const context = createQualityGateContext({
      runId,
      gateId: "probe-pm01-skip-gate",
      taskId: "qa",
      required: true // Workflow definition mandates gate is REQUIRED!
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);

    // SAFETY INVARIANT: A required quality gate CANNOT be skipped to "passed" status!
    // If skipped, it must evaluate to "failed" or "blocked", never "passed".
    // (Upstream P04 currently violates this by returning status: "passed" with code: "CHECK_SKIPPED")
    expect(result.status).not.toBe("passed");
  });

  it("PROBE PM-03 (P04 DEFECT): Missing required quality test count evidence must fail the gate", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    // Gate configured with minPassedTestsCount: 100, but without outputParser
    const gate = createSafeSubprocessGate({
      gateId: "probe-pm03-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        console.log("Ran 0 tests");
        process.exit(0);
      `,
      outputExpectation: {
        minPassedTestsCount: 100
      }
    });

    const context = createQualityGateContext({
      runId,
      gateId: "probe-pm03-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);

    // SAFETY INVARIANT: When minPassedTestsCount is 100, running 0 tests MUST FAIL!
    // (Upstream P04 currently violates this by nesting the check only inside `if (this.spec.outputParser)`)
    expect(result.status).toBe("failed");
    expect(result.findings.some((f) => f.code === "MISSING_EXECUTION_EVIDENCE")).toBe(true);
  });

  it("PROBE PM-04 (P04 DEFECT): Governance evaluation must reject foreign run quality gate results", async () => {
    const foreignRunId = `run-foreign-${randomUUID()}`;
    const targetRunId = `run-target-${randomUUID()}`;

    const foreignPassedGate: QualityGateResult = {
      gateId: "gate-automated-check",
      runId: foreignRunId, // BELONGS TO A DIFFERENT WORKFLOW RUN!
      evaluationId: `eval-${randomUUID()}`,
      status: "passed",
      findings: [],
      producedArtifacts: [],
      evaluatedAt: new Date().toISOString()
    };

    const govRes = await evaluateAutomatedVsHumanGovernance({
      runId: targetRunId,
      automatedGateResults: [foreignPassedGate],
      requiresHumanApproval: true,
      humanApprovalDecision: {
        schemaVersion: 1,
        approvalId: `appr-${randomUUID()}`,
        runId: targetRunId,
        target: { type: "run" },
        revision: 1,
        generation: 0,
        decision: "approved",
        decidedBy: "human_release_manager",
        decidedAt: new Date().toISOString(),
        feedbackArtifacts: [],
        idempotencyKey: `appr-key-${randomUUID()}`
      }
    });

    const govOutcome = expectOk(govRes);

    // SAFETY INVARIANT: A gate result from a foreign workflow run CANNOT satisfy the target run!
    // (Upstream P04 currently violates this by never checking gate.runId === request.runId)
    expect(govOutcome.allAutomatedGatesPassed).toBe(false);
    expect(govOutcome.canProceedToDelivery).toBe(false);
  });

  it("PROBE PM-08: CommandQualityGate generates arbitrary uncoordinated evaluationId", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "probe-pm08-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: `process.exit(0);`
    });

    const context = createQualityGateContext({
      runId,
      gateId: "probe-pm08-gate",
      taskId: "review"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);

    // Documented behavior: evaluator mints its own uncoordinated random UUID evaluationId
    expect(result.evaluationId).toContain("eval-probe-pm08-gate-");
  });
});
