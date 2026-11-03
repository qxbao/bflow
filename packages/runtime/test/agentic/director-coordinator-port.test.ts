import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationRequestSchema } from "@bflow/contracts";
import { AgenticJournal } from "../../src/agentic/journal.js";
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
