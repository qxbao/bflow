import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact.js";
import { IdentifierSchema, IdempotencyKeySchema, IsoDateTimeSchema, JsonValueSchema } from "./common.js";
import { ContractErrorSchema, type OperationResult } from "./errors.js";
import type { OperationOptions } from "./ports.js";
import { isTrustScopeWithin, PlatformSchemaVersionSchema, TrustScopeSchema } from "./platform.js";
import { RuntimeCommandSchema } from "./runtime.js";
import { MachineSetupPlanSchema } from "./setup.js";

/** Declarative commands; the host authenticates the caller independently of this payload. */
export const BflowCommandSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  commandId: IdentifierSchema,
  correlationId: IdentifierSchema,
  scope: TrustScopeSchema,
  requestedAt: IsoDateTimeSchema,
  idempotencyKey: IdempotencyKeySchema,
  operation: z.discriminatedUnion("name", [
    z.object({ name: z.literal("setup.plan"), componentIds: z.array(IdentifierSchema).min(1) }).strict(),
    z.object({ name: z.literal("setup.apply"), plan: MachineSetupPlanSchema,
      approvalReceiptId: IdentifierSchema.optional() }).strict(),
    z.object({ name: z.literal("tools.inspect"), toolIds: z.array(IdentifierSchema) }).strict(),
    z.object({ name: z.literal("mcp.inspect"), serviceIds: z.array(IdentifierSchema) }).strict(),
    z.object({ name: z.literal("skills.inspect"), manifestId: IdentifierSchema.optional() }).strict(),
    z.object({ name: z.literal("environment.up") }).strict(),
    z.object({ name: z.literal("environment.down") }).strict(),
    z.object({ name: z.literal("environment.attach") }).strict(),
    z.object({ name: z.literal("environment.status") }).strict(),
    z.object({ name: z.literal("environment.doctor") }).strict(),
    z.object({ name: z.literal("workflow.request"), intent: z.enum(["feature", "bugfix", "refactor", "review", "verify"]),
      objective: z.string().trim().min(1), entrypoint: z.literal("conversation") }).strict(),
    // Retains the existing RuntimeService semantics and storage; not an Agentic-host shortcut.
    z.object({ name: z.literal("workflow.legacy"), command: RuntimeCommandSchema }).strict()
  ])
}).strict().superRefine((command, ctx) => {
  if ((command.operation.name.startsWith("environment.") || command.operation.name.startsWith("workflow.")) && command.scope.kind === "machine")
    ctx.addIssue({ code: "custom", message: "environment/workflow commands require repository or session scope" });
  if (command.operation.name === "workflow.request" && command.scope.kind !== "session")
    ctx.addIssue({ code: "custom", message: "agentic workflow requests require a Conversation session" });
  if (command.operation.name === "setup.apply") {
    if (command.operation.plan.machineId !== command.scope.machineId)
      ctx.addIssue({ code: "custom", message: "setup plan belongs to another machine" });
    if (command.operation.plan.steps.some(step => !isTrustScopeWithin(step.scope, command.scope)))
      ctx.addIssue({ code: "custom", message: "setup step exceeds command authority scope" });
    if (command.operation.plan.steps.some(step => step.requiresApproval) && !command.operation.approvalReceiptId)
      ctx.addIssue({ code: "custom", message: "setup plan requires explicit approval" });
  }
});
export type BflowCommand = z.infer<typeof BflowCommandSchema>;

export const CommandExecutionResultSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  commandId: IdentifierSchema,
  correlationId: IdentifierSchema,
  status: z.enum(["accepted", "waiting_user", "succeeded", "failed", "unknown"]),
  runId: IdentifierSchema.optional(),
  approvalRequestId: IdentifierSchema.optional(),
  output: JsonValueSchema,
  artifacts: z.array(ArtifactReferenceSchema),
  error: ContractErrorSchema.optional(),
  observedAt: IsoDateTimeSchema
}).strict().superRefine((result, ctx) => {
  if ((result.status === "failed") !== !!result.error && result.status !== "unknown")
    ctx.addIssue({ code: "custom", message: "only failed/unknown commands carry an error; failed requires one" });
});
export type CommandExecutionResult = z.infer<typeof CommandExecutionResultSchema>;

export interface BflowCommandExecutor {
  execute(command: BflowCommand, options?: OperationOptions): Promise<OperationResult<CommandExecutionResult>>;
}
