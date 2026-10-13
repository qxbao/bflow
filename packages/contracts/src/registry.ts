import { z } from "zod";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";

export const AgentConfigurationSchema = z
  .object({
    agentId: IdentifierSchema,
    role: z.string().min(1),
    transport: z.string().min(1),
    enabled: z.boolean(),
    priority: z.number().int(),
    maxConcurrentTasks: z.number().int().min(1),
    capabilities: z.array(z.string().min(1)),
    settings: JsonValueSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const AgentResolutionContextSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    requiredCapabilities: z.array(z.string().min(1)),
    preferredAgentId: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export const AcquireAgentLeaseRequestSchema = z
  .object({
    leaseId: IdentifierSchema,
    agentId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    ttlMs: z.number().int().positive(),
    requestedAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const AgentLeaseSchema = z
  .object({
    leaseId: IdentifierSchema,
    agentId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    fencingToken: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    acquiredAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((lease, context) => {
    if (Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be after acquiredAt",
        path: ["expiresAt"]
      });
    }
  });

export const RenewAgentLeaseRequestSchema = z
  .object({
    leaseId: IdentifierSchema,
    fencingToken: z.number().int().positive(),
    expectedVersion: z.number().int().nonnegative(),
    ttlMs: z.number().int().positive(),
    requestedAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const ReleaseAgentLeaseRequestSchema = z
  .object({
    leaseId: IdentifierSchema,
    fencingToken: z.number().int().positive(),
    expectedVersion: z.number().int().nonnegative(),
    releasedAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>;
export type AgentResolutionContext = z.infer<typeof AgentResolutionContextSchema>;
export type AcquireAgentLeaseRequest = z.infer<typeof AcquireAgentLeaseRequestSchema>;
export type AgentLease = z.infer<typeof AgentLeaseSchema>;
export type RenewAgentLeaseRequest = z.infer<typeof RenewAgentLeaseRequestSchema>;
export type ReleaseAgentLeaseRequest = z.infer<typeof ReleaseAgentLeaseRequestSchema>;
