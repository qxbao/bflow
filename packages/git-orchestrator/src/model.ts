import { z } from "zod";
import {
  GitChangeSetSchema, IdentifierSchema, RoleMessageSchema, VerificationResultSchema
} from "@bflow/contracts";

export const CommitHashSchema = z.string().regex(/^[a-f0-9]{40}$/);
const PathSchema = z.string().min(1).refine(p =>
  !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") &&
  !p.split("/").some(s => s === ".." || s === "." || s === "") && !p.includes("*"),
"Use a repository-relative file or directory, without globs or traversal");
export const TaskRequestSchema = z.object({
  runId: IdentifierSchema,
  taskId: IdentifierSchema,
  attemptId: IdentifierSchema,
  baseRevision: z.string().min(1),
  ownedPaths: z.array(PathSchema).min(1),
  forbiddenPaths: z.array(PathSchema).default([]),
  /** Verified heads of DAG dependencies; several are merged into the task base. Absent in journals written before this field. */
  dependencyHeads: z.array(CommitHashSchema).refine(heads => new Set(heads).size === heads.length, "Dependency heads must be unique").default([]),
  developerId: IdentifierSchema
}).strict();
export type TaskRequest = z.input<typeof TaskRequestSchema>;
export const TaskRecordSchema = z.object({
  key: z.string(),
  request: TaskRequestSchema,
  baseCommitHash: CommitHashSchema,
  branchName: z.string(),
  worktreePath: z.string(),
  status: z.enum(["creating", "active", "cancelled", "cleaned"]),
  headCommitHash: CommitHashSchema.optional(),
  changeSet: GitChangeSetSchema.optional()
}).strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export const IntegrationRequestSchema = z.object({
  runId: IdentifierSchema,
  integrationId: IdentifierSchema,
  baseRevision: z.string().min(1),
  tasks: z.array(z.object({
    taskKey: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).default([])
  }).strict()).min(1)
}).strict();
export type IntegrationRequest = z.input<typeof IntegrationRequestSchema>;
export const IntegrationRecordSchema = z.object({
  key: z.string(),
  request: IntegrationRequestSchema,
  branchName: z.string(),
  worktreePath: z.string(),
  baseCommitHash: CommitHashSchema,
  expectedHead: CommitHashSchema,
  order: z.array(z.string()),
  snapshots: z.record(GitChangeSetSchema),
  merged: z.array(z.string()),
  currentTask: z.string().optional(),
  beforeMerge: CommitHashSchema.optional(),
  status: z.enum(["creating", "ready", "merging", "conflict", "awaiting_verification", "verified", "cancelled", "cleaned"]),
  conflictPaths: z.array(z.string()),
  requests: z.array(RoleMessageSchema),
  verification: VerificationResultSchema.optional(),
  pullRequest: z.object({ state: z.enum(["pending", "created"]), requestKey: z.string(), url: z.string().url().optional() }).strict().optional()
}).strict();
export type IntegrationRecord = z.infer<typeof IntegrationRecordSchema>;
export const StateSchema = z.object({
  version: z.literal(1),
  repository: z.string(),
  tasks: z.record(TaskRecordSchema),
  integrations: z.record(IntegrationRecordSchema)
}).strict();
export type State = z.infer<typeof StateSchema>;

export class GitOrchestrationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "GitOrchestrationError"; }
}
export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new GitOrchestrationError(code, message);
}
