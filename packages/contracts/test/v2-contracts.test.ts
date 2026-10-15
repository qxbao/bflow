import { describe, expect, it } from "vitest";
import {
  AcceptanceCriterionSchema,
  AgentAssignmentSchema,
  AgentCapabilitySchema,
  AgentRoleProfileSchema,
  AgentRoleSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ApprovalStatusSchema,
  ApprovalTargetSchema,
  ChangeClassificationSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  ConversationSessionStatusSchema,
  DelegationRequestSchema,
  GitChangeSetSchema,
  GitChangedFileSchema,
  InterRoleMessageSchema,
  PaneBindingSchema,
  RecoveryCheckpointSchema,
  RoleMessageSchema,
  SddPolicyLevelSchema,
  SdlcRecoveryContextSchema,
  SdlcWorkStatusSchema,
  SessionManifestSchema,
  SessionManifestStatusSchema,
  SpecificationSchema,
  TddDecisionSchema,
  TddModeSchema,
  TestStrategySchema,
  VerificationCycleSchema,
  VerificationCycleStatusSchema,
  VerificationEscalationSchema,
  VerificationResultSchema,
  WorkflowAggregateCheckpointStateSchema
} from "../src/index.js";
import { artifactReference, later, now } from "./fixtures.js";

const runId = "run-1";
const specId = "spec-1";
const taskId = "task-1";
const sessionId = "session-1";

const patchArtifact = {
  ...artifactReference,
  artifactId: "patch-1",
  kind: "patch" as const,
  uri: "artifact://local/patch-1"
};

const evidenceArtifact = {
  ...artifactReference,
  artifactId: "evidence-1",
  kind: "test-result" as const,
  uri: "artifact://local/evidence-1"
};

const validAcceptanceCriterion = {
  id: "ac-1",
  description: "Must return 200 OK on valid request",
  category: "functional" as const,
  verificationMethod: "unit_test" as const,
  required: true,
  status: "satisfied" as const,
  evidenceArtifactIds: [evidenceArtifact.artifactId]
};

const validTddDecision = {
  schemaVersion: 2 as const,
  decisionId: "tdd-dec-1",
  runId,
  specId,
  mode: "required" as const,
  rationale: "Core business calculations must be test-driven with unit assertions",
  verifiableConditions: ["Unit tests exist", "All edge cases pass"],
  changeClassification: "domain_logic" as const,
  requiresFailingTestFirst: true,
  decidedBy: "coordinator" as const,
  decidedAt: now
};

const validTestStrategy = {
  schemaVersion: 2 as const,
  strategyId: "strat-1",
  specId,
  tddDecision: validTddDecision,
  requiredTestLevels: ["unit" as const, "integration" as const],
  targetCommands: ["pnpm test"],
  coverageThresholdPercent: 90,
  independentVerificationRequired: true as const,
  criterionMappings: [{ criterionId: "ac-1", testNames: ["calc test 1"] }],
  createdAt: now
};

describe("SDLC 4 Distinct State Domains", () => {
  it("validates all SdlcWorkStatus values", () => {
    const statuses = [
      "intake",
      "clarifying",
      "specifying",
      "planning",
      "tdd_deciding",
      "implementing",
      "verifying",
      "reviewing",
      "awaiting_approval",
      "completed",
      "escalated",
      "failed",
      "cancelled"
    ];
    statuses.forEach((s) => {
      expect(SdlcWorkStatusSchema.parse(s)).toBe(s);
    });
    expect(SdlcWorkStatusSchema.safeParse("invalid_status").success).toBe(false);
  });

  it("validates all ConversationSessionStatus values", () => {
    const statuses = [
      "active",
      "awaiting_user_clarification",
      "delegated_to_coordinator",
      "reporting_progress",
      "awaiting_user_approval",
      "completed",
      "paused",
      "closed",
      "archived"
    ];
    statuses.forEach((s) => {
      expect(ConversationSessionStatusSchema.parse(s)).toBe(s);
    });
    expect(ConversationSessionStatusSchema.safeParse("unknown").success).toBe(false);
  });

  it("validates all VerificationCycle status values", () => {
    const statuses = ["in_progress", "passed", "rework_required", "escalated", "aborted"];
    statuses.forEach((s) => {
      expect(VerificationCycleStatusSchema.parse(s)).toBe(s);
    });
    expect(VerificationCycleStatusSchema.safeParse("done").success).toBe(false);
  });

  it("validates all SessionManifest status values", () => {
    const statuses = ["initializing", "up", "degraded", "stopping", "down"];
    statuses.forEach((s) => {
      expect(SessionManifestStatusSchema.parse(s)).toBe(s);
    });
    expect(SessionManifestStatusSchema.safeParse("crashed").success).toBe(false);
  });
});

