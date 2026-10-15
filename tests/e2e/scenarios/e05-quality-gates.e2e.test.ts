import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createQualityGateContext,
  createRealNodeUnitTestGate,
  createSafeSubprocessGate,
  createStrictTapParser,
  expectOk
} from "../helpers/fixtures.js";
import {
  evaluateAutomatedVsHumanGovernance,
  CommandQualityGate,
  createDefaultSecurityPolicy,
  DEFAULT_ALLOWED_COMMANDS,
  type QualityCommandOutcome
} from "@bflow/quality-gates";
import type {
  ApprovalDecision,
  ApprovalRequest,
  QualityGateResult
} from "@bflow/contracts";

function makeCommandOutcome(stdout: string, exitCode = 0): QualityCommandOutcome {
  return {
    executable: process.execPath,
    args: ["--test", "--test-reporter=tap"],
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    combinedOutput: stdout,
    durationMs: 10,
    timedOut: false,
    aborted: false,
    outputTruncated: false
  };
}

describe("Scenario E05 — Quality Gates & Policy Enforcement", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("evaluates protocol output smoke QualityGate successfully with checkKind custom and verified evidence", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "review-gate-pass",
      workingDirectory: harness.tmpDir,
      checkKind: "custom",
      scriptBody: `
        console.log("Protocol output smoke check: runner execution verified");
        process.exit(0);
      `,
      outputExpectation: {
        mustContain: ["Protocol output smoke check"],
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
        console.error("Critical defect detected: assertion failure in test suite");
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
        // Silent success without any stdout
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

    const gate = createSafeSubprocessGate({
      gateId: "timeout-gate",
      workingDirectory: harness.tmpDir,
      timeoutMs: 200,
      scriptBody: `
        // Intentional infinite loop
        setInterval(() => {}, 1000);
      `
    });

    const context = createQualityGateContext({
      runId,
      gateId: "timeout-gate",
      taskId: "qa",
      timeoutMs: 200
    });

    const evalRes = await gate.evaluate(context);
    const result: QualityGateResult = expectOk(evalRes);

    expect(["failed", "error"]).toContain(result.status);
    const timeoutFinding = result.findings.find((f) => f.code === "COMMAND_TIMEOUT");
    expect(timeoutFinding).toBeDefined();
    expect(timeoutFinding?.severity).toBe("error");
  });

  it("evaluates real test suite with strict TAP parser: passes when real node:test tests meet plan", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createRealNodeUnitTestGate({
      gateId: "real-node-pass-gate",
      workingDirectory: harness.tmpDir,
      testFileContent: `
        import test from "node:test";
        import assert from "node:assert/strict";

        test("real auth logic verification", () => {
          assert.equal(1 + 1, 2);
        });

        test("real token format verification", () => {
          assert.equal(typeof "token-123", "string");
        });

        test("real session duration verification", () => {
          assert.equal(Math.max(10, 20), 20);
        });
      `,
      minPassedTestsCount: 3,
      outputParser: createStrictTapParser({ requirePlan: true, minPassedTestsCount: 3 })
    });

    const context = createQualityGateContext({
      runId,
      gateId: "real-node-pass-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);
    expect(result.status).toBe("passed");
    expect(result.metadata?.exitCode).toBe(0);
    expect(result.findings.length).toBe(0);
  });

  it("evaluates real test suite with strict TAP parser: genuine node:test assertion failure exits non-zero and fails gate", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createRealNodeUnitTestGate({
      gateId: "real-node-fail-gate",
      workingDirectory: harness.tmpDir,
      testFileContent: `
        import test from "node:test";
        import assert from "node:assert/strict";

        test("passing verification", () => {
          assert.equal(1, 1);
        });

        test("failing verification", () => {
          assert.equal(1, 2, "intentional test failure");
        });
      `,
      outputParser: createStrictTapParser({ requirePlan: true })
    });

    const context = createQualityGateContext({
      runId,
      gateId: "real-node-fail-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);
    expect(result.status).toBe("failed");
    expect(result.metadata?.exitCode).toBe(1);
    expect(result.findings.some((f) => f.code === "NON_ZERO_EXIT_CODE" || f.code === "TEST_POINT_FAILED")).toBe(true);
  });

  it("evaluates actual ZERO test file with minPassedTestsCount: fails when no tests executed", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createRealNodeUnitTestGate({
      gateId: "real-node-zero-gate",
      workingDirectory: harness.tmpDir,
      testFileContent: `
        // Empty test file with zero test cases
        import test from "node:test";
        import assert from "node:assert/strict";
      `,
      minPassedTestsCount: 1,
      outputParser: createStrictTapParser({ requirePlan: true, minPassedTestsCount: 1 })
    });

    const context = createQualityGateContext({
      runId,
      gateId: "real-node-zero-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);
    expect(result.status).toBe("failed");
    expect(result.findings.some((f) => f.code === "NO_TAP_TEST_POINTS" || f.code === "INSUFFICIENT_PASSED_TESTS")).toBe(true);
  });

  it("evaluates malformed report negative fixture: rejects deliberately invalid stdout with parser findings", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "malformed-report-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        console.log("MALFORMED STDOUT: NOT A TAP REPORT AT ALL");
        console.log("Random error message without TAP version or plan");
        process.exit(0);
      `,
      outputParser: createStrictTapParser({ requirePlan: true, minPassedTestsCount: 1 })
    });

    const context = createQualityGateContext({
      runId,
      gateId: "malformed-report-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);
    expect(result.status).toBe("failed");
    expect(result.findings.some((f) => f.severity === "error")).toBe(true);
  });

  it("strict TAP parser fails closed on malformed streams: missing version, bailout, missing plan, bad plan, duplicate IDs, nested subtests", () => {
    const parser = createStrictTapParser({ requirePlan: true, minPassedTestsCount: 1 });

    // 1. Missing version header
    const missingVersion = parser(makeCommandOutcome("1..1\nok 1 - auth\n"));
    expect(missingVersion.findings.some((f) => f.code === "MISSING_OR_INVALID_TAP_VERSION")).toBe(true);

    // 2. Bail out directive
    const bailedOut = parser(makeCommandOutcome("TAP version 13\n1..2\nok 1 - test 1\nBail out! Unhandled fatal error\n"));
    expect(bailedOut.findings.some((f) => f.code === "TAP_BAIL_OUT")).toBe(true);

    // 3. Missing plan when required
    const missingPlan = parser(makeCommandOutcome("TAP version 13\nok 1 - lone test\n"));
    expect(missingPlan.findings.some((f) => f.code === "TAP_PLAN_MISSING")).toBe(true);

    // 4. Bad plan (plan count mismatch: specified 3, got 1)
    const badPlan = parser(makeCommandOutcome("TAP version 13\n1..3\nok 1 - only one\n"));
    expect(badPlan.findings.some((f) => f.code === "TAP_PLAN_COUNT_MISMATCH")).toBe(true);

    // 5. Duplicate or non-sequential IDs
    const duplicateIds = parser(makeCommandOutcome("TAP version 13\n1..2\nok 1 - first\nok 1 - duplicate first\n"));
    expect(duplicateIds.findings.some((f) => f.code === "TAP_INVALID_TEST_ID")).toBe(true);

    // 6. Parent/nested TAP: Indented test points must not be counted as flat top-level points
    const nestedStream = [
      "TAP version 13",
      "# Subtest: parent suite",
      "    # Subtest: nested 1",
      "    ok 1 - nested 1",
      "    # Subtest: nested 2",
      "    ok 2 - nested 2",
      "    1..2",
      "ok 1 - parent suite",
      "1..1",
      "# tests 1",
      "# pass 1",
      "# fail 0"
    ].join("\n");
    const nestedRes = parser(makeCommandOutcome(nestedStream));
    // Top-level must observe exactly 1 test point ("ok 1 - parent suite"), NOT 3
    expect(nestedRes.passedTests).toBe(1);
    expect(nestedRes.findings.length).toBe(0);
  });

  it("PROBE PM-01 (P04 DEFECT): Required quality gate must not be downgraded or skipped to passed", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const policyRes = createDefaultSecurityPolicy({
      allowedRootDirs: [harness.tmpDir],
      assignedWorktreePath: harness.tmpDir,
      maxExecutionTimeoutMs: 30000,
      allowedCommands: [...DEFAULT_ALLOWED_COMMANDS]
    });
    const policy = expectOk(policyRes);

    // Evaluator spec has required: false, skip: true
    const gate = new CommandQualityGate({
      spec: {
        gateId: "probe-pm01-skip-gate",
        checkKind: "unit_test",
        command: { executable: "node", args: ["-e", "process.exit(0);"] },
        workingDirectory: harness.tmpDir,
        required: false, // Spec attempts to override definition
        skip: true,
        skipReason: "Local bypass requested"
      },
      securityPolicy: policy
    });

    // Workflow definition explicitly mandates that the gate is REQUIRED!
    const context = createQualityGateContext({
      runId,
      gateId: "probe-pm01-skip-gate",
      taskId: "qa",
      required: true // Workflow definition mandates gate is REQUIRED!
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);

    // SAFETY INVARIANT: A gate marked required by workflow definition CANNOT be skipped to "passed"!
    // When skipped, if the definition requires it, it must fail or be blocked.
    // (Upstream P04 evaluator.ts:254 violates this by prioritizing this.spec.required over definition.required, returning status: "passed")
    expect(result.status).not.toBe("passed");
  });

  it("PROBE PM-02 (P04 DEFECT): CommandQualityGate must enforce OperationOptions deadline/timeoutMs before execution", async () => {
    harness = await createE2eHarness();
    const runId = `run-pm02-${randomUUID()}`;
    const sentinelFile = join(harness.tmpDir, "sentinel-pm02.txt");

    const gate = createSafeSubprocessGate({
      gateId: "probe-pm02-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(sentinelFile)}, "EXECUTED_DESPITE_EXPIRED_DEADLINE", "utf8");
        process.exit(0);
      `
    });

    const context = createQualityGateContext({
      runId,
      gateId: "probe-pm02-gate",
      taskId: "qa"
    });

    // Invoke with already expired deadline (past date) and timeoutMs: 0
    const pastDate = new Date(Date.now() - 60000);
    const evalRes = await gate.evaluate(context, {
      deadline: pastDate.toISOString(),
      timeoutMs: 0
    });

    // SAFETY INVARIANT: When deadline has expired or timeoutMs is 0,
    // the command runner must abort BEFORE execution and produce NO side-effects!
    // (Upstream P04 evaluator.ts ignores options.deadline and options.timeoutMs, running the command anyway)
    expect(existsSync(sentinelFile)).toBe(false);
    expect(evalRes.ok).toBe(false);
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
    // (Upstream P04 currently violates this by nesting the check only inside outputParser)
    expect(result.status).toBe("failed");
    expect(result.findings.some((f) => f.code === "MISSING_EXECUTION_EVIDENCE")).toBe(true);
  });

  it("PROBE PM-04 (P04 DEFECT): Governance evaluation must reject foreign run quality gate results", async () => {
    const runId = `run-target-${randomUUID()}`;
    const foreignRunId = `run-foreign-${randomUUID()}`;

    const foreignGateResult: QualityGateResult = {
      evaluationId: `eval-${randomUUID()}`,
      runId: foreignRunId, // BELONGS TO DIFFERENT RUN!
      gateId: "test-gate",
      taskId: "qa",
      status: "passed",
      findings: [],
      producedArtifacts: [],
      evaluatedAt: new Date().toISOString()
    };

    const govOutcome = evaluateAutomatedVsHumanGovernance({
      runId, // Target run
      requiresHumanApproval: false,
      automatedGateResults: [foreignGateResult]
    });

    // SAFETY INVARIANT: A gate result from a foreign workflow run CANNOT satisfy this run's governance!
    // (Upstream P04 currently violates this by never checking gate.runId === input.runId)
    const passed = govOutcome.ok ? govOutcome.value.allAutomatedGatesPassed : false;
    const canProceed = govOutcome.ok ? govOutcome.value.canProceedToDelivery : false;
    expect(passed).toBe(false);
    expect(canProceed).toBe(false);
  });

  it("PROBE PM-05 (P04 DEFECT): Governance evaluation must reject stale approval decisions for prior revisions", async () => {
    const runId = `run-pm05-${randomUUID()}`;
    const approvalId = `appr-${randomUUID()}`;

    const approvalRequest: ApprovalRequest = {
      schemaVersion: 1,
      approvalId,
      runId,
      target: {
        type: "task",
        taskId: "review"
      },
      requestedBy: "runtime",
      requestedAt: new Date().toISOString(),
      revision: 2, // CURRENT REQUEST IS REVISION 2
      generation: 1, // CURRENT GENERATION IS 1
      reason: "Approval required for revision 2",
      evidence: [],
      idempotencyKey: `req-${approvalId}`
    };

    // Stale decision from prior revision (revision 1, generation 0)
    const staleApprovalDecision: ApprovalDecision = {
      schemaVersion: 1,
      approvalId,
      runId,
      target: {
        type: "task",
        taskId: "review"
      },
      decision: "approved",
      decidedBy: "lead_engineer",
      decidedAt: new Date().toISOString(),
      revision: 1, // STALE REVISION 1
      generation: 0, // STALE GENERATION 0
      reason: "Approved old revision 1",
      feedbackArtifacts: [],
      idempotencyKey: `dec-${approvalId}`
    };

    const gateResult: QualityGateResult = {
      evaluationId: `eval-${randomUUID()}`,
      runId,
      gateId: "test-gate",
      taskId: "review",
      status: "passed",
      findings: [],
      producedArtifacts: [],
      evaluatedAt: new Date().toISOString()
    };

    const govRes = evaluateAutomatedVsHumanGovernance({
      runId,
      taskId: "review",
      requiresHumanApproval: true,
      automatedGateResults: [gateResult],
      approvalRequest,
      humanApprovalDecision: staleApprovalDecision
    });

    const govOutcome = expectOk(govRes);
    // SAFETY INVARIANT: An approval decision for revision 1 must NOT approve a request for revision 2!
    // Stale approval decisions across rework cycles must be rejected fail-closed.
    // (Upstream P04 rbac-approval.ts:636 violates this by only matching approvalId, ignoring revision and generation)
    expect(govOutcome.canProceedToDelivery).toBe(false);
  });

  it("OBSERVATION PM-08 (CONTRACT/INTEGRATION DECISION): QualityGateContext does not supply evaluationId; Runtime orchestrator coordinates and overrides it", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = createSafeSubprocessGate({
      gateId: "probe-pm08-gate",
      workingDirectory: harness.tmpDir,
      scriptBody: "process.exit(0);"
    });

    const context = createQualityGateContext({
      runId,
      gateId: "probe-pm08-gate",
      taskId: "qa"
    });

    const evalRes = await gate.evaluate(context);
    const result = expectOk(evalRes);

    // Contract observation: QualityGateContext in @bflow/contracts does not define an evaluationId.
    // CommandQualityGate generates a default evaluationId, and Runtime orchestrator coordinates
    // by overwriting it to the requested execution/evaluation ID before persistence.
    expect(result.evaluationId).toBeDefined();
    expect(typeof result.evaluationId).toBe("string");
  });
});
