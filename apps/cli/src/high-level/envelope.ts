import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CommandExecutionResultSchema,
  ContractErrorSchema,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  JsonValueSchema,
  type ArtifactReference,
  type CommandExecutionResult,
  type ContractError,
  type JsonValue
} from "@bflow/contracts";

/** Stable command names; `bflow <words>` maps onto these identifiers. */
export const HIGH_LEVEL_COMMANDS = [
  "repo.inspect",
  "task.preview",
  "task.plan",
  "task.implement",
  "verify",
  "git.prepare",
  "mcp.status",
  "tool.status",
  "skills.sync",
  "skills.scan",
  "skills.import",
  "skills.approve",
  "skills.disable",
  "skills.revoke",
  "skills.status",
  "agent.check"
] as const;
export type HighLevelCommandName = (typeof HIGH_LEVEL_COMMANDS)[number];
export const HighLevelCommandNameSchema = z.enum(HIGH_LEVEL_COMMANDS);

/**
 * Exit codes are part of the command contract. A command that ran correctly but observed a
 * negative outcome (not ready, verification not passed) exits NOT_READY, never SUCCESS.
 */
export const HIGH_LEVEL_EXIT_CODES = {
  SUCCESS: 0,
  FAILED: 1,
  USAGE: 2,
  NOT_READY: 3,
  NOT_FOUND: 4,
  PERMISSION_REQUIRED: 5,
  CONFLICT: 6,
  UNKNOWN_STATE: 7
} as const;
export type HighLevelExitCode = (typeof HIGH_LEVEL_EXIT_CODES)[keyof typeof HIGH_LEVEL_EXIT_CODES];

export const StepStatusSchema = z.enum(["succeeded", "failed", "skipped", "blocked", "reused"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const CommandStepSchema = z
  .object({
    id: z.string().min(1),
    status: StepStatusSchema,
    message: z.string().min(1).optional(),
    data: JsonValueSchema.optional()
  })
  .strict();
export type CommandStep = z.infer<typeof CommandStepSchema>;

/** Domain verdict, separate from command status: `succeeded` never implies run/task success. */
export const CommandOutcomeSchema = z.enum([
  "inspected",
  "planned",
  "checked",
  "prepared",
  "integration_prepared",
  "conflict_detected",
  "passed",
  "not_passed",
  "ready",
  "not_ready",
  "synced",
  "already_synced",
  "preview",
  "approval_required",
  "reconciliation_required",
  "failed"
]);
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>;

export const HighLevelOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: HighLevelCommandNameSchema,
    outcome: CommandOutcomeSchema,
    ids: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).optional()
      })
      .strict(),
    replayed: z.boolean(),
    steps: z.array(CommandStepSchema),
    data: JsonValueSchema
  })
  .strict();
export type HighLevelOutput = z.infer<typeof HighLevelOutputSchema>;

/** JSON stdout document of every high-level command (`--json`). */
export const HighLevelEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    command: HighLevelCommandNameSchema,
    exitCode: z.number().int().min(0).max(7),
    result: CommandExecutionResultSchema
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const output = HighLevelOutputSchema.safeParse(envelope.result.output);
    if (!output.success) ctx.addIssue({ code: "custom", message: `invalid command output: ${output.error.message}` });
    else if (output.data.command !== envelope.command) ctx.addIssue({ code: "custom", message: "output command mismatch" });
    if (envelope.ok !== (envelope.exitCode === 0)) ctx.addIssue({ code: "custom", message: "ok must equal exitCode 0" });
  });
export type HighLevelEnvelope = z.infer<typeof HighLevelEnvelopeSchema>;

export interface CommandIdentity {
  readonly commandId: string;
  readonly correlationId: string;
}

export function newCommandIdentity(correlationId?: string): CommandIdentity {
  return {
    commandId: `cmd-${randomUUID()}`,
    correlationId: correlationId ?? `corr-${randomUUID()}`
  };
}

/** A failure carrying a contract error and the exit code it maps to. */
export class HighLevelError extends Error {
  constructor(readonly contractError: ContractError, readonly exitCode: HighLevelExitCode = exitCodeForError(contractError)) {
    super(contractError.message);
  }
}

export const validationError = (message: string, details?: JsonValue): ContractError =>
  ({ code: "validation", retryable: false, message, ...(details !== undefined ? { details } : {}) });
export const notFoundError = (message: string, details?: JsonValue): ContractError =>
  ({ code: "not_found", retryable: false, message, ...(details !== undefined ? { details } : {}) });
export const conflictError = (message: string, details?: JsonValue): ContractError =>
  ({ code: "conflict", retryable: true, message, ...(details !== undefined ? { details } : {}) });
