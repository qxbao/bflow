import { mkdtemp, readFile, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

it("retains a journal-only terminal outcome without creating Core events or mutating workflow state", async () => {
  const root = await mkdtemp("/tmp/bflow-telemetry-");
  const directory = `${root}/journal`, journal = new AgenticJournal(directory, root);
  try {
    await journal.exclusive(async (state, save) => {
      state.runs.push({ runId: "run-1", status: "failed", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3,
        delegation: { schemaVersion: 2, delegationId: "delegation", messageId: "message", correlationId: "correlation",
          sessionId: "session", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Test",
          objective: "Test", specificationId: "spec", sddLevel: "lightweight", acceptanceCriteria: [{ id: "criterion",
            description: "Test", category: "functional", verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }],
          inputArtifacts: [], priority: "normal", requestedAt: "2026-10-27T00:00:00Z", idempotencyKey: "key" } });
      await save();
    });
    const before = await readFile(`${directory}/state.json`);
    const runtime = new AgenticWorkflowRuntime({ runStore: { get: async () => ({ ok: true, value: null }) } } as any,
      { journalDirectory: directory, repositoryPath: root });
    const report = await runtime.telemetryReport("run-1", "2026-10-27T00:01:00Z");
    expect(report).toMatchObject({ outcome: "failed", outcomeSource: "host_journal", hostWorkStatus: "failed",
      coverage: { quality: "unavailable" }, firstPass: { value: null } });
    expect(await readFile(`${directory}/state.json`)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