describe("AcceptanceCriterionSchema", () => {
  it("accepts valid criterion with evidence artifact", () => {
    expect(AcceptanceCriterionSchema.parse(validAcceptanceCriterion)).toEqual(validAcceptanceCriterion);
  });

  it("rejects satisfied criterion without evidence artifacts when method is not manual_review", () => {
    expect(
      AcceptanceCriterionSchema.safeParse({
        ...validAcceptanceCriterion,
        status: "satisfied",
        verificationMethod: "unit_test",
        evidenceArtifactIds: []
      }).success
    ).toBe(false);
  });

  it("allows satisfied criterion without evidence artifacts if verificationMethod is manual_review", () => {
    expect(
      AcceptanceCriterionSchema.safeParse({
        ...validAcceptanceCriterion,
        status: "satisfied",
        verificationMethod: "manual_review",
        evidenceArtifactIds: []
      }).success
    ).toBe(true);
  });

  it("requires waiverReason when status is waived", () => {
    expect(
      AcceptanceCriterionSchema.safeParse({
        ...validAcceptanceCriterion,
        status: "waived",
        waiverReason: undefined
      }).success
    ).toBe(false);

    expect(
      AcceptanceCriterionSchema.safeParse({
        ...validAcceptanceCriterion,
        status: "waived",
        waiverReason: "Feature postponed to next quarter"
      }).success
    ).toBe(true);
  });
});

describe("Conditional TDD & TestStrategy", () => {
  it("enforces requiresFailingTestFirst = true when mode is required", () => {
    expect(
      TddDecisionSchema.safeParse({
        ...validTddDecision,
        mode: "required",
        requiresFailingTestFirst: false
      }).success
    ).toBe(false);
  });

  it("rejects requiresFailingTestFirst = true when mode is not_applicable", () => {
    expect(
      TddDecisionSchema.safeParse({
        ...validTddDecision,
        mode: "not_applicable",
        requiresFailingTestFirst: true,
        changeClassification: "documentation"
      }).success
    ).toBe(false);
  });

  it("rejects not_applicable for domain_logic without humanOverrideApproved", () => {
    expect(
      TddDecisionSchema.safeParse({
        ...validTddDecision,
        mode: "not_applicable",
        requiresFailingTestFirst: false,
        changeClassification: "domain_logic",
        metadata: {}
      }).success
    ).toBe(false);

    expect(
      TddDecisionSchema.safeParse({
        ...validTddDecision,
        mode: "not_applicable",
        requiresFailingTestFirst: false,
        changeClassification: "domain_logic",
        metadata: { humanOverrideApproved: true }
      }).success
    ).toBe(true);
  });

  it("allows not_applicable for documentation or ui_layout without override", () => {
    expect(
      TddDecisionSchema.safeParse({
        ...validTddDecision,
        mode: "not_applicable",
        requiresFailingTestFirst: false,
        changeClassification: "documentation"
      }).success
    ).toBe(true);
  });

  it("validates TestStrategy matches TddDecision specId", () => {
    expect(
      TestStrategySchema.safeParse({
        ...validTestStrategy,
        specId: "spec-different"
      }).success
    ).toBe(false);
  });

  it("enforces non-empty test levels and target commands when TDD is required", () => {
    expect(
      TestStrategySchema.safeParse({
        ...validTestStrategy,
        requiredTestLevels: []
      }).success
    ).toBe(false);

    expect(
      TestStrategySchema.safeParse({
        ...validTestStrategy,
        targetCommands: []
      }).success
    ).toBe(false);
  });
});

