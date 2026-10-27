import { z } from "zod";
import { AgentExecutionHandleSchema, IsoDateTimeSchema, type AgentExecutionHandle, type PaneBinding } from "@bflow/contracts";

/** Correlated transport evidence at its contract level; never a claim of full OS-process containment. */
const namespaceFields = { source: z.literal("linux_pid_namespace"), observedAt: IsoDateTimeSchema,
  scopeId: z.string().uuid(), bootId: z.string().uuid(), initPid: z.number().int().positive(), initStartTime: z.string().regex(/^\d+$/),
  namespace: z.string().regex(/^pid:\[\d+\]$/), receiptDigest: z.string().regex(/^[0-9a-f]{64}$/) };
export const NamespaceExitProofSchema = z.object(namespaceFields).strict();
export type NamespaceExitProof = z.infer<typeof NamespaceExitProofSchema>;
export const CancellationStopProofSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("correlated_transport"), handle: AgentExecutionHandleSchema, observedAt: IsoDateTimeSchema }).strict(),
  z.object({ ...namespaceFields, handle: AgentExecutionHandleSchema }).strict()
]);
export type CancellationStopProof = z.infer<typeof CancellationStopProofSchema>;
export const CancellationReconciliationReportSchema = z.object({ runId: z.string().min(1), fullyStopped: z.boolean(),
  blockers: z.array(z.string()), retainedWorktrees: z.array(z.string()) }).strict().refine(report => report.fullyStopped === (report.blockers.length === 0),
    "Cancellation outcome and blockers disagree");
export type CancellationReconciliationReport = z.infer<typeof CancellationReconciliationReportSchema>;

export function ownsCancelledAllocation(runId: string, binding: PaneBinding): boolean {
  return binding.role === "developer" && binding.metadata?.runId === runId &&
    typeof binding.metadata?.taskId === "string" && binding.metadata.taskId.length > 0;
}

export function ownsCancellationPane(handle: AgentExecutionHandle, binding: PaneBinding): boolean {
  const target = handle.target;
  return binding.role === "developer" && binding.agentId === target.agentId && binding.paneId === target.paneId &&
    binding.workspaceId === target.workspaceId && binding.tabId === target.tabId && binding.terminalId === target.terminalId &&
    binding.worktreePath === target.worktreePath && binding.metadata?.taskId === `${handle.runId}-${handle.taskId}` &&
    !!binding.session && !!target.session && binding.session.source === target.session.source &&
    binding.session.kind === target.session.kind && binding.session.value === target.session.value;
}
