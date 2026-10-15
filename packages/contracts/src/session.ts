import { z } from "zod";
import { AgentSessionLocatorSchema, AgentTransportStateSchema } from "./agent.js";
import { ArtifactReferenceSchema } from "./artifact.js";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";
import { AcceptanceCriterionSchema, SddPolicyLevelSchema, TddDecisionSchema } from "./sdlc.js";

export const AGENT_ROLES = [
  "conversation",
  "coordinator",
  "planner",
  "architect",
  "specifier",
  "developer",
  "tester",
  "reviewer",
  "qa",
  "security"
] as const;

export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentCapabilityCategorySchema = z.enum([
  "conversation",
  "coordination",
  "specification",
  "architecture",
  "implementation",
  "testing",
  "verification",
  "review",
  "security"
]);
export type AgentCapabilityCategory = z.infer<typeof AgentCapabilityCategorySchema>;

export const AgentCapabilitySchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1),
    category: AgentCapabilityCategorySchema,
    description: z.string().min(1),
    readOnly: z.boolean(),
    requiredTools: z.array(z.string().min(1)).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentRoleProfileSchema = z
  .object({
    role: AgentRoleSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    defaultCapabilities: z.array(IdentifierSchema).min(1),
    allowedRecipients: z.array(z.union([AgentRoleSchema, z.literal("user"), z.literal("runtime")])).min(1),
    canDelegateToSpecialist: z.boolean(),
    userFacing: z.boolean(),
    readOnlyWorkspace: z.boolean(),
    requiresDedicatedPane: z.literal(true),
    requiresIndependentVerification: z.boolean()
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.role !== "conversation") {
      if (profile.userFacing) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "only conversation role may have userFacing = true",
          path: ["userFacing"]
        });
      }
      if (profile.allowedRecipients.includes("user")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "only conversation role may include user in allowedRecipients",
          path: ["allowedRecipients"]
        });
      }
    }
    if (profile.role === "conversation") {
      if (profile.canDelegateToSpecialist) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "conversation role cannot have canDelegateToSpecialist = true",
          path: ["canDelegateToSpecialist"]
        });
      }
      const allowedForConversationProfile = new Set(["user", "coordinator", "runtime"]);
      const hasDisallowedRecipient = profile.allowedRecipients.some((r) => !allowedForConversationProfile.has(r));
      if (hasDisallowedRecipient) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "conversation role may only include user, coordinator, or runtime in allowedRecipients",
          path: ["allowedRecipients"]
        });
      }
    }
    if (profile.role !== "conversation" && profile.role !== "coordinator") {
      const allowedForSpecialist = new Set(["coordinator", "runtime"]);
      const hasDisallowedRecipient = profile.allowedRecipients.some((r) => !allowedForSpecialist.has(r));
      if (hasDisallowedRecipient) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "specialist roles may only list 'coordinator' or 'runtime' in allowedRecipients",
          path: ["allowedRecipients"]
        });
      }
    }
    if (profile.role !== "coordinator" && profile.canDelegateToSpecialist) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only coordinator role may have canDelegateToSpecialist = true",
        path: ["canDelegateToSpecialist"]
      });
    }
  });
export type AgentRoleProfile = z.infer<typeof AgentRoleProfileSchema>;

export const PaneBindingSchema = z
  .object({
    schemaVersion: z.literal(2),
    bindingId: IdentifierSchema,
    sessionId: IdentifierSchema,
    role: AgentRoleSchema,
    agentId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    tabId: IdentifierSchema,
    paneId: IdentifierSchema,
    terminalId: IdentifierSchema.optional(),
    session: AgentSessionLocatorSchema.optional(),
    provider: z.string().min(1),
    agentKind: z.string().min(1),
    model: z.string().min(1).optional(),
    cwd: z.string().min(1),
    worktreePath: z.string().min(1).optional(),
    isolationMode: z.literal("dedicated_pane"),
    readOnlyWorkspace: z.boolean(),
    transportState: AgentTransportStateSchema,
    boundAt: IsoDateTimeSchema,
    lastHeartbeatAt: IsoDateTimeSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type PaneBinding = z.infer<typeof PaneBindingSchema>;

export const SessionManifestStatusSchema = z.enum(["initializing", "up", "degraded", "stopping", "down"]);
export type SessionManifestStatus = z.infer<typeof SessionManifestStatusSchema>;

export const SessionManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    sessionId: IdentifierSchema,
    projectName: z.string().min(1),
    workspaceRoot: z.string().min(1),
    herdrWorkspaceId: IdentifierSchema,
    herdrTabId: IdentifierSchema,
    status: SessionManifestStatusSchema,
    conversationSessionId: IdentifierSchema,
    activeRunIds: z.array(IdentifierSchema),
    panes: z.array(PaneBindingSchema).min(1),
    attachTarget: z
      .object({
        role: z.literal("conversation"),
        paneId: IdentifierSchema,
        terminalId: IdentifierSchema.optional()
      })
      .strict(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    stoppedAt: IsoDateTimeSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((manifest, context) => {
    const seenPaneIds = new Set<string>();
    manifest.panes.forEach((p, idx) => {
      if (seenPaneIds.has(p.paneId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate paneId in panes: ${p.paneId}`,
          path: ["panes", idx, "paneId"]
        });
      }
      seenPaneIds.add(p.paneId);
    });

    manifest.panes.forEach((p, idx) => {
      if (p.sessionId !== manifest.sessionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pane sessionId ${p.sessionId} does not match manifest sessionId ${manifest.sessionId}`,
          path: ["panes", idx, "sessionId"]
        });
      }
    });

    const conversationPane = manifest.panes.find((p) => p.role === "conversation");
    const coordinatorPane = manifest.panes.find((p) => p.role === "coordinator");

    if (manifest.status === "up") {
      if (!conversationPane) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "session manifest in status 'up' must include a conversation pane",
          path: ["panes"]
        });
      }
      if (!coordinatorPane) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "session manifest in status 'up' must include a coordinator pane",
          path: ["panes"]
        });
      }
    }

    if (conversationPane && manifest.attachTarget.paneId !== conversationPane.paneId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachTarget.paneId must equal conversation pane's paneId",
        path: ["attachTarget", "paneId"]
      });
    }
  });
