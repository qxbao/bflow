/** Local web HTTP v1. Browser-safe closure; authority stays with the host. */
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import { ApprovalStatusSchema, ApprovalTargetSchema } from "./approval.js";
import { ArtifactChecksumSchema, ArtifactIdSchema, ArtifactKindSchema } from "./artifact.js";
import { AgentTransportStateSchema } from "./agent.js";
import { AgentRoleSchema } from "./agent-roles.js";
import { RunStatusSchema, TaskStatusSchema } from "./execution.js";
import { AcceptanceCriterionSchema, SdlcWorkStatusSchema } from "./sdlc.js";
import { ConversationSessionStatusSchema } from "./conversation-status.js";
import { OperationResultSchema, type OperationResult } from "./errors.js";
import { AgentProviderIdSchema } from "./platform.js";
import { DirectorMessageSchema, DirectorProgressSnapshotSchema, ParkedIssueSchema, ParkedIssueStatusSchema } from "./director.js";
// D-CD-01: browser-safe Director read shapes; Web imports them only through this subpath.
export {
  DIRECTOR_LIMITS, DIRECTOR_SCHEMA_VERSION, DirectorChannelSchema, DirectorMessageSchema, DirectorPresenceSchema,
  DirectorProgressRunSchema, DirectorProgressSnapshotSchema, DirectorProgressTaskSchema, ParkedIssueKindSchema,
  ParkedIssueSchema, ParkedIssueStatusSchema
} from "./director.js";
export type {
  DirectorChannel, DirectorMessage, DirectorPresence, DirectorProgressRun, DirectorProgressSnapshot, DirectorProgressTask,
  ParkedIssue, ParkedIssueKind, ParkedIssueStatus
} from "./director.js";

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
// D-CD-01: issue commands are WebCommand members but deliberately not WebAction kinds,
// so existing run snapshots/action lists never advertise them to older clients.
export const WebIssueCommandKindSchema = z.enum(["issue_retry", "issue_dismiss"]);
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
  z.object({ ...command, kind: z.literal("cancel"), runId: id, expectedVersion: WebRevisionVersionSchema, reason: text }).strict(),
  z.object({ ...command, kind: z.literal("issue_retry"), runId: id, issueId: id, expectedUpdatedAt: time }).strict(),
  z.object({ ...command, kind: z.literal("issue_dismiss"), runId: id, issueId: id, expectedUpdatedAt: time }).strict()
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
  z.object({ kind: z.literal("lifecycle"), session: WebProjectSessionSchema }).strict(),
  z.object({ kind: z.literal("issue"), issueId: id, status: ParkedIssueStatusSchema }).strict(),
  z.object({ kind: z.literal("director_launch"), provider: AgentProviderIdSchema, mode: z.enum(["terminal_opened", "manual_command"]),
    manualCommand: nonblank(4096), launchedAt: time }).strict()
]);
export const WebOperationKindSchema = z.enum([...WebCommandKindSchema.options, ...WebIssueCommandKindSchema.options,
  "session_start", "session_stop", "director_launch"]);