describe("SpecificationSchema: Lightweight vs Full SDD", () => {
  const baseSpec = {
    schemaVersion: 2 as const,
    specId,
    sessionId,
    title: "SDLC Enhancement Spec",
    summary: "Add SDD and TDD workflows",
    problemStatement: "Need strict contracts for autonomous SDLC",
    scope: {
      inScope: ["contracts", "runtime"],
      outOfScope: ["ui"]
    },
    acceptanceCriteria: [validAcceptanceCriterion],
    affectedPaths: ["packages/contracts/src/sdlc.ts"],
    status: "draft" as const,
    createdBy: "coordinator",
    createdAt: now,
    updatedAt: now
  };

  it("accepts minimal specification in lightweight mode", () => {
    const lightweight = {
      ...baseSpec,
      level: "lightweight" as const
    };
    expect(SpecificationSchema.parse(lightweight)).toEqual(lightweight);
  });

  it("rejects full level specification missing architectural / strategy sections", () => {
    expect(
      SpecificationSchema.safeParse({
        ...baseSpec,
        level: "full" as const
      }).success
    ).toBe(false);
  });

  it("accepts full level specification when all required fields are present", () => {
    const fullSpec = {
      ...baseSpec,
      level: "full" as const,
      architectureNotes: "Modular architecture separating session from contracts",
      securityConsiderations: "Enforce boundary checks and path traversal rejection",
      rollbackPlan: "Revert git commit and restore previous package build",
      testStrategy: validTestStrategy,
      tddDecision: validTddDecision
    };
    expect(SpecificationSchema.parse(fullSpec)).toEqual(fullSpec);
  });

  it("rejects duplicate acceptance criteria ids", () => {
    expect(
      SpecificationSchema.safeParse({
        ...baseSpec,
        level: "lightweight" as const,
        acceptanceCriteria: [validAcceptanceCriterion, { ...validAcceptanceCriterion, description: "duplicate id" }]
      }).success
    ).toBe(false);
  });

  it("enforces approvedBy and artifactRef when status is approved", () => {
    expect(
      SpecificationSchema.safeParse({
        ...baseSpec,
        level: "lightweight" as const,
        status: "approved"
      }).success
    ).toBe(false);

    expect(
      SpecificationSchema.safeParse({
        ...baseSpec,
        level: "lightweight" as const,
        status: "approved",
        approvedBy: "human_reviewer",
        artifactRef: {
          ...artifactReference,
          artifactId: "spec-doc-1",
          uri: "artifact://local/spec-doc-1"
        }
      }).success
    ).toBe(true);
  });
});

