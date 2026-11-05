import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationRequestSchema, RoleMessageSchema } from "@bflow/contracts";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { DIRECTOR_TOOL_PRINCIPAL, directorCoordinatorPort } from "../../src/agentic/host-director-mode.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { DirectorEndpoint } from "../../src/director/endpoint.js";
import { cleanups, fixture } from "../helpers/agentic-integration-fixture.js";

// B2a Task 10 fix (R-B2-12): the host's Director endpoint Coordinator port runs every Director-token call under the Director
// principal, so the legacy-run guard holds in a live Director session and not only when a caller passes the principal itself.

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const REFUSAL = "Run v2 chỉ đọc trong phiên Director; hủy rồi tạo lại bằng start_work";

async function legacySession() {
  const f = await fixture({ director: true, intake: false });
  // A run a v2 Conversation created, reopened in the Director (v3) session.
  await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => {
    state.runs.push({ runId: "run-1", delegation: DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1",
      correlationId: "correlation-1", sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: f.spec.title,
      objective: f.spec.summary, specificationId: f.spec.specId, sddLevel: f.spec.level, acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [],
      priority: "normal", requestedAt: "2026-11-03T10:00:00.000Z", idempotencyKey: "intake-1" }), status: "intake", tasks: [], coreCreated: false,
      cancelled: false, maxIterations: 3 });
    await save();
  });
  const principals: unknown[] = [];
  const logged: { kind: string; action: string }[] = [];
  const tools = new CoordinatorTools(f.runtime);
  // The host composition: the endpoint's Coordinator port is directorCoordinatorPort over the host's Coordinator tool path.
  const endpoint = new DirectorEndpoint({ directory: join(f.root, "director"), repositoryRoot: f.repository, feed: { read: () => ({ items: [] }) },
    inspect: () => f.runtime.inspect(),
    coordinator: directorCoordinatorPort({
      invoke: async (name, parameters, principal) => { principals.push(principal); return tools.invoke(name, parameters, principal); },
      planningReference: async () => ({}), log: async entry => { logged.push(entry); } }) });
  const { token } = await endpoint.register({ provider: "claude" });
  return { f, endpoint, token, principals, logged, tools };
}