type WebOperationKind = z.infer<typeof WebOperationKindSchema>;
// D-CD-01 per-kind ownership/result rules; the pre-existing kinds keep their original rules.
const localLifecycleKinds: readonly WebOperationKind[] = ["session_start", "session_stop", "director_launch"];
function allowedResultKinds(kind: WebOperationKind): readonly string[] {
  if (kind === "session_start" || kind === "session_stop") return ["lifecycle"];
  if (kind === "director_launch") return ["director_launch"];
  if (kind === "issue_retry" || kind === "issue_dismiss") return ["issue"];
  if (kind === "create_request" || kind === "revise_request" || kind === "answer_clarification") return ["interaction", "intake"];
  return ["interaction"];
}
export const WebOperationSchema = z.object({ apiVersion: version, operationId: uuid, projectId: id,
  owner: z.enum(["host_interaction", "local_lifecycle"]), operationKind: WebOperationKindSchema,
  state: z.enum(["accepted", "running", "applied", "failed", "reconciliation_required"]),
  result: WebOperationResultSchema.optional(), error: WebApiErrorSchema.optional(), updatedAt: time }).strict().superRefine((value, ctx) => {
  const lifecycle = localLifecycleKinds.includes(value.operationKind);
  if (lifecycle !== (value.owner === "local_lifecycle")) ctx.addIssue({ code: "custom", path: ["owner"], message: "operation owner/kind mismatch" });
  if (value.result && !allowedResultKinds(value.operationKind).includes(value.result.kind))
    ctx.addIssue({ code: "custom", path: ["result"], message: "result kind does not match operation kind" });
  if (value.state === "applied" && !value.result) ctx.addIssue({ code: "custom", path: ["result"], message: "applied requires result" });
  if (value.state === "failed" && !value.error) ctx.addIssue({ code: "custom", path: ["error"], message: "failed requires error" });
  if (value.state !== "applied" && value.result) ctx.addIssue({ code: "custom", path: ["result"], message: "non-applied operation cannot have result" });
  if ((value.state === "applied" || value.state === "accepted" || value.state === "running") && value.error)
    ctx.addIssue({ code: "custom", path: ["error"], message: "error only for failed or uncertain operation" });
  const session = value.operationKind === "session_start" || value.operationKind === "session_stop";
  if (value.result && session !== (value.result.kind === "lifecycle")) ctx.addIssue({ code: "custom", path: ["result"], message: "result owner mismatch" });
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
export const WebSessionStopRequestSchema = WebSessionStartRequestSchema.extend({ confirmed: z.literal(true), force: z.boolean().optional() }).strict();
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
/** Additive project settings API. Configuration authority stays in CLI composition. */
export type WebConfigValue = string | number | boolean | null | WebConfigValue[] | { [key: string]: WebConfigValue };
export const WebConfigValueSchema: z.ZodType<WebConfigValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(WebConfigValueSchema), z.record(WebConfigValueSchema)
]));
export const WebProjectConfigurationSchema = z.object({ apiVersion: version, projectId: id, revision: digest,
  yaml: z.string().max(180000), gitIgnore: z.string().max(180000).optional(), values: z.record(WebConfigValueSchema) }).strict();
export const WebConfigurationSaveSchema = z.object({ apiVersion: version, expectedRevision: digest,
  yaml: z.string().min(1).max(180000).optional(), values: z.record(WebConfigValueSchema).optional()
}).strict().refine(value => (value.yaml === undefined) !== (value.values === undefined), "provide YAML or form values");
export const WebProjectInitRequestSchema = z.object({ apiVersion: version, operationId: uuid,
  acceptGitNexusLicense: z.boolean(), update: z.boolean().default(false),
  skipGitNexus: z.boolean().optional(),
  commitConfiguration: z.boolean().optional(), expectedConfigurationRevision: digest.optional(),
  provider: z.enum(["claude", "codex", "agy"]).optional() }).strict().superRefine((value,ctx)=>{
    if(value.commitConfiguration && (!value.expectedConfigurationRevision || value.update))
      ctx.addIssue({code:"custom",message:"configuration commit requires a reviewed revision and cannot update config in the same request"});
  });
export const WebProjectInitializationSchema = z.object({ apiVersion: version, projectId: id, operationId: uuid,
  state: z.enum(["running", "succeeded", "failed", "interrupted"]), message: z.string().max(16000), updatedAt: time }).strict();
