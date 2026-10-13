import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, MetadataSchema } from "./common.js";

export const ApprovalDecisionSchema = z
  .object({
    approvalId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    gateId: IdentifierSchema.optional(),
    decision: z.enum(["approved", "rejected", "changes_requested"]),
    decidedBy: z.string().min(1),
    decidedAt: IsoDateTimeSchema,
    reason: z.string().min(1).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
