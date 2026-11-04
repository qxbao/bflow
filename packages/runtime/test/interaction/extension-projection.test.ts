import { expect, it, vi } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { digest } from "../../src/agentic/journal.js";
import { projectExtensionRoutes } from "../../src/agentic/extension-projection.js";
import { nativeExtensionFixture } from "../helpers/native-extension.js";
import { run, state } from "./fixtures.js";

it("scopes persisted extension projections to the current Conversation and preserves original admission identity", async () => {
  const f = await nativeExtensionFixture("analysis"), { sdk } = await f.open(); await f.start(sdk);
  const original = run("run-native"); original.delegation.sessionId = "session-native";
  const delegated = { ...original.delegation, sessionId: "old-conversation" };
  const route = { runId: "run-native", kind: "analysis", started: true, delegation: delegated,
    projection: { schemaVersion: 1, runId: "run-native", sessionId: "old-conversation", delegationDigest: digest(delegated),
      kind: "analysis", status: "specifying", cancelled: false, coreVersion: 1, definition: sdk.status("run-native").definition, approvals: [] } };
  const message = () => RoleMessageSchema.parse({ schema_version: 2, message_id: "route-1", correlation_id: "route-correlation", run_id: "run-native",
    sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status", payload: { kind: "extension.route", route },
    artifact_references: [], idempotency_key: "route-1" });
  const routes = () => ({ ...state([]), inbox: [{ message: message(), status: "applied" as const }] });
  expect(projectExtensionRoutes(state([original]), routes(), "session-native").runs).toEqual([original]);
  delegated.sessionId = "session-native"; route.projection.sessionId = "session-native"; route.projection.delegationDigest = digest(delegated);
  expect(projectExtensionRoutes(state([original]), routes(), "session-native").runs[0]).toMatchObject({ status: "specifying", coreCreated: true });
  delegated.objective = "different admitted request"; route.projection.delegationDigest = digest(delegated);
  const diagnostic = vi.fn();
  expect(projectExtensionRoutes(state([original]), routes(), "session-native", diagnostic).runs).toEqual([original]);
  expect(diagnostic).toHaveBeenCalledWith("extension_projection_delegation_mismatch");
});
