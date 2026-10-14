import { createHash } from "node:crypto";
import {
  ArtifactReferenceSchema,
  type AgentConfiguration,
  type AgentResult,
  type ApprovalDecision,
  type ArtifactProposal,
  type ArtifactReference,
  type ArtifactStore,
  type OperationResult,
  type QualityGateResult,
  type WorkflowDefinition
} from "@ai-flow/contracts";
import { createDefaultMvpConfigurations } from "./roles.js";
import { renderRolePrompt, type RenderedRolePrompt } from "./prompts.js";
import {
  validateRoleOutput,
  toContractAgentResult,
  toContractApprovalDecision,
  toContractQualityGateResult,
  type PlannerOutput,
  type DeveloperOutput,
  type ReviewerOutput,
  type QaOutput
} from "./outputs.js";
import {
  createRoleArtifactHandoff,
  ingestRoleArtifactProposals,
  type RoleArtifactHandoff
} from "./handoff.js";
import { createFeatureWorkflowDefinition } from "./workflows.js";

export interface CompleteFeatureWorkflowExample {
  readonly runId: string;
  readonly configurations: readonly AgentConfiguration[];
  readonly workflow: WorkflowDefinition;
  readonly stages: {
    readonly planner: {
      readonly prompt: RenderedRolePrompt;
      readonly rawOutput: unknown;
      readonly validatedOutput: PlannerOutput;
      readonly agentResult: AgentResult;
      readonly proposal: ArtifactProposal;
      readonly storedReference: ArtifactReference;
    };
    readonly developer: {
      readonly handoff: RoleArtifactHandoff;
      readonly prompt: RenderedRolePrompt;
      readonly rawOutput: unknown;
      readonly validatedOutput: DeveloperOutput;
      readonly agentResult: AgentResult;
      readonly patchProposal: ArtifactProposal;
      readonly storedPatchReference: ArtifactReference;
      readonly testReportProposal: ArtifactProposal;
      readonly storedTestReportReference: ArtifactReference;
    };
    readonly reviewer: {
      readonly handoff: RoleArtifactHandoff;
      readonly prompt: RenderedRolePrompt;
      readonly rawOutput: unknown;
      readonly validatedOutput: ReviewerOutput;
      readonly agentResult: AgentResult;
      readonly approvalDecision: ApprovalDecision;
      readonly reviewReportProposal: ArtifactProposal;
      readonly storedReviewReportReference: ArtifactReference;
    };
    readonly qa: {
      readonly handoff: RoleArtifactHandoff;
      readonly prompt: RenderedRolePrompt;
      readonly rawOutput: unknown;
      readonly validatedOutput: QaOutput;
      readonly agentResult: AgentResult;
      readonly qualityGateResult: QualityGateResult;
      readonly qaReportProposal: ArtifactProposal;
      readonly storedQaReportReference: ArtifactReference;
    };
  };
}

async function resolveOrStoreProposals(
  proposals: readonly ArtifactProposal[],
  contentByProposalId: Readonly<Record<string, Uint8Array | string>>,
  store?: ArtifactStore
): Promise<OperationResult<readonly ArtifactReference[]>> {
  if (store) {
    return ingestRoleArtifactProposals(store, proposals, contentByProposalId);
  }
  const references: ArtifactReference[] = [];
  for (const proposal of proposals) {
    const raw = contentByProposalId[proposal.proposalId];
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    if (!bytes) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Missing content for proposal '${proposal.proposalId}'`
        }
      };
    }
    const parsed = ArtifactReferenceSchema.safeParse({
      trust: "stored",
      artifactId: proposal.proposalId,
      runId: proposal.runId,
      ...(proposal.taskId !== undefined ? { taskId: proposal.taskId } : {}),
      kind: proposal.kind,
      uri: `artifact://local/${proposal.proposalId}`,
      mediaType: proposal.mediaType,
      sizeBytes: bytes.byteLength,
      checksum: proposal.expectedIntegrity.checksum,
      createdAt: "2026-01-01T00:00:30.000Z",
      ...(proposal.metadata !== undefined ? { metadata: proposal.metadata } : {})
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: parsed.error.message
        }
      };
    }
    references.push(parsed.data);
  }
  return { ok: true, value: references };
}

