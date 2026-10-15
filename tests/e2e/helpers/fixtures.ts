import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  AgentExecutionHandle,
  AgentResult,
  ArtifactProposal,
  ArtifactReference,
  ContractError,
  JsonValue,
  OperationResult,
  QualityGateContext,
  WorkflowDefinition
} from "@ai-flow/contracts";
import {
  CommandQualityGate,
  createDefaultSecurityPolicy,
  DEFAULT_ALLOWED_COMMANDS,
  type QualityCheckKind,
  type QualityCheckOutputExpectation
} from "@ai-flow/quality-gates";

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
 * Creates a schema-compliant verified AgentResult for an accepted execution handle.
 * 
 * NOTE: This fixture represents test-controlled correlation under @ai-flow/contracts
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
  readonly nodeScript?: string;
  readonly scriptBody?: string;
  readonly checkKind?: QualityCheckKind;
  readonly required?: boolean;
  readonly minPassedTestsCount?: number;
  readonly timeoutMs?: number;
  readonly outputExpectation?: QualityCheckOutputExpectation;
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
        : {})
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
