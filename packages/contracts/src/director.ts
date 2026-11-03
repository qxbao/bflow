/** Director agent (ADR 0009). Director is a host principal, not an AgentRole or Herdr pane. */
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import { AgentProviderIdSchema } from "./platform.js";
import { AgentRoleSchema } from "./agent-roles.js";
import { TaskStatusSchema } from "./execution.js";
import { SdlcWorkStatusSchema } from "./sdlc.js";

export const DIRECTOR_SCHEMA_VERSION = 1 as const;
export const DIRECTOR_LIMITS = {
  messageBytes: 16384,
  transcriptPage: 200,
  issuesMax: 500,
  issueTextMax: 2000,
  waitDefaultMs: 45000,
  waitMinMs: 1000,
  waitMaxMs: 300000,
  heartbeatStaleMs: 120000,
  mailboxPage: 200,
  mailboxMax: 5000
} as const;

const version = z.literal(DIRECTOR_SCHEMA_VERSION);
const id = IdentifierSchema;
const time = IsoDateTimeSchema;
const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "must not be blank");
const issueText = nonblank(DIRECTOR_LIMITS.issueTextMax);

export const DirectorChannelSchema = z.enum(["cli", "web"]);
export type DirectorChannel = z.infer<typeof DirectorChannelSchema>;
export const DirectorPresenceSchema = z.enum(["active", "waiting", "absent"]);
export type DirectorPresence = z.infer<typeof DirectorPresenceSchema>;

export const DirectorSessionSchema = z.object({
  schemaVersion: version,
  directorId: id,
  provider: AgentProviderIdSchema,
  repositoryRoot: z.string().min(1).max(4096),
  tokenId: id,
  startedAt: time,
  heartbeatAt: time,
  waitingSince: time.nullable()
}).strict();
export type DirectorSession = z.infer<typeof DirectorSessionSchema>;

export const DirectorMessageSchema = z.object({
  schemaVersion: version,
  seq: z.number().int().min(1),
  messageId: id,
  author: z.enum(["user", "director"]),
  channel: DirectorChannelSchema,
  text: nonblank(DIRECTOR_LIMITS.messageBytes).refine(value => Buffer.byteLength(value, "utf8") <= DIRECTOR_LIMITS.messageBytes,
    `must be at most ${DIRECTOR_LIMITS.messageBytes} UTF-8 bytes`),
  at: time,
  runId: id.optional()
}).strict();
export type DirectorMessage = z.infer<typeof DirectorMessageSchema>;

export const ParkedIssueKindSchema = z.enum([
  "transport_failure",
  "provider_failure",
  "verification_exhausted",
  "rework_exhausted",
  "user_decision_pending",
  "environment",
  "other"
]);
export type ParkedIssueKind = z.infer<typeof ParkedIssueKindSchema>;
export const ParkedIssueStatusSchema = z.enum(["open", "retrying", "resolved", "dismissed"]);
export type ParkedIssueStatus = z.infer<typeof ParkedIssueStatusSchema>;

export const ParkedIssueSchema = z.object({
  schemaVersion: version,
  issueId: id,
  runId: id,
  taskKey: id.optional(),
  kind: ParkedIssueKindSchema,
  status: ParkedIssueStatusSchema,
  summary: issueText,
  attempts: z.number().int().min(0),
  evidence: z.array(z.string().regex(/^artifact:\/\/\S+$/)).max(50),
  suggestedAction: issueText.optional(),
  createdAt: time,
  updatedAt: time
}).strict();
export type ParkedIssue = z.infer<typeof ParkedIssueSchema>;

export const DirectorRuntimeEventSchema = z.object({
  type: id,
  runId: id.optional(),
  summary: issueText
}).strict();
export type DirectorRuntimeEvent = z.infer<typeof DirectorRuntimeEventSchema>;

export const DirectorMailboxItemSchema = z.object({
  schemaVersion: version,
  seq: z.number().int().min(1),
  messageId: id,
  at: time,
  audience: z.enum(["director", "user"]),
  runId: id.optional(),
  taskId: id.optional(),
  type: id,
  kind: id.optional(),
  fromRole: z.union([AgentRoleSchema, z.literal("runtime")]),
  summary: issueText,
  text: nonblank(4000).optional(),
  code: z.string().regex(/^#[1-9]\d*$/).optional()
}).strict();
export type DirectorMailboxItem = z.infer<typeof DirectorMailboxItemSchema>;

export const DirectorWaitResultSchema = z.object({
  cursor: z.string().min(1).max(512),
  timedOut: z.boolean(),
  messages: z.array(DirectorMessageSchema).max(DIRECTOR_LIMITS.transcriptPage),
  issues: z.array(ParkedIssueSchema).max(DIRECTOR_LIMITS.issuesMax),
  runtimeEvents: z.array(DirectorRuntimeEventSchema).max(200),
  mailbox: z.array(DirectorMailboxItemSchema).max(DIRECTOR_LIMITS.mailboxPage).optional()
}).strict();
export type DirectorWaitResult = z.infer<typeof DirectorWaitResultSchema>;

export const DirectorProgressTaskSchema = z.object({
  taskKey: id,
  title: nonblank(200),
  status: TaskStatusSchema,
  role: AgentRoleSchema.optional(),
  startedAt: time.optional()
}).strict();
export type DirectorProgressTask = z.infer<typeof DirectorProgressTaskSchema>;

export const DirectorProgressRunSchema = z.object({
  runId: id,
  title: nonblank(200),
  sdlcStatus: SdlcWorkStatusSchema,
  tasks: z.array(DirectorProgressTaskSchema).max(1000)
}).strict();
export type DirectorProgressRun = z.infer<typeof DirectorProgressRunSchema>;

export const DirectorProgressSnapshotSchema = z.object({
  schemaVersion: version,
  generatedAt: time,
  director: z.object({
    presence: DirectorPresenceSchema,
    provider: AgentProviderIdSchema.optional(),
    heartbeatAt: time.optional()
  }).strict(),
  runs: z.array(DirectorProgressRunSchema).max(100),
  pendingApprovals: z.number().int().min(0),
  pendingQuestions: z.number().int().min(0),
  issues: z.array(ParkedIssueSchema).max(DIRECTOR_LIMITS.issuesMax)
}).strict();
export type DirectorProgressSnapshot = z.infer<typeof DirectorProgressSnapshotSchema>;