describe("GitChangeSetSchema", () => {
  const validChangeSet = {
    schemaVersion: 2 as const,
    changeSetId: "cs-1",
    runId,
    taskId,
    attemptId: "att-1",
    worktreePath: "/tmp/worktree",
    branchName: "feature/sdlc-v2",
    baseCommitHash: "0123456789abcdef",
    headCommitHash: "abcdef0123456789",
    dirtyWorkingTree: false,
    filesChanged: [
      {
        path: "packages/contracts/src/sdlc.ts",
        changeType: "added" as const,
        additions: 150,
        deletions: 0
      }
    ],
    patchArtifact,
    createdAt: now
  };

  it("accepts valid changeset", () => {
    expect(GitChangeSetSchema.parse(validChangeSet)).toEqual(validChangeSet);
  });

  it("rejects patchArtifact with kind not equal to patch", () => {
    expect(
      GitChangeSetSchema.safeParse({
        ...validChangeSet,
        patchArtifact: { ...patchArtifact, kind: "report" }
      }).success
    ).toBe(false);
  });

  it("rejects patchArtifact with mismatched runId", () => {
    expect(
      GitChangeSetSchema.safeParse({
        ...validChangeSet,
        patchArtifact: { ...patchArtifact, runId: "other-run" }
      }).success
    ).toBe(false);
  });

  it.each(["/etc/passwd", "../packages/core", "a/../../b"])("rejects unsafe file path %s", (path) => {
    expect(
      GitChangeSetSchema.safeParse({
        ...validChangeSet,
        filesChanged: [
          {
            path,
            changeType: "modified",
            additions: 1,
            deletions: 1
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("VerificationResult & VerificationCycle", () => {
  const validVerificationResult = {
    schemaVersion: 2 as const,
    verificationId: "ver-1",
    runId,
    taskId,
    cycleNumber: 1,
    attemptId: "att-1",
    status: "passed" as const,
    independentExecution: true as const,
    evaluatedCriteria: [
      {
        criterionId: "ac-1",
        passed: true,
        command: "pnpm test",
        exitCode: 0,
        evidenceArtifactId: evidenceArtifact.artifactId,
        summary: "12 tests passed"
      }
    ],
    qualityGateResults: [
      {
        gateId: "qg-tests",
        runId,
        taskId,
        evaluationId: "eval-1",
        status: "passed" as const,
        findings: [],
        producedArtifacts: [],
        evaluatedAt: now
      }
    ],
    evidenceArtifacts: [evidenceArtifact],
    findings: [],
    verifiedBy: "tester" as const,
    startedAt: now,
    completedAt: later
  };

  it("accepts valid verification result", () => {
    expect(VerificationResultSchema.parse(validVerificationResult)).toEqual(validVerificationResult);
  });

  it("rejects verification result when completedAt < startedAt", () => {
    expect(
      VerificationResultSchema.safeParse({
        ...validVerificationResult,
        startedAt: later,
        completedAt: now
      }).success
    ).toBe(false);
  });

  it("rejects when criterion references missing evidence artifact", () => {
    expect(
      VerificationResultSchema.safeParse({
        ...validVerificationResult,
        evaluatedCriteria: [
          {
            ...validVerificationResult.evaluatedCriteria[0],
            evidenceArtifactId: "missing-artifact"
          }
        ]
      }).success
    ).toBe(false);
  });

  it("rejects passed status when a criterion failed or quality gate failed or error finding exists", () => {
    expect(
      VerificationResultSchema.safeParse({
        ...validVerificationResult,
        evaluatedCriteria: [
          {
            ...validVerificationResult.evaluatedCriteria[0],
            passed: false
          }
        ]
      }).success
    ).toBe(false);

    expect(
      VerificationResultSchema.safeParse({
        ...validVerificationResult,
        findings: [
          {
            code: "ERR_SYNTAX",
            severity: "error",
            message: "Syntax error in file"
          }
        ]
      }).success
    ).toBe(false);
  });

  it("validates VerificationCycle iterations and loop limits", () => {
    const cycle = {
      schemaVersion: 2 as const,
      cycleId: "cycle-1",
      runId,
      taskId,
      specId,
      currentIteration: 3,
      maxIterations: 3,
      status: "rework_required" as const,
      tddDecision: validTddDecision,
      history: [{ ...validVerificationResult, status: "failed" as const }],
      startedAt: now,
      updatedAt: later
    };

    // cannot require rework when loop limit is reached and last attempt failed
    expect(VerificationCycleSchema.safeParse(cycle).success).toBe(false);

    // must escalate instead
    expect(
      VerificationCycleSchema.safeParse({
        ...cycle,
        status: "escalated",
        escalation: {
          escalatedAt: later,
          reason: "Max iteration limit reached",
          target: "coordinator",
          evidenceArtifacts: [evidenceArtifact]
        }
      }).success
    ).toBe(true);
  });

  it("requires escalation details when status is escalated", () => {
    expect(
      VerificationCycleSchema.safeParse({
        schemaVersion: 2,
        cycleId: "cycle-1",
        runId,
        taskId,
        specId,
        currentIteration: 1,
        maxIterations: 3,
        status: "escalated",
        tddDecision: validTddDecision,
        history: [],
        startedAt: now,
        updatedAt: later
      }).success
    ).toBe(false);
  });

  it("validates standalone VerificationEscalationSchema", () => {
    const escalation = {
      escalatedAt: now,
      reason: "Iterative rework exhausted threshold",
      target: "coordinator" as const,
      evidenceArtifacts: [evidenceArtifact]
    };
    expect(VerificationEscalationSchema.parse(escalation)).toEqual(escalation);
    expect(VerificationEscalationSchema.safeParse({ ...escalation, evidenceArtifacts: [] }).success).toBe(false);
  });
});

describe("SessionManifest & PaneBinding", () => {
  const conversationPane = {
    schemaVersion: 2 as const,
    bindingId: "bind-conv-1",
    sessionId,
    role: "conversation" as const,
    agentId: "agent-conv-1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    paneId: "pane-1",
    provider: "herdr",
    agentKind: "conversation-v2",
    cwd: "/workspace",
    isolationMode: "dedicated_pane" as const,
    readOnlyWorkspace: false,
    transportState: "idle" as const,
    boundAt: now
  };

  const coordinatorPane = {
    schemaVersion: 2 as const,
    bindingId: "bind-coord-1",
    sessionId,
    role: "coordinator" as const,
    agentId: "agent-coord-1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    paneId: "pane-2",
    provider: "herdr",
    agentKind: "coordinator-v2",
    cwd: "/workspace",
    isolationMode: "dedicated_pane" as const,
    readOnlyWorkspace: false,
    transportState: "idle" as const,
    boundAt: now
  };

  it("accepts valid session manifest with distinct panes", () => {
    const manifest = {
      schemaVersion: 2 as const,
      sessionId,
      projectName: "ai-flow-sdlc",
      workspaceRoot: "/workspace",
      herdrWorkspaceId: "ws-1",
      herdrTabId: "tab-1",
      status: "up" as const,
      conversationSessionId: "conv-sess-1",
      activeRunIds: [runId],
      panes: [conversationPane, coordinatorPane],
      attachTarget: {
        role: "conversation" as const,
        paneId: "pane-1"
      },
      createdAt: now,
      updatedAt: now
    };
    expect(SessionManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects duplicate paneId across panes", () => {
    expect(
      SessionManifestSchema.safeParse({
        schemaVersion: 2,
        sessionId,
        projectName: "ai-flow-sdlc",
        workspaceRoot: "/workspace",
        herdrWorkspaceId: "ws-1",
        herdrTabId: "tab-1",
        status: "initializing",
        conversationSessionId: "conv-sess-1",
        activeRunIds: [],
        panes: [conversationPane, { ...coordinatorPane, paneId: "pane-1" }],
        attachTarget: { role: "conversation", paneId: "pane-1" },
        createdAt: now,
        updatedAt: now
      }).success
    ).toBe(false);
  });

  it("enforces both conversation and coordinator panes when manifest status is up", () => {
    expect(
      SessionManifestSchema.safeParse({
        schemaVersion: 2,
        sessionId,
        projectName: "ai-flow-sdlc",
        workspaceRoot: "/workspace",
        herdrWorkspaceId: "ws-1",
        herdrTabId: "tab-1",
        status: "up",
        conversationSessionId: "conv-sess-1",
        activeRunIds: [],
        panes: [conversationPane],
        attachTarget: { role: "conversation", paneId: "pane-1" },
        createdAt: now,
        updatedAt: now
      }).success
    ).toBe(false);
  });

  it("rejects attachTarget.paneId not matching conversation pane", () => {
    expect(
      SessionManifestSchema.safeParse({
        schemaVersion: 2,
        sessionId,
        projectName: "ai-flow-sdlc",
        workspaceRoot: "/workspace",
        herdrWorkspaceId: "ws-1",
        herdrTabId: "tab-1",
        status: "up",
        conversationSessionId: "conv-sess-1",
        activeRunIds: [],
        panes: [conversationPane, coordinatorPane],
        attachTarget: { role: "conversation", paneId: "pane-999" },
        createdAt: now,
        updatedAt: now
      }).success
    ).toBe(false);
  });
});

describe("Conversation & Coordinator Boundaries", () => {
  it("validates AgentRoleProfile constraints", () => {
    // Only conversation role can be userFacing
    expect(
      AgentRoleProfileSchema.safeParse({
        role: "developer",
        title: "Developer",
        description: "Specialist dev",
        defaultCapabilities: ["cap-code"],
        allowedRecipients: ["coordinator"],
        canDelegateToSpecialist: false,
        userFacing: true,
        readOnlyWorkspace: false,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(false);

    // Conversation role cannot delegate to specialist
    expect(
      AgentRoleProfileSchema.safeParse({
        role: "conversation",
        title: "Chat",
        description: "User intake",
        defaultCapabilities: ["cap-chat"],
        allowedRecipients: ["coordinator", "user"],
        canDelegateToSpecialist: true,
        userFacing: true,
        readOnlyWorkspace: true,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(false);

    // Conversation role cannot have specialist in allowedRecipients (developer, tester, architect, etc.)
    expect(
      AgentRoleProfileSchema.safeParse({
        role: "conversation",
        title: "Chat",
        description: "User intake",
        defaultCapabilities: ["cap-chat"],
        allowedRecipients: ["coordinator", "user", "developer"],
        canDelegateToSpecialist: false,
        userFacing: true,
        readOnlyWorkspace: true,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(false);

    expect(
      AgentRoleProfileSchema.safeParse({
        role: "conversation",
        title: "Chat",
        description: "User intake",
        defaultCapabilities: ["cap-chat"],
        allowedRecipients: ["coordinator", "user", "tester"],
        canDelegateToSpecialist: false,
        userFacing: true,
        readOnlyWorkspace: true,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(false);

    // Specialist role may only list coordinator or runtime in allowedRecipients
    expect(
      AgentRoleProfileSchema.safeParse({
        role: "developer",
        title: "Developer",
        description: "Specialist dev",
        defaultCapabilities: ["cap-code"],
        allowedRecipients: ["coordinator", "tester"],
        canDelegateToSpecialist: false,
        userFacing: false,
        readOnlyWorkspace: false,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(false);

    expect(
      AgentRoleProfileSchema.safeParse({
        role: "developer",
        title: "Developer",
        description: "Specialist dev",
        defaultCapabilities: ["cap-code"],
        allowedRecipients: ["coordinator", "runtime"],
        canDelegateToSpecialist: false,
        userFacing: false,
        readOnlyWorkspace: false,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(true);

    // Only coordinator can have canDelegateToSpecialist = true
    expect(
      AgentRoleProfileSchema.safeParse({
        role: "coordinator",
        title: "Coordinator",
        description: "Workflow orchestration",
        defaultCapabilities: ["cap-coord"],
        allowedRecipients: ["conversation", "developer", "tester"],
        canDelegateToSpecialist: true,
        userFacing: false,
        readOnlyWorkspace: false,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      }).success
    ).toBe(true);
  });

  it("rejects conversation role in AgentAssignment", () => {
    expect(
      AgentAssignmentSchema.safeParse({
        schemaVersion: 2,
        assignmentId: "assign-1",
        runId,
        taskId,
        delegationId: "del-1",
        role: "conversation",
        agentId: "agent-1",
        paneId: "pane-1",
        leaseId: "lease-1",
        fencingToken: 1,
        requiredCapabilities: ["cap-1"],
        assignedBy: "coordinator",
        assignedAt: now,
        status: "assigned",
        idempotencyKey: "key-1"
      }).success
    ).toBe(false);
  });

  it("enforces DelegationRequest targetRole rules", () => {
    const baseDelegation = {
      schemaVersion: 2 as const,
      delegationId: "del-1",
      messageId: "msg-1",
      correlationId: "corr-1",
      sessionId,
      runId,
      title: "Implement Auth Feature",
      objective: "Build JWT authentication",
      specificationId: specId,
      sddLevel: "lightweight" as const,
      acceptanceCriteria: [validAcceptanceCriterion],
      inputArtifacts: [evidenceArtifact],
      priority: "normal" as const,
      requestedAt: now,
      idempotencyKey: "del-key-1"
    };

    // Conversation can only delegate to coordinator
    expect(
      DelegationRequestSchema.safeParse({
        ...baseDelegation,
        requestedBy: "conversation",
        targetRole: "developer"
      }).success
    ).toBe(false);

    expect(
      DelegationRequestSchema.safeParse({
        ...baseDelegation,
        requestedBy: "conversation",
        targetRole: "coordinator"
      }).success
    ).toBe(true);

    // Coordinator cannot delegate to conversation or coordinator
    expect(
      DelegationRequestSchema.safeParse({
        ...baseDelegation,
        requestedBy: "coordinator",
        targetRole: "coordinator"
      }).success
    ).toBe(false);

    expect(
      DelegationRequestSchema.safeParse({
        ...baseDelegation,
        requestedBy: "coordinator",
        targetRole: "developer"
      }).success
    ).toBe(true);
  });

  it("enforces ConversationMessage topology: user only talks to conversation", () => {
    expect(
      ConversationMessageSchema.safeParse({
        schemaVersion: 2,
        messageId: "msg-1",
        sessionId,
        correlationId: "corr-1",
        turnSequence: 1,
        sender: "user",
        recipient: "coordinator",
        intent: "user_request",
        content: "Please build feature",
        artifactReferences: [],
        createdAt: now
      }).success
    ).toBe(false);

    expect(
      ConversationMessageSchema.safeParse({
        schemaVersion: 2,
        messageId: "msg-1",
        sessionId,
        correlationId: "corr-1",
        turnSequence: 1,
        sender: "user",
        recipient: "conversation",
        intent: "user_request",
        content: "Please build feature",
        artifactReferences: [],
        createdAt: now
      }).success
    ).toBe(true);

    expect(
      ConversationMessageSchema.safeParse({
        schemaVersion: 2,
        messageId: "msg-2",
        sessionId,
        correlationId: "corr-2",
        turnSequence: 2,
        sender: "runtime",
        recipient: "coordinator",
        intent: "progress_update",
        content: "Status report",
        artifactReferences: [],
        createdAt: now
      }).success
    ).toBe(false);
  });
});

describe("InterRoleMessageSchema (Envelope)", () => {
  it("allows non-workflow messages (conversation.intake) without run_id", () => {
    const intakeMsg = {
      schema_version: 2 as const,
      message_id: "msg-intake-1",
      correlation_id: "corr-1",
      sender: { role: "user" as const },
      recipient: { role: "conversation" as const },
      type: "conversation.intake" as const,
      payload: { prompt: "Build new endpoint" },
      artifact_references: []
    };
    expect(RoleMessageSchema.parse(intakeMsg)).toEqual(intakeMsg);
    expect(InterRoleMessageSchema.parse(intakeMsg)).toEqual(intakeMsg);
  });

  it("requires run_id for workflow-scoped message types", () => {
    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-task-1",
        correlation_id: "corr-1",
        sender: { role: "coordinator" },
        recipient: { role: "developer" },
        type: "task.assignment",
        payload: { taskId: "task-1" },
        artifact_references: []
      }).success
    ).toBe(false);

    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-task-1",
        correlation_id: "corr-1",
        run_id: runId,
        sender: { role: "coordinator" },
        recipient: { role: "developer" },
        type: "task.assignment",
        payload: { taskId: "task-1" },
        artifact_references: []
      }).success
    ).toBe(true);
  });

  it("rejects conversation directly messaging developer or tester", () => {
    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-direct-1",
        correlation_id: "corr-1",
        run_id: runId,
        sender: { role: "conversation" },
        recipient: { role: "developer" },
        type: "task.status",
        payload: {},
        artifact_references: []
      }).success
    ).toBe(false);
  });

  it("enforces artifact reference runId matches envelope run_id", () => {
    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-art-1",
        correlation_id: "corr-1",
        run_id: runId,
        sender: { role: "coordinator" },
        recipient: { role: "developer" },
        type: "delegation.request",
        payload: {},
        artifact_references: [{ ...evidenceArtifact, runId: "other-run-id" }]
      }).success
    ).toBe(false);
  });

  it("accepts optional causation_id in RoleMessageSchema", () => {
    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-cause-1",
        correlation_id: "corr-1",
        causation_id: "cause-1",
        run_id: runId,
        sender: { role: "coordinator" },
        recipient: { role: "developer" },
        type: "task.assignment",
        payload: { taskId: "task-1" },
        artifact_references: []
      }).success
    ).toBe(true);
  });

  it("rejects self-messaging in RoleMessageSchema", () => {
    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-self-1",
        correlation_id: "corr-1",
        run_id: runId,
        sender: { role: "developer" },
        recipient: { role: "developer" },
        type: "task.status",
        payload: {},
        artifact_references: []
      }).success
    ).toBe(false);
  });

  it("rejects specialist-to-specialist direct messaging in RoleMessageSchema", () => {
    expect(
      RoleMessageSchema.safeParse({
        schema_version: 2,
        message_id: "msg-spec-1",
        correlation_id: "corr-1",
        run_id: runId,
        sender: { role: "developer" },
        recipient: { role: "tester" },
        type: "task.status",
        payload: {},
        artifact_references: []
      }).success
    ).toBe(false);
  });
});

describe("Approval v2 Extensions & Backward Compatibility", () => {
  it("supports v1 and v2 ApprovalRequest with new targets", () => {
    // New target: specification
    const specApproval = ApprovalRequestSchema.parse({
      schemaVersion: 2,
      approvalId: "appr-spec-1",
      runId,
      sessionId,
      status: "pending",
      expiresAt: later,
      target: { type: "specification", specId },
      revision: 1,
      generation: 0,
      requestedBy: "specifier",
      requestedAt: now,
      reason: "Please approve SDD spec",
      evidence: [artifactReference],
      idempotencyKey: "appr-req-1"
    });
    expect(specApproval.target.type).toBe("specification");
    expect(specApproval.schemaVersion).toBe(2);

    // v1 approval still parses perfectly
    const v1Approval = ApprovalRequestSchema.parse({
      schemaVersion: 1,
      approvalId: "appr-v1-1",
      runId,
      target: { type: "task", taskId: "build" },
      revision: 1,
      generation: 0,
      requestedBy: "coordinator",
      requestedAt: now,
      reason: "Please approve build",
      evidence: [],
      idempotencyKey: "appr-v1-key"
    });
    expect(v1Approval.schemaVersion).toBe(1);
    expect(v1Approval.status).toBeUndefined();
  });

  it("supports new targets: tdd_decision, verification_escalation, git_changeset, delegation", () => {
    expect(
      ApprovalTargetSchema.parse({
        type: "tdd_decision",
        decisionId: "tdd-1",
        taskId: "task-1"
      }).type
    ).toBe("tdd_decision");

    expect(
      ApprovalTargetSchema.parse({
        type: "verification_escalation",
        cycleId: "cycle-1",
        taskId: "task-1"
      }).type
    ).toBe("verification_escalation");

    expect(
      ApprovalTargetSchema.parse({
        type: "git_changeset",
        changeSetId: "cs-1",
        taskId: "task-1"
      }).type
    ).toBe("git_changeset");

    expect(
      ApprovalTargetSchema.parse({
        type: "delegation",
        delegationId: "del-1"
      }).type
    ).toBe("delegation");
  });

  it("validates ApprovalDecisionSchema v2 with optional sessionId", () => {
    const decision = ApprovalDecisionSchema.parse({
      schemaVersion: 2,
      approvalId: "appr-spec-1",
      runId,
      sessionId,
      target: { type: "specification", specId },
      revision: 1,
      generation: 0,
      decision: "approved",
      decidedBy: "architect",
      decidedAt: later,
      feedbackArtifacts: [],
      idempotencyKey: "decision-1"
    });
    expect(decision.schemaVersion).toBe(2);
    expect(decision.sessionId).toBe(sessionId);
  });
});

describe("Recovery Checkpoint & SdlcRecoveryContext", () => {
  it("RecoveryCheckpointSchema supports optional sessionId and conversationSessionId", () => {
    const checkpoint = RecoveryCheckpointSchema.parse({
      checkpointSchemaVersion: 1,
      codec: { name: "bflow.workflow-run-snapshot+json", version: 1 },
      checkpointId: "cp-1",
      runId,
      sessionId,
      conversationSessionId: "conv-1",
      eventSequence: 5,
      version: 5,
      state: { status: "running" },
      createdAt: now
    });
    expect(checkpoint.sessionId).toBe(sessionId);
    expect(checkpoint.conversationSessionId).toBe("conv-1");
  });

  it("SdlcRecoveryContextSchema parses valid context", () => {
    const context = SdlcRecoveryContextSchema.parse({
      specifications: [],
      activeAssignments: [],
      verificationCycles: [],
      gitChangeSets: []
    });
    expect(context.specifications).toEqual([]);
  });
});