export type WebProjectConfiguration = z.infer<typeof WebProjectConfigurationSchema>;
export type WebConfigurationSave = z.infer<typeof WebConfigurationSaveSchema>;
export type WebProjectInitRequest = z.infer<typeof WebProjectInitRequestSchema>;
export type WebProjectInitialization = z.infer<typeof WebProjectInitializationSchema>;
export const WebProjectConfigurationResultSchema = OperationResultSchema(WebProjectConfigurationSchema);
export const WebProjectInitializationResultSchema = OperationResultSchema(WebProjectInitializationSchema);
export const WebProjectMutationStatusSchema = z.object({ apiVersion: version, projectId: id, initializationPending: z.boolean() }).strict();
export const WebProjectMutationStatusResultSchema = OperationResultSchema(WebProjectMutationStatusSchema);
export interface LocalWorkspaceServices {
  projectMutationStatus?(projectId: string): Promise<OperationResult<z.infer<typeof WebProjectMutationStatusSchema>>>;
  readConfiguration?(projectId: string): Promise<OperationResult<WebProjectConfiguration>>;
  saveConfiguration?(projectId: string, request: WebConfigurationSave): Promise<OperationResult<WebProjectConfiguration>>;
  initializeProject?(projectId: string, request: WebProjectInitRequest): Promise<OperationResult<WebProjectInitialization>>;
  readInitialization?(projectId: string, operationId: string): Promise<OperationResult<WebProjectInitialization>>;
  inspectProject(projectId: string): Promise<OperationResult<WebProjectInspection>>;
  startSession(projectId: string, operationId: string): Promise<OperationResult<WebProjectSession>>;
  stopSession(projectId: string, operationId: string, force?: boolean): Promise<OperationResult<WebProjectSession>>;
  reconcileSessionOperation(operation: WebOperation): Promise<OperationResult<WebOperation>>;
  preview(projectId: string): Promise<OperationResult<WebProjectPreview>>;
}
// D-WEB-03 workforce projection: read-only, additive. The workforce view carries no pane, cwd, worktree, session metadata, token or RoleMessage payload.
// The excerpt and transcript routes (ADR 0008 amendment 2026-11-02) carry redacted terminal text only: an unverified snapshot, never task evidence.
export const WebAgentWorkSchema = z.object({
  messageId: id, kind: z.enum(["assignment", "delegation", "verification"]),
  runId: id, taskId: id.optional(), attemptId: id.optional(),
  delivery: z.enum(["queued", "sending", "accepted", "released", "unknown_delivery", "failed", "cancelled"]),
  acceptedAt: time.optional(), turnSeenAt: time.optional(), leaseExpiresAt: time.optional()
}).strict();
export const WebAgentViewSchema = z.object({
  instanceId: id, role: AgentRoleSchema, profileId: id.optional(), displayName: nonblank(200),
  group: z.enum(["conversation", "coordination", "verification", "developer_worktree"]).optional(),
  permanent: z.boolean(), provider: nonblank(100), model: nonblank(200).optional(),
  allocation: z.enum(["active", "released", "stopped_retained"]),
  transport: z.object({ state: AgentTransportStateSchema, observedAt: time }).strict(),
  boundAt: time, work: z.array(WebAgentWorkSchema).max(8)
}).strict();
export const WebHandoffViewSchema = z.object({
  handoffId: id, ordinal: z.number().int().nonnegative(), runId: id, taskId: id.optional(),
  messageType: nonblank(80), direction: z.enum(["outbound", "inbound"]),
  from: z.object({ role: nonblank(32), instanceId: id.optional() }).strict(),
  to: z.object({ role: nonblank(32), instanceId: id.optional() }).strict(),
  state: z.enum(["queued", "sending", "accepted", "delivered", "released", "applied",
    "rejected", "unknown_delivery", "failed", "cancelled"]),
  evidence: z.array(WebEvidenceReferenceSchema).max(20)
}).strict();
export const WebWorkforceViewSchema = z.object({
  apiVersion: version, projectId: id, sessionId: id, revisionToken: token,
  agents: z.array(WebAgentViewSchema).max(100), handoffs: z.array(WebHandoffViewSchema).max(100),
  truncated: z.boolean(), observedAt: time
}).strict();
export const WebActivityEntrySchema = z.object({
  entryId: uuid, occurredAt: time, kind: nonblank(32), role: nonblank(32), action: nonblank(80),
  runId: id, taskId: id.optional(), outcome: nonblank(240).optional()
}).strict();
export const WebAgentExcerptSchema = z.object({ instanceId: id, text: z.string().min(1).max(600), observedAt: time }).strict();
export const WebWorkforceExcerptsSchema = z.object({
  apiVersion: version, projectId: id, sessionId: id, items: z.array(WebAgentExcerptSchema).max(100), observedAt: time
}).strict();
export const WebAgentTranscriptSchema = z.object({
  apiVersion: version, projectId: id, sessionId: id, instanceId: id, source: z.literal("terminal_snapshot"),
  text: z.string().max(64000), truncated: z.boolean(), observedAt: time
}).strict();
export const WebActivityQuerySchema = z.object({ cursor: WebCursorSchema.optional() }).strict();
export type WebAgentWork = z.infer<typeof WebAgentWorkSchema>;
export type WebAgentView = z.infer<typeof WebAgentViewSchema>;
export type WebHandoffView = z.infer<typeof WebHandoffViewSchema>;
export type WebWorkforceView = z.infer<typeof WebWorkforceViewSchema>;
export type WebActivityEntry = z.infer<typeof WebActivityEntrySchema>;
export type WebAgentExcerpt = z.infer<typeof WebAgentExcerptSchema>;
export type WebWorkforceExcerpts = z.infer<typeof WebWorkforceExcerptsSchema>;
export type WebAgentTranscript = z.infer<typeof WebAgentTranscriptSchema>;
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
  /** D-WEB-03 optional read ports; a backend without them answers operation_not_allowed. */
  readWorkforce?(projectId: string): Promise<OperationResult<WebWorkforceView>>;
  readRunActivity?(projectId: string, runId: string, cursor?: string): Promise<OperationResult<WebPage<WebActivityEntry>>>;
  readWorkforceExcerpts?(projectId: string): Promise<OperationResult<WebWorkforceExcerpts>>;
  readAgentTranscript?(projectId: string, instanceId: string): Promise<OperationResult<WebAgentTranscript>>;
}
// D-CD-01 Director Web read/launch DTOs. No DirectorSession, token, directorId or repository path crosses to the browser.
export const WebDirectorViewSchema = z.object({ apiVersion: version, projectId: id,
  layout: z.enum(["director", "legacy_v2", "not_started"]), sessionId: id.optional(), snapshot: DirectorProgressSnapshotSchema,
  waitingSince: time.optional(), transcriptSeq: z.number().int().min(0), cliCaptureMayBeIncomplete: z.boolean(), observedAt: time }).strict();
