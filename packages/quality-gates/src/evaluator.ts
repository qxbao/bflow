import {
  ArtifactProposalSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  QualityFindingSchema,
  QualityGateContextSchema,
  QualityGateDefinitionSchema,
  QualityGateResultSchema,
  type ArtifactProposal,
  type ContractError,
  type ExecutionError,
  type JsonValue,
  type OperationOptions,
  type OperationResult,
  type QualityFinding,
  type QualityGate,
  type QualityGateContext,
  type QualityGateDefinition,
  type QualityGateResult
} from "@ai-flow/contracts";
import {
  isQualityCheckKind,
  sanitizeExecutionEnvironment,
  validateCommandAgainstPolicy,
  validateDirectoryScope,
  validateTimeoutBudget,
  type CommandSpec,
  type QualityCheckKind,
  type QualitySecurityPolicy
} from "./security-policy.js";
import {
  createQualityCommandRunner,
  type QualityCommandOutcome,
  type QualityCommandRunner
} from "./runner.js";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";

export {
  QualityFindingSchema,
  QualityGateDefinitionSchema,
  type ContractError,
  type JsonValue,
  type QualityGateDefinition
};

export type QualityCheckStatus = "passed" | "failed" | "skipped" | "error";

export interface QualityCheckOutputExpectation {
  readonly mustContain?: readonly string[];
  readonly mustNotContain?: readonly string[];
  readonly requireNonEmptyStdout?: boolean;
  readonly minPassedTestsCount?: number;
}

export interface QualityCheckSpec {
  readonly gateId: string;
  readonly checkKind: QualityCheckKind;
  readonly command: CommandSpec;
  readonly workingDirectory: string;
  readonly timeoutMs?: number;
  readonly required?: boolean;
  readonly skip?: boolean;
  readonly skipReason?: string;
  readonly requireEvidence?: boolean;
  readonly outputExpectation?: QualityCheckOutputExpectation;
  readonly outputParser?: (outcome: QualityCommandOutcome) => {
    readonly findings?: readonly QualityFinding[];
    readonly passedTests?: number;
    readonly failedTests?: number;
    readonly skippedTests?: number;
  };
}

export interface QualityCheckEvidence {
  readonly gateId: string;
  readonly taskId?: string;
  readonly checkKind: QualityCheckKind;
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifactProposal: ArtifactProposal;
  readonly serializedReport: string;
}

export interface QualityCheckResult {
  readonly gateId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly checkKind: QualityCheckKind;
  readonly status: QualityCheckStatus;
  readonly summary: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly findings: readonly QualityFinding[];
  readonly evidence?: QualityCheckEvidence;
  readonly contractResult: QualityGateResult;
}

export interface CreateQualityGateOptions {
  readonly spec: QualityCheckSpec;
  readonly securityPolicy: QualitySecurityPolicy;
  readonly runner?: QualityCommandRunner;
  readonly now?: () => string;
  readonly onCheckCompleted?: (result: QualityCheckResult) => void;
}

function resolveIsoTimestamp(nowFn: () => string): string {
  const candidate = nowFn();
  const parsed = IsoDateTimeSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }
  return new Date().toISOString();
}

function sanitizeIdentifier(input: string): string {
  const sanitized = input.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 190);
  return sanitized.length > 0 ? sanitized : "evidence-artifact";
}

function sanitizeLogicalName(input: string): string {
  const sanitized = input.trim().replace(/[/\\]/g, "-").slice(0, 250);
  if (sanitized === "." || sanitized === ".." || sanitized.length === 0) {
    return "evidence.json";
  }
  return sanitized;
}

function detectUntrustedAgentDirectives(agentResult: QualityGateContext["agentResult"]): boolean {
  if (!agentResult) {
    return false;
  }

  const suspiciousKeys = [
    "command",
    "shellCommand",
    "customCommand",
    "overrideCommand"
  ];

  const checkValue = (val: unknown): boolean => {
    if (!val) {
      return false;
    }
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          return checkValue(parsed);
        }
      } catch {
        // Not a JSON object string
      }
      return false;
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      if (record["skipQualityGates"] === true || record["skipQualityGates"] === "true") {
        return true;
      }
      for (const key of suspiciousKeys) {
        if (key in record && record[key] !== undefined && record[key] !== null) {
          return true;
        }
      }
    }
    return false;
  };

  if (agentResult.metadata && checkValue(agentResult.metadata)) {
    return true;
  }
  if (agentResult.output && checkValue(agentResult.output)) {
    return true;
  }

  return false;
}

