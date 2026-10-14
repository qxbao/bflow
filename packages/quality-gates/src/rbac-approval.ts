import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  IdentifierSchema,
  QualityGateResultSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type ContractError,
  type OperationResult,
  type QualityGateResult
} from "@ai-flow/contracts";
import * as path from "node:path";

function createValidationError(message: string): ContractError {
  return {
    code: "validation",
    retryable: false,
    message
  };
}

export const QUALITY_POLICY_ROLES = [
  "reviewer",
  "developer",
  "qa",
  "delivery"
] as const;
export type QualityPolicyRole = (typeof QUALITY_POLICY_ROLES)[number];

export const QUALITY_POLICY_ACTIONS = [
  "read_code",
  "analyze_code",
  "modify_code",
  "run_local_check",
  "execute_test_suite",
  "evaluate_quality_gate",
  "merge_branch",
  "deploy_release"
] as const;
export type QualityPolicyAction = (typeof QUALITY_POLICY_ACTIONS)[number];

export interface RoleAuthorizationPolicy {
  readonly role: QualityPolicyRole;
  readonly allowedActions: readonly QualityPolicyAction[];
  readonly readOnly: boolean;
  readonly requiresAssignedWorktree: boolean;
  readonly requiresAuthorizedTestEnvironment: boolean;
  readonly requiresHumanApprovalBeforeMergeOrDeploy: boolean;
}

export const ROLE_AUTHORIZATION_POLICIES: Readonly<
  Record<QualityPolicyRole, RoleAuthorizationPolicy>
> = {
  reviewer: {
    role: "reviewer",
    allowedActions: ["read_code", "analyze_code"],
    readOnly: true,
    requiresAssignedWorktree: false,
    requiresAuthorizedTestEnvironment: false,
    requiresHumanApprovalBeforeMergeOrDeploy: false
  },
  developer: {
    role: "developer",
    allowedActions: [
      "read_code",
      "analyze_code",
      "modify_code",
      "run_local_check"
    ],
    readOnly: false,
    requiresAssignedWorktree: true,
    requiresAuthorizedTestEnvironment: false,
    requiresHumanApprovalBeforeMergeOrDeploy: false
  },
  qa: {
    role: "qa",
    allowedActions: [
      "read_code",
      "analyze_code",
      "execute_test_suite",
      "evaluate_quality_gate"
    ],
    readOnly: true,
    requiresAssignedWorktree: false,
    requiresAuthorizedTestEnvironment: true,
    requiresHumanApprovalBeforeMergeOrDeploy: false
  },
  delivery: {
    role: "delivery",
    allowedActions: ["read_code", "merge_branch", "deploy_release"],
    readOnly: false,
    requiresAssignedWorktree: false,
    requiresAuthorizedTestEnvironment: false,
    requiresHumanApprovalBeforeMergeOrDeploy: true
  }
};

export interface RoleAuthorizationRequest {
  readonly role: QualityPolicyRole;
  readonly action: QualityPolicyAction;
  readonly actorId: string;
  readonly targetPath?: string;
  readonly assignedWorktreePath?: string;
  readonly modifiedFiles?: readonly string[];
  readonly environment?: string;
  readonly authorizedEnvironments?: readonly string[];
  readonly automatedGateResults?: readonly QualityGateResult[];
  readonly humanApprovalDecision?: ApprovalDecision;
}

export interface RoleAuthorizationDecision {
  readonly authorized: boolean;
  readonly role: QualityPolicyRole;
  readonly action: QualityPolicyAction;
  readonly readOnly: boolean;
  readonly verifiedScope?: string;
  readonly verifiedEnvironment?: string;
  readonly requiresHumanApproval: boolean;
  readonly humanApprovalVerified: boolean;
  readonly reason: string;
}

const AUTOMATED_PREFIX_REGEX =
  /^(agent|ai|bot|system|auto|llm|planner|developer|reviewer|qa)([:_-]|$)/i;

export function isHumanApprover(decidedBy: string): boolean {
  if (
    !decidedBy ||
    typeof decidedBy !== "string" ||
    decidedBy.trim().length === 0
  ) {
    return false;
  }
  return !AUTOMATED_PREFIX_REGEX.test(decidedBy.trim());
}

