import { expect, it, vi } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { projectExtensionRoutes } from "../../src/agentic/extension-projection.js";
import { state, run } from "./fixtures.js";

it("ignores a malformed extension projection with a diagnostic so ordinary session reads remain available", () => {
  const original = run(), diagnostic = vi.fn();
  const route = RoleMessageSchema.parse({ schema_version: 2, message_id: "corrupt-route", correlation_id: "c", run_id: original.runId,
    sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status", artifact_references: [],
    payload: { kind: "extension.route", route: { runId: original.runId, kind: "analysis", started: true, projection: { schemaVersion: 999 } } } });
  expect(projectExtensionRoutes(state([original]), { ...state([]), inbox: [{ status: "applied", message: route }] }, "conversation-1", diagnostic).runs).toEqual([original]);
  expect(diagnostic).toHaveBeenCalledWith("extension_projection_invalid");
});
