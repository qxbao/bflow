/** Local web HTTP v1. Browser-safe closure; authority stays with the host. */
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import { ApprovalStatusSchema, ApprovalTargetSchema } from "./approval.js";
import { ArtifactChecksumSchema, ArtifactIdSchema, ArtifactKindSchema } from "./artifact.js";
import { AgentTransportStateSchema } from "./agent.js";
import { RunStatusSchema, TaskStatusSchema } from "./execution.js";
import { AcceptanceCriterionSchema, SdlcWorkStatusSchema } from "./sdlc.js";
import { ConversationSessionStatusSchema } from "./conversation-status.js";
import { OperationResultSchema, type OperationResult } from "./errors.js";

export const WEB_API_VERSION = 1 as const;
export const WEB_LIMITS = { bodyBytes: 262144, chatBytes: 16384, previewBytes: 1048576,
  chunkBytes: 65536, pageDefault: 25, pageMax: 100, bootstrapSeconds: 60, sessionSeconds: 43200,
  eventsPerProject: 1000, eventsPerClient: 100, heartbeatSeconds: 15 } as const;
const version = z.literal(WEB_API_VERSION);
const id = IdentifierSchema;
const time = IsoDateTimeSchema;
const uuid = z.string().uuid();
const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "must not be blank");
const text = nonblank(16000);
const token = nonblank(2048);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WebCursorSchema = token;
export const WebEventCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}:(0|[1-9][0-9]{0,19})$/);
export const WebRequestKindSchema = z.enum(["feature", "bugfix", "refactor", "spike"]);
export const WebCommandKindSchema = z.enum(["create_request", "revise_request", "answer_clarification", "answer_decision", "resume", "cancel"]);
export const WebDraftCriterionSchema = z.object({ description: nonblank(2000),
  verificationMethod: AcceptanceCriterionSchema.innerType().shape.verificationMethod }).strict();
const requirements = { objective: text, acceptanceCriteria: z.array(WebDraftCriterionSchema).min(1).max(100),
  constraints: z.array(nonblank(2000)).max(100) };
export const WebRevisionVersionSchema = z.object({ revisionToken: token }).strict();
export const WebApprovalVersionSchema = z.object({ revisionToken: token, approvalId: id, target: ApprovalTargetSchema,
  revision: z.number().int().positive(), generation: z.number().int().nonnegative(), evidenceDigest: digest }).strict();
