import { describe, expect, it, vi } from "vitest";
import { SessionManifestV3Schema } from "@bflow/contracts";
import * as directorMode from "../../src/agentic/host-director-mode.js";
import { directorExtensionFixture, extensionDelegation } from "../helpers/director-extension.js";

const manifest = () => SessionManifestV3Schema.parse({ schemaVersion: 3, sessionId: "session-native", conversationSessionId: "session-native",
  projectName: "Native", workspaceRoot: "/tmp", herdrWorkspaceId: "w", herdrTabId: "w:t", status: "up", activeRunIds: [], panes: [],
  attachTarget: { role: "progress", tabId: "w:t", paneId: "w:progress" },
  progressPane: { tabId: "w:t", paneId: "w:progress", command: ["bflow", "progress"], phase: "running", restarts: [] },
  createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" });

describe("Director start_extension", () => {
  it("provides the Director's host admission entry", () => {
    expect(Reflect.get(directorMode, "startDirectorExtension")).toBeTypeOf("function");
  });
  const start = async (deps: unknown, principal: unknown, input: unknown) => {
    const fn = Reflect.get(directorMode, "startDirectorExtension"); expect(fn).toBeTypeOf("function"); return fn(deps, principal, input);
  };
  it("refuses an orphaned route when Runtime never admitted its run", async () => {
    const e = await directorExtensionFixture(), host = await e.create(); await host.admit(extensionDelegation());
    const wake = vi.fn();
    await expect(start({ manifest, extensions: host, wake, readRun: async () => { throw new Error("Unknown delegation run"); } },
      directorMode.DIRECTOR_TOOL_PRINCIPAL, { kind: "analysis", runId: "run-native", intake: e.intake, packPin: e.pin }))
      .rejects.toThrow("Unknown delegation run");
    expect(wake).not.toHaveBeenCalled();
    expect(e.a.transport.sentRequests).toHaveLength(0);
  });
  const readRun = async () => ({ runId: "run-native", delegation: extensionDelegation() });
  it.each([{ role: "specifier" }, { role: "web" }, { role: "coordinator" }, { role: "specifier", principal: "director" }])(
    "refuses an unauthenticated Director principal %j before starting", async principal => {
      const e = await directorExtensionFixture(), host = await e.create(); await host.admit(extensionDelegation());
      const wake = vi.fn(), spy = vi.spyOn(host, "start");
      await expect(start({ manifest, extensions: host, wake, readRun }, principal, { kind: "analysis", runId: "run-native", intake: e.intake, packPin: e.pin }))
        .rejects.toThrow(/Director|principal/);
      expect(spy).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
    });

  it("requires a matching route, session and pin, then starts idempotently and wakes the pump", async () => {
    const e = await directorExtensionFixture(), host = await e.create(), wake = vi.fn();
    const deps = { manifest, extensions: host, wake, readRun }, principal = directorMode.DIRECTOR_TOOL_PRINCIPAL;
    const input = { kind: "analysis", runId: "run-native", intake: e.intake, packPin: e.pin };
    await expect(start(deps, principal, input)).rejects.toThrow(/admi|route|delegat/);
    await host.admit(extensionDelegation());
    await expect(start(deps, principal, { ...input, packPin: { ...e.pin, digest: "f".repeat(64) } })).rejects.toThrow(/pin/);
    await expect(start({ ...deps, manifest: () => ({ ...manifest(), conversationSessionId: "foreign" }) }, principal, input)).rejects.toThrow(/session/);
    expect(await start(deps, principal, input)).toMatchObject({ kind: "analysis", coreCreated: true });
    expect(await start(deps, principal, input)).toMatchObject({ kind: "analysis", coreCreated: true });
    expect(wake).toHaveBeenCalledTimes(2); expect(wake).toHaveBeenLastCalledWith("run-native");
    await expect(start(deps, principal, { ...input, intake: { ...e.intake, title: "Changed" } })).rejects.toThrow("Conflicting immutable extension intake");
    await expect(start(deps, principal, { ...input, extra: true })).rejects.toThrow();
  });
});
