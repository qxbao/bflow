import {
  IdentifierSchema,
  WorkflowDefinitionSchema,
  type AgentConfiguration,
  type AgentRegistry,
  type JsonValue,
  type OperationOptions,
  type OperationResult,
  type RecoveryPolicy,
  type RetryPolicy,
  type TimeoutPolicy,
  type WorkflowDefinition
} from "@ai-flow/contracts";
import { isMvpRole, parseRoleAgentSettings } from "./roles.js";

export const WORKFLOW_KINDS = ["feature", "bugfix", "refactor"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export function isWorkflowKind(value: unknown): value is WorkflowKind {
  return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value);
}

export interface WorkflowTemplateOptions {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly maxConcurrency?: number;
  readonly failurePolicy?: "fail-fast" | "continue-independent" | "block";
  readonly maxReworks?: number;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly recovery?: RecoveryPolicy;
  readonly metadata?: Record<string, JsonValue>;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 2,
  strategy: "exponential",
  initialDelayMs: 1_000,
  maxDelayMs: 5_000,
  multiplier: 2,
  jitter: true
};

const DEFAULT_TIMEOUT: TimeoutPolicy = {
  executionTimeoutMs: 300_000,
  onTimeout: "fail"
};

const DEFAULT_RECOVERY: RecoveryPolicy = {
  checkpoint: "task-boundary",
  resumeStrategy: "checkpoint-then-replay",
  staleExecution: "reconcile"
};

function failure<T>(message: string, details?: JsonValue): OperationResult<T> {
  return {
    ok: false,
    error: {
      code: "validation",
      retryable: false,
      message,
      ...(details !== undefined ? { details } : {})
    }
  };
}

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

export function validateMvpWorkflowConventions(
  workflow: WorkflowDefinition
): OperationResult<WorkflowDefinition> {
  const parseRes = WorkflowDefinitionSchema.safeParse(workflow);
  if (!parseRes.success) {
    return failure(`Invalid workflow definition: ${parseRes.error.message}`);
  }

  for (const task of workflow.tasks) {
    if (!isMvpRole(task.role)) {
      return failure(
        `Task '${task.id}' has invalid/out-of-scope role '${task.role}'. Only MVP roles are permitted.`
      );
    }
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      return failure(`Task '${task.id}' must have at least one acceptance criterion.`);
    }
    if (task.role === "reviewer" && !task.requiresApproval) {
      return failure(
        `Reviewer task '${task.id}' must require approval (requiresApproval must be true).`
      );
    }
    if (task.role === "qa" && (!Array.isArray(task.qualityGates) || !task.qualityGates.some((g) => g.required))) {
      return failure(`QA task '${task.id}' must have at least one required quality gate binding.`);
    }
  }

  return success(parseRes.data);
}

export function createFeatureWorkflowDefinition(
  options?: WorkflowTemplateOptions
): OperationResult<WorkflowDefinition> {
  const retry = options?.retry ?? DEFAULT_RETRY;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const recovery = options?.recovery ?? DEFAULT_RECOVERY;
  const maxReworks = options?.maxReworks ?? 2;

  const candidate: WorkflowDefinition = {
    schemaVersion: "1",
    id: options?.id ?? "feature-workflow",
    name: options?.name ?? "Feature Implementation Workflow",
    version: options?.version ?? "1.0.0",
    ...(options?.description !== undefined
      ? { description: options.description }
      : { description: "End-to-end SDLC feature implementation: plan -> implement -> review -> qa" }),
    maxConcurrency: options?.maxConcurrency ?? 1,
    failurePolicy: options?.failurePolicy ?? "fail-fast",
    recovery,
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    tasks: [
      {
        id: "plan",
        title: "Plan Feature Implementation",
        description: "Analyze requirements, break down tasks, and map dependencies",
        role: "planner",
        instruction: "Analyze requirements and create task breakdown and dependency plan.",
        acceptanceCriteria: ["Detailed task breakdown created", "Dependencies identified"],
        retry,
        timeout,
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "implement",
        title: "Implement Feature",
        description: "Implement code changes in isolated worktree and verify local tests",
        role: "developer",
        instruction: "Implement feature code in worktree with tests.",
        acceptanceCriteria: ["Feature implemented according to plan", "Unit tests pass in worktree"],
        retry,
        rework: { maxReworks, onExhausted: "require_human" },
        timeout,
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "review",
        title: "Review Feature Implementation",
        description: "Perform architectural, security, and quality code review",
        role: "reviewer",
        instruction: "Perform code and architecture review on the implemented feature.",
        acceptanceCriteria: ["Code quality verified", "No high/error findings"],
        retry,
        timeout,
        requiresApproval: true,
        qualityGates: []
      },
      {
        id: "qa",
        title: "QA Verification",
        description: "Execute independent verification and automated test suite",
        role: "qa",
        instruction: "Execute independent verification and automated tests.",
        acceptanceCriteria: [
          "Automated tests execute and pass independently",
          "All acceptance criteria verified"
        ],
        retry,
        timeout,
        requiresApproval: false,
        qualityGates: [{ gateId: "qa-gate", phase: "after_result", required: true }]
      }
    ],
    dependencies: [
      { taskId: "implement", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "review", dependsOnTaskId: "implement", condition: "succeeded" },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" }
    ],
    qualityGates: [
      {
        id: "qa-gate",
        name: "Feature QA Gate",
        description: "Automated test verification gate",
        evaluator: "automated-test-runner",
        required: true,
        timeout
      }
    ]
  };

  return validateMvpWorkflowConventions(candidate);
}

