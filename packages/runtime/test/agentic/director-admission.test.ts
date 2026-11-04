import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationRequestSchema, RoleMessageSchema } from "@bflow/contracts";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { DIRECTOR_LEGACY_RUN_MESSAGE } from "../../src/agentic/runtime.js";
import { CoordinatorTools, DIRECTOR_LEGACY_RUN_TOOLS } from "../../src/agentic/tools.js";
import { cleanups, fixture } from "../helpers/agentic-integration-fixture.js";

// B2a Task 4 (R-B2-4, R-B2-12): the Director opens runs itself, can cancel them, and cannot mutate v2 Conversation runs.

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

type Fixture = Awaited<ReturnType<typeof fixture>>;
function directorDelegation(f: Fixture, overrides: Record<string, unknown> = {}) {
  const at = "2026-11-03T10:00:00.000Z"; // fixed so a replay is byte-identical
  return DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation-d1", messageId: "director-intake-1", correlationId: "correlation-d1",
    sessionId: "session-1", runId: "run-1", requestedBy: "director", targetRole: "coordinator", title: f.spec.title, objective: f.spec.summary,
    specificationId: f.spec.specId, sddLevel: f.spec.level, acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal",
    requestedAt: at, idempotencyKey: "director:director-intake-1", ...overrides });
}
const state = async (f: Fixture) => (await f.runtime.inspect() as any);
const tools = (f: Fixture) => new CoordinatorTools(f.runtime);
const director = { role: "coordinator", principal: "director" } as const;

function cancelEnvelope(runId: string, sessionId = "session-1") {
  const at = new Date().toISOString(), id = "cancel-control-d1";
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "cancel-correlation-d1", run_id: runId,
    sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request",
    payload: { schemaVersion: 2, delegationId: "cancel-delegation-d1", messageId: id, correlationId: "cancel-correlation-d1", sessionId, runId,
      requestedBy: "conversation", targetRole: "coordinator", title: "Cancel existing run", objective: "User requested cancellation",
      specificationId: "cancel-spec", sddLevel: "lightweight",
      acceptanceCriteria: [{ id: "ac-cancel", description: "Cancel", category: "functional", verificationMethod: "manual_review", required: true,
        status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "critical", requestedAt: at, idempotencyKey: id,
      metadata: { action: "cancel", targetRunId: runId, cancellationRequest: { schemaVersion: 1, cancellationId: "cancel-d1", runId,
        requestedBy: "conversation", requestedAt: at, expectedVersion: 1, reason: "User requested cancellation", idempotencyKey: id } } },
    artifact_references: [], occurred_at: at, idempotency_key: id });
}