export class CommandQualityGate implements QualityGate {
  readonly id: string;
  private readonly spec: QualityCheckSpec;
  private readonly securityPolicy: QualitySecurityPolicy;
  private readonly runner: QualityCommandRunner;
  private readonly now: () => string;
  private readonly onCheckCompleted?: (result: QualityCheckResult) => void;

  constructor(options: CreateQualityGateOptions) {
    this.spec = options.spec;
    this.securityPolicy = options.securityPolicy;
    this.runner = options.runner ?? createQualityCommandRunner();
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.onCheckCompleted !== undefined) {
      this.onCheckCompleted = options.onCheckCompleted;
    }
    this.id = options.spec.gateId;
  }

  async evaluate(
    context: QualityGateContext,
    options?: OperationOptions
  ): Promise<OperationResult<QualityGateResult>> {
    const detailed = await this.evaluateDetailed(context, options);
    if (!detailed.ok) {
      return { ok: false, error: detailed.error };
    }
    return { ok: true, value: detailed.value.contractResult };
  }

  async evaluateDetailed(
    context: QualityGateContext,
    options?: OperationOptions
  ): Promise<OperationResult<QualityCheckResult>> {
    // 1. Ingress validation
    const parsedContext = QualityGateContextSchema.safeParse(context);
    if (!parsedContext.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid quality gate context: ${parsedContext.error.message}`,
          details: {
            errors: parsedContext.error.errors.map((e) => ({
              path: e.path.join("."),
              message: e.message
            }))
          }
        }
      };
    }
    const validContext = parsedContext.data;

    // Check cancellation before starting
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Quality gate evaluation was aborted before execution"
        }
      };
    }

    const evaluatedAt = resolveIsoTimestamp(this.now);
    const evaluationId = sanitizeIdentifier(`eval-${this.spec.gateId}-${crypto.randomUUID()}`);
    const isRequired = this.spec.required ?? validContext.definition.required ?? true;

    // Independence from AI agent claims / directive injection rejection
    if (detectUntrustedAgentDirectives(validContext.agentResult)) {
      const findings: readonly QualityFinding[] = [
        {
          code: "UNTRUSTED_AGENT_COMMAND_REJECTED",
          severity: "error",
          message: "Rejected untrusted command or bypass directive from AI agent output"
        }
      ];
      const contractResult: QualityGateResult = {
        gateId: this.spec.gateId,
        runId: validContext.runId,
        ...(validContext.taskId ? { taskId: validContext.taskId } : {}),
        evaluationId,
        status: "failed",
        findings: [...findings],
        producedArtifacts: [],
        evaluatedAt,
        metadata: {
          checkKind: this.spec.checkKind,
          checkStatus: "failed",
          command: [this.spec.command.executable, ...this.spec.command.args].join(" "),
          workingDirectory: this.spec.command.cwd ?? this.spec.workingDirectory,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          evidenceProposalId: null,
          evidenceChecksumSha256: null,
          independentOfAgentClaims: true,
          ...(validContext.taskId ? { failedTaskId: validContext.taskId } : {})
        }
      };
      const parsedContractResult = QualityGateResultSchema.safeParse(contractResult);
      if (!parsedContractResult.success) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: `Failed to construct valid contract result: ${parsedContractResult.error.message}`
          }
        };
      }
      const checkResult: QualityCheckResult = {
        gateId: this.spec.gateId,
        runId: validContext.runId,
        ...(validContext.taskId !== undefined ? { taskId: validContext.taskId } : {}),
        checkKind: this.spec.checkKind,
        status: "failed",
        summary: `Check "${this.spec.gateId}" failed: rejected untrusted command or bypass directive from AI agent output`,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        findings,
        contractResult: parsedContractResult.data
      };
      this.onCheckCompleted?.(checkResult);
      return { ok: true, value: checkResult };
    }

    // 2. Handling skip
    if (this.spec.skip === true) {
      if (isRequired) {
        const findings: readonly QualityFinding[] = [
          {
            code: "REQUIRED_CHECK_SKIPPED_OR_MISSING_EVIDENCE",
            severity: "error",
            message: "Required quality check cannot be skipped"
          }
        ];
        const contractResult: QualityGateResult = {
          gateId: this.spec.gateId,
          runId: validContext.runId,
          ...(validContext.taskId ? { taskId: validContext.taskId } : {}),
          evaluationId,
          status: "failed",
          findings: [...findings],
          producedArtifacts: [],
          evaluatedAt,
          metadata: {
            checkKind: this.spec.checkKind,
            checkStatus: "failed",
            command: [this.spec.command.executable, ...this.spec.command.args].join(" "),
            workingDirectory: this.spec.command.cwd ?? this.spec.workingDirectory,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            evidenceProposalId: null,
            evidenceChecksumSha256: null,
            independentOfAgentClaims: true,
            ...(validContext.taskId ? { failedTaskId: validContext.taskId } : {})
          }
        };
        const parsedContractResult = QualityGateResultSchema.safeParse(contractResult);
        if (!parsedContractResult.success) {
          return {
            ok: false,
            error: {
              code: "validation",
              retryable: false,
              message: `Failed to construct valid contract result: ${parsedContractResult.error.message}`
            }
          };
        }
        const checkResult: QualityCheckResult = {
          gateId: this.spec.gateId,
          runId: validContext.runId,
          ...(validContext.taskId !== undefined ? { taskId: validContext.taskId } : {}),
          checkKind: this.spec.checkKind,
          status: "failed",
          summary: `Check "${this.spec.gateId}" failed: required quality check cannot be skipped`,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          findings,
          contractResult: parsedContractResult.data
        };
        this.onCheckCompleted?.(checkResult);
        return { ok: true, value: checkResult };
      } else {
        const skipReason = this.spec.skipReason ?? "Optional quality check was skipped";
        const findings: readonly QualityFinding[] = [
          {
            code: "CHECK_SKIPPED",
            severity: "info",
            message: skipReason
          }
        ];
        const contractResult: QualityGateResult = {
          gateId: this.spec.gateId,
          runId: validContext.runId,
          ...(validContext.taskId ? { taskId: validContext.taskId } : {}),
          evaluationId,
          status: "passed",
          findings: [...findings],
          producedArtifacts: [],
          evaluatedAt,
          metadata: {
            checkKind: this.spec.checkKind,
            checkStatus: "skipped",
            skippedReason: skipReason,
            command: [this.spec.command.executable, ...this.spec.command.args].join(" "),
            workingDirectory: this.spec.command.cwd ?? this.spec.workingDirectory,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            evidenceProposalId: null,
            evidenceChecksumSha256: null,
            independentOfAgentClaims: true
          }
        };
        const parsedContractResult = QualityGateResultSchema.safeParse(contractResult);
        if (!parsedContractResult.success) {
          return {
            ok: false,
            error: {
              code: "validation",
              retryable: false,
              message: `Failed to construct valid contract result: ${parsedContractResult.error.message}`
            }
          };
        }
        const checkResult: QualityCheckResult = {
          gateId: this.spec.gateId,
          runId: validContext.runId,
          ...(validContext.taskId !== undefined ? { taskId: validContext.taskId } : {}),
          checkKind: this.spec.checkKind,
          status: "skipped",
          summary: `Check "${this.spec.gateId}" skipped: ${skipReason}`,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          findings,
          contractResult: parsedContractResult.data
        };
        this.onCheckCompleted?.(checkResult);
        return { ok: true, value: checkResult };
      }
    }

    // 3. Security Policy Validation before Execution
    if (!isQualityCheckKind(this.spec.checkKind)) {
      const msg = `Invalid quality check kind: ${String(this.spec.checkKind)}`;
      const executionError: ExecutionError = {
        code: "INVALID_CHECK_KIND",
        message: msg,
        retryable: false
      };
      const findings: readonly QualityFinding[] = [
        {
          code: "INVALID_CHECK_KIND",
          severity: "error",
          message: msg
        }
      ];
      return this.createErrorCheckResult(validContext, evaluationId, evaluatedAt, executionError, findings, null);
    }

    const dirRes = await validateDirectoryScope(
      this.spec.command.cwd ?? this.spec.workingDirectory,
      this.securityPolicy
    );
    if (!dirRes.ok) {
      const executionError: ExecutionError = {
        code: "DIRECTORY_SCOPE_VIOLATION",
        message: dirRes.error.message,
        retryable: false,
        ...(dirRes.error.details ? { details: dirRes.error.details } : {})
      };
      const findings: readonly QualityFinding[] = [
        {
          code: "DIRECTORY_SCOPE_VIOLATION",
          severity: "error",
          message: dirRes.error.message,
          ...(dirRes.error.details ? { details: dirRes.error.details } : {})
        }
      ];
      return this.createErrorCheckResult(
        validContext,
        evaluationId,
        evaluatedAt,
        executionError,
        findings,
        this.spec.command.cwd ?? this.spec.workingDirectory
      );
    }

    const cmdRes = validateCommandAgainstPolicy(this.spec.command, this.securityPolicy, {
      checkKind: this.spec.checkKind,
      source: "policy"
    });
    if (!cmdRes.ok) {
      const executionError: ExecutionError = {
        code: "DISALLOWED_COMMAND",
        message: cmdRes.error.message,
        retryable: false,
        ...(cmdRes.error.details ? { details: cmdRes.error.details } : {})
      };
      const findings: readonly QualityFinding[] = [
        {
          code: "DISALLOWED_COMMAND",
          severity: "error",
          message: cmdRes.error.message,
          ...(cmdRes.error.details ? { details: cmdRes.error.details } : {})
        }
      ];
      return this.createErrorCheckResult(
        validContext,
        evaluationId,
        evaluatedAt,
        executionError,
        findings,
        dirRes.value
      );
    }

    const timeoutMs = this.spec.timeoutMs ?? this.securityPolicy.maxExecutionTimeoutMs;
    const timeoutRes = validateTimeoutBudget(timeoutMs, this.securityPolicy);
    if (!timeoutRes.ok) {
      const executionError: ExecutionError = {
        code: "INVALID_TIMEOUT_POLICY",
        message: timeoutRes.error.message,
        retryable: false,
        ...(timeoutRes.error.details ? { details: timeoutRes.error.details } : {})
      };
      const findings: readonly QualityFinding[] = [
        {
          code: "INVALID_TIMEOUT_POLICY",
          severity: "error",
          message: timeoutRes.error.message,
          ...(timeoutRes.error.details ? { details: timeoutRes.error.details } : {})
        }
      ];
      return this.createErrorCheckResult(
        validContext,
        evaluationId,
        evaluatedAt,
        executionError,
        findings,
        dirRes.value
      );
    }

    // 4. Command Execution & Output/Timeout/ExitCode Inspection
    const sanitizedEnv = sanitizeExecutionEnvironment(
      { ...process.env, ...this.spec.command.env },
      this.securityPolicy.allowedEnvKeys
    );

    let outcome: QualityCommandOutcome;
    try {
      const runRes = await this.runner.run({
        executable: this.spec.command.executable,
        args: this.spec.command.args,
        cwd: dirRes.value,
        env: sanitizedEnv,
        timeoutMs: timeoutRes.value,
        ...(options?.signal !== undefined ? { signal: options.signal } : {})
      });
      if (!runRes.ok) {
        const executionError: ExecutionError = {
          code: "RUNNER_EXECUTION_FAILURE",
          message: runRes.error.message,
          retryable: false,
          ...(runRes.error.details ? { details: runRes.error.details } : {})
        };
        const findings: readonly QualityFinding[] = [
          {
            code: "RUNNER_EXECUTION_FAILURE",
            severity: "error",
            message: runRes.error.message,
            ...(runRes.error.details ? { details: runRes.error.details } : {})
          }
        ];
        return this.createErrorCheckResult(
          validContext,
          evaluationId,
          evaluatedAt,
          executionError,
          findings,
          dirRes.value
        );
      }
      outcome = runRes.value;
    } catch (runnerErr) {
      const executionError: ExecutionError = {
        code: "RUNNER_EXECUTION_FAILURE",
        message: runnerErr instanceof Error ? runnerErr.message : String(runnerErr),
        retryable: false
      };
      const findings: readonly QualityFinding[] = [
        {
          code: "RUNNER_EXECUTION_FAILURE",
          severity: "error",
          message: runnerErr instanceof Error ? runnerErr.message : String(runnerErr)
        }
      ];
      return this.createErrorCheckResult(
        validContext,
        evaluationId,
        evaluatedAt,
        executionError,
        findings,
        dirRes.value
      );
    }

    let status: QualityCheckStatus = "passed";
    let executionError: ExecutionError | undefined = undefined;
    const findings: QualityFinding[] = [];

    if (outcome.spawnError || outcome.aborted) {
      status = "error";
      const code = outcome.aborted ? "CHECK_ABORTED" : "COMMAND_SPAWN_ERROR";
      const message = outcome.aborted
        ? "Command execution was aborted"
        : (outcome.spawnError ?? "Failed to spawn command process");
      findings.push({
        code,
        severity: "error",
        message
      });
      executionError = {
        code,
        message,
        retryable: Boolean(outcome.aborted)
      };
    } else if (outcome.timedOut) {
      status = "error";
      const message = `Command timed out after ${timeoutRes.value}ms`;
      findings.push({
        code: "COMMAND_TIMEOUT",
        severity: "error",
        message
      });
      executionError = {
        code: "COMMAND_TIMEOUT",
        message,
        retryable: true
      };
    } else if (outcome.exitCode !== 0) {
      status = "failed";
      findings.push({
        code: "NON_ZERO_EXIT_CODE",
        severity: "error",
        message: `Check "${this.spec.checkKind}" (${this.spec.gateId}) failed with exit code ${String(outcome.exitCode)}`
      });
    } else {
      status = "passed";
    }

    // 5. Output Expectations, Parser & Evidence Verification
    if (!outcome.spawnError && !outcome.aborted && !outcome.timedOut) {
      if (
        this.spec.outputExpectation?.requireNonEmptyStdout &&
        outcome.exitCode === 0 &&
        outcome.stdout.trim().length === 0
      ) {
        status = "failed";
        findings.push({
          code: "MISSING_EXECUTION_EVIDENCE",
          severity: "error",
          message: "Command exited 0 but produced empty stdout when output evidence was required"
        });
      }

      if (this.spec.outputExpectation?.mustContain) {
        for (const sub of this.spec.outputExpectation.mustContain) {
          if (!outcome.combinedOutput.includes(sub)) {
            status = "failed";
            findings.push({
              code: "OUTPUT_EXPECTATION_FAILED",
              severity: "error",
              message: `Expected output to contain "${sub}"`
            });
          }
        }
      }

      if (this.spec.outputExpectation?.mustNotContain) {
        for (const sub of this.spec.outputExpectation.mustNotContain) {
          if (outcome.combinedOutput.includes(sub)) {
            status = "failed";
            findings.push({
              code: "FORBIDDEN_OUTPUT_PATTERN",
              severity: "error",
              message: `Output contained forbidden pattern "${sub}"`
            });
          }
        }
      }

      let parsedPassedTests: number | undefined;
      if (this.spec.outputParser) {
        try {
          const parsed = this.spec.outputParser(outcome);
          if (parsed.findings) {
            for (const finding of parsed.findings) {
              findings.push(finding);
              if (finding.severity === "error") {
                status = "failed";
              }
            }
          }
          if (parsed.failedTests !== undefined && parsed.failedTests > 0) {
            status = "failed";
            findings.push({
              code: "TEST_FAILURES_DETECTED",
              severity: "error",
              message: `Detected ${parsed.failedTests} failed test(s) in output`
            });
          }
          parsedPassedTests = parsed.passedTests;
          if (
            this.spec.outputExpectation?.minPassedTestsCount !== undefined &&
            (parsedPassedTests ?? 0) < this.spec.outputExpectation.minPassedTestsCount
          ) {
            status = "failed";
            findings.push({
              code: "MISSING_EXECUTION_EVIDENCE",
              severity: "error",
              message: `Passed tests count (${parsedPassedTests ?? 0}) is below required minimum of ${this.spec.outputExpectation.minPassedTestsCount}`
            });
          }
        } catch (err) {
          status = "failed";
          findings.push({
            code: "OUTPUT_PARSER_ERROR",
            severity: "error",
            message: `Output parser threw an error: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      }

      // Evidence Collection & Missing Evidence Check
      const requireEvidence = this.spec.requireEvidence ?? (this.spec.checkKind === "unit_test" || isRequired);
      if (status === "passed" && requireEvidence) {
        if (outcome.combinedOutput.trim().length === 0) {
          status = "failed";
          findings.push({
            code: "MISSING_EXECUTION_EVIDENCE",
            severity: "error",
            message: `Check "${this.spec.gateId}" produced no execution output evidence`
          });
        }
        if (this.spec.checkKind === "unit_test") {
          const zeroPassRegex = /\b0 passed\b/i;
          const noTestsRegex = /no tests found/i;
          if (
            zeroPassRegex.test(outcome.combinedOutput) ||
            noTestsRegex.test(outcome.combinedOutput) ||
            parsedPassedTests === 0
          ) {
            status = "failed";
            findings.push({
              code: "MISSING_EXECUTION_EVIDENCE",
              severity: "error",
              message: "Unit test check ran 0 passing tests; verifiable test evidence is required"
            });
          }
        }
      }
    }

    // Build QualityCheckEvidence
    const evidenceReportData = {
      gateId: this.spec.gateId,
      runId: validContext.runId,
      taskId: validContext.taskId ?? null,
      checkKind: this.spec.checkKind,
      commandLine: [this.spec.command.executable, ...this.spec.command.args].join(" "),
      workingDirectory: dirRes.value,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      evaluatedAt
    };
    const serializedReport = JSON.stringify(evidenceReportData, null, 2);
    const sha256Hex = crypto.createHash("sha256").update(serializedReport, "utf8").digest("hex");
    const byteSize = Buffer.byteLength(serializedReport, "utf8");

    const proposalId = sanitizeIdentifier(`${this.spec.gateId}-${validContext.taskId ?? "run"}-evidence`);
    const logicalName = sanitizeLogicalName(`${this.spec.gateId}-${this.spec.checkKind}-evidence.json`);

    const artifactProposal: ArtifactProposal = {
      proposalId,
      runId: validContext.runId,
      ...(validContext.taskId ? { taskId: validContext.taskId } : {}),
      kind: this.spec.checkKind === "unit_test" ? "test-result" : "report",
      logicalName,
      mediaType: "application/json",
      expectedIntegrity: {
        checksum: { algorithm: "sha256", value: sha256Hex },
        sizeBytes: byteSize
      },
      metadata: {
        createdAt: evaluatedAt,
        checkKind: this.spec.checkKind
      }
    };

    const parsedProposal = ArtifactProposalSchema.safeParse(artifactProposal);
    if (!parsedProposal.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Failed to construct valid artifact proposal: ${parsedProposal.error.message}`
        }
      };
    }

    const evidence: QualityCheckEvidence = {
      gateId: this.spec.gateId,
      ...(validContext.taskId !== undefined ? { taskId: validContext.taskId } : {}),
      checkKind: this.spec.checkKind,
      commandLine: [this.spec.command.executable, ...this.spec.command.args].join(" "),
      workingDirectory: dirRes.value,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      artifactProposal: parsedProposal.data,
      serializedReport
    };

    // 6. Build and Validate QualityGateResult (contractResult)
    const contractStatus: "passed" | "failed" | "blocked" | "error" =
      status === "passed" ? "passed" :
      status === "failed" ? "failed" :
      "error";

    const contractResult: QualityGateResult = {
      gateId: this.spec.gateId,
      runId: validContext.runId,
      ...(validContext.taskId ? { taskId: validContext.taskId } : {}),
      evaluationId,
      status: contractStatus,
      findings,
      producedArtifacts: [evidence.artifactProposal],
      ...(contractStatus === "error"
        ? {
            error: executionError ?? {
              code: "UNKNOWN_QUALITY_ERROR",
              message: "Quality check encountered an unknown error",
              retryable: false
            }
          }
        : {}),
      evaluatedAt,
      metadata: {
        checkKind: this.spec.checkKind,
        checkStatus: status,
        command: [this.spec.command.executable, ...this.spec.command.args].join(" "),
        workingDirectory: dirRes.value,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        evidenceProposalId: evidence.artifactProposal.proposalId,
        evidenceChecksumSha256: evidence.artifactProposal.expectedIntegrity.checksum.value,
        independentOfAgentClaims: true,
        ...(validContext.taskId ? { failedTaskId: status === "failed" || status === "error" ? validContext.taskId : null } : {})
      }
    };

    const parsedContractResult = QualityGateResultSchema.safeParse(contractResult);
    if (!parsedContractResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Failed to construct valid contract result: ${parsedContractResult.error.message}`
        }
      };
    }

    const summary =
      status === "passed"
        ? `Check "${this.spec.checkKind}" (${this.spec.gateId}) passed (${outcome.durationMs}ms)`
        : status === "failed"
        ? `Check "${this.spec.checkKind}" (${this.spec.gateId}) failed (exit code ${outcome.exitCode ?? "n/a"})`
        : `Check "${this.spec.checkKind}" (${this.spec.gateId}) error: ${executionError?.message ?? "unknown error"}`;

    const checkResult: QualityCheckResult = {
      gateId: this.spec.gateId,
      runId: validContext.runId,
      ...(validContext.taskId !== undefined ? { taskId: validContext.taskId } : {}),
      checkKind: this.spec.checkKind,
      status,
      summary,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      findings,
      evidence,
      contractResult: parsedContractResult.data
    };

    this.onCheckCompleted?.(checkResult);
    return { ok: true, value: checkResult };
  }

  private createErrorCheckResult(
    validContext: QualityGateContext,
    evaluationId: string,
    evaluatedAt: string,
    executionError: ExecutionError,
    findings: readonly QualityFinding[],
    workingDirectory: string | null
  ): OperationResult<QualityCheckResult> {
    const contractResult: QualityGateResult = {
      gateId: this.spec.gateId,
      runId: validContext.runId,
      ...(validContext.taskId ? { taskId: validContext.taskId } : {}),
      evaluationId,
      status: "error",
      findings: [...findings],
      producedArtifacts: [],
      error: executionError,
      evaluatedAt,
      metadata: {
        checkKind: this.spec.checkKind,
        checkStatus: "error",
        command: [this.spec.command.executable, ...this.spec.command.args].join(" "),
        workingDirectory: workingDirectory ?? (this.spec.command.cwd ?? this.spec.workingDirectory),
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        evidenceProposalId: null,
        evidenceChecksumSha256: null,
        independentOfAgentClaims: true,
        ...(validContext.taskId ? { failedTaskId: validContext.taskId } : {})
      }
    };

    const parsedContractResult = QualityGateResultSchema.safeParse(contractResult);
    if (!parsedContractResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Failed to construct valid contract result: ${parsedContractResult.error.message}`
        }
      };
    }

    const checkResult: QualityCheckResult = {
      gateId: this.spec.gateId,
      runId: validContext.runId,
      ...(validContext.taskId !== undefined ? { taskId: validContext.taskId } : {}),
      checkKind: this.spec.checkKind,
      status: "error",
      summary: `Check "${this.spec.checkKind}" (${this.spec.gateId}) error: ${executionError.message}`,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      findings,
      contractResult: parsedContractResult.data
    };

    this.onCheckCompleted?.(checkResult);
    return { ok: true, value: checkResult };
  }
}

export function createQualityGate(
  options: CreateQualityGateOptions
): CommandQualityGate {
  return new CommandQualityGate(options);
}

export interface PresetQualityGateInput {
  readonly gateId?: string;
  readonly checkKind: QualityCheckKind;
  readonly workingDirectory: string;
  readonly securityPolicy: QualitySecurityPolicy;
  readonly customCommand?: CommandSpec;
  readonly argsOverride?: readonly string[];
  readonly timeoutMs?: number;
  readonly required?: boolean;
  readonly skip?: boolean;
  readonly skipReason?: string;
  readonly requireEvidence?: boolean;
  readonly outputExpectation?: QualityCheckOutputExpectation;
  readonly runner?: QualityCommandRunner;
  readonly now?: () => string;
}

export function createPresetQualityGate(
  input: PresetQualityGateInput
): OperationResult<CommandQualityGate> {
  if (!isQualityCheckKind(input.checkKind)) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid quality check kind: ${String(input.checkKind)}`
      }
    };
  }

  let command: CommandSpec;
  switch (input.checkKind) {
    case "typecheck":
      command = { executable: "pnpm", args: input.argsOverride ?? ["typecheck"] };
      break;
    case "lint":
      command = { executable: "pnpm", args: input.argsOverride ?? ["lint"] };
      break;
    case "unit_test":
      command = { executable: "pnpm", args: input.argsOverride ?? ["test"] };
      break;
    case "build":
      command = { executable: "pnpm", args: input.argsOverride ?? ["build"] };
      break;
    case "custom":
      if (!input.customCommand) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: "custom quality check kind requires customCommand"
          }
        };
      }
      command = input.customCommand;
      break;
  }

  const gateId = input.gateId ?? `${input.checkKind}-gate`;
  const parsedGateId = IdentifierSchema.safeParse(gateId);
  if (!parsedGateId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid gateId "${gateId}": ${parsedGateId.error.message}`
      }
    };
  }

  const spec: QualityCheckSpec = {
    gateId: parsedGateId.data,
    checkKind: input.checkKind,
    command,
    workingDirectory: input.workingDirectory,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.required !== undefined ? { required: input.required } : {}),
    ...(input.skip !== undefined ? { skip: input.skip } : {}),
    ...(input.skipReason !== undefined ? { skipReason: input.skipReason } : {}),
    ...(input.requireEvidence !== undefined ? { requireEvidence: input.requireEvidence } : {}),
    ...(input.outputExpectation !== undefined ? { outputExpectation: input.outputExpectation } : {})
  };

  return {
    ok: true,
    value: new CommandQualityGate({
      spec,
      securityPolicy: input.securityPolicy,
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.now !== undefined ? { now: input.now } : {})
    })
  };
}

export interface QualitySuiteFailedTaskReport {
  readonly taskId?: string;
  readonly gateId: string;
  readonly checkKind: QualityCheckKind;
  readonly status: "failed" | "error";
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly summary: string;
  readonly findings: readonly QualityFinding[];
}

export interface QualityCheckSuiteReport {
  readonly runId: string;
  readonly taskId?: string;
  readonly overallStatus: QualityCheckStatus;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly results: readonly QualityCheckResult[];
  readonly failedTasks: readonly QualitySuiteFailedTaskReport[];
  readonly evidenceProposals: readonly ArtifactProposal[];
  readonly evidenceContentsByProposalId: Readonly<Record<string, string>>;
}

export async function evaluateQualityCheckSuite(
  gates: readonly CommandQualityGate[],
  context: QualityGateContext,
  options?: OperationOptions
): Promise<OperationResult<QualityCheckSuiteReport>> {
  const parsedContext = QualityGateContextSchema.safeParse(context);
  if (!parsedContext.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid quality gate context: ${parsedContext.error.message}`,
        details: {
          errors: parsedContext.error.errors.map((e) => ({
            path: e.path.join("."),
            message: e.message
          }))
        }
      }
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        retryable: false,
        message: "Quality check suite evaluation was aborted before execution"
      }
    };
  }

  const results: QualityCheckResult[] = [];
  const failedTasks: QualitySuiteFailedTaskReport[] = [];
  const evidenceProposals: ArtifactProposal[] = [];
  const evidenceContentsByProposalId: Record<string, string> = {};

  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const gate of gates) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Quality check suite evaluation was aborted"
        }
      };
    }

    const evalRes = await gate.evaluateDetailed(context, options);
    if (!evalRes.ok) {
      return { ok: false, error: evalRes.error };
    }

    const checkResult = evalRes.value;
    results.push(checkResult);

    switch (checkResult.status) {
      case "passed":
        passedCount++;
        break;
      case "failed":
        failedCount++;
        break;
      case "skipped":
        skippedCount++;
        break;
      case "error":
        errorCount++;
        break;
    }

    if (checkResult.status === "failed" || checkResult.status === "error") {
      failedTasks.push({
        ...(checkResult.taskId !== undefined ? { taskId: checkResult.taskId } : {}),
        gateId: checkResult.gateId,
        checkKind: checkResult.checkKind,
        status: checkResult.status,
        exitCode: checkResult.exitCode,
        timedOut: checkResult.timedOut,
        summary: checkResult.summary,
        findings: checkResult.findings
      });
    }

    if (checkResult.evidence) {
      evidenceProposals.push(checkResult.evidence.artifactProposal);
      evidenceContentsByProposalId[checkResult.evidence.artifactProposal.proposalId] =
        checkResult.evidence.serializedReport;
    }
  }

  const overallStatus: QualityCheckStatus =
    errorCount > 0
      ? "error"
      : failedCount > 0
      ? "failed"
      : passedCount === 0 && skippedCount > 0
      ? "skipped"
      : "passed";

  const report: QualityCheckSuiteReport = {
    runId: parsedContext.data.runId,
    ...(parsedContext.data.taskId !== undefined ? { taskId: parsedContext.data.taskId } : {}),
    overallStatus,
    passedCount,
    failedCount,
    skippedCount,
    errorCount,
    results,
    failedTasks,
    evidenceProposals,
    evidenceContentsByProposalId
  };

  return {
    ok: true,
    value: report
  };
}
