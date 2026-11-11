import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, SpecificationSchema } from "@bflow/contracts";
import { measureBehavior } from "../../src/agentic/behavioral-runner.js";
import { TaskBlocker } from "../../src/agentic/blockers.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, fixture } from "../helpers/behavioral-runner-fixture.js";

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("behavioral measurement blockers", () => {
  it("reports every declared test path absent from the pinned commit before running a command", async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, "test/second.test.cjs"), "const {test}=require('node:test'); test('second',()=>{});\n");
    const revision = f.commit("Add second test");
    const testPaths = ["test/behavior.test.cjs", "test/second.test.cjs", "test/future.test.cjs", "test/later.test.cjs"];

    const error = await measureBehavior({ ...f.command, testPaths }, f.cwd, revision).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(TaskBlocker);
    expect(error).toMatchObject({
      code: "declared_test_missing",
      fixableBy: "director",
      details: { paths: ["test/future.test.cjs", "test/later.test.cjs"], revision }
    });
    expect((error as Error).message).toBe("Behavioral test identity must be a committed regular file: test/future.test.cjs, test/later.test.cjs");
  });

  it("returns a plan mismatch from check_work when an accepted test is absent from the commit", async () => {
    const f = await fixture();
    const missing = "test/future.test.cjs";
    const testPaths = ["test/behavior.test.cjs", missing];
    const specification = SpecificationSchema.parse({ ...f.specification, affectedPaths: testPaths });
    const command = { ...f.command, testPaths };
    const developer = PaneBindingSchema.parse({ ...f.binding, bindingId: "developer-binding", role: "developer",
      agentId: "dev-1", paneId: "developer-pane", worktreePath: f.cwd, readOnlyWorkspace: false });
    const message = { schema_version: 2, message_id: "assignment", correlation_id: "correlation", run_id: "run-1",
      sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "dev-1", pane_id: "developer-pane" },
      type: "task.assignment", payload: {}, artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: "assignment" };
    const handle = { executionId: "execution-1", requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1",
      idempotencyKey: "assignment-1", target: { transport: "herdr", agentId: "dev-1", workspaceId: "workspace", tabId: "tab",
        paneId: "developer-pane", worktreePath: f.cwd }, correlation: { token: "request-1", provenance: "orchestrator", verified: false },
      acceptedAt: new Date().toISOString() };
    const task = { spec: { specification, strategy: f.strategy }, worktrees: [{ baseCommitHash: f.base }] };
    const runtime = { inspect: async () => ({ outbound: [{ status: "accepted", taskId: "task-1", attemptId: "attempt-1", message, handle }] }),
      withDeveloperWorkspace: async (_binding: unknown, _runId: string, _taskId: string, use: (...args: any[]) => Promise<unknown>) =>
        use(task, { metadata: { ownedPaths: testPaths } }),
      ports: { artifactStore: f.store, policies: { assertReadyToImplement: () => undefined } } } as unknown as AgenticWorkflowRuntime;
    const development = new HostDevelopment(() => runtime, [command]);

    const result = await development.check(developer, { runId: "run-1", taskId: "task-1" });

    expect(result).toMatchObject({ status: "blocked", classification: "plan_mismatch", independentAcceptanceEvidence: false,
      blocker: { code: "declared_test_missing", fixableBy: "director", details: { paths: [missing], revision: f.redRevision } },
      reason: expect.stringContaining("Behavioral test identity must be a committed regular file"),
      recovery: expect.stringContaining("Resume không sửa được") });
  });
});