describe("Director admission", () => {
  it("opens an intake run, notifies the user and never queues anything for the Coordinator", async () => {
    const f = await fixture({ director: true, intake: false });
    expect(await f.runtime.admitDirectorWork(directorDelegation(f))).toEqual({ runId: "run-1", correlationId: "correlation-d1", admission: "new" });
    const s = await state(f);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ runId: "run-1", status: "intake", cancelled: false, delegation: { requestedBy: "director" } });
    expect(s.outbound.map((out: any) => [out.message.type, out.message.recipient.role])).toEqual([["delegation.accepted", "conversation"]]);
    expect(s.outbound.some((out: any) => out.message.recipient.role === "coordinator")).toBe(false);
    expect(JSON.parse(await readFile(join(f.runtimeOptions.journalDirectory, "state.json"), "utf8")).version).toBe(8);
  });

  it("is idempotent for the same delegation and refuses different content for the same run", async () => {
    const f = await fixture({ director: true, intake: false });
    await f.runtime.admitDirectorWork(directorDelegation(f));
    expect(await f.runtime.admitDirectorWork(directorDelegation(f))).toEqual({ runId: "run-1", correlationId: "correlation-d1", admission: "duplicate" });
    expect((await state(f)).outbound).toHaveLength(1);
    await expect(f.runtime.admitDirectorWork(directorDelegation(f, { objective: "A different objective" }))).rejects.toThrow(/another delegation/);
    expect((await state(f)).runs).toHaveLength(1);
  });

  it("refuses requirement revisions with the slice-B2 guidance", async () => {
    const f = await fixture({ director: true, intake: false });
    await f.runtime.admitDirectorWork(directorDelegation(f));
    await expect(f.runtime.admitDirectorWork(directorDelegation(f, { objective: "Changed", metadata: { isRequirementChange: true, revision: 2 },
      messageId: "director-intake-2", idempotencyKey: "director:director-intake-2" })))
      .rejects.toThrow("Director requirement revisions are not supported in slice B2; cancel the run and call start_work again");
  });

  it("requires a Director (v3) manifest and the same interaction session", async () => {
    const legacy = await fixture({ intake: false });
    await expect(legacy.runtime.admitDirectorWork(directorDelegation(legacy))).rejects.toThrow("Director work requires an active Director session");
    const f = await fixture({ director: true, intake: false });
    await expect(f.runtime.admitDirectorWork(directorDelegation(f, { sessionId: "session-other" }))).rejects.toThrow("Cross-session delegation");
    await expect(f.runtime.admitDirectorWork({ ...directorDelegation(f), requestedBy: "conversation" })).rejects.toThrow();
    expect((await state(f)).runs).toHaveLength(0);
  });

  it("lets the Director plan the run it created like the Coordinator would", async () => {
    const f = await fixture({ director: true, intake: false });
    await f.runtime.admitDirectorWork(directorDelegation(f));
    await tools(f).invoke("propose_workflow", { runId: "run-1", specification: f.spec, definition: f.def }, director);
    expect((await state(f)).runs[0].status).not.toBe("intake");
  });

  it("cancels a Director run through the cancel tool", async () => {
    const f = await fixture({ director: true, intake: false });
    await f.runtime.admitDirectorWork(directorDelegation(f));
    await tools(f).invoke("cancel", { runId: "run-1", reason: "Director changed course" }, director);
    expect((await state(f)).runs[0]).toMatchObject({ cancelled: true });
  });

  it("cancels a Director run through the Web cancellation handoff", async () => {
    const f = await fixture({ director: true, intake: false });
    await f.runtime.admitDirectorWork(directorDelegation(f));
    await f.runtime.queueHerdr(cancelEnvelope("run-1"));
    expect((await state(f)).runs[0]).toMatchObject({ cancelled: true });
  });

  it("still refuses a cancellation from another session", async () => {
    const f = await fixture({ director: true, intake: false });
    await f.runtime.admitDirectorWork(directorDelegation(f));
    await expect(f.runtime.queueHerdr(cancelEnvelope("run-1", "session-other"))).rejects.toThrow();
    expect((await state(f)).runs[0]).toMatchObject({ cancelled: false });
  });

  it("blocks mutating tools on a v2 run for the Director principal but keeps the read and cancel set", async () => {
    const f = await fixture({ director: true, intake: false });
    await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (s, save) => {
      s.runs.push({ runId: "run-1", delegation: directorDelegation(f, { requestedBy: "conversation", messageId: "intake-1", idempotencyKey: "intake-1" }),
        status: "intake", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 });
      await save();
    });
    await expect(tools(f).invoke("propose_workflow", { runId: "run-1", specification: f.spec, definition: f.def }, director))
      .rejects.toThrow(DIRECTOR_LEGACY_RUN_MESSAGE);
    expect(DIRECTOR_LEGACY_RUN_MESSAGE).toBe("Run v2 chỉ đọc trong phiên Director; hủy rồi tạo lại bằng start_work");
    expect(await tools(f).invoke("inspect", { runId: "run-1" }, director)).toMatchObject({ runId: "run-1" });
    expect(DIRECTOR_LEGACY_RUN_TOOLS).toContain("cancel");
    await tools(f).invoke("cancel", { runId: "run-1", reason: "Recreate with start_work" }, director);
    expect((await state(f)).runs[0]).toMatchObject({ cancelled: true });
  });
});
