import { CancellationRequestSchema, type CancellationRequest, type OperationResult,
  type WorkflowAdvanceResult, type WorkflowRunSnapshot } from "@bflow/contracts";
import type { NativeExtensionRolePort } from "./agentic/extension-delivery.js";

/** SDK-owned Core cancellation, using the native bridge's exact stop evidence. */
export async function cancelExtension(input: {
  runId: string; reason: string; cancellation?: CancellationRequest; native: NativeExtensionRolePort; now(): string;
  persist(request: CancellationRequest): Promise<void>;
  localStopped(taskId: string, transport: string): boolean;
  unresolvedLocalWork(): boolean;
  snapshot(): Promise<WorkflowRunSnapshot>;
  mutate(action: (version: number) => Promise<OperationResult<WorkflowAdvanceResult>>): Promise<WorkflowRunSnapshot>;
  request(request: CancellationRequest): Promise<OperationResult<WorkflowAdvanceResult>>;
  confirm(command: Parameters<import("@bflow/contracts").WorkflowEngine["confirmCancellationStop"]>[0]): Promise<OperationResult<WorkflowAdvanceResult>>;
}) {
  let snapshot = await input.snapshot();
  if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) return snapshot;
  const cancellation = CancellationRequestSchema.parse(input.cancellation ?? {
    schemaVersion: 1, cancellationId: `extension-cancel-${input.runId}`, runId: input.runId,
    requestedBy: "conversation", requestedAt: input.now(), expectedVersion: snapshot.version,
    reason: input.reason, idempotencyKey: `extension:cancel:${input.runId}`
  });
  await input.persist(cancellation); // Intent survives a crash before Core/transport side effects.
  if (snapshot.status !== "cancelling") snapshot = await input.mutate(() => input.request(cancellation));
  const result = await input.native.cancel(cancellation);
  for (const stop of result.stopped) {
    snapshot = await input.snapshot();
    if (!snapshot.tasks.some(task => task.status === "cancelling" && task.agentExecution?.executionId === stop.executionId)) continue;
    snapshot = await input.mutate(version => input.confirm({ runId: input.runId, expectedVersion: version,
      idempotencyKey: `extension:cancel-stop:${input.runId}:${stop.executionId}`, confirmation: { schemaVersion: 1,
        cancellationId: cancellation.cancellationId, executionId: stop.executionId, stoppedAt: stop.stoppedAt, terminalStatus: "cancelled" } }));
  }
  snapshot = await input.snapshot();
  for (const task of snapshot.tasks.filter(task => task.status === "cancelling" && task.agentExecution)) {
    const handle = task.agentExecution!;
    if (!input.localStopped(task.taskId, handle.target.transport)) continue;
    snapshot = await input.mutate(version => input.confirm({ runId: input.runId, expectedVersion: version,
      idempotencyKey: `extension:cancel-stop:${input.runId}:${handle.executionId}`, confirmation: { schemaVersion: 1,
        cancellationId: cancellation.cancellationId, executionId: handle.executionId, stoppedAt: input.now(), terminalStatus: "cancelled" } }));
  }
  if (snapshot.status === "cancelling" && !result.unresolvedRequestIds.length && !input.unresolvedLocalWork() &&
      !snapshot.tasks.some(task => task.status === "cancelling" && task.agentExecution))
    snapshot = await input.mutate(version => input.confirm({ runId: input.runId, expectedVersion: version,
      idempotencyKey: `extension:cancel-stop:${input.runId}:unbound`, confirmation: { schemaVersion: 1,
        cancellationId: cancellation.cancellationId, stoppedAt: input.now(), terminalStatus: "cancelled" } }));
  return snapshot;
}