export function authorizeRoleAction(
  request: RoleAuthorizationRequest
): OperationResult<RoleAuthorizationDecision> {
  if (!request || typeof request !== "object") {
    return {
      ok: false,
      error: createValidationError("Authorization request must be an object")
    };
  }

  if (!(QUALITY_POLICY_ROLES as readonly string[]).includes(request.role)) {
    return {
      ok: false,
      error: createValidationError(`Invalid role "${request.role}"`)
    };
  }

  if (!(QUALITY_POLICY_ACTIONS as readonly string[]).includes(request.action)) {
    return {
      ok: false,
      error: createValidationError(`Invalid action "${request.action}"`)
    };
  }

  if (
    !request.actorId ||
    typeof request.actorId !== "string" ||
    request.actorId.trim().length === 0
  ) {
    return {
      ok: false,
      error: createValidationError("actorId must be a non-empty string")
    };
  }

  const policy = ROLE_AUTHORIZATION_POLICIES[request.role];
  if (!policy.allowedActions.includes(request.action)) {
    return {
      ok: false,
      error: createValidationError(
        `Role "${request.role}" is not authorized to perform action "${request.action}"`
      )
    };
  }

  // Reviewer role constraints
  if (request.role === "reviewer") {
    if (request.modifiedFiles && request.modifiedFiles.length > 0) {
      return {
        ok: false,
        error: createValidationError(
          "Reviewer role is read-only and cannot modify files"
        )
      };
    }
    return {
      ok: true,
      value: {
        authorized: true,
        role: "reviewer",
        action: request.action,
        readOnly: true,
        requiresHumanApproval: false,
        humanApprovalVerified: false,
        reason: `Reviewer role authorized to perform read-only action "${request.action}"`
      }
    };
  }

  // Developer role constraints
  if (request.role === "developer") {
    if (
      request.action === "modify_code" ||
      request.action === "run_local_check"
    ) {
      if (
        !request.assignedWorktreePath ||
        typeof request.assignedWorktreePath !== "string" ||
        request.assignedWorktreePath.trim().length === 0 ||
        request.assignedWorktreePath.split(/[\\/]+/).includes("..")
      ) {
        return {
          ok: false,
          error: createValidationError(
            `Developer action "${request.action}" requires an assignedWorktreePath without ".." segments`
          )
        };
      }

      const worktreeResolved = path.resolve(request.assignedWorktreePath);

      if (request.targetPath !== undefined) {
        if (request.targetPath.split(/[\\/]+/).includes("..")) {
          return {
            ok: false,
            error: createValidationError(
              `Target path "${request.targetPath}" escapes assigned worktree "${request.assignedWorktreePath}"`
            )
          };
        }
        const targetResolved = path.resolve(request.targetPath);
        const rel = path.relative(worktreeResolved, targetResolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return {
            ok: false,
            error: createValidationError(
              `Target path "${request.targetPath}" escapes assigned worktree "${request.assignedWorktreePath}"`
            )
          };
        }
      }

      if (request.modifiedFiles && request.modifiedFiles.length > 0) {
        for (const file of request.modifiedFiles) {
          if (file.split(/[\\/]+/).includes("..")) {
            return {
              ok: false,
              error: createValidationError(
                `Modified file "${file}" escapes assigned worktree "${request.assignedWorktreePath}"`
              )
            };
          }
          const fileResolved = path.resolve(worktreeResolved, file);
          const rel = path.relative(worktreeResolved, fileResolved);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            return {
              ok: false,
              error: createValidationError(
                `Modified file "${file}" escapes assigned worktree "${request.assignedWorktreePath}"`
              )
            };
          }
        }
      }

      return {
        ok: true,
        value: {
          authorized: true,
          role: "developer",
          action: request.action,
          readOnly: false,
          verifiedScope: worktreeResolved,
          requiresHumanApproval: false,
          humanApprovalVerified: false,
          reason: `Developer role authorized to perform "${request.action}" within assigned worktree`
        }
      };
    }

    return {
      ok: true,
      value: {
        authorized: true,
        role: "developer",
        action: request.action,
        readOnly: true,
        ...(request.assignedWorktreePath !== undefined
          ? { verifiedScope: path.resolve(request.assignedWorktreePath) }
          : {}),
        requiresHumanApproval: false,
        humanApprovalVerified: false,
        reason: `Developer role authorized to perform read-only action "${request.action}"`
      }
    };
  }

  // QA role constraints
  if (request.role === "qa") {
    if (request.modifiedFiles && request.modifiedFiles.length > 0) {
      return {
        ok: false,
        error: createValidationError(
          "QA role is read-only and cannot modify files"
        )
      };
    }

    if (
      request.action === "execute_test_suite" ||
      request.action === "evaluate_quality_gate"
    ) {
      if (
        !request.environment ||
        typeof request.environment !== "string" ||
        request.environment.trim().length === 0
      ) {
        return {
          ok: false,
          error: createValidationError(
            `QA action "${request.action}" requires an environment to be specified`
          )
        };
      }

      const allowedEnvs =
        request.authorizedEnvironments ?? [
          "test",
          "ci",
          "qa-sandbox",
          "local-test"
        ];
      if (
        request.environment.toLowerCase().includes("prod") ||
        !allowedEnvs.includes(request.environment)
      ) {
        return {
          ok: false,
          error: createValidationError(
            `QA role is not authorized to execute tests in environment "${request.environment}"`
          )
        };
      }

      return {
        ok: true,
        value: {
          authorized: true,
          role: "qa",
          action: request.action,
          readOnly: true,
          verifiedEnvironment: request.environment,
          requiresHumanApproval: false,
          humanApprovalVerified: false,
          reason: `QA role authorized to perform "${request.action}" in environment "${request.environment}"`
        }
      };
    }

    return {
      ok: true,
      value: {
        authorized: true,
        role: "qa",
        action: request.action,
        readOnly: true,
        requiresHumanApproval: false,
        humanApprovalVerified: false,
        reason: `QA role authorized to perform read-only action "${request.action}"`
      }
    };
  }

  // Delivery role constraints
  if (request.role === "delivery") {
    if (
      request.action === "merge_branch" ||
      request.action === "deploy_release"
    ) {
      if (
        !request.automatedGateResults ||
        !Array.isArray(request.automatedGateResults) ||
        request.automatedGateResults.length === 0
      ) {
        return {
          ok: false,
          error: createValidationError(
            `Delivery action "${request.action}" requires automated quality gate results`
          )
        };
      }

      for (const gate of request.automatedGateResults) {
        const parsed = QualityGateResultSchema.safeParse(gate);
        if (!parsed.success) {
          return {
            ok: false,
            error: createValidationError(
              `Invalid quality gate result for "${gate?.gateId}": ${parsed.error.message}`
            )
          };
        }
        if (gate.status !== "passed") {
          return {
            ok: false,
            error: createValidationError(
              `Cannot authorize delivery action "${request.action}": automated quality gate "${gate.gateId}" has status "${gate.status}"`
            )
          };
        }
      }

      if (!request.humanApprovalDecision) {
        return {
          ok: false,
          error: createValidationError(
            `Delivery action "${request.action}" requires mandatory human approval in addition to automated quality gates`
          )
        };
      }

      const decisionParsed = ApprovalDecisionSchema.safeParse(
        request.humanApprovalDecision
      );
      if (!decisionParsed.success) {
        return {
          ok: false,
          error: createValidationError(
            `Invalid human approval decision: ${decisionParsed.error.message}`
          )
        };
      }

      const decision = request.humanApprovalDecision;
      if (decision.decision !== "approved") {
        return {
          ok: false,
          error: createValidationError(
            `Delivery action "${request.action}" requires an approved decision, but received "${decision.decision}"`
          )
        };
      }

      if (
        !isHumanApprover(decision.decidedBy) ||
        decision.metadata?.automatedOnly === true
      ) {
        return {
          ok: false,
          error: createValidationError(
            `Mandatory human approval cannot be satisfied by an automated or AI agent actor "${decision.decidedBy}"`
          )
        };
      }

      return {
        ok: true,
        value: {
          authorized: true,
          role: "delivery",
          action: request.action,
          readOnly: false,
          requiresHumanApproval: true,
          humanApprovalVerified: true,
          reason: `Delivery action "${request.action}" authorized with verified automated quality gates and valid human approval`
        }
      };
    }

    return {
      ok: true,
      value: {
        authorized: true,
        role: "delivery",
        action: request.action,
        readOnly: true,
        requiresHumanApproval: false,
        humanApprovalVerified: false,
        reason: "Delivery role authorized to perform read-only action \"read_code\""
      }
    };
  }

  return {
    ok: false,
    error: createValidationError(`Unhandled role "${request.role}"`)
  };
}