const command = { apiVersion: version, commandId: uuid, projectId: id };
export const WebCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...command, kind: z.literal("create_request"), title: nonblank(200), requestKind: WebRequestKindSchema, ...requirements }).strict(),
  z.object({ ...command, kind: z.literal("revise_request"), runId: id, expectedVersion: WebRevisionVersionSchema, ...requirements }).strict(),
  z.object({ ...command, kind: z.literal("answer_clarification"), runId: id.optional(), intakeId: id.optional(), questionId: id,
    expectedVersion: WebRevisionVersionSchema, answer: text }).strict(),
  z.object({ ...command, kind: z.literal("answer_decision"), runId: id, decisionId: id, expectedVersion: WebApprovalVersionSchema,
    outcome: z.enum(["approved", "rejected", "changes_requested"]), reason: text.optional(), selectedOption: nonblank(200).optional() }).strict(),
  z.object({ ...command, kind: z.literal("resume"), runId: id, actionId: id, expectedVersion: WebRevisionVersionSchema }).strict(),
  z.object({ ...command, kind: z.literal("cancel"), runId: id, expectedVersion: WebRevisionVersionSchema, reason: text }).strict()
]).superRefine((input, ctx) => {
  if (input.kind === "answer_clarification" && (input.runId === undefined) === (input.intakeId === undefined))
    ctx.addIssue({ code: "custom", path: ["intakeId"], message: "exactly one runId or intakeId is required" });
  if (input.kind === "answer_decision") {
    if (input.decisionId !== input.expectedVersion.approvalId)
      ctx.addIssue({ code: "custom", path: ["decisionId"], message: "decisionId must equal approvalId" });
    if (input.outcome !== "approved" && input.reason === undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason required for rejection or changes" });
  }
});
export type WebCommand = z.infer<typeof WebCommandSchema>;
export const WebEvidenceReferenceSchema = z.object({ artifactId: ArtifactIdSchema, runId: id, kind: ArtifactKindSchema,
  mediaType: nonblank(200), checksum: ArtifactChecksumSchema, sizeBytes: z.number().int().nonnegative().optional() }).strict();
export const WebDecisionSchema = z.object({ decisionId: id, runId: id, kind: z.enum(["approval", "user_decision"]),
  status: ApprovalStatusSchema, question: text, options: z.array(nonblank(200)).max(10), expectedVersion: WebApprovalVersionSchema,
  evidence: z.array(WebEvidenceReferenceSchema).max(100), expiresAt: time.optional() }).strict()
  .refine(value => value.decisionId === value.expectedVersion.approvalId, "decision identity mismatch");
export const WebActionSchema = z.object({ actionId: id, kind: WebCommandKindSchema, enabled: z.boolean(),
  disabledReason: text.optional(), expectedVersion: z.union([WebRevisionVersionSchema, WebApprovalVersionSchema]) }).strict()
  .superRefine((value, ctx) => {
    if (!value.enabled && value.disabledReason === undefined) ctx.addIssue({ code: "custom", path: ["disabledReason"], message: "disabled action needs reason" });
    if (value.kind === "answer_decision" && !("approvalId" in value.expectedVersion))
      ctx.addIssue({ code: "custom", path: ["expectedVersion"], message: "decision requires exact approval version" });
    if (value.kind !== "answer_decision" && "approvalId" in value.expectedVersion)
      ctx.addIssue({ code: "custom", path: ["expectedVersion"], message: "non-decision requires revision version" });
  });
export const WebClarificationSchema = z.object({ questionId: id, question: text, options: z.array(nonblank(200)).max(10),
  expectedVersion: WebRevisionVersionSchema }).strict();
export const WebIntakeViewSchema = z.object({ intakeId: id, sessionId: id, correlationId: id, title: nonblank(200),
  status: z.enum(["clarifying", "admitted", "failed"]), runId: id.optional(), clarifications: z.array(WebClarificationSchema).max(100),
  updatedAt: time }).strict().refine(value => value.status !== "admitted" || value.runId !== undefined, "admitted intake requires runId");
export const WebBlockerSchema = z.object({ code: id, message: text }).strict();
export const WebTaskViewSchema = z.object({ taskId: id, title: nonblank(200), status: TaskStatusSchema }).strict();
export const WebTransportSummarySchema = z.object({ states: z.array(AgentTransportStateSchema).max(100), observedAt: time }).strict();
export const WebRunViewSchema = z.object({ apiVersion: version, runId: id, sessionId: id, revisionToken: token, title: nonblank(200),
  originRunId: id, parentRunId: id.optional(), continuedAsRunId: id.optional(), currentRunId: id,
  sdlcStatus: SdlcWorkStatusSchema, coreStatus: RunStatusSchema.nullable(), transportSummary: WebTransportSummarySchema,
  tasks: z.array(WebTaskViewSchema).max(1000), blockers: z.array(WebBlockerSchema).max(100), decisions: z.array(WebDecisionSchema).max(100),
  clarifications: z.array(WebClarificationSchema).max(100), availableActions: z.array(WebActionSchema).max(100), updatedAt: time }).strict();
export const WebProjectSchema = z.object({ apiVersion: version, projectId: id, displayName: nonblank(200), canonicalPath: nonblank(4096),
  registrationState: z.enum(["registered", "unavailable"]) }).strict();
export const WebProjectSessionSchema = z.object({ apiVersion: version, projectId: id, sessionId: id.optional(),
  state: z.enum(["stopped", "starting", "ready", "stopping", "unavailable"]), conversationStatus: ConversationSessionStatusSchema.optional(),
  pendingIntakes: z.array(WebIntakeViewSchema).max(100), blockers: z.array(WebBlockerSchema).max(100), updatedAt: time }).strict();
export const WebProjectInspectionSchema = z.object({ apiVersion: version, projectId: id, ready: z.boolean(),
  checks: z.array(z.object({ id, state: z.enum(["passed", "failed", "unsupported"]), message: text }).strict()).max(100), observedAt: time }).strict();
export const WebProjectPreviewSchema = z.object({ apiVersion: version, projectId: id, available: z.boolean(), summary: text,
  blockers: z.array(WebBlockerSchema).max(100), observedAt: time }).strict();
export const WebPageQuerySchema = z.object({ cursor: token.optional(), limit: z.number().int().min(1).max(100).default(25) }).strict();
export const WebRunQuerySchema = WebPageQuerySchema.extend({ search: nonblank(200).optional(), sdlcStatus: SdlcWorkStatusSchema.optional() }).strict();
export function WebPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ apiVersion: version, items: z.array(item).max(100), nextCursor: token.optional() }).strict();
}
export const WebApiErrorStatus = {
  invalid_request: 400, session_required: 401, forbidden: 403, not_found: 404, stale_version: 409,
  operation_conflict: 409, payload_too_large: 413, operation_not_allowed: 422, unavailable: 503, reconciliation_required: 503
} as const;
export const WebApiErrorCodeSchema = z.enum(["invalid_request", "session_required", "forbidden", "not_found", "stale_version",
  "operation_conflict", "payload_too_large", "operation_not_allowed", "unavailable", "reconciliation_required"]);
