import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  AgentExecutionHandle,
  AgentResult,
  ArtifactProposal,
  ArtifactReference,
  ArtifactStore,
  ContractError,
  JsonValue,
  OperationResult,
  QualityGateContext,
  WorkflowDefinition
} from "@bflow/contracts";
import {
  CommandQualityGate,
  createDefaultSecurityPolicy,
  DEFAULT_ALLOWED_COMMANDS,
  type QualityCheckKind,
  type QualityCheckOutputExpectation,
  type QualityCommandOutcome,
  type QualityFinding
} from "@bflow/quality-gates";

/**
 * Asserts that an OperationResult is successful and narrows its type to T.
 */
export function expectOk<T>(result: OperationResult<T>, message?: string): T {
  expect(result.ok, message ?? (!result.ok ? result.error.message : "operation failed")).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/**
 * Asserts that an OperationResult failed and narrows its type to ContractError.
 */
export function expectFailure<T>(result: OperationResult<T>, message?: string): ContractError {
  expect(result.ok, message ?? (result.ok ? "operation unexpectedly succeeded" : "operation succeeded")).toBe(false);
  if (result.ok) {
    throw new Error(`Expected failed result, got ok value: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

/**
 * Creates an AsyncIterable byte stream from a Buffer.
 */
export function createByteStream(content: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(content);
    }
  };
}

/**
 * Safely reads all bytes of an artifact reference from an ArtifactStore.
 * Avoids type assertions; cleanly preserves typed errors from chunk results.
 */
export async function readArtifactBytes(
  store: ArtifactStore,
  ref: ArtifactReference
): Promise<OperationResult<Buffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of store.get(ref)) {
    if (!chunk.ok) {
      return { ok: false, error: chunk.error };
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

/**
 * Strict, reusable TAP (Test Anything Protocol) machine output parser.
 *
 * Rules:
 * 1. Fail-closed: Blank or unparseable output produces error findings.
 * 2. Never treats absence of evidence (0 parsed tests) as silently valid success.
 * 3. Enforces TAP 13 plan specification (`1..N`) and verifies test point count against plan.
 * 4. Strictly checks sequential test point IDs (1, 2, 3...) to reject duplicate/misordered points.
 * 5. Requires top-level test points anchored at column 0 to avoid counting nested subtests as flat.
 * 6. Checks summary counters (# tests, # pass, # fail) when present.
 * 7. Fails on Bail out! directives.
 */
export interface StrictTapParserOptions {
  readonly requirePlan?: boolean;
  readonly minPassedTestsCount?: number;
  readonly expectedVersion?: string;
}

export function createStrictTapParser(options?: StrictTapParserOptions) {
  const requirePlan = options?.requirePlan ?? true;
  const minPassedTestsCount = options?.minPassedTestsCount;
  const expectedVersion = options?.expectedVersion ?? "13";

  return (outcome: QualityCommandOutcome): {
    readonly findings: readonly QualityFinding[];
    readonly passedTests: number;
    readonly failedTests: number;
    readonly skippedTests: number;
  } => {
    const rawOutput = outcome.combinedOutput;
    const findings: QualityFinding[] = [];

    if (rawOutput.trim().length === 0) {
      findings.push({
        code: "EMPTY_TAP_OUTPUT",
        severity: "error",
        message: "TAP output stream was completely empty"
      });
      return { findings, passedTests: 0, failedTests: 0, skippedTests: 0 };
    }

    const rawLines = rawOutput.split(/\r?\n/);

    let planTotal: number | undefined;
    let countedOk = 0;
    let countedNotOk = 0;
    let countedSkip = 0;
    let hasPlanLine = false;
    let hasVersionHeader = false;
    let expectedNextId = 1;
    let summaryTests: number | undefined;
    let summaryPass: number | undefined;
    let summaryFail: number | undefined;

    for (const line of rawLines) {
      // 1. Version header (must be anchored at column 0)
      const versionMatch = line.match(/^TAP version (\d+)\b/);
      if (versionMatch) {
        if (versionMatch[1] === expectedVersion) {
          hasVersionHeader = true;
        } else {
          findings.push({
            code: "INVALID_TAP_VERSION",
            severity: "error",
            message: `TAP version was "${versionMatch[1]}", expected "${expectedVersion}"`
          });
        }
        continue;
      }

      // 2. Bail out check
      const bailMatch = line.match(/^Bail out!(?:\s+(.*))?/i);
      if (bailMatch) {
        findings.push({
          code: "TAP_BAIL_OUT",
          severity: "error",
          message: `TAP test runner bailed out${bailMatch[1] ? `: ${bailMatch[1]}` : ""}`
        });
        continue;
      }

      // 3. Plan line (anchored at column 0: 1..N)
      const planMatch = line.match(/^1\.\.(\d+)\b/);
      if (planMatch && planMatch[1]) {
        if (hasPlanLine) {
          findings.push({
            code: "DUPLICATE_TAP_PLAN",
            severity: "error",
            message: "Multiple TAP plan lines detected"
          });
        }
        hasPlanLine = true;
        planTotal = parseInt(planMatch[1], 10);
        continue;
      }

      // 4. Summaries (anchored at column 0)
      const testsSummary = line.match(/^# tests\s+(\d+)\b/);
      if (testsSummary && testsSummary[1]) {
        summaryTests = parseInt(testsSummary[1], 10);
        continue;
      }
      const passSummary = line.match(/^# pass\s+(\d+)\b/);
      if (passSummary && passSummary[1]) {
        summaryPass = parseInt(passSummary[1], 10);
        continue;
      }
      const failSummary = line.match(/^# fail\s+(\d+)\b/);
      if (failSummary && failSummary[1]) {
        summaryFail = parseInt(failSummary[1], 10);
        continue;
      }

      // 5. Test points (strictly anchored at column 0, no leading whitespace!)
      // Exclude nested subtests which have leading spaces
      const notOkMatch = line.match(/^not ok\s+(\d+)(?:\s+-\s+(.*))?$/i);
      if (notOkMatch && notOkMatch[1]) {
        const pointId = parseInt(notOkMatch[1], 10);
        if (pointId !== expectedNextId) {
          findings.push({
            code: "TAP_INVALID_TEST_ID",
            severity: "error",
            message: `TAP test point ID out of sequence: expected ${expectedNextId}, but observed ${pointId}`
          });
        }
        expectedNextId++;
        countedNotOk++;
        findings.push({
          code: "TEST_POINT_FAILED",
          severity: "error",
          message: `TAP test point failure: ${line}`
        });
        continue;
      }

      const okMatch = line.match(/^ok\s+(\d+)(?:\s+-\s+(.*))?$/i);
      if (okMatch && okMatch[1]) {
        const pointId = parseInt(okMatch[1], 10);
        const rawDesc = okMatch[2]?.trim() ?? "";
        const directiveMatch = rawDesc.match(/#\s*(SKIP|TODO)\b(.*)$/i);
        const desc = (directiveMatch ? rawDesc.slice(0, directiveMatch.index) : rawDesc).trim();
        const directive = directiveMatch ? directiveMatch[1]!.toUpperCase() : undefined;

        // Check if this test point is actually just the node runner wrapping a file with 0 tests
        // (e.g. "ok 1 - /path/to/zero.test.mjs" with no actual test definitions inside)
        if (desc.endsWith(".test.mjs") || desc.endsWith(".test.js")) {
          // File wrapper for empty suite - does not count as unit test point
          continue;
        }

        if (pointId !== expectedNextId) {
          findings.push({
            code: "TAP_INVALID_TEST_ID",
            severity: "error",
            message: `TAP test point ID out of sequence: expected ${expectedNextId}, but observed ${pointId}`
          });
        }
        expectedNextId++;

        if (directive === "SKIP" || directive === "TODO") {
          countedSkip++;
        } else {
          countedOk++;
        }
        continue;
      }
    }

    if (!hasVersionHeader) {
      findings.push({
        code: "MISSING_OR_INVALID_TAP_VERSION",
        severity: "error",
        message: `Missing required 'TAP version ${expectedVersion}' header`
      });
    }

    if (requirePlan && !hasPlanLine) {
      findings.push({
        code: "TAP_PLAN_MISSING",
        severity: "error",
        message: "Strict TAP parser requires an explicit test plan (e.g. '1..N')"
      });
    }

    const totalObserved = countedOk + countedNotOk + countedSkip;
    if (totalObserved === 0) {
      findings.push({
        code: "NO_TAP_TEST_POINTS",
        severity: "error",
        message: "No valid TAP test points ('ok' or 'not ok') found in command output"
      });
    }

    if (planTotal !== undefined && totalObserved !== planTotal) {
      findings.push({
        code: "TAP_PLAN_COUNT_MISMATCH",
        severity: "error",
        message: `TAP plan specified ${planTotal} tests but observed ${totalObserved} test points`
      });
    }

    if (summaryTests !== undefined && summaryTests !== totalObserved) {
      findings.push({
        code: "TAP_SUMMARY_MISMATCH",
        severity: "error",
        message: `Summary reported ${summaryTests} tests, but observed ${totalObserved} test points`
      });
    }

    if (summaryPass !== undefined && summaryPass !== countedOk) {
      findings.push({
        code: "TAP_SUMMARY_MISMATCH",
        severity: "error",
        message: `Summary reported ${summaryPass} passed tests, but observed ${countedOk}`
      });
    }

    if (summaryFail !== undefined && summaryFail !== countedNotOk) {
      findings.push({
        code: "TAP_SUMMARY_MISMATCH",
        severity: "error",
        message: `Summary reported ${summaryFail} failed tests, but observed ${countedNotOk}`
      });
    }

    if (minPassedTestsCount !== undefined && countedOk < minPassedTestsCount) {
      findings.push({
        code: "INSUFFICIENT_PASSED_TESTS",
        severity: "error",
        message: `Counted passed tests (${countedOk}) is less than required minimum of ${minPassedTestsCount}`
      });
    }

    return {
      findings,
      passedTests: countedOk,
      failedTests: countedNotOk,
      skippedTests: countedSkip
    };
  };
}

/**
 * Creates a schema-compliant verified AgentResult for an accepted execution handle.
 *
 * NOTE: This fixture represents test-controlled correlation under @bflow/contracts
 * and must not be claimed as evidence of live Herdr correlation capability.
 */
export function createVerifiedAgentResult(options: {
  readonly handle: AgentExecutionHandle;
  readonly status?: "succeeded" | "failed" | "blocked" | "timed_out";
  readonly output?: JsonValue;
  readonly artifactProposals?: readonly ArtifactProposal[];
  readonly completedAt?: string;
  readonly error?: { code: string; message: string; retryable: boolean };
}): AgentResult {
  const completedAt = options.completedAt ?? new Date().toISOString();
  const status = options.status ?? "succeeded";
  const artifactProposals = options.artifactProposals ?? [];

  return {
    executionId: options.handle.executionId,
    requestId: options.handle.requestId,
    attemptId: options.handle.attemptId,
    runId: options.handle.runId,
    taskId: options.handle.taskId,
    status,
    ...(options.output ? { output: options.output } : {}),
    artifactProposals: [...artifactProposals],
    ...(options.error ? { error: options.error } : {}),
    retryable: options.error ? options.error.retryable : false,
    startedAt: options.handle.acceptedAt,
    completedAt,
    verification: {
      status: "verified",
      evidence: "Fixture correlation verified",
      correlation: {
        token: options.handle.correlation.token,
        provenance: options.handle.correlation.provenance,
        verified: true
      }
    }
  };
}

/**
 * Creates an artifact proposal with precomputed SHA-256 checksum and size.
 */
export function createArtifactProposal(options: {
  readonly runId: string;
  readonly taskId?: string;
  readonly kind?: "agent-output" | "document" | "log" | "report" | "patch" | "test-result" | "other";
  readonly logicalName?: string;
  readonly mediaType?: string;
  readonly content: string | Uint8Array;
  readonly proposalId?: string;
}): { proposal: ArtifactProposal; rawBytes: Uint8Array } {
  const proposalId = options.proposalId ?? `prop-${randomUUID()}`;
  const rawBytes = typeof options.content === "string" ? Buffer.from(options.content, "utf8") : options.content;
  const checksum = createHash("sha256").update(rawBytes).digest("hex");

  const proposal: ArtifactProposal = {
    proposalId,
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    kind: options.kind ?? "report",
    logicalName: options.logicalName ?? "artifact.txt",
    mediaType: options.mediaType ?? "text/plain",
    expectedIntegrity: {
      checksum: {
        algorithm: "sha256",
        value: checksum
      },
      sizeBytes: rawBytes.byteLength
    }
  };

  return { proposal, rawBytes };
}

/**
 * Creates a valid 4-stage MVP SDLC workflow definition:
 * plan (planner) -> implement (developer, rework) -> review (reviewer, approval) -> qa (qa, gate)
 */
export function createStandardMvpWorkflow(options?: {
  readonly id?: string;
  readonly gateId?: string;
  readonly maxReworks?: number;
  readonly onExhausted?: "fail" | "require_human";
}): WorkflowDefinition {
  const gateId = options?.gateId ?? "qa-gate";
  const maxReworks = options?.maxReworks ?? 2;
  const onExhausted = options?.onExhausted ?? "require_human";

  return {
    schemaVersion: "1",
    id: options?.id ?? "sdlc-standard-e2e",
    name: "SDLC Standard E2E Integration Workflow",
    version: "1.0.0",
    description: "Verified 4-stage SDLC pipeline: plan -> implement -> review -> qa",
    maxConcurrency: 1,
    failurePolicy: "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    tasks: [
      {
        id: "plan",
        title: "Plan Implementation",
        description: "Analyze requirement and produce architectural task breakdown",
        role: "planner",
        instruction: "Decompose requirements into tasks.",
        acceptanceCriteria: ["Task breakdown generated"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "implement",
        title: "Implement Code Changes",
        description: "Implement patch and unit tests",
        role: "developer",
        instruction: "Write code and tests.",
        acceptanceCriteria: ["Code implemented", "Tests pass"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        rework: { maxReworks, onExhausted },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "review",
        title: "Review Changes",
        description: "Code review and human governance gate",
        role: "reviewer",
        instruction: "Perform architectural and security review.",
        acceptanceCriteria: ["Code verified without critical issues"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: true,
        qualityGates: []
      },
      {
        id: "qa",
        title: "Automated QA Verification",
        description: "Execute automated verification gate",
        role: "qa",
        instruction: "Run automated quality checks.",
        acceptanceCriteria: ["Automated checks pass"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: [{ gateId, phase: "after_result", required: true }]
      }
    ],
    dependencies: [
      { taskId: "implement", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "review", dependsOnTaskId: "implement", condition: "succeeded" },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" }
    ],
    qualityGates: [
      {
        id: gateId,
        name: "Automated QA Gate",
        description: "Subprocess verification gate",
        evaluator: "command",
        required: true,
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
      }
    ]
  };
}

/**
 * Creates a minimal single-task workflow with a required quality gate.
 */
export function createGatedSingleTaskWorkflow(options: {
  readonly id?: string;
  readonly taskId?: string;
  readonly gateId: string;
  readonly role?: string;
  readonly required?: boolean;
}): WorkflowDefinition {
  const taskId = options.taskId ?? "task-with-gate";
  const required = options.required ?? true;

  return {
    schemaVersion: "1",
    id: options.id ?? `wf-gate-${randomUUID().slice(0, 8)}`,
    name: "Gated Workflow",
    version: "1.0.0",
    maxConcurrency: 1,
    failurePolicy: "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    tasks: [
      {
        id: taskId,
        title: "Gated Task",
        role: options.role ?? "developer",
        instruction: "Execute task subject to quality gate",
        acceptanceCriteria: ["Task completed"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: [{ gateId: options.gateId, phase: "after_result", required }]
      }
    ],
    dependencies: [],
    qualityGates: [
      {
        id: options.gateId,
        name: "Test Quality Gate",
        evaluator: "command",
        required,
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
      }
    ]
  };
}

/**
 * Creates a real CommandQualityGate with safe Node.js subprocess invocation.
 */
export function createSafeSubprocessGate(options: {
  readonly gateId: string;
  readonly workingDirectory: string;
  readonly nodeScript?: string | undefined;
  readonly scriptBody?: string | undefined;
  readonly checkKind?: QualityCheckKind | undefined;
  readonly required?: boolean | undefined;
  readonly minPassedTestsCount?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly outputExpectation?: QualityCheckOutputExpectation | undefined;
  readonly outputParser?: ((outcome: QualityCommandOutcome) => {
    readonly findings?: readonly QualityFinding[];
    readonly passedTests?: number;
    readonly failedTests?: number;
    readonly skippedTests?: number;
  }) | undefined;
}): CommandQualityGate {
  const scriptContent = options.nodeScript ?? options.scriptBody ?? "process.exit(0);";
  const scriptFileName = `test-gate-${options.gateId}.mjs`;
  const scriptFilePath = join(options.workingDirectory, scriptFileName);
  writeFileSync(scriptFilePath, scriptContent, "utf8");

  const policyRes = createDefaultSecurityPolicy({
    allowedRootDirs: [options.workingDirectory],
    assignedWorktreePath: options.workingDirectory,
    maxExecutionTimeoutMs: Math.max(options.timeoutMs ?? 30000, 30000),
    allowedCommands: [
      ...DEFAULT_ALLOWED_COMMANDS,
      {
        executable: "node",
        allowedArgPrefixes: [[scriptFileName]],
        description: "Node.js safe script runner"
      }
    ]
  });

  if (!policyRes.ok) {
    throw new Error(`Failed to create security policy: ${policyRes.error.message}`);
  }

  return new CommandQualityGate({
    spec: {
      gateId: options.gateId,
      checkKind: options.checkKind ?? "unit_test",
      command: {
        executable: "node",
        args: [scriptFileName]
      },
      workingDirectory: options.workingDirectory,
      required: options.required ?? true,
      requireEvidence: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.outputExpectation
        ? { outputExpectation: options.outputExpectation }
        : options.minPassedTestsCount !== undefined
        ? { outputExpectation: { minPassedTestsCount: options.minPassedTestsCount } }
        : {}),
      ...(options.outputParser ? { outputParser: options.outputParser } : {})
    },
    securityPolicy: policyRes.value
  });
}

/**
 * Creates a real Node.js unit-test CommandQualityGate that executes an actual *.test.mjs file
 * via node --test --test-reporter=tap <filename>.
 *
 * Enforces:
 * 1. Writes real *.test.mjs file importing node:test and node:assert/strict.
 * 2. Runs via real CommandQualityGate with executable "node" and args ["--test", "--test-reporter=tap", filename].
 * 3. Tight allowlist in QualitySecurityPolicy for only this command/args prefix.
 * 4. Captures real exit code and real machine TAP output.
 */
export function createRealNodeUnitTestGate(options: {
  readonly gateId: string;
  readonly workingDirectory: string;
  readonly testFileContent?: string | undefined;
  readonly testCount?: number | undefined;
  readonly testFileName?: string | undefined;
  readonly required?: boolean | undefined;
  readonly minPassedTestsCount?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly outputParser?: ((outcome: QualityCommandOutcome) => {
    readonly findings?: readonly QualityFinding[];
    readonly passedTests?: number;
    readonly failedTests?: number;
    readonly skippedTests?: number;
  }) | undefined;
}): CommandQualityGate {
  const scriptFileName = options.testFileName ?? `unit-test-${options.gateId}.test.mjs`;
  const scriptFilePath = join(options.workingDirectory, scriptFileName);

  let content = options.testFileContent;
  if (!content) {
    const count = options.testCount ?? (options.minPassedTestsCount ?? 1);
    const testsCode: string[] = [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      ""
    ];
    for (let i = 1; i <= count; i++) {
      testsCode.push(`test("SDLC unit test #${i}", () => {`);
      testsCode.push(`  assert.equal(typeof ${i}, "number");`);
      testsCode.push(`  assert.equal(${i} > 0, true);`);
      testsCode.push(`  assert.equal(${i} * 2, ${i * 2});`);
      testsCode.push("});");
    }
    content = testsCode.join("\n");
  }

  writeFileSync(scriptFilePath, content, "utf8");

  const policyRes = createDefaultSecurityPolicy({
    allowedRootDirs: [options.workingDirectory],
    assignedWorktreePath: options.workingDirectory,
    maxExecutionTimeoutMs: Math.max(options.timeoutMs ?? 30000, 30000),
    allowedCommands: [
      ...DEFAULT_ALLOWED_COMMANDS,
      {
        executable: "node",
        allowedArgPrefixes: [["--test", "--test-reporter=tap", scriptFileName]],
        description: "Node.js real test runner"
      }
    ]
  });

  if (!policyRes.ok) {
    throw new Error(`Failed to create security policy: ${policyRes.error.message}`);
  }

  return new CommandQualityGate({
    spec: {
      gateId: options.gateId,
      checkKind: "unit_test",
      command: {
        executable: "node",
        args: ["--test", "--test-reporter=tap", scriptFileName]
      },
      workingDirectory: options.workingDirectory,
      required: options.required ?? true,
      requireEvidence: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.minPassedTestsCount !== undefined
        ? { outputExpectation: { minPassedTestsCount: options.minPassedTestsCount } }
        : {}),
      ...(options.outputParser ? { outputParser: options.outputParser } : {})
    },
    securityPolicy: policyRes.value
  });
}

/**
 * Creates a schema-compliant QualityGateContext.
 */
export function createQualityGateContext(options: {
  readonly runId: string;
  readonly gateId: string;
  readonly taskId?: string;
  readonly required?: boolean;
  readonly timeoutMs?: number;
  readonly agentResult?: AgentResult;
  readonly artifacts?: ArtifactReference[];
}): QualityGateContext {
  return {
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    definition: {
      id: options.gateId,
      name: `Gate ${options.gateId}`,
      evaluator: options.gateId,
      required: options.required ?? true,
      timeout: {
        executionTimeoutMs: options.timeoutMs ?? 10000,
        onTimeout: "fail"
      }
    },
    ...(options.agentResult ? { agentResult: options.agentResult } : {}),
    artifacts: options.artifacts ?? []
  };
}