export function createBugfixWorkflowDefinition(
  options?: WorkflowTemplateOptions
): OperationResult<WorkflowDefinition> {
  const retry = options?.retry ?? DEFAULT_RETRY;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const recovery = options?.recovery ?? DEFAULT_RECOVERY;
  const maxReworks = options?.maxReworks ?? 2;

  const candidate: WorkflowDefinition = {
    schemaVersion: "1",
    id: options?.id ?? "bugfix-workflow",
    name: options?.name ?? "Bugfix Workflow",
    version: options?.version ?? "1.0.0",
    ...(options?.description !== undefined
      ? { description: options.description }
      : { description: "Root cause analysis, bug fix with regression tests, review, and QA verification" }),
    maxConcurrency: options?.maxConcurrency ?? 1,
    failurePolicy: options?.failurePolicy ?? "fail-fast",
    recovery,
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    tasks: [
      {
        id: "plan",
        title: "Analyze Root Cause and Plan Bugfix",
        description: "Root cause analysis and reproduction steps",
        role: "planner",
        instruction: "Analyze defect, determine root cause, and formulate reproduction and fix plan.",
        acceptanceCriteria: ["Root cause identified", "Reproduction steps documented"],
        retry,
        timeout,
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "fix",
        title: "Fix Bug and Add Regression Test",
        description: "Fix defect in worktree and add regression test preventing recurrence",
        role: "developer",
        instruction: "Fix defect in worktree and add regression test preventing recurrence.",
        acceptanceCriteria: ["Bug resolved", "Regression test passes"],
        retry,
        rework: { maxReworks, onExhausted: "require_human" },
        timeout,
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "review",
        title: "Review Bugfix",
        description: "Review bugfix patch for correctness, security, and side-effects",
        role: "reviewer",
        instruction: "Review bugfix patch for correctness, security, and side-effects.",
        acceptanceCriteria: ["Fix verified", "No regressions introduced"],
        retry,
        timeout,
        requiresApproval: true,
        qualityGates: []
      },
      {
        id: "qa",
        title: "QA Regression Verification",
        description: "Execute independent regression test run to verify bug fix",
        role: "qa",
        instruction: "Execute independent regression test run to verify bug fix.",
        acceptanceCriteria: ["Regression test verified independently", "All test suites pass"],
        retry,
        timeout,
        requiresApproval: false,
        qualityGates: [{ gateId: "regression-qa-gate", phase: "after_result", required: true }]
      }
    ],
    dependencies: [
      { taskId: "fix", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "review", dependsOnTaskId: "fix", condition: "succeeded" },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" }
    ],
    qualityGates: [
      {
        id: "regression-qa-gate",
        name: "Regression QA Gate",
        description: "Automated regression verification gate",
        evaluator: "automated-test-runner",
        required: true,
        timeout
      }
    ]
  };

  return validateMvpWorkflowConventions(candidate);
}