export const WebApiErrorSchema = z.object({ apiVersion: version, code: WebApiErrorCodeSchema, message: text, retryable: z.boolean(),
  operationId: uuid.optional(), correlationId: id, details: z.object({ field: nonblank(200).optional(), resourceId: id.optional() }).strict().optional()
}).strict().refine(value => value.retryable === (value.code === "unavailable"), "retryability must match registered code");
export const WebOperationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interaction"), runId: id, currentRunId: id, continuedAsRunId: id.optional() }).strict(),
  z.object({ kind: z.literal("intake"), intakeId: id }).strict(),
  z.object({ kind: z.literal("lifecycle"), session: WebProjectSessionSchema }).strict()
]);
export const WebOperationKindSchema = z.enum([...WebCommandKindSchema.options, "session_start", "session_stop"]);
export const WebOperationSchema = z.object({ apiVersion: version, operationId: uuid, projectId: id,
  owner: z.enum(["host_interaction", "local_lifecycle"]), operationKind: WebOperationKindSchema,
  state: z.enum(["accepted", "running", "applied", "failed", "reconciliation_required"]),
  result: WebOperationResultSchema.optional(), error: WebApiErrorSchema.optional(), updatedAt: time }).strict().superRefine((value, ctx) => {
  const lifecycle = value.operationKind === "session_start" || value.operationKind === "session_stop";
  if (lifecycle !== (value.owner === "local_lifecycle")) ctx.addIssue({ code: "custom", path: ["owner"], message: "operation owner/kind mismatch" });
  if (value.state === "applied" && !value.result) ctx.addIssue({ code: "custom", path: ["result"], message: "applied requires result" });
  if (value.state === "failed" && !value.error) ctx.addIssue({ code: "custom", path: ["error"], message: "failed requires error" });
  if (value.state !== "applied" && value.result) ctx.addIssue({ code: "custom", path: ["result"], message: "non-applied operation cannot have result" });
  if ((value.state === "applied" || value.state === "accepted" || value.state === "running") && value.error)
    ctx.addIssue({ code: "custom", path: ["error"], message: "error only for failed or uncertain operation" });
  if (value.result && lifecycle !== (value.result.kind === "lifecycle")) ctx.addIssue({ code: "custom", path: ["result"], message: "result owner mismatch" });
  if (value.result?.kind === "intake" && !["create_request", "revise_request", "answer_clarification"].includes(value.operationKind))
    ctx.addIssue({ code: "custom", path: ["result"], message: "only intake commands return intake result" });
  if (value.error?.operationId && value.error.operationId !== value.operationId) ctx.addIssue({ code: "custom", path: ["error"], message: "error operation identity mismatch" });
});
export const WebEventSchema = z.object({ apiVersion: version, cursor: WebEventCursorSchema, projectId: id,
  type: z.enum(["invalidate", "operation", "notice", "chat", "reset"]), resourceIds: z.array(id).max(100), occurredAt: time }).strict();
