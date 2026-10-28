import { DelegationRequestSchema } from "@bflow/contracts";
import type { RunRecord, JournalState } from "../../src/agentic/journal.js";
export const at = "2026-10-28T00:00:00.000Z";
export function run(
  id = "run-1",
  overrides: Partial<RunRecord> = {},
): RunRecord {
  const delegation = DelegationRequestSchema.parse({
    schemaVersion: 2,
    delegationId: `d-${id}`,
    messageId: `m-${id}`,
    correlationId: `c-${id}`,
    sessionId: "conversation-1",
    runId: id,
    requestedBy: "conversation",
    targetRole: "coordinator",
    title: "Test request",
    objective: "Read safely",
    specificationId: "spec-1",
    sddLevel: "lightweight",
    acceptanceCriteria: [
      {
        id: "ac-1",
        description: "Read safely",
        category: "functional",
        verificationMethod: "unit_test",
        required: true,
        status: "pending",
        evidenceArtifactIds: [],
      },
    ],
    inputArtifacts: [],
    priority: "normal",
    requestedAt: at,
    idempotencyKey: `i-${id}`,
  });
  return {
    runId: id,
    delegation,
    status: "planning",
    tasks: [],
    coreCreated: false,
    cancelled: false,
    maxIterations: 3,
    ...overrides,
  };
}
export function state(runs: RunRecord[]): JournalState {
  return {
    version: 1,
    repository: "/repo",
    runs,
    outbound: [],
    inbox: [],
    pendingCore: [],
    pendingVerifications: [],
  };
}
export const pending = {
  actionId: "resume-1",
  kind: "resume_coordinator",
  owner: "coordinator",
  reason: "Needs intervention",
  sourceMessageId: "source-1",
  createdAt: at,
  state: "pending",
} as const;
export function uiStates() {
  return [
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
    "cancelled",
  ].map((status) =>
    run(`run-${status}`, { status: status as RunRecord["status"] }),
  );
}

/** Synthetic Conversation-owned context, shared with host-query tests and W03/W06. */
export function clarificationContext(hostSessionId = "host-1") {
  return {
    schemaVersion: 2,
    session: {
      schemaVersion: 2,
      sessionId: "conversation-1",
      herdrSessionId: hostSessionId,
      conversationAgentId: "agent",
      paneId: "pane",
      status: "awaiting_user_clarification",
      activeApprovalIds: [],
      turnCount: 1,
      unresolvedQuestions: ["Which behavior?"],
      createdAt: at,
      updatedAt: at,
    },
    messages: [],
    workflows: {},
    runIdToCorrelationId: {},
    pendingClarifications: {
      "intake-1": {
        correlationId: "intake-1",
        originalRequestText: "Improve behavior",
        accumulatedDetails: [],
        unresolvedQuestions: ["Which behavior?"],
        draft: {
          title: "Pending request",
          objective: "Improve behavior",
          kind: "feature",
          sddLevel: "lightweight",
          priority: "normal",
          scopeDefined: false,
          isLargeTask: false,
          affectedPaths: [],
          acceptanceCriteriaDescriptions: [],
          isRequirementChange: false,
        },
        createdAt: at,
        updatedAt: at,
      },
    },
    pendingApprovals: {},
    approvalDecisions: {},
    pendingInboundQueue: [],
    processedMessageIds: [],
    deliveryRecords: {},
    agentBusy: false,
    transportState: "done",
  };
}
