import { z } from "zod";
import { AgentExecutionHandleSchema, FailoverCandidateSchema, IsoDateTimeSchema, PaneBindingSchema,
  ProviderFailoverPolicySchema, ProviderFailureObservationSchema } from "@bflow/contracts";
import { CancellationStopProofSchema } from "./cancellation-stop.js";

export const TaskFailoverSchema = z.object({
  switchId: z.string().min(1), sourceMessageId: z.string().min(1), sourceBinding: PaneBindingSchema,
  sourceHandle: AgentExecutionHandleSchema, policy: ProviderFailoverPolicySchema, policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  current: FailoverCandidateSchema, failure: ProviderFailureObservationSchema, createdAt: IsoDateTimeSchema,
  phase: z.enum(["observed", "stopping", "stopped", "retired", "allocating", "allocated", "dispatched", "blocked", "cancelled"]),
  reason: z.string().max(300).optional(), stopProof: CancellationStopProofSchema.optional(),
  rejectedCandidates: z.array(FailoverCandidateSchema).max(16), destination: FailoverCandidateSchema.optional(),
  spentAt: IsoDateTimeSchema.optional(), destinationBinding: PaneBindingSchema.optional(),
  revision: z.string().regex(/^[a-f0-9]{40}$/).optional(), handoverStatus: z.enum(["selected", "absent", "withheld"]).optional(),
  destinationMessageId: z.string().min(1).optional(), ordinal: z.number().int().min(1).max(16).optional(),
  retryCount: z.number().int().min(0).max(16).default(0),
  stopAttempts: z.number().int().min(0).max(3).default(0)
}).strict().superRefine((entry, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (entry.failure.executionId !== entry.sourceHandle.executionId || entry.failure.provider !== entry.current.provider ||
      entry.sourceBinding.provider !== entry.current.provider || entry.sourceHandle.target.paneId !== entry.sourceBinding.paneId ||
      entry.sourceHandle.target.agentId !== entry.sourceBinding.agentId || entry.sourceHandle.target.worktreePath !== entry.sourceBinding.worktreePath)
    fail("failover source ownership mismatch");
  if (["stopped", "retired", "allocating", "allocated", "dispatched"].includes(entry.phase) && !entry.stopProof) fail("missing stop proof");
  if (entry.stopProof && JSON.stringify(entry.stopProof.handle) !== JSON.stringify(entry.sourceHandle)) fail("foreign stop proof");
  if (["allocating", "allocated", "dispatched"].includes(entry.phase) && (!entry.destination || !entry.spentAt || !entry.ordinal || !entry.destinationMessageId || !entry.revision)) fail("missing durable launch intent");
  if (["allocated", "dispatched"].includes(entry.phase) && !entry.destinationBinding) fail("missing destination binding");
});
export type TaskFailover = z.infer<typeof TaskFailoverSchema>;
export const failoverHoldsTask = (entries: readonly TaskFailover[] | undefined): boolean =>
  entries?.some(entry => !["dispatched", "cancelled"].includes(entry.phase)) ?? false;
