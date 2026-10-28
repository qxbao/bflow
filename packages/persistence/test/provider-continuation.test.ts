import { expect, it } from "vitest";
import { DomainEventSchema, StoredRunSchema } from "@bflow/contracts";
import { project } from "../src/projection.js";
import { now, workflow, runCreatedEvent } from "../../contracts/test/fixtures.js";
it("projects a declared execution continuation while refusing an undeclared binding replacement", () => {
  const definition = workflow([]), taskId = definition.tasks[0]!.id;
  const old = { executionId: "old", requestId: "old-request", attemptId: "attempt", runId: "run-1", taskId,
    idempotencyKey: "old-key", acceptedAt: now, target: { transport: "test", agentId: "old-agent", paneId: "old-pane" },
    correlation: { token: "old-token", provenance: "transport", verified: true } };
  const run = StoredRunSchema.parse({ definition, snapshot: { runId: "run-1", workflowId: definition.id, workflowVersion: definition.version,
    status: "running", tasks: definition.tasks.map(task => ({ taskId: task.id, status: "running", attempt: 1, generation: 0, version: 0,
      attemptId: "attempt", agentExecution: { ...old, taskId: task.id } })), createdAt: now, updatedAt: now, version: 0, lastEventSequence: 0 } });
  const handle = { ...old, executionId: "new", requestId: "new-request", target: { ...old.target, agentId: "new-agent", paneId: "new-pane" } };
  const base = { ...runCreatedEvent(), taskId, type: "agent.execution_bound", payload: { handle, attempt: 1 } };
  expect(() => project(run, [DomainEventSchema.parse(base)])).toThrow("Execution binding mismatch");
  const event = DomainEventSchema.parse({ ...base, payload: { ...base.payload, continuation: { previousExecutionId: old.executionId,
    switchId: "switch", policyDigest: "a".repeat(64), stoppedAt: now, ordinal: 1 } } });
  expect(project(run, [event]).snapshot.tasks[0]!.agentExecution).toEqual(handle);
});