export async function buildCompleteFeatureWorkflowExample(
  store?: ArtifactStore
): Promise<OperationResult<CompleteFeatureWorkflowExample>> {
  const configsRes = createDefaultMvpConfigurations();
  if (!configsRes.ok) {
    return configsRes;
  }

  const workflowRes = createFeatureWorkflowDefinition();
  if (!workflowRes.ok) {
    return workflowRes;
  }
  const workflow = workflowRes.value;
  const runId = "feature-run-001";

  // Stage 1: Planner
  const planPromptRes = renderRolePrompt("planner", {
    runId,
    workflowKind: "feature",
    requirement: "Implement JWT user authentication with token generation and verification.",
    repositoryContext: "Clean TypeScript SDLC workspace with contracts and agent registry."
  });
  if (!planPromptRes.ok) {
    return planPromptRes;
  }

  const specContent = `# Feature Specification: JWT Authentication\n\n## Tasks\n1. Implement JWT auth\n2. Add tests`;
  const specBytes = Buffer.from(specContent, "utf8");
  const specSha256 = createHash("sha256").update(specBytes).digest("hex");

  const planProposal: ArtifactProposal = {
    proposalId: "plan-spec-artifact",
    runId,
    taskId: "plan",
    kind: "document",
    logicalName: "feature-spec.md",
    mediaType: "text/markdown",
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: specSha256 },
      sizeBytes: specBytes.byteLength
    }
  };

  const planIngestRes = await resolveOrStoreProposals(
    [planProposal],
    { [planProposal.proposalId]: specBytes },
    store
  );
  if (!planIngestRes.ok) {
    return planIngestRes;
  }
  const storedPlanReference = planIngestRes.value[0]!;

  const rawPlannerOutput = {
    role: "planner",
    summary: "Authentication feature plan with 2 implementation tasks and verification gates.",
    tasks: [
      {
        id: "implement",
        title: "Implement Feature",
        role: "developer" as const,
        instruction: "Implement feature code in worktree with tests.",
        acceptanceCriteria: ["Feature implemented according to plan", "Unit tests pass in worktree"]
      },
      {
        id: "review",
        title: "Review Feature Implementation",
        role: "reviewer" as const,
        instruction: "Perform code and architecture review on the implemented feature.",
        acceptanceCriteria: ["Code quality verified", "No high/error findings"],
        requiresApproval: true
      },
      {
        id: "qa",
        title: "QA Verification",
        role: "qa" as const,
        instruction: "Execute independent verification and automated tests.",
        acceptanceCriteria: [
          "Automated tests execute and pass independently",
          "All acceptance criteria verified"
        ]
      }
    ],
    dependencies: [
      { taskId: "review", dependsOnTaskId: "implement", condition: "succeeded" as const },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" as const }
    ],
    consumedArtifactIds: [],
    artifactProposals: [planProposal]
  };

  const validatedPlannerRes = validateRoleOutput("planner", rawPlannerOutput, {
    runId,
    expectedTaskId: "plan"
  });
  if (!validatedPlannerRes.ok) {
    return validatedPlannerRes;
  }

  const plannerAgentResultRes = toContractAgentResult(validatedPlannerRes.value, {
    requestId: "req-planner-01",
    attemptId: "att-planner-01",
    runId,
    taskId: "plan",
    executionId: "exec-planner-01",
    correlation: { token: "token-plan-01", provenance: "transport", verified: true },
    evidence: "Plan generated with 3 tasks and 2 dependencies",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z"
  });
  if (!plannerAgentResultRes.ok) {
    return plannerAgentResultRes;
  }

  // Stage 2: Developer
  const devHandoffRes = createRoleArtifactHandoff({
    runId,
    fromRole: "planner",
    toRole: "developer",
    fromTaskId: "plan",
    toTaskId: "implement",
    artifacts: [storedPlanReference]
  });
  if (!devHandoffRes.ok) {
    return devHandoffRes;
  }
  const devHandoff = devHandoffRes.value;

  const devPromptRes = renderRolePrompt("developer", {
    runId,
    taskId: "implement",
    taskTitle: "Implement Feature",
    taskDescription: "Implement JWT authentication module in isolated worktree",
    instruction: "Implement JWT authentication module with unit tests in assigned worktree.",
    acceptanceCriteria: ["Feature implemented according to plan", "Unit tests pass in worktree"],
    worktreePath: "worktrees/run-001/implement",
    branchName: "feat/jwt-auth",
    inputArtifacts: devHandoff.references
  });
  if (!devPromptRes.ok) {
    return devPromptRes;
  }

  const patchContent = "diff --git a/src/auth.ts b/src/auth.ts\nnew file mode 100644\n...";
  const patchBytes = Buffer.from(patchContent, "utf8");
  const patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
  const patchProposal: ArtifactProposal = {
    proposalId: "dev-patch-artifact",
    runId,
    taskId: "implement",
    kind: "patch",
    logicalName: "jwt-auth.patch",
    mediaType: "text/x-diff",
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: patchSha256 },
      sizeBytes: patchBytes.byteLength
    }
  };

  const devReportContent = JSON.stringify({ passed: 12, failed: 0 });
  const devReportBytes = Buffer.from(devReportContent, "utf8");
  const devReportSha256 = createHash("sha256").update(devReportBytes).digest("hex");
  const devReportProposal: ArtifactProposal = {
    proposalId: "dev-test-report-artifact",
    runId,
    taskId: "implement",
    kind: "test-result",
    logicalName: "unit-tests.json",
    mediaType: "application/json",
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: devReportSha256 },
      sizeBytes: devReportBytes.byteLength
    }
  };

  const devIngestRes = await resolveOrStoreProposals(
    [patchProposal, devReportProposal],
    {
      [patchProposal.proposalId]: patchBytes,
      [devReportProposal.proposalId]: devReportBytes
    },
    store
  );
  if (!devIngestRes.ok) {
    return devIngestRes;
  }
  const [storedPatchReference, storedDevReportReference] = devIngestRes.value;
  if (!storedPatchReference || !storedDevReportReference) {
    return {
      ok: false,
      error: { code: "corruption", retryable: false, message: "Expected 2 stored developer artifacts" }
    };
  }

  const rawDevOutput = {
    role: "developer",
    taskId: "implement",
    worktreePath: "worktrees/run-001/implement",
    commit: {
      sha: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4",
      message: "feat: implement JWT authentication and unit tests",
      branch: "feat/jwt-auth"
    },
    changedFiles: [
      { path: "src/auth.ts", changeType: "added" as const },
      { path: "test/auth.test.ts", changeType: "added" as const }
    ],
    testReport: {
      command: "pnpm test:unit",
      exitCode: 0,
      passed: 12,
      failed: 0,
      skipped: 0,
      selfReportedOnly: true as const,
      evidenceArtifactName: "unit-tests.json"
    },
    consumedArtifactIds: [storedPlanReference.artifactId],
    artifactProposals: [patchProposal, devReportProposal]
  };

  const validatedDevRes = validateRoleOutput("developer", rawDevOutput, {
    runId,
    expectedTaskId: "implement",
    assignedWorktreePath: "worktrees/run-001/implement",
    availableInputArtifacts: devHandoff.references
  });
  if (!validatedDevRes.ok) {
    return validatedDevRes;
  }

  const devAgentResultRes = toContractAgentResult(validatedDevRes.value, {
    requestId: "req-developer-01",
    attemptId: "att-developer-01",
    runId,
    taskId: "implement",
    executionId: "exec-developer-01",
    correlation: { token: "token-dev-01", provenance: "transport", verified: true },
    evidence: "Committed git SHA a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4 with 12 passing unit tests",
    startedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:02:00.000Z"
  });
  if (!devAgentResultRes.ok) {
    return devAgentResultRes;
  }

  // Stage 3: Reviewer
  const reviewerHandoffRes = createRoleArtifactHandoff({
    runId,
    fromRole: "developer",
    toRole: "reviewer",
    fromTaskId: "implement",
    toTaskId: "review",
    artifacts: [storedPatchReference, storedDevReportReference]
  });
  if (!reviewerHandoffRes.ok) {
    return reviewerHandoffRes;
  }
  const reviewerHandoff = reviewerHandoffRes.value;

  const reviewerPromptRes = renderRolePrompt("reviewer", {
    runId,
    taskId: "review",
    taskTitle: "Review Feature Implementation",
    acceptanceCriteria: ["Code quality verified", "No high/error findings"],
    commitSha: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4",
    changedFiles: ["src/auth.ts", "test/auth.test.ts"],
    diffSummary: "Added authentication service, token validator, and test suites.",
    inputArtifacts: reviewerHandoff.references
  });
  if (!reviewerPromptRes.ok) {
    return reviewerPromptRes;
  }

  const reviewReportContent = "# Code Review: Approved\nAll acceptance criteria met.";
  const reviewReportBytes = Buffer.from(reviewReportContent, "utf8");
  const reviewReportSha256 = createHash("sha256").update(reviewReportBytes).digest("hex");
  const reviewReportProposal: ArtifactProposal = {
    proposalId: "reviewer-report-artifact",
    runId,
    taskId: "review",
    kind: "report",
    logicalName: "review-summary.md",
    mediaType: "text/markdown",
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: reviewReportSha256 },
      sizeBytes: reviewReportBytes.byteLength
    }
  };

  const reviewIngestRes = await resolveOrStoreProposals(
    [reviewReportProposal],
    { [reviewReportProposal.proposalId]: reviewReportBytes },
    store
  );
  if (!reviewIngestRes.ok) {
    return reviewIngestRes;
  }
  const storedReviewReportReference = reviewIngestRes.value[0]!;

  const rawReviewerOutput = {
    role: "reviewer",
    taskId: "review",
    decision: "approved" as const,
    summary: "Authentication changes are well modularized and meet all security criteria.",
    criteriaEvaluation: [
      {
        criterion: "Code quality verified",
        met: true,
        evidence: "Adheres to contracts and error handling conventions"
      },
      {
        criterion: "No high/error findings",
        met: true,
        evidence: "Only 1 info finding regarding configurable token expiry"
      }
    ],
    findings: [
      {
        category: "maintainability" as const,
        severity: "info" as const,
        message: "Token expiry is hardcoded to 1 hour; consider making it configurable.",
        file: "src/auth.ts",
        line: 25,
        evidence: "const TOKEN_EXPIRY = 3600;"
      }
    ],
    modifiedFiles: [],
    consumedArtifactIds: [storedPatchReference.artifactId],
    artifactProposals: [reviewReportProposal]
  };

  const validatedReviewerRes = validateRoleOutput("reviewer", rawReviewerOutput, {
    runId,
    expectedTaskId: "review",
    availableInputArtifacts: reviewerHandoff.references,
    expectedAcceptanceCriteria: ["Code quality verified", "No high/error findings"]
  });
  if (!validatedReviewerRes.ok) {
    return validatedReviewerRes;
  }

  const reviewerAgentResultRes = toContractAgentResult(validatedReviewerRes.value, {
    requestId: "req-reviewer-01",
    attemptId: "att-reviewer-01",
    runId,
    taskId: "review",
    executionId: "exec-reviewer-01",
    correlation: { token: "token-rev-01", provenance: "transport", verified: true },
    evidence: "Review approved with 0 error findings",
    startedAt: "2026-01-01T00:02:00.000Z",
    completedAt: "2026-01-01T00:03:00.000Z"
  });
  if (!reviewerAgentResultRes.ok) {
    return reviewerAgentResultRes;
  }

  const approvalDecisionRes = toContractApprovalDecision(validatedReviewerRes.value, {
    approvalId: "approval-review-01",
    runId,
    taskId: "review",
    revision: 1,
    generation: 0,
    decidedBy: "agent:reviewer",
    decidedAt: "2026-01-01T00:03:00.000Z",
    feedbackArtifacts: [storedReviewReportReference],
    idempotencyKey: "idemp-approval-review-01"
  });
  if (!approvalDecisionRes.ok) {
    return approvalDecisionRes;
  }

  // Stage 4: QA
  const qaTestLogContent = "PASS test/auth.test.ts (15 tests passed, 0 failed)\nDone in 2.15s.";
  const qaTestLogBytes = Buffer.from(qaTestLogContent, "utf8");
  const qaTestLogSha256 = createHash("sha256").update(qaTestLogBytes).digest("hex");
  const qaTestLogProposal: ArtifactProposal = {
    proposalId: "qa-test-log-artifact",
    runId,
    taskId: "qa",
    kind: "log",
    logicalName: "independent-test.log",
    mediaType: "text/plain",
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: qaTestLogSha256 },
      sizeBytes: qaTestLogBytes.byteLength
    }
  };

  const qaTestLogIngestRes = await resolveOrStoreProposals(
    [qaTestLogProposal],
    { [qaTestLogProposal.proposalId]: qaTestLogBytes },
    store
  );
  if (!qaTestLogIngestRes.ok) {
    return qaTestLogIngestRes;
  }
  const storedTestLogReference = qaTestLogIngestRes.value[0]!;

  const qaHandoffRes = createRoleArtifactHandoff({
    runId,
    fromRole: "reviewer",
    toRole: "qa",
    fromTaskId: "review",
    toTaskId: "qa",
    artifacts: [storedReviewReportReference, storedTestLogReference]
  });
  if (!qaHandoffRes.ok) {
    return qaHandoffRes;
  }
  const qaHandoff = qaHandoffRes.value;

  const qaPromptRes = renderRolePrompt("qa", {
    runId,
    taskId: "qa",
    taskTitle: "QA Verification",
    acceptanceCriteria: [
      "Automated tests execute and pass independently",
      "All acceptance criteria verified"
    ],
    testExecutionSummary: "Run end-to-end authentication test suite in independent test environment.",
    inputArtifacts: qaHandoff.references
  });
  if (!qaPromptRes.ok) {
    return qaPromptRes;
  }

  const qaReportContent = "# QA Verdict: Passed\nAll 15 tests passed in isolated container.";
  const qaReportBytes = Buffer.from(qaReportContent, "utf8");
  const qaReportSha256 = createHash("sha256").update(qaReportBytes).digest("hex");
  const qaReportProposal: ArtifactProposal = {
    proposalId: "qa-report-artifact",
    runId,
    taskId: "qa",
    kind: "report",
    logicalName: "qa-summary.md",
    mediaType: "text/markdown",
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: qaReportSha256 },
      sizeBytes: qaReportBytes.byteLength
    }
  };

  const qaReportIngestRes = await resolveOrStoreProposals(
    [qaReportProposal],
    { [qaReportProposal.proposalId]: qaReportBytes },
    store
  );
  if (!qaReportIngestRes.ok) {
    return qaReportIngestRes;
  }
  const storedQaReportReference = qaReportIngestRes.value[0]!;

  const rawQaOutput = {
    role: "qa",
    taskId: "qa",
    verdict: "passed" as const,
    summary: "Independent verification completed: all 15 automated test cases passed.",
    criteriaVerification: [
      {
        criterion: "Automated tests execute and pass independently",
        passed: true,
        evidence: "Independent test run completed with exitCode 0"
      },
      {
        criterion: "All acceptance criteria verified",
        passed: true,
        evidence: "Verified login, logout, token generation, and expiry checks"
      }
    ],
    testVerification: {
      independentRunVerified: true,
      command: "pnpm test:e2e",
      exitCode: 0,
      passedCount: 15,
      failedCount: 0,
      skippedCount: 0,
      evidence: "Independent run completed with exitCode 0, verified via test log",
      evidenceArtifactIds: [storedTestLogReference.artifactId]
    },
    consumedArtifactIds: [storedReviewReportReference.artifactId, storedTestLogReference.artifactId],
    artifactProposals: [qaReportProposal]
  };

  const validatedQaRes = validateRoleOutput("qa", rawQaOutput, {
    runId,
    expectedTaskId: "qa",
    availableInputArtifacts: qaHandoff.references,
    expectedAcceptanceCriteria: [
      "Automated tests execute and pass independently",
      "All acceptance criteria verified"
    ]
  });
  if (!validatedQaRes.ok) {
    return validatedQaRes;
  }

  const qaAgentResultRes = toContractAgentResult(validatedQaRes.value, {
    requestId: "req-qa-01",
    attemptId: "att-qa-01",
    runId,
    taskId: "qa",
    executionId: "exec-qa-01",
    correlation: { token: "token-qa-01", provenance: "transport", verified: true },
    evidence: "Independent test suite verified: 15 passed, 0 failed",
    startedAt: "2026-01-01T00:03:00.000Z",
    completedAt: "2026-01-01T00:04:00.000Z"
  });
  if (!qaAgentResultRes.ok) {
    return qaAgentResultRes;
  }

  const qualityGateResultRes = toContractQualityGateResult(validatedQaRes.value, {
    gateId: "qa-gate",
    runId,
    taskId: "qa",
    evaluationId: "eval-qa-gate-01",
    evaluatedAt: "2026-01-01T00:04:00.000Z"
  });
  if (!qualityGateResultRes.ok) {
    return qualityGateResultRes;
  }

  return {
    ok: true,
    value: {
      runId,
      configurations: configsRes.value,
      workflow,
      stages: {
        planner: {
          prompt: planPromptRes.value,
          rawOutput: rawPlannerOutput,
          validatedOutput: validatedPlannerRes.value,
          agentResult: plannerAgentResultRes.value,
          proposal: planProposal,
          storedReference: storedPlanReference
        },
        developer: {
          handoff: devHandoff,
          prompt: devPromptRes.value,
          rawOutput: rawDevOutput,
          validatedOutput: validatedDevRes.value,
          agentResult: devAgentResultRes.value,
          patchProposal,
          storedPatchReference,
          testReportProposal: devReportProposal,
          storedTestReportReference: storedDevReportReference
        },
        reviewer: {
          handoff: reviewerHandoff,
          prompt: reviewerPromptRes.value,
          rawOutput: rawReviewerOutput,
          validatedOutput: validatedReviewerRes.value,
          agentResult: reviewerAgentResultRes.value,
          approvalDecision: approvalDecisionRes.value,
          reviewReportProposal,
          storedReviewReportReference
        },
        qa: {
          handoff: qaHandoff,
          prompt: qaPromptRes.value,
          rawOutput: rawQaOutput,
          validatedOutput: validatedQaRes.value,
          agentResult: qaAgentResultRes.value,
          qualityGateResult: qualityGateResultRes.value,
          qaReportProposal,
          storedQaReportReference
        }
      }
    }
  };
}