/** Message `channel` records the origin; Director replies stay `cli` because Director runs in a CLI. */
export const WebDirectorTranscriptPageSchema = WebPageSchema(DirectorMessageSchema);
export const WebIssueQueueViewSchema = WebPageSchema(ParkedIssueSchema);
/** Installed is not ready: `available` requires the server's own readiness checks. */
export const WebDirectorLaunchOptionSchema = z.object({ provider: AgentProviderIdSchema,
  state: z.enum(["available", "unavailable", "unverified"]), reason: nonblank(2000).optional(), manualCommand: nonblank(4096) }).strict();
export const WebDirectorLaunchOptionsSchema = z.object({ apiVersion: version, projectId: id,
  terminal: z.object({ available: z.boolean(), reason: nonblank(2000).optional() }).strict(),
  providers: z.array(WebDirectorLaunchOptionSchema).max(3)
    .refine(items => new Set(items.map(item => item.provider)).size === items.length, "providers must be unique"),
  observedAt: time }).strict();
/** The server derives argv/cwd/env; the browser only selects a provider. */
export const WebDirectorLaunchRequestSchema = z.object({ apiVersion: version, operationId: uuid, provider: AgentProviderIdSchema,
  replaceActive: z.boolean().default(false) }).strict();
export type WebDirectorView = z.infer<typeof WebDirectorViewSchema>;
export type WebDirectorTranscriptPage = z.infer<typeof WebDirectorTranscriptPageSchema>;
export type WebIssueQueueView = z.infer<typeof WebIssueQueueViewSchema>;
export type WebDirectorLaunchOption = z.infer<typeof WebDirectorLaunchOptionSchema>;
export type WebDirectorLaunchOptions = z.infer<typeof WebDirectorLaunchOptionsSchema>;
export type WebDirectorLaunchRequest = z.infer<typeof WebDirectorLaunchRequestSchema>;
export type WebIssueCommand = Extract<WebCommand, { kind: z.infer<typeof WebIssueCommandKindSchema> }>;
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
  configuration: { method: "GET", path: "/api/v1/projects/:id/configuration", body: noBody, query: noQuery, response: WebProjectConfigurationSchema, statuses: [200] },
  saveConfiguration: { method: "PUT", path: "/api/v1/projects/:id/configuration", body: WebConfigurationSaveSchema, query: noQuery, response: WebProjectConfigurationResultSchema, statuses: [200] },
  initializeProject: { method: "POST", path: "/api/v1/projects/:id/initializations", body: WebProjectInitRequestSchema, query: noQuery, response: WebProjectInitializationSchema, statuses: [202] },
  initialization: { method: "GET", path: "/api/v1/projects/:id/initializations/:operationId", body: noBody, query: noQuery, response: WebProjectInitializationSchema, statuses: [200] },
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
  sendMessage: { method: "POST", path: "/api/v1/projects/:id/sessions/:sessionId/messages", body: WebChatSendSchema, query: noQuery, response: WebChatMessageSchema, statuses: [202] },
  workforce: { method: "GET", path: "/api/v1/projects/:id/workforce", body: noBody, query: noQuery, response: WebWorkforceViewSchema, statuses: [200] },
  activity: { method: "GET", path: "/api/v1/projects/:id/runs/:runId/activity", body: noBody, query: WebActivityQuerySchema, response: WebPageSchema(WebActivityEntrySchema), statuses: [200] },
  workforceExcerpts: { method: "GET", path: "/api/v1/projects/:id/workforce/excerpts", body: noBody, query: noQuery, response: WebWorkforceExcerptsSchema, statuses: [200] },
  agentTranscript: { method: "GET", path: "/api/v1/projects/:id/agents/:instanceId/transcript", body: noBody, query: noQuery, response: WebAgentTranscriptSchema, statuses: [200] },
  // D-CD-01 Director routes. Issue actions use `command`; SSE event types are unchanged.
  director: { method: "GET", path: "/api/v1/projects/:id/director", body: noBody, query: noQuery, response: WebDirectorViewSchema, statuses: [200] },
  directorMessages: { method: "GET", path: "/api/v1/projects/:id/director/messages", body: noBody, query: WebMessagesQuerySchema, response: WebDirectorTranscriptPageSchema, statuses: [200] },
  sendDirectorMessage: { method: "POST", path: "/api/v1/projects/:id/director/messages", body: WebChatSendSchema, query: noQuery, response: DirectorMessageSchema, statuses: [202] },
  directorIssues: { method: "GET", path: "/api/v1/projects/:id/director/issues", body: noBody, query: WebMessagesQuerySchema, response: WebIssueQueueViewSchema, statuses: [200] },
  directorLaunchOptions: { method: "GET", path: "/api/v1/projects/:id/director/launch-options", body: noBody, query: noQuery, response: WebDirectorLaunchOptionsSchema, statuses: [200] },
  launchDirector: { method: "POST", path: "/api/v1/projects/:id/director/launch", body: WebDirectorLaunchRequestSchema, query: noQuery, response: WebOperationSchema, statuses: [202] }
} as const;
export const WebHttpPathParamsSchema = z.object({ id, runId: id.optional(), operationId: uuid.optional(),
  artifactId: ArtifactIdSchema.optional(), noticeId: id.optional(), sessionId: id.optional(), instanceId: id.optional() }).strict();
