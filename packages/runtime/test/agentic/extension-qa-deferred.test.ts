import { expect, it, vi } from "vitest";
import { buildAnalysisPack } from "../../src/analysis/pack.js";
import { workflowPackDigest } from "../../src/planning/index.js";
import { AgenticJournal, json, record } from "../../src/agentic/journal.js";
import { QaWorkflowRuntime } from "../../src/qa/workflow.js";
import { directorExtensionFixture, extensionDelegation } from "../helpers/director-extension.js";
import { nativeExtensionFixture } from "../helpers/native-extension.js";

it.each(["start", "drive"] as const)("fences persisted pre-D6 QA %s without launching specialists", async action => {
  const e = await directorExtensionFixture(), q = await nativeExtensionFixture("qa"), { sdk, engine } = await q.open();
  if (!(sdk instanceof QaWorkflowRuntime)) throw new Error("Wrong SDK fixture");
  const pack = buildAnalysisPack({ id: "legacy-qa", version: "1" });
  pack.defaults = { "workflow.id": "bflow.qa-only", "workflow.version": "1", "capabilities.required": ["workflow.qa_only"] };
  pack.digest = workflowPackDigest(pack);
  const request = extensionDelegation("run-native", false);
  const journal = new AgenticJournal(e.options.journalDirectory, e.a.repo);
  // A real formerly admitted route persisted by PR82, before D6 split its contracts from this branch.
  await journal.exclusive(async (state, save) => {
    state.inbox.push({ status: "applied", message: { schema_version: 2, message_id: "old-qa-route", correlation_id: request.correlationId,
      run_id: request.runId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status", artifact_references: [],
      payload: json({ kind: "extension.route", route: { schemaVersion: 1, runId: request.runId, kind: "qa", delegation: request, pack,
        started: action === "drive", decisions: [], completionNotified: false } }) } });
    await save();
  });
  const host = await e.create({ admissionOrigin: "conversation", qa: sdk, engine, native: q.native, runStore: q.runStore, readPack: async () => pack });
  if (action === "drive") await q.start(sdk);
  const call = vi.spyOn(sdk, action);
  const operation = action === "drive" ? host.drive("run-native") : host.start({ kind: "qa", runId: "run-native", packPin: pack,
    intake: { schemaVersion: 1, requestId: "legacy-qa", sessionId: "session-native", title: "Legacy native QA", userStatements: [{ id: "U-1", text: "Check health" }],
      target: { environmentId: "fixture", kind: "fixture", origins: ["http://127.0.0.1:8123"], readinessPath: "/health" },
      criteria: [{ id: "AC-1", description: "Health returns HTTP 200" }], allowedActions: ["http_read"], accountPolicy: { accounts: [] },
      dataPolicy: { fixturePrefix: "legacy-qa" }, cleanup: { required: true }, workspace: { assetRoot: "qa" }, protectedPaths: [] } });
  await expect(operation).rejects.toThrow("Native QA admission awaits its Runtime HTTP contract decision");
  expect(call).not.toHaveBeenCalled(); expect(q.transport.sentRequests).toHaveLength(0);
  expect(record(await host.inspect("run-native")).kind).toBe("qa");
  if (action === "drive") expect(await host.cancel("run-native", "Owner retired deferred QA")).toMatchObject({ cancelled: true });
});
