import { z } from "zod";
import { IdentifierSchema, IdempotencyKeySchema, IsoDateTimeSchema } from "./common.js";
import type { OperationResult } from "./errors.js";
import type { OperationOptions } from "./ports.js";
import { ConfigurationLevelSchema, NonEmptyArgumentSchema, PlatformSchemaVersionSchema,
  Sha256DigestSchema, TrustScopeSchema } from "./platform.js";

export const ToolCapabilitySchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  toolId: IdentifierSchema,
  kind: z.enum(["cli_only", "existing_shared_worker", "native_remote_mcp", "stdio_mcp"]),
  version: NonEmptyArgumentSchema,
  operations: z.array(IdentifierSchema).min(1),
  resource: z.discriminatedUnion("sharing", [
    z.object({ sharing: z.literal("concurrent"), maxConcurrency: z.number().int().positive() }).strict(),
    z.object({ sharing: z.literal("exclusive"), resourceKey: IdentifierSchema }).strict()
  ]),
  required: z.boolean()
}).strict();
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export const ToolInstallRequestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  toolId: IdentifierSchema,
  installerId: IdentifierSchema,
  version: NonEmptyArgumentSchema,
  source: z.string().url(),
  integrity: Sha256DigestSchema,
  scope: TrustScopeSchema,
  destination: NonEmptyArgumentSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type ToolInstallRequest = z.infer<typeof ToolInstallRequestSchema>;

export const SetupStepSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  stepId: IdentifierSchema,
  action: z.enum(["install_tool", "configure", "register_mcp", "resolve_skills", "verify"]),
  componentId: IdentifierSchema,
  level: ConfigurationLevelSchema,
  scope: TrustScopeSchema,
  dependsOn: z.array(IdentifierSchema),
  desiredStateDigest: Sha256DigestSchema,
  expectedStateDigest: Sha256DigestSchema.nullable(),
  requiresApproval: z.boolean(),
  rollback: z.enum(["restore_owned_config", "remove_owned_install", "manual", "none"]),
  toolInstall: ToolInstallRequestSchema.optional(),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((step, ctx) => {
  if (step.scope.kind !== step.level) ctx.addIssue({ code: "custom", message: "setup level must match trust scope" });
  if (step.dependsOn.includes(step.stepId) || new Set(step.dependsOn).size !== step.dependsOn.length)
    ctx.addIssue({ code: "custom", message: "invalid step dependencies" });
  if (step.level === "machine" && step.action !== "verify" && !step.requiresApproval)
    ctx.addIssue({ code: "custom", message: "machine mutations require explicit approval" });
  if ((step.action === "install_tool") !== !!step.toolInstall)
    ctx.addIssue({ code: "custom", message: "only install_tool steps require toolInstall" });
  if (step.toolInstall && (step.toolInstall.toolId !== step.componentId ||
      JSON.stringify(step.toolInstall.scope) !== JSON.stringify(step.scope)))
    ctx.addIssue({ code: "custom", message: "tool install identity/scope mismatch" });
});
export type SetupStep = z.infer<typeof SetupStepSchema>;

export const MachineSetupPlanSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  planId: IdentifierSchema,
  machineId: IdentifierSchema,
  revision: z.number().int().positive(),
  planDigest: Sha256DigestSchema,
  createdAt: IsoDateTimeSchema,
  steps: z.array(SetupStepSchema),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((plan, ctx) => {
  // Wire order is a topological order; arbitrary/cyclic dependency graphs are rejected.
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.stepId) || step.scope.machineId !== plan.machineId || step.dependsOn.some(id => !seen.has(id)))
      ctx.addIssue({ code: "custom", message: "setup steps require unique IDs, matching machine and dependency order" });
    seen.add(step.stepId);
  }
});
export type MachineSetupPlan = z.infer<typeof MachineSetupPlanSchema>;

export const SetupReceiptSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  receiptId: IdentifierSchema,
  planId: IdentifierSchema,
  planDigest: Sha256DigestSchema,
  stepId: IdentifierSchema,
  scope: TrustScopeSchema,
  status: z.enum(["applied", "already_satisfied", "failed", "blocked", "unknown"]),
  desiredStateDigest: Sha256DigestSchema,
  observedStateDigest: Sha256DigestSchema.nullable(),
  ownedPaths: z.array(NonEmptyArgumentSchema),
  approvalReceiptId: IdentifierSchema.optional(),
  observedAt: IsoDateTimeSchema,
  diagnostics: z.array(z.string().min(1)),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((receipt, ctx) => {
  if (["applied", "already_satisfied"].includes(receipt.status) && receipt.observedStateDigest !== receipt.desiredStateDigest)
    ctx.addIssue({ code: "custom", message: "successful setup requires observed desired state" });
});
export type SetupReceipt = z.infer<typeof SetupReceiptSchema>;

export const SetupApplyRequestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  planId: IdentifierSchema,
  planDigest: Sha256DigestSchema,
  step: SetupStepSchema,
  approvalReceiptId: IdentifierSchema.optional()
}).strict().superRefine((request, ctx) => {
  if (request.step.requiresApproval && !request.approvalReceiptId)
    ctx.addIssue({ code: "custom", message: "step requires a verified approval receipt" });
});
export type SetupApplyRequest = z.infer<typeof SetupApplyRequestSchema>;

/** Installer accepts only owned, pinned install_tool steps; no arbitrary shell programs. */
export interface ToolInstaller {
  readonly installerId: string;
  plan(request: ToolInstallRequest, options?: OperationOptions): Promise<OperationResult<SetupStep>>;
  apply(request: SetupApplyRequest, options?: OperationOptions): Promise<OperationResult<SetupReceipt>>;
  reconcile(request: SetupApplyRequest, options?: OperationOptions): Promise<OperationResult<SetupReceipt>>;
}