export interface GovernanceEvaluationInput {
  readonly runId: string;
  readonly taskId?: string;
  readonly automatedGateResults: readonly QualityGateResult[];
  readonly requiresHumanApproval: boolean;
  readonly approvalRequest?: ApprovalRequest;
  readonly humanApprovalDecision?: ApprovalDecision;
}

export interface GovernanceEvaluationResult {
  readonly automatedChecksStatus: "passed" | "failed" | "blocked" | "error";
  readonly allAutomatedGatesPassed: boolean;
  readonly requiresHumanApproval: boolean;
  readonly humanApprovalStatus: "not_required" | "pending" | "approved" | "rejected";
  readonly humanApproverId?: string;
  readonly canProceedToDelivery: boolean;
  readonly summary: string;
}

export function evaluateAutomatedVsHumanGovernance(
  input: GovernanceEvaluationInput
): OperationResult<GovernanceEvaluationResult> {
  if (!input || typeof input !== "object") {
    return {
      ok: false,
      error: createValidationError("Governance evaluation input must be an object")
    };
  }

  const runIdParsed = IdentifierSchema.safeParse(input.runId);
  if (!runIdParsed.success) {
    return {
      ok: false,
      error: createValidationError(`Invalid runId: ${runIdParsed.error.message}`)
    };
  }

  if (input.taskId !== undefined) {
    const taskIdParsed = IdentifierSchema.safeParse(input.taskId);
    if (!taskIdParsed.success) {
      return {
        ok: false,
        error: createValidationError(
          `Invalid taskId: ${taskIdParsed.error.message}`
        )
      };
    }
  }

  if (
    !Array.isArray(input.automatedGateResults) ||
    input.automatedGateResults.length === 0
  ) {
    return {
      ok: false,
      error: createValidationError(
        "Governance evaluation requires at least one automated quality gate result"
      )
    };
  }

  for (const gate of input.automatedGateResults) {
    const gateParsed = QualityGateResultSchema.safeParse(gate);
    if (!gateParsed.success) {
      return {
        ok: false,
        error: createValidationError(
          `Invalid quality gate result for "${gate?.gateId}": ${gateParsed.error.message}`
        )
      };
    }
  }

  const statuses = input.automatedGateResults.map(g => g.status);
  let automatedChecksStatus: "passed" | "failed" | "blocked" | "error";
  if (statuses.includes("error")) {
    automatedChecksStatus = "error";
  } else if (statuses.includes("blocked")) {
    automatedChecksStatus = "blocked";
  } else if (statuses.includes("failed")) {
    automatedChecksStatus = "failed";
  } else {
    automatedChecksStatus = "passed";
  }

  const allAutomatedGatesPassed = automatedChecksStatus === "passed";

  let humanApprovalStatus: "not_required" | "pending" | "approved" | "rejected";
  let humanApproverId: string | undefined = undefined;

  if (!input.requiresHumanApproval) {
    humanApprovalStatus = "not_required";
  } else if (!input.humanApprovalDecision) {
    humanApprovalStatus = "pending";
  } else {
    const decisionParsed = ApprovalDecisionSchema.safeParse(
      input.humanApprovalDecision
    );
    if (!decisionParsed.success) {
      return {
        ok: false,
        error: createValidationError(
          `Invalid human approval decision: ${decisionParsed.error.message}`
        )
      };
    }

    const dec = input.humanApprovalDecision;
    if (dec.runId !== input.runId) {
      return {
        ok: false,
        error: createValidationError(
          `Approval decision runId "${dec.runId}" does not match governance runId "${input.runId}"`
        )
      };
    }

    if (
      input.taskId !== undefined &&
      dec.target.type === "task" &&
      dec.target.taskId !== input.taskId
    ) {
      return {
        ok: false,
        error: createValidationError(
          `Approval decision target taskId "${dec.target.taskId}" does not match governance taskId "${input.taskId}"`
        )
      };
    }

    if (input.approvalRequest !== undefined) {
      const reqParsed = ApprovalRequestSchema.safeParse(input.approvalRequest);
      if (!reqParsed.success) {
        return {
          ok: false,
          error: createValidationError(
            `Invalid approval request: ${reqParsed.error.message}`
          )
        };
      }
      if (dec.approvalId !== input.approvalRequest.approvalId) {
        return {
          ok: false,
          error: createValidationError(
            `Approval decision approvalId "${dec.approvalId}" does not match request approvalId "${input.approvalRequest.approvalId}"`
          )
        };
      }
    }

    if (
      !isHumanApprover(dec.decidedBy) ||
      dec.metadata?.automatedOnly === true
    ) {
      return {
        ok: false,
        error: createValidationError(
          "Mandatory human approval cannot be satisfied by an automated or AI agent actor"
        )
      };
    }

    humanApproverId = dec.decidedBy;
    humanApprovalStatus = dec.decision === "approved" ? "approved" : "rejected";
  }

  const canProceedToDelivery =
    allAutomatedGatesPassed &&
    (!input.requiresHumanApproval || humanApprovalStatus === "approved");

  const summary = `Governance evaluation completed: automated gates [${automatedChecksStatus}] (${input.automatedGateResults.length} gates), human approval [${humanApprovalStatus}]. Proceed to delivery: ${canProceedToDelivery ? "ALLOWED" : "DISALLOWED"}. Automated quality checks and human approvals are separate, independent governance controls.`;

  return {
    ok: true,
    value: {
      automatedChecksStatus,
      allAutomatedGatesPassed,
      requiresHumanApproval: input.requiresHumanApproval,
      humanApprovalStatus,
      ...(humanApproverId !== undefined ? { humanApproverId } : {}),
      canProceedToDelivery,
      summary
    }
  };
}