describe("Director endpoint Coordinator port (host composition)", () => {
  it("refuses propose_workflow on a v2 run through the Director endpoint and still allows inspect", async () => {
    const { f, endpoint, token, principals, logged } = await legacySession();
    await expect(endpoint.call(token, "propose_workflow", { runId: "run-1", specification: f.spec, definition: f.def })).rejects.toThrow(REFUSAL);
    expect((await f.inspect()).status).toBe("intake");
    expect(await endpoint.call(token, "inspect", { runId: "run-1" })).toMatchObject({ runId: "run-1", status: "intake" });
    expect(principals).toEqual([DIRECTOR_TOOL_PRINCIPAL, DIRECTOR_TOOL_PRINCIPAL]);
    expect(logged).toEqual([{ kind: "error", action: "director:propose_workflow:failed", outcome: expect.any(String) }, { kind: "tool", action: "director:inspect:completed" }]);
  }, 60000);

  it("resumes a retained Director run with a new token after inspecting the exact blocker", async () => {
    const { f, endpoint, token } = await legacySession();
    const journal = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
    await journal.exclusive(async (state, save) => {
      const run = state.runs[0]!;
      run.delegation.requestedBy = "director";
      run.status = "escalated";
      run.error = "Startup blocker repaired";
      run.pendingAction = { actionId: `next-${digest(["run-1", "startup-blocker"])}`, kind: "resume_coordinator", owner: "coordinator", state: "pending",
        reason: run.error, sourceMessageId: "startup-blocker", createdAt: "2026-11-03T10:00:00.000Z", previousStatus: "specifying", recovery: "manual" };
      await save();
    });
    const rotated = await endpoint.register({ provider: "codex" });
    await expect(endpoint.call(token, "inspect", { runId: "run-1" })).rejects.toThrow();
    expect(await endpoint.call(rotated.token, "inspect", { runId: "run-1" })).toMatchObject({
      delegation: { requestedBy: "director", sessionId: "session-1" }, pendingAction: { actionId: `next-${digest(["run-1", "startup-blocker"])}` } });
    const resumed = await endpoint.call(rotated.token, "resume_run", { runId: "run-1", actionId: `next-${digest(["run-1", "startup-blocker"])}` });
    expect(resumed).toMatchObject({ queued: true, actionId: `next-${digest(["run-1", "startup-blocker"])}` });
    expect(await endpoint.call(rotated.token, "resume_run", { runId: "run-1", actionId: `next-${digest(["run-1", "startup-blocker"])}` })).toEqual(resumed);
    expect(await f.inspect()).toMatchObject({ status: "specifying", pendingAction: { manualResumeAttempts: 1 } });
  }, 60000);

  it("refuses resume_run for a retained Conversation-origin run", async () => {
    const { endpoint, token } = await legacySession();
    await expect(endpoint.call(token, "resume_run", { runId: "run-1", actionId: `next-${digest(["run-1", "startup-blocker"])}` })).rejects.toThrow(REFUSAL);
  }, 60000);

  it("refuses mutations of a retained Director run from another interaction session", async () => {
    const { f, endpoint, token } = await legacySession();
    await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => {
      const run = state.runs[0]!;
      run.delegation.requestedBy = "director";
      run.delegation.sessionId = "session-other";
      run.status = "escalated";
      run.pendingAction = { actionId: `next-${digest(["run-1", "foreign-blocker"])}`, kind: "resume_coordinator", owner: "coordinator", state: "pending",
        reason: "Foreign retained blocker", sourceMessageId: "foreign-blocker", createdAt: "2026-11-03T10:00:00.000Z", previousStatus: "specifying", recovery: "manual" };
      await save();
    });
    await expect(endpoint.call(token, "resume_run", { runId: "run-1", actionId: `next-${digest(["run-1", "foreign-blocker"])}` }))
      .rejects.toThrow("Cross-session Director mutation");
    expect(await f.inspect()).toMatchObject({ status: "escalated", pendingAction: { state: "pending" } });
  }, 60000);

  it("keeps foreign-session cancellation and message reconciliation outside Director authority", async () => {
    const { f, endpoint, token } = await legacySession();
    await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => {
      const run = state.runs[0]!;
      run.delegation.requestedBy = "director";
      run.delegation.sessionId = "session-other";
      run.nativeDeliveries = [{ operationId: "foreign-native", message: RoleMessageSchema.parse({ schema_version: 2,
        message_id: "foreign-message", correlation_id: "correlation-1", run_id: "run-1", sender: { role: "runtime" }, recipient: { role: "planner" },
        type: "task.status", payload: { headline: "Foreign native intent" }, artifact_references: [], occurred_at: "2026-11-03T10:00:00.000Z",
        idempotency_key: "foreign-message" }) }];
      await save();
    });
    await expect(endpoint.call(token, "cancel", { runId: "run-1", reason: "Foreign cancellation" })).rejects.toThrow("Cross-session Director mutation");
    await expect(endpoint.call(token, "reconcile_cancellation", { runId: "run-1" })).rejects.toThrow("Cross-session Director mutation");
    await expect(endpoint.call(token, "reconcile_delivery", { messageId: "foreign-message" })).rejects.toThrow("Cross-session Director mutation");
    expect(await endpoint.call(token, "inspect", { runId: "run-1" })).toMatchObject({ cancelled: false });
  }, 60000);

  it("requires unknown delivery reconciliation before a retained Director run resumes", async () => {
    const { f, endpoint, token } = await legacySession();
    await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => {
      const run = state.runs[0]!;
      run.delegation.requestedBy = "director";
      run.status = "escalated";
      run.pendingAction = { actionId: `next-${digest(["run-1", "unknown-1"])}`, kind: "reconcile_delivery", owner: "coordinator", state: "pending",
        reason: "Unknown startup delivery", sourceMessageId: "unknown-1", createdAt: "2026-11-03T10:00:00.000Z", previousStatus: "specifying", recovery: "manual" };
      const message = { schema_version: 2, message_id: "unknown-1", correlation_id: "correlation-1", run_id: "run-1",
        sender: { role: "runtime" }, recipient: { role: "planner" }, type: "task.status", payload: { headline: "uncertain" },
        artifact_references: [], occurred_at: "2026-11-03T10:00:00.000Z", idempotency_key: "unknown-1" };
      run.nativeDeliveries = [{ operationId: "native-unknown", message: RoleMessageSchema.parse(message) }];
      await save();
    });
    await expect(endpoint.call(token, "resume_run", { runId: "run-1", actionId: `next-${digest(["run-1", "unknown-1"])}` }))
      .rejects.toThrow("Unknown delivery must be reconciled before resume");
    expect(await f.inspect()).toMatchObject({ status: "escalated", pendingAction: { state: "pending" } });
  }, 60000);

  it("keeps the v2 Coordinator pane path (no Director principal) unchanged", async () => {
    const { f, tools } = await legacySession();
    await tools.invoke("propose_workflow", { runId: "run-1", specification: f.spec, definition: f.def }, { role: "coordinator" });
    expect((await f.inspect()).status).not.toBe("intake");
  }, 60000);

  it("refuses tools the Director may not use before reaching the host path", async () => {
    const { endpoint, token, principals } = await legacySession();
    await expect(endpoint.call(token, "report_progress", { runId: "run-1", headline: "x" })).rejects.toThrow("Unknown Director tool");
    const port = directorCoordinatorPort({ invoke: async (_name, _parameters, principal) => { principals.push(principal); return null; },
      planningReference: async () => ({}), log: async () => undefined });
    await expect(port.invoke("report_progress", {})).rejects.toThrow("Tool is unavailable to the Director");
    await expect(port.invoke("repository_read", {})).rejects.toThrow("Tool is unavailable to the Director");
    expect(principals).toEqual([]);
  }, 60000);
});
