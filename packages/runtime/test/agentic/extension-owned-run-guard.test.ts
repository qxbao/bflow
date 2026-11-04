import { expect, it } from "vitest";
import { record } from "../../src/agentic/journal.js";
import { directorNativeFlow } from "../helpers/director-native-flow.js";


it("refuses the Developer DAG for an extension-owned run and ticks without any Herdr task dispatch", async () => {
  const f = await directorNativeFlow(), runId = String(record(await f.start()).runId);
  await expect(f.endpoint.call(f.token, "propose_workflow", { runId, specification: { ...f.parent.spec, runId }, definition: f.parent.def })).rejects.toThrow(/Extension workflow/);
  await f.runtime.tick();
  expect(f.parent.transport.sentRequests).toHaveLength(0);
  expect(f.native.transport.sentRequests).toHaveLength(0);
  expect(await f.runtime.inspect(runId)).toMatchObject({ coreCreated: false, tasks: [] });
});
