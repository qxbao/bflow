import { z } from "zod";
import { ApprovalDecisionSchema } from "./approval.js";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";
import { CancellationRequestSchema } from "./execution.js";
import { WorkflowDefinitionSchema } from "./workflow.js";

export const StartRunInputSchema = z
  .object({
    runId: IdentifierSchema,
    definition: WorkflowDefinitionSchema,
    input: JsonValueSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
    requestedAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const ResumeRunInputSchema = z
  .object({
    runId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
    requestedAt: IsoDateTimeSchema
  })
  .strict();

export const RuntimeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), input: StartRunInputSchema }).strict(),
  z.object({ type: z.literal("resume"), input: ResumeRunInputSchema }).strict(),
  z.object({ type: z.literal("cancel"), input: CancellationRequestSchema }).strict(),
  z.object({ type: z.literal("approve"), input: ApprovalDecisionSchema }).strict()
]);

export type StartRunInput = z.infer<typeof StartRunInputSchema>;
export type ResumeRunInput = z.infer<typeof ResumeRunInputSchema>;
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;
