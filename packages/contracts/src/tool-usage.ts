import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema } from "./common.js";
import { PlatformSchemaVersionSchema } from "./platform.js";
import { AgentRoleSchema } from "./session.js";

/** Agent-supplied action intent. Authenticated principal, pane, role, run and task are host-derived. */
export const ToolActionRequestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  actionId: IdentifierSchema,
  toolId: IdentifierSchema,
  operation: IdentifierSchema,
  input: JsonValueSchema
}).strict();
export type ToolActionRequest = z.infer<typeof ToolActionRequestSchema>;

export const ToolUsageStatusSchema = z.enum([
  "planned", "denied", "skipped", "degraded", "blocked", "started", "completed", "failed", "unknown"
]);
export type ToolUsageStatus = z.infer<typeof ToolUsageStatusSchema>;

/** Consumption is separate from invocation completion and requires linked evidence. */
export const ToolConsumptionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("consumed"),
    source: z.enum(["host_context", "accepted_artifact", "verified_action"]),
    evidenceReferences: z.array(ArtifactReferenceSchema).min(1)
  }).strict(),
  z.object({ status: z.literal("rejected"), reasonCode: IdentifierSchema, evidenceReferences: z.array(ArtifactReferenceSchema).optional() }).strict(),
  z.object({ status: z.literal("not_used"), reasonCode: IdentifierSchema }).strict()
]);
export type ToolConsumption = z.infer<typeof ToolConsumptionSchema>;

/** Secret-free usage evidence; this record never contains invocation input or output bodies. */
export const ToolUsageRecordSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  runId: IdentifierSchema.optional(),
  taskId: IdentifierSchema.optional(),
  role: AgentRoleSchema,
  sessionId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  invocationId: IdentifierSchema,
  toolId: IdentifierSchema,
  serviceId: IdentifierSchema.optional(),
  operation: IdentifierSchema,
  status: ToolUsageStatusSchema,
  consumption: ToolConsumptionSchema.optional(),
  reasonCode: IdentifierSchema.optional(),
  observedAt: IsoDateTimeSchema
}).strict().superRefine((record, context) => {
  if (record.taskId !== undefined && record.runId === undefined) {
    context.addIssue({ code: "custom", path: ["runId"], message: "taskId requires runId" });
  }
  if (["denied", "skipped", "degraded", "blocked"].includes(record.status) && record.reasonCode === undefined) {
    context.addIssue({ code: "custom", path: ["reasonCode"], message: `${record.status} usage requires reasonCode` });
  }
  if (record.consumption?.status === "consumed" && record.status !== "completed") {
    context.addIssue({ code: "custom", path: ["consumption"], message: "only a completed invocation can be consumed" });
  }
  if (record.consumption?.status === "consumed" && (record.runId === undefined || record.taskId === undefined)) {
    context.addIssue({ code: "custom", path: ["consumption"], message: "consumed result requires run and task linkage" });
  }
  if (record.consumption?.status === "consumed" && record.consumption.evidenceReferences.some(reference => reference.runId !== record.runId || reference.taskId !== record.taskId)) {
    context.addIssue({ code: "custom", path: ["consumption", "evidenceReferences"], message: "consumption evidence ownership must match usage record" });
  }
});
export type ToolUsageRecord = z.infer<typeof ToolUsageRecordSchema>;