export type SessionManifest = z.infer<typeof SessionManifestSchema>;

export const AgentAssignmentSchema = z
  .object({
    schemaVersion: z.literal(2),
    assignmentId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    delegationId: IdentifierSchema,
    role: AgentRoleSchema,
    agentId: IdentifierSchema,
    paneId: IdentifierSchema,
    leaseId: IdentifierSchema,
    fencingToken: z.number().int().positive(),
    requiredCapabilities: z.array(IdentifierSchema),
    assignedBy: z.literal("coordinator"),
    assignedAt: IsoDateTimeSchema,
    status: z.enum(["assigned", "active", "released", "revoked", "completed", "failed"]),
    worktreePath: z.string().min(1).optional(),
    idempotencyKey: IdempotencyKeySchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((assignment, context) => {
    if (assignment.role === "conversation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "role cannot be conversation in agent assignment",
        path: ["role"]
      });
    }
  });
export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>;

export const ConversationSessionStatusSchema = z.enum([
  "active",
  "awaiting_user_clarification",
  "delegated_to_coordinator",
  "reporting_progress",
  "awaiting_user_approval",
  "completed",
  "paused",
  "closed",
  "archived"
]);
export type ConversationSessionStatus = z.infer<typeof ConversationSessionStatusSchema>;

export const ConversationSessionSchema = z
  .object({
    schemaVersion: z.literal(2),
    sessionId: IdentifierSchema,
    herdrSessionId: IdentifierSchema,
    conversationAgentId: IdentifierSchema,
    paneId: IdentifierSchema,
    status: ConversationSessionStatusSchema,
    activeRunId: IdentifierSchema.optional(),
    specificationId: IdentifierSchema.optional(),
    activeApprovalIds: z.array(IdentifierSchema),
    turnCount: z.number().int().nonnegative(),
    unresolvedQuestions: z.array(z.string().min(1)),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    closedAt: IsoDateTimeSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((session, context) => {
    if (session.status === "awaiting_user_clarification" && session.unresolvedQuestions.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unresolvedQuestions must have length >= 1 when status is awaiting_user_clarification",
        path: ["unresolvedQuestions"]
      });
    }
    if (
      session.status === "delegated_to_coordinator" &&
      session.activeRunId === undefined &&
      session.specificationId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activeRunId or specificationId is required when status is delegated_to_coordinator",
        path: ["activeRunId"]
      });
    }
  });
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;