export function createRefactorWorkflowDefinition(
  options?: WorkflowTemplateOptions
): OperationResult<WorkflowDefinition> {
  const retry = options?.retry ?? DEFAULT_RETRY;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const recovery = options?.recovery ?? DEFAULT_RECOVERY;
  const maxReworks = options?.maxReworks ?? 2;

  const candidate: WorkflowDefinition = {
    schemaVersion: "1",
    id: options?.id ?? "refactor-workflow",
    name: options?.name ?? "Refactor Workflow",
    version: options?.version ?? "1.0.0",
    ...(options?.description !== undefined
      ? { description: options.description }
      : { description: "Behavior-preserving refactoring with invariant verification" }),
    maxConcurrency: options?.maxConcurrency ?? 1,
    failurePolicy: options?.failurePolicy ?? "fail-fast",
    recovery,
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    tasks: [
      {
        id: "plan",
        title: "Plan Refactoring and Identify Invariants",
        description: "Define refactoring scope, modular boundaries, and behavioral invariants",
        role: "planner",
        instruction: "Define refactoring scope, modular boundaries, and behavioral invariants.",
        acceptanceCriteria: ["Invariants documented", "Refactoring steps defined"],
        retry,
        timeout,
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "refactor",
        title: "Execute Behavior-Preserving Refactoring",
        description: "Refactor codebase while preserving existing behavior and test suites",
        role: "developer",
        instruction: "Refactor codebase while preserving existing behavior and test suites.",
        acceptanceCriteria: ["Refactoring complete", "Existing tests pass without modification"],
        retry,
        rework: { maxReworks, onExhausted: "require_human" },
        timeout,
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "review",
        title: "Review Refactoring",
        description: "Verify architectural improvements and that behavior invariants were preserved",
        role: "reviewer",
        instruction: "Verify architectural improvements and that behavior invariants were preserved.",
        acceptanceCriteria: ["Architectural clarity improved", "No unintended functional changes"],
        retry,
        timeout,
        requiresApproval: true,
        qualityGates: []
      },
      {
        id: "qa",
        title: "QA Invariant Verification",
        description: "Verify system behavior and test suites after refactoring",
        role: "qa",
        instruction: "Verify system behavior and test suites after refactoring.",
        acceptanceCriteria: [
          "All test suites pass independently",
          "Performance and behavior invariants verified"
        ],
        retry,
        timeout,
        requiresApproval: false,
        qualityGates: [{ gateId: "invariant-qa-gate", phase: "after_result", required: true }]
      }
    ],
    dependencies: [
      { taskId: "refactor", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "review", dependsOnTaskId: "refactor", condition: "succeeded" },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" }
    ],
    qualityGates: [
      {
        id: "invariant-qa-gate",
        name: "Invariant QA Gate",
        description: "Automated invariant verification gate",
        evaluator: "automated-test-runner",
        required: true,
        timeout
      }
    ]
  };

  return validateMvpWorkflowConventions(candidate);
}

export function loadWorkflowDefinition(
  source: WorkflowKind | string | unknown,
  options?: WorkflowTemplateOptions
): OperationResult<WorkflowDefinition> {
  if (typeof source === "string") {
    if (isWorkflowKind(source)) {
      switch (source) {
        case "feature":
          return createFeatureWorkflowDefinition(options);
        case "bugfix":
          return createBugfixWorkflowDefinition(options);
        case "refactor":
          return createRefactorWorkflowDefinition(options);
      }
    }
    try {
      const parsed = JSON.parse(source);
      return validateMvpWorkflowConventions(parsed as WorkflowDefinition);
    } catch (err) {
      return failure(`Failed to parse workflow definition JSON: ${(err as Error).message}`);
    }
  }

  if (typeof source === "object" && source !== null) {
    return validateMvpWorkflowConventions(source as WorkflowDefinition);
  }

  return failure(
    "Invalid workflow definition source: expected WorkflowKind, JSON string, or WorkflowDefinition object"
  );
}

export async function verifyWorkflowRolesRegistered(
  workflow: WorkflowDefinition,
  registry: AgentRegistry,
  runId: string,
  options?: OperationOptions
): Promise<OperationResult<Readonly<Record<string, AgentConfiguration>>>> {
  const conventionsRes = validateMvpWorkflowConventions(workflow);
  if (!conventionsRes.ok) {
    return conventionsRes;
  }

  const runIdRes = IdentifierSchema.safeParse(runId);
  if (!runIdRes.success) {
    return failure(`Invalid runId in verifyWorkflowRolesRegistered: ${runIdRes.error.message}`);
  }

  const configs: Record<string, AgentConfiguration> = {};
  const seenRoles = new Set<string>();

  for (const task of workflow.tasks) {
    const role = task.role;
    if (seenRoles.has(role)) {
      continue;
    }
    seenRoles.add(role);

    const resolveRes = await registry.resolve(
      role,
      {
        runId,
        taskId: task.id,
        requiredCapabilities: []
      },
      options
    );

    if (!resolveRes.ok) {
      return resolveRes;
    }

    if (resolveRes.value === null) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `No agent registered for workflow role '${role}' (required by task '${task.id}')`
        }
      };
    }

    const settingsRes = parseRoleAgentSettings(
      resolveRes.value.settings,
      isMvpRole(role) ? role : undefined
    );
    if (!settingsRes.ok) {
      return settingsRes;
    }

    configs[role] = resolveRes.value;
  }

  return success(configs);
}
