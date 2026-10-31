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

/**
 * Fail-closed check for a read-only/non-writer specialist pane when Herdr wait reports `not_found`.
 * Confirms absence when the pane is missing from the manifest, `inspectRoleHealth` reports `not_found`,
 * `paneExists === false`, or the specialist CLI process exited leaving the pane at a bare disconnected shell
 * (`status: "not_ready"`, `transportState: "disconnected"`, `readyForPrompt: false`, `occupantMatches: false`).
 * Never confirms `agent_replaced` or active/unknown occupants.
 */
export function isSpecialistHealthConfirmedAbsent(
  targetPaneId: string,
  health:
    | {
        ok: true;
        value: {
          status?: string;
          transportState?: string;
          readyForPrompt: boolean;
          occupantMatches: boolean;
          paneExists?: boolean;
          paneId: string;
        };
      }
    | { ok: false; error: { code: string } }
): boolean {
  if (!health.ok) return health.error.code === "not_found";
  if (health.value.paneId !== targetPaneId) return false;
  if (health.value.paneExists === false) return true;
  return (
    health.value.status === "not_ready" &&
    health.value.transportState === "disconnected" &&
    health.value.readyForPrompt === false &&
    health.value.occupantMatches === false
  );
}