export const ConversationMessageSchema = z
  .object({
    schemaVersion: z.literal(2),
    messageId: IdentifierSchema,
    sessionId: IdentifierSchema,
    correlationId: IdentifierSchema,
    runId: IdentifierSchema.optional(),
    turnSequence: z.number().int().nonnegative(),
    sender: z.enum(["user", "conversation", "coordinator", "runtime"]),
    recipient: z.enum(["user", "conversation", "coordinator"]),
    intent: z.enum([
      "user_request",
      "clarification_question",
      "clarification_answer",
      "spec_draft_review",
      "delegation_handoff",
      "progress_update",
      "approval_prompt",
      "approval_response",
      "final_summary",
      "error_report"
    ]),
    content: z.string().min(1),
    artifactReferences: z.array(ArtifactReferenceSchema),
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((message, context) => {
    if ((message.sender as string) === (message.recipient as string)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sender cannot equal recipient",
        path: ["recipient"]
      });
    }
    if (message.sender !== "conversation" && message.recipient !== "conversation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "conversation messages must involve the conversation role as sender or recipient",
        path: ["recipient"]
      });
    }
    if (message.sender === "user" && message.recipient !== "conversation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user sender can only send to conversation",
        path: ["recipient"]
      });
    }
    if (message.recipient === "user" && message.sender !== "conversation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user recipient can only receive from conversation",
        path: ["sender"]
      });
    }
  });
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const DelegationRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    delegationId: IdentifierSchema,
    messageId: IdentifierSchema,
    correlationId: IdentifierSchema,
    sessionId: IdentifierSchema,
    runId: IdentifierSchema.optional(),
    requestedBy: z.enum(["conversation", "coordinator"]),
    targetRole: AgentRoleSchema,
    title: z.string().min(1),
    objective: z.string().min(1),
    specificationId: IdentifierSchema,
    sddLevel: SddPolicyLevelSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
    tddDecision: TddDecisionSchema.optional(),
    inputArtifacts: z.array(ArtifactReferenceSchema),
    priority: z.enum(["low", "normal", "high", "critical"]),
    requestedAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((request, context) => {
    if (request.requestedBy === "conversation" && request.targetRole !== "coordinator") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "conversation role can only delegate to coordinator",
        path: ["targetRole"]
      });
    }
    if (request.requestedBy === "coordinator") {
      if (request.targetRole === "conversation" || request.targetRole === "coordinator") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "coordinator cannot delegate to conversation or coordinator",
          path: ["targetRole"]
        });
      }
      if (request.runId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "runId is required when coordinator delegates tasks",
          path: ["runId"]
        });
      }
    }
  });
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

const RoleParticipantSchema = z
  .object({
    role: z.union([AgentRoleSchema, z.literal("user"), z.literal("runtime")]),
    agent_id: IdentifierSchema.optional(),
    pane_id: IdentifierSchema.optional()
  })
  .strict();

export const RoleMessageSchema = z
  .object({
    schema_version: z.literal(2),
    message_id: IdentifierSchema,
    correlation_id: IdentifierSchema,
    causation_id: IdentifierSchema.optional(),
    run_id: IdentifierSchema.optional(),
    sender: RoleParticipantSchema,
    recipient: RoleParticipantSchema,
    type: z.enum([
      "conversation.intake",
      "conversation.clarification",
      "conversation.progress",
      "delegation.request",
      "delegation.accepted",
      "spec.draft",
      "spec.approved",
      "tdd.decision",
      "task.assignment",
      "task.status",
      "implementation.submitted",
      "verification.requested",
      "verification.result",
      "verification.escalation",
      "review.verdict",
      "approval.request",
      "approval.decision"
    ]),
    payload: JsonValueSchema,
    artifact_references: z.array(ArtifactReferenceSchema),
    occurred_at: IsoDateTimeSchema.optional(),
    idempotency_key: IdempotencyKeySchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((message, context) => {
    if (message.type !== "conversation.intake" && message.type !== "conversation.clarification") {
      if (message.run_id === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `run_id is required for workflow-scoped message type ${message.type}`,
          path: ["run_id"]
        });
      }
    }

    if (message.run_id !== undefined) {
      message.artifact_references.forEach((ref, index) => {
        if (ref.runId !== message.run_id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `artifact reference runId ${ref.runId} must match message run_id ${message.run_id}`,
            path: ["artifact_references", index, "runId"]
          });
        }
      });
    }

    if (message.sender.role === message.recipient.role) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sender and recipient roles must be different",
        path: ["recipient", "role"]
      });
    }

    const nonSpecialistRoles = new Set(["user", "conversation", "coordinator", "runtime"]);
    if (
      !nonSpecialistRoles.has(message.sender.role) &&
      message.recipient.role !== "coordinator" &&
      message.recipient.role !== "runtime"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "specialist roles may only send messages to coordinator or runtime",
        path: ["recipient", "role"]
      });
    }
    if (
      !nonSpecialistRoles.has(message.recipient.role) &&
      message.sender.role !== "coordinator" &&
      message.sender.role !== "runtime"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "specialist roles may only receive messages from coordinator or runtime",
        path: ["sender", "role"]
      });
    }

    if (message.sender.role === "user" && message.recipient.role !== "conversation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user can only send messages to conversation",
        path: ["recipient", "role"]
      });
    }
    if (message.recipient.role === "user" && message.sender.role !== "conversation") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user can only receive messages from conversation",
        path: ["sender", "role"]
      });
    }

    const allowedForConversation = new Set(["user", "coordinator", "runtime"]);
    if (message.sender.role === "conversation" && !allowedForConversation.has(message.recipient.role)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `conversation cannot send message to ${message.recipient.role}`,
        path: ["recipient", "role"]
      });
    }
    if (message.recipient.role === "conversation" && !allowedForConversation.has(message.sender.role)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `conversation cannot receive message from ${message.sender.role}`,
        path: ["sender", "role"]
      });
    }
  });

export const InterRoleMessageSchema = RoleMessageSchema;
export type RoleMessage = z.infer<typeof RoleMessageSchema>;
export type InterRoleMessage = z.infer<typeof InterRoleMessageSchema>;
