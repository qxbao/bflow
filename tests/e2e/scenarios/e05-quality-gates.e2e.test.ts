import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createQualityGateContext,
  createSafeSubprocessGate,
  createStandardMvpWorkflow
} from "../helpers/fixtures.js";
import {
  CommandQualityGate,
  evaluateAutomatedVsHumanGovernance
} from "@ai-flow/quality-gates";
import type {
  QualityGateContext,
  QualityGateResult,
  TaskState
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

    const gate = await createSafeSubprocessGate({
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
    expect(evalRes.error).toBeUndefined();
    expect(evalRes.ok).toBe(true);
    const result: QualityGateResult = evalRes.value;

    expect(result.status).toBe("passed");
    expect(result.gateId).toBe("review-gate-pass");
    expect(result.runId).toBe(runId);
    expect(result.producedArtifacts.length).toBe(1);
    expect(result.producedArtifacts[0].expectedIntegrity.checksum.algorithm).toBe("sha256");
    expect(result.producedArtifacts[0].expectedIntegrity.sizeBytes).toBeGreaterThan(0);
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("evaluates real subprocess CommandQualityGate with non-zero exit code (FAIL) and records findings", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    const gate = await createSafeSubprocessGate({
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
    expect(evalRes.error).toBeUndefined();
    expect(evalRes.ok).toBe(true);
    const result: QualityGateResult = evalRes.value;

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

    const gate = await createSafeSubprocessGate({
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
    expect(evalRes.error).toBeUndefined();
    expect(evalRes.ok).toBe(true);
    const result: QualityGateResult = evalRes.value;

    expect(result.status).toBe("failed");
    const evidenceFinding = result.findings.find((f) => f.code === "MISSING_EXECUTION_EVIDENCE");
    expect(evidenceFinding).toBeDefined();
    expect(evidenceFinding?.severity).toBe("error");
  });

  it("enforces command timeout: terminates hanging command and records COMMAND_TIMEOUT error", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    // Subprocess with infinite busy loop
    const gate = await createSafeSubprocessGate({
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
    expect(evalRes.error).toBeUndefined();
    expect(evalRes.ok).toBe(true);
    const result: QualityGateResult = evalRes.value;

    expect(result.status).toBe("error");
    const timeoutFinding = result.findings.find((f) => f.code === "COMMAND_TIMEOUT");
    expect(timeoutFinding).toBeDefined();
    expect(timeoutFinding?.severity).toBe("error");
    expect(result.metadata?.timedOut).toBe(true);
  });

  // =========================================================================
  // UPSTREAM DEFECT PROBES (Reproduction tests for findings PM-03, PM-04, PM-08)
  // =========================================================================

  it("PROBE PM-03: outputExpectation.minPassedTestsCount is silently ignored without outputParser", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;

    // Gate configured with minPassedTestsCount: 100, but without outputParser
    const gate = await createSafeSubprocessGate({
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
    expect(evalRes.error).toBeUndefined();
    expect(evalRes.ok).toBe(true);
    const result = evalRes.value;

    // DEFECT REPRODUCTION ASSERTION:
    // Because minPassedTestsCount check is nested exclusively inside `if (this.spec.outputParser)`,
    // the gate evaluates to status "passed" despite running 0 out of 100 required tests!
    expect(result.status).toBe("passed");
  });

  it("PROBE PM-04: evaluateAutomatedVsHumanGovernance accepts foreign run quality gate results", async () => {
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
      action: "deploy_release",
      role: "delivery",
      runId: targetRunId,
      automatedGateResults: [foreignPassedGate],
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
        idempotencyKey: `appr-key-${randomUUID()}`
      }
    });

    // DEFECT REPRODUCTION ASSERTION:
    // evaluateAutomatedVsHumanGovernance does NOT check that gate.runId === request.runId.
    // The foreign run's gate result is accepted, returning ok: true!
    expect(govRes.error).toBeUndefined();
    expect(govRes.ok).toBe(true);
    expect(govRes.value?.allAutomatedGatesPassed).toBe(true);
    expect(govRes.value?.canProceedToDelivery).toBe(true);
  });

  it("PROBE PM-08: CommandQualityGate generates arbitrary evaluationId divergence", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const requestedEvaluationId = `eval-orchestrator-requested-${randomUUID()}`;

    const gate = await createSafeSubprocessGate({
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
    expect(evalRes.ok).toBe(true);

    // DEFECT REPRODUCTION ASSERTION:
    // evaluator.ts line 253 generates an uncoordinated random UUID:
    // const evaluationId = sanitizeIdentifier(`eval-${this.spec.gateId}-${crypto.randomUUID()}`);
    // This forces orchestrator.ts:826 to forcefully overwrite it:
    // const effectiveResult: QualityGateResult = { ...gateResult, evaluationId };
    expect(evalRes.value.evaluationId).toContain("eval-probe-pm08-gate-");
    expect(evalRes.value.evaluationId).toContain("eval-probe-pm08-gate-");
  });
});
