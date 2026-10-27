import { z } from 'zod';
import { AgentRoleSchema } from './session.js';
import { AgentProviderIdSchema } from './platform.js';
import { SkillPinSchema } from './skills.js';
import { IdentifierSchema, IsoDateTimeSchema } from './common.js';
const Shape = {
  approvalReceiptId: IdentifierSchema,
  skillId: IdentifierSchema,
  version: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  dependencies: z.array(SkillPinSchema),
  repositoryId: IdentifierSchema,
  sessionId: IdentifierSchema
};
export const SkillApprovalRequestSchema = z.object({
  ...Shape, role: AgentRoleSchema, provider: AgentProviderIdSchema
}).strict();
export const SkillApprovalReceiptSchema = z.object({
  ...Shape,
  roles: z.array(AgentRoleSchema).min(1),
  providers: z.array(AgentProviderIdSchema).min(1),
  approvedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.optional()
}).strict();
export const SkillApprovalStoreSchema = z.object({
  schemaVersion: z.literal(3), receipts: z.array(SkillApprovalReceiptSchema)
}).strict().superRefine((store, context) => {
  if (new Set(store.receipts.map(receipt => receipt.approvalReceiptId)).size !== store.receipts.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate skill approval receipt' });
});
export type SkillApprovalRequest=z.infer<typeof SkillApprovalRequestSchema>;
export type SkillApprovalReceipt=z.infer<typeof SkillApprovalReceiptSchema>;