const chatText = nonblank(16384).refine(value => new TextEncoder().encode(value).byteLength <= WEB_LIMITS.chatBytes, "chat exceeds UTF-8 byte limit");
export const WebChatSendSchema = z.object({ apiVersion: version, messageId: uuid, projectId: id, sessionId: id, runId: id.optional(), content: chatText }).strict();
export const WebChatMessageSchema = z.object({ apiVersion: version, messageId: uuid, sessionId: id, runId: id.optional(),
  sender: z.enum(["user", "conversation"]), content: chatText, createdAt: time,
  delivery: z.enum(["accepted", "queued", "delivered", "unknown_delivery", "failed"]), source: z.enum(["web", "native"]) }).strict();
export const WebSessionSummarySchema = z.object({ apiVersion: version, sessionId: id, expiresAt: time, csrfToken: token }).strict();
export const WebSessionBootstrapRequestSchema = z.object({ apiVersion: version, secret: token }).strict();
export const WebProjectRegistrationRequestSchema = z.object({ apiVersion: version, path: nonblank(4096) }).strict();
export const WebProjectUnregisterRequestSchema = z.object({ apiVersion: version, confirmed: z.literal(true) }).strict();
export const WebSessionStartRequestSchema = z.object({ apiVersion: version, operationId: uuid }).strict();
export const WebSessionStopRequestSchema = WebSessionStartRequestSchema.extend({ confirmed: z.literal(true) }).strict();
export const WebSessionInspectRequestSchema = z.object({ apiVersion: version }).strict();
export const WebNoticeDisplayedRequestSchema = z.object({ apiVersion: version }).strict();
export const WebNoticeDisplayedSchema = z.object({ apiVersion: version, noticeId: id, displayedAt: time }).strict();
export const WebArtifactMetadataSchema = z.object({ apiVersion: version, artifactId: ArtifactIdSchema, runId: id,
  mediaType: nonblank(200), checksum: ArtifactChecksumSchema, sizeBytes: z.number().int().nonnegative(),
  disposition: z.enum(["inline", "attachment"]), previewLimitBytes: z.number().int().min(0).max(WEB_LIMITS.previewBytes) }).strict();
export const WebArtifactChunkSchema = z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= WEB_LIMITS.chunkBytes, "chunk must be 1..65536 bytes");

