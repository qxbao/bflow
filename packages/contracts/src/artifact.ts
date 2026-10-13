import { z } from "zod";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PageRequestSchema
} from "./common.js";

export const ArtifactReferenceSchema = z
  .object({
    artifactId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    kind: z.enum(["agent-output", "document", "log", "report", "patch", "test-result", "other"]),
    uri: z.string().min(1),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    checksum: z
      .object({
        algorithm: z.enum(["sha256", "sha512"]),
        value: z.string().min(1)
      })
      .strict(),
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const ArtifactWriteOptionsSchema = z
  .object({
    artifactId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    kind: ArtifactReferenceSchema.shape.kind,
    mediaType: z.string().min(1),
    idempotencyKey: IdempotencyKeySchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const ArtifactQuerySchema = PageRequestSchema.extend({
  runId: IdentifierSchema.optional(),
  taskId: IdentifierSchema.optional(),
  kind: ArtifactReferenceSchema.shape.kind.optional()
}).strict();

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
export type ArtifactWriteOptions = z.infer<typeof ArtifactWriteOptionsSchema>;
export type ArtifactQuery = z.infer<typeof ArtifactQuerySchema>;
