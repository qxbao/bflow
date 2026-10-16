import type { DomainEvent } from "./events.js";
import { CURRENT_DOMAIN_EVENT_SCHEMA_VERSION, DomainEventSchema } from "./events.js";
import type { RecoveryCheckpoint } from "./execution.js";
import { RecoveryCheckpointSchema } from "./execution.js";
import type { OperationResult } from "./errors.js";
import type { WorkflowRunSnapshot } from "./workflow.js";
import { WorkflowRunSnapshotSchema } from "./workflow.js";
import { WorkflowAggregateCheckpointStateSchema, type WorkflowAggregateCheckpointState } from "./recovery.js";

export const CURRENT_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_DOMAIN_EVENT_SCHEMA_VERSIONS = [0, CURRENT_DOMAIN_EVENT_SCHEMA_VERSION, 2] as const;
export const SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS = [0, CURRENT_CHECKPOINT_SCHEMA_VERSION] as const;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validationFailure<T>(message: string): OperationResult<T> {
  return { ok: false, error: { code: "validation", retryable: false, message } };
}

export function parseDomainEventWithCompatibility(input: unknown): OperationResult<DomainEvent> {
  const record = objectRecord(input);
  if (record === undefined) return validationFailure("domain event must be an object");
  const version = record.schemaVersion ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return validationFailure("domain event schemaVersion must be a non-negative integer");
  }
  if (!SUPPORTED_DOMAIN_EVENT_SCHEMA_VERSIONS.includes(version as 0 | 1 | 2)) {
    return {
      ok: false,
      error: {
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [...SUPPORTED_DOMAIN_EVENT_SCHEMA_VERSIONS],
        receivedVersion: version,
        message: `unsupported domain event schema version: ${version}`
      }
    };
  }

  // P00 legacy events had the current payload shape but no envelope schemaVersion.
  const candidate = version === 0 ? { ...record, schemaVersion: CURRENT_DOMAIN_EVENT_SCHEMA_VERSION } : record;
  const parsed = DomainEventSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : validationFailure(`invalid domain event: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
}

export function parseRecoveryCheckpointWithCompatibility(input: unknown): OperationResult<RecoveryCheckpoint> {
  const record = objectRecord(input);
  if (record === undefined) return validationFailure("checkpoint must be an object");
  const version = record.checkpointSchemaVersion ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return validationFailure("checkpointSchemaVersion must be a non-negative integer");
  }
  if (!SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS.includes(version as 0 | 1)) {
    return {
      ok: false,
      error: {
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [...SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS],
        receivedVersion: version,
        message: `unsupported checkpoint schema version: ${version}`
      }
    };
  }

  // P00 legacy checkpoints used JSON state and omitted explicit codec metadata.
  const candidate =
    version === 0
      ? {
          ...record,
          checkpointSchemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
          codec: { name: "bflow.workflow-run-snapshot+json", version: 1 }
        }
      : record;
  const parsed = RecoveryCheckpointSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : validationFailure(`invalid checkpoint: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
}

export function decodeWorkflowRunCheckpointState(
  checkpoint: RecoveryCheckpoint
): OperationResult<WorkflowRunSnapshot> {
  if (checkpoint.codec.name !== "bflow.workflow-run-snapshot+json" || checkpoint.codec.version !== 1) {
    return validationFailure("checkpoint codec is not supported by the workflow snapshot decoder");
  }
  const parsed = WorkflowRunSnapshotSchema.safeParse(checkpoint.state);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `checkpoint state does not match its codec: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`
        }
      };
}

export function decodeWorkflowAggregateCheckpointState(
  checkpoint: RecoveryCheckpoint
): OperationResult<WorkflowAggregateCheckpointState> {
  if (checkpoint.codec.name !== "bflow.workflow-aggregate+json" || ![1, 2].includes(checkpoint.codec.version)) {
    return validationFailure("checkpoint codec is not supported by the workflow aggregate decoder");
  }
  const parsed = WorkflowAggregateCheckpointStateSchema.safeParse(checkpoint.state);
  if (parsed.success && checkpoint.codec.version === 1 && requiresAuthenticatedBindingCodec(parsed.data))
    return validationFailure("Authenticated bindings require aggregate codec 2");
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: {
      code: "corruption", retryable: false,
      message: `checkpoint aggregate state does not match its codec: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    } };
}

export function requiresAuthenticatedBindingCodec(state: WorkflowAggregateCheckpointState): boolean {
  return state.snapshot.tasks.some(task => !!task.bindingVerification) || state.commands.some(command =>
    command.result.snapshot.tasks.some(task => !!task.bindingVerification) ||
    command.result.emittedEvents.some(event => event.type === "agent.binding_verified"));
}