export type WebProject = z.infer<typeof WebProjectSchema>;
export type WebRunView = z.infer<typeof WebRunViewSchema>;
export type WebAction = z.infer<typeof WebActionSchema>;
export type WebDecision = z.infer<typeof WebDecisionSchema>;
export type WebClarification = z.infer<typeof WebClarificationSchema>;
export type WebIntakeView = z.infer<typeof WebIntakeViewSchema>;
export type WebEvidenceReference = z.infer<typeof WebEvidenceReferenceSchema>;
export type WebApprovalVersion = z.infer<typeof WebApprovalVersionSchema>;
export type WebRevisionVersion = z.infer<typeof WebRevisionVersionSchema>;
export type WebDraftCriterion = z.infer<typeof WebDraftCriterionSchema>;
export type WebBlocker = z.infer<typeof WebBlockerSchema>;
export type WebTaskView = z.infer<typeof WebTaskViewSchema>;
export type WebTransportSummary = z.infer<typeof WebTransportSummarySchema>;
export type WebOperation = z.infer<typeof WebOperationSchema>;
export type WebOperationResult = z.infer<typeof WebOperationResultSchema>;
export type WebEvent = z.infer<typeof WebEventSchema>;
export type WebChatMessage = z.infer<typeof WebChatMessageSchema>;
export type WebChatSend = z.infer<typeof WebChatSendSchema>;
export type WebApiError = z.infer<typeof WebApiErrorSchema>;
export type WebProjectSession = z.infer<typeof WebProjectSessionSchema>;
export type WebProjectInspection = z.infer<typeof WebProjectInspectionSchema>;
export type WebProjectPreview = z.infer<typeof WebProjectPreviewSchema>;
export type WebSessionSummary = z.infer<typeof WebSessionSummarySchema>;
export type WebArtifactMetadata = z.infer<typeof WebArtifactMetadataSchema>;
export type WebNoticeDisplayed = z.infer<typeof WebNoticeDisplayedSchema>;
export type WebRunQuery = z.input<typeof WebRunQuerySchema>;
export type WebPage<T> = { apiVersion: 1; items: T[]; nextCursor?: string };
export const WebArtifactReadSchema = z.object({ metadata: WebArtifactMetadataSchema,
  chunks: z.custom<AsyncIterable<Uint8Array>>(value => value !== null && typeof value === "object" &&
    Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function", "expected async byte iterable")
}).strict();
export const WebArtifactReadResultSchema = OperationResultSchema(WebArtifactReadSchema);
export type WebArtifactRead = z.infer<typeof WebArtifactReadSchema>;
export interface LocalWorkspaceServices {
  inspectProject(projectId: string): Promise<OperationResult<WebProjectInspection>>;
  startSession(projectId: string, operationId: string): Promise<OperationResult<WebProjectSession>>;
  stopSession(projectId: string, operationId: string): Promise<OperationResult<WebProjectSession>>;
  reconcileSessionOperation(operation: WebOperation): Promise<OperationResult<WebOperation>>;
  preview(projectId: string): Promise<OperationResult<WebProjectPreview>>;
}
export interface UserInteractionClient {
  readProjectSession(projectId: string): Promise<OperationResult<WebProjectSession>>;
  listRuns(projectId: string, query: WebRunQuery): Promise<OperationResult<WebPage<WebRunView>>>;
  readRun(projectId: string, runId: string): Promise<OperationResult<WebRunView>>;
  listDecisions(projectId: string): Promise<OperationResult<WebPage<WebDecision>>>;
  execute(command: WebCommand): Promise<OperationResult<WebOperation>>;
  readOperation(projectId: string, operationId: string): Promise<OperationResult<WebOperation>>;
  events(projectId: string, cursor?: string): AsyncIterable<WebEvent>;
  acknowledgeNotice(projectId: string, noticeId: string): Promise<OperationResult<WebNoticeDisplayed>>;
  listMessages(projectId: string, sessionId: string, cursor?: string): Promise<OperationResult<WebPage<WebChatMessage>>>;
  sendMessage(input: WebChatSend): Promise<OperationResult<WebChatMessage>>;
  readArtifact(projectId: string, artifactId: string): Promise<OperationResult<WebArtifactRead>>;
}
export const WebProjectInspectionResultSchema = OperationResultSchema(WebProjectInspectionSchema);
export const WebProjectSessionResultSchema = OperationResultSchema(WebProjectSessionSchema);
export const WebProjectPreviewResultSchema = OperationResultSchema(WebProjectPreviewSchema);
export const WebOperationResponseSchema = OperationResultSchema(WebOperationSchema);
export const WebRunViewResultSchema = OperationResultSchema(WebRunViewSchema);
export const WebRunPageResultSchema = OperationResultSchema(WebPageSchema(WebRunViewSchema));
export const WebDecisionPageResultSchema = OperationResultSchema(WebPageSchema(WebDecisionSchema));
export const WebNoticeDisplayedResultSchema = OperationResultSchema(WebNoticeDisplayedSchema);
export const WebChatMessageResultSchema = OperationResultSchema(WebChatMessageSchema);
export const WebChatPageResultSchema = OperationResultSchema(WebPageSchema(WebChatMessageSchema));

/** Route contracts reserve exact JSON shapes/statuses; no HTTP implementation here. */
const noBody = z.undefined();
const noQuery = z.object({}).strict();
export const WebEventsQuerySchema = z.object({ cursor: WebEventCursorSchema.optional() }).strict();
export const WebMessagesQuerySchema = z.object({ cursor: WebCursorSchema.optional() }).strict();
// Numeric URL values must first be parsed as strict decimal strings at HTTP ingress.
export const WebRunHttpQuerySchema = WebRunQuerySchema.omit({ limit: true }).extend({
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().int().max(100)).default("25")
}).strict();
export const WebHttpContracts = {
  bootstrap: { method: "POST", path: "/api/v1/session/bootstrap", body: WebSessionBootstrapRequestSchema, query: noQuery, response: WebSessionSummarySchema, statuses: [200] },
  session: { method: "GET", path: "/api/v1/session", body: noBody, query: noQuery, response: WebSessionSummarySchema, statuses: [200] },
  projects: { method: "GET", path: "/api/v1/projects", body: noBody, query: noQuery, response: WebPageSchema(WebProjectSchema), statuses: [200] },
  registerProject: { method: "POST", path: "/api/v1/projects", body: WebProjectRegistrationRequestSchema, query: noQuery, response: WebProjectSchema, statuses: [201, 200] },
  unregisterProject: { method: "DELETE", path: "/api/v1/projects/:id", body: WebProjectUnregisterRequestSchema, query: noQuery, response: z.undefined(), statuses: [204] },
  projectSession: { method: "GET", path: "/api/v1/projects/:id/session", body: noBody, query: noQuery, response: WebProjectSessionSchema, statuses: [200] },
  startSession: { method: "POST", path: "/api/v1/projects/:id/session/start", body: WebSessionStartRequestSchema, query: noQuery, response: WebOperationSchema, statuses: [202] },
  stopSession: { method: "POST", path: "/api/v1/projects/:id/session/stop", body: WebSessionStopRequestSchema, query: noQuery, response: WebOperationSchema, statuses: [202] },
  inspectSession: { method: "POST", path: "/api/v1/projects/:id/session/inspect", body: WebSessionInspectRequestSchema, query: noQuery, response: WebProjectInspectionSchema, statuses: [200] },
  preview: { method: "GET", path: "/api/v1/projects/:id/preview", body: noBody, query: noQuery, response: WebProjectPreviewSchema, statuses: [200] },
  runs: { method: "GET", path: "/api/v1/projects/:id/runs", body: noBody, query: WebRunHttpQuerySchema, response: WebPageSchema(WebRunViewSchema), statuses: [200] },
  run: { method: "GET", path: "/api/v1/projects/:id/runs/:runId", body: noBody, query: noQuery, response: WebRunViewSchema, statuses: [200] },
  decisions: { method: "GET", path: "/api/v1/projects/:id/decisions", body: noBody, query: noQuery, response: WebPageSchema(WebDecisionSchema), statuses: [200] },
  command: { method: "POST", path: "/api/v1/projects/:id/commands", body: WebCommandSchema, query: noQuery, response: WebOperationSchema, statuses: [202] },
  operation: { method: "GET", path: "/api/v1/projects/:id/operations/:operationId", body: noBody, query: noQuery, response: WebOperationSchema, statuses: [200] },
  artifact: { method: "GET", path: "/api/v1/projects/:id/artifacts/:artifactId", body: noBody, query: noQuery, response: WebArtifactMetadataSchema, statuses: [200], stream: "artifact" },
  events: { method: "GET", path: "/api/v1/projects/:id/events", body: noBody, query: WebEventsQuerySchema, response: WebEventSchema, statuses: [200], stream: "sse" },
  noticeDisplayed: { method: "POST", path: "/api/v1/projects/:id/notices/:noticeId/displayed", body: WebNoticeDisplayedRequestSchema, query: noQuery, response: WebNoticeDisplayedSchema, statuses: [200] },
  messages: { method: "GET", path: "/api/v1/projects/:id/sessions/:sessionId/messages", body: noBody, query: WebMessagesQuerySchema, response: WebPageSchema(WebChatMessageSchema), statuses: [200] },
  sendMessage: { method: "POST", path: "/api/v1/projects/:id/sessions/:sessionId/messages", body: WebChatSendSchema, query: noQuery, response: WebChatMessageSchema, statuses: [202] }
} as const;
export const WebHttpPathParamsSchema = z.object({ id, runId: id.optional(), operationId: uuid.optional(),
  artifactId: ArtifactIdSchema.optional(), noticeId: id.optional(), sessionId: id.optional() }).strict();
