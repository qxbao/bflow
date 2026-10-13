import { z } from "zod";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PageRequestSchema
} from "./common.js";

export const ArtifactIdSchema = IdentifierSchema.refine(
  (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
  "artifactId must be an opaque identifier, not a path"
);

export const ArtifactKindSchema = z.enum([
  "agent-output",
  "document",
  "log",
  "report",
  "patch",
  "test-result",
  "other"
]);

export const ArtifactChecksumSchema = z.discriminatedUnion("algorithm", [
  z.object({ algorithm: z.literal("sha256"), value: z.string().regex(/^[a-f0-9]{64}$/i) }).strict(),
  z.object({ algorithm: z.literal("sha512"), value: z.string().regex(/^[a-f0-9]{128}$/i) }).strict()
]);

export const ArtifactProposalSchema = z
  .object({
    proposalId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    kind: ArtifactKindSchema,
    logicalName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..", {
        message: "logicalName must be a file name, not a path"
      }),
    mediaType: z.string().min(1),
    expectedIntegrity: z
      .object({
        checksum: ArtifactChecksumSchema,
        sizeBytes: z.number().int().nonnegative().optional()
      })
      .strict(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export const ArtifactReferenceSchema = z
  .object({
    trust: z.literal("stored"),
    artifactId: ArtifactIdSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    kind: ArtifactKindSchema,
    uri: z.string().regex(/^artifact:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    checksum: ArtifactChecksumSchema,
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((reference, context) => {
    const match = /^artifact:\/\/([^/]+)\/([^/]+)$/.exec(reference.uri);
    const storeId = match?.[1];
    const uriArtifactId = match?.[2];
    if (storeId === "." || storeId === ".." || uriArtifactId === "." || uriArtifactId === "..") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact URI segments cannot traverse paths", path: ["uri"] });
    }
    if (uriArtifactId !== reference.artifactId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifact URI identifier must match artifactId",
        path: ["uri"]
      });
    }
  });

export const ArtifactWriteOptionsSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    kind: ArtifactKindSchema,
    mediaType: z.string().min(1),
    expectedIntegrity: z
      .object({
        checksum: ArtifactChecksumSchema,
        sizeBytes: z.number().int().nonnegative().optional()
      })
      .strict(),
    idempotencyKey: IdempotencyKeySchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const ArtifactQuerySchema = PageRequestSchema.extend({
  runId: IdentifierSchema.optional(),
  taskId: IdentifierSchema.optional(),
  kind: ArtifactKindSchema.optional()
}).strict();

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
export type ArtifactProposal = z.infer<typeof ArtifactProposalSchema>;
export type ArtifactChecksum = z.infer<typeof ArtifactChecksumSchema>;
export type ArtifactWriteOptions = z.infer<typeof ArtifactWriteOptionsSchema>;
export type ArtifactQuery = z.infer<typeof ArtifactQuerySchema>;