export const unavailableError = (message: string, details?: JsonValue): ContractError =>
  ({ code: "transport_unavailable", retryable: true, message, ...(details !== undefined ? { details } : {}) });
export const unknownStateError = (message: string, details?: JsonValue): ContractError =>
  ({ code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message,
    ...(details !== undefined ? { details } : {}) });
export const permissionError = (message: string, permission: string): ContractError =>
  validationError(message, { reason: "permission_required", permission });
export const usageError = (message: string): ContractError => validationError(message, { reason: "usage" });

function errorReason(error: ContractError): string | undefined {
  const details = error.details;
  if (details !== null && typeof details === "object" && !Array.isArray(details)) {
    const reason = details.reason;
    return typeof reason === "string" ? reason : undefined;
  }
  return undefined;
}

export function exitCodeForError(error: ContractError): HighLevelExitCode {
  switch (error.code) {
    case "validation": {
      const reason = errorReason(error);
      if (reason === "usage") return HIGH_LEVEL_EXIT_CODES.USAGE;
      if (reason === "permission_required") return HIGH_LEVEL_EXIT_CODES.PERMISSION_REQUIRED;
      return HIGH_LEVEL_EXIT_CODES.FAILED;
    }
    case "not_found": return HIGH_LEVEL_EXIT_CODES.NOT_FOUND;
    case "conflict": return HIGH_LEVEL_EXIT_CODES.CONFLICT;
    case "unknown_delivery": return HIGH_LEVEL_EXIT_CODES.UNKNOWN_STATE;
    default: return HIGH_LEVEL_EXIT_CODES.FAILED;
  }
}

/** Normalizes any thrown value into a ContractError without leaking non-contract shapes. */
export function toContractError(error: unknown): ContractError {
  if (error instanceof HighLevelError) return error.contractError;
  const parsed = ContractErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const message = error instanceof Error ? error.message : String(error);
  if (candidate !== null && typeof candidate === "object" && candidate.code === "busy")
    return conflictError(message || "Resource is busy", { reason: "busy" });
  return validationError(message.trim().length > 0 ? message : "Command failed");
}

export interface CommandReport {
  readonly command: HighLevelCommandName;
  readonly outcome: CommandOutcome;
  readonly status: CommandExecutionResult["status"];
  readonly exitCode: HighLevelExitCode;
  readonly steps: readonly CommandStep[];
  readonly data: JsonValue;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly replayed?: boolean | undefined;
  readonly artifacts?: readonly ArtifactReference[] | undefined;
  readonly error?: ContractError | undefined;
}

/** Builds and validates the envelope at the egress boundary. */
export function buildEnvelope(identity: CommandIdentity, report: CommandReport, observedAt: string): HighLevelEnvelope {
  const output: HighLevelOutput = {
    schemaVersion: 1,
    command: report.command,
    outcome: report.outcome,
    ids: {
      ...(report.runId !== undefined ? { runId: report.runId } : {}),
      ...(report.taskId !== undefined ? { taskId: report.taskId } : {}),
      ...(report.idempotencyKey !== undefined ? { idempotencyKey: report.idempotencyKey } : {})
    },
    replayed: report.replayed ?? false,
    steps: [...report.steps],
    data: report.data
  };
  const result: CommandExecutionResult = {
    schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
    commandId: identity.commandId,
    correlationId: identity.correlationId,
    status: report.status,
    ...(report.runId !== undefined ? { runId: report.runId } : {}),
    output: JSON.parse(JSON.stringify(output)) as JsonValue,
    artifacts: [...(report.artifacts ?? [])],
    ...(report.error !== undefined ? { error: report.error } : {}),
    observedAt
  };
  return HighLevelEnvelopeSchema.parse({ ok: report.exitCode === 0, command: report.command, exitCode: report.exitCode, result });
}

/** Report for an error raised before or during execution. */
export function errorReport(command: HighLevelCommandName, error: unknown, partial: Partial<CommandReport> = {}): CommandReport {
  const contractError = toContractError(error);
  const exitCode = error instanceof HighLevelError ? error.exitCode : exitCodeForError(contractError);
  const unknown = contractError.code === "unknown_delivery";
  return {
    command,
    outcome: unknown ? "reconciliation_required" : "failed",
    status: unknown ? "unknown" : "failed",
    exitCode,
    steps: partial.steps ?? [],
    data: partial.data ?? null,
    runId: partial.runId,
    taskId: partial.taskId,
    idempotencyKey: partial.idempotencyKey,
    replayed: partial.replayed,
    artifacts: partial.artifacts,
    error: contractError
  };
}
