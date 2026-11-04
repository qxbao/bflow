import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { selectNativeExtensionScope } from "../../src/agentic/extension-permissions.js";
import { WorkflowExtensionPump } from "../../src/agentic/extension-pump.js";
import { nativeExtensionFixture } from "../helpers/native-extension.js";

async function delivery() {
  const f = await nativeExtensionFixture("analysis");
  const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "elicitation", correlation_id: "correlation-native",
    run_id: "run-native", sender: { role: "coordinator" }, recipient: { role: "specifier" }, type: "delegation.request",
    payload: {}, artifact_references: [], idempotency_key: "elicitation" });
  const intent = { family: "analysis" as const, runId: "run-native", taskId: "elicitation", attemptId: "attempt-1",
    requestKey: "first-elicitation", message, allowedReadPaths: ["src"], outputKind: "analysis.elicitation" };
  return { ...f, intent, journal: new AgenticJournal(join(f.root, "delivery"), f.repo) };
}

describe("native extension review hardening", () => {
  it.each(["sending", "unknown_delivery"] as const)("blocks another preparation while %s has no returned handle", async status => {
    const f = await delivery(); await f.native.prepare(f.intent);
    await f.journal.exclusive(async (state, save) => { state.outbound[0]!.status = status; await save(); });
    await expect(f.native.prepare({ ...f.intent, requestKey: "second-elicitation" })).rejects.toThrow(/unsettled/);
    expect(f.transport.sentRequests).toHaveLength(0);
  });

  it("clears a released extension lockout for a newer accepted task.status on the same bound session", async () => {
    const f = await delivery(), request = await f.native.prepare(f.intent), handle = await f.native.dispatch(request);
    const native = (await f.native.snapshot()).outbound.map(out => ({ ...out, status: "released" as const }));
    const ordinary = [{ status: "accepted", message: RoleMessageSchema.parse({ ...native[0]!.message, type: "task.status", payload: {} }),
      handle: { ...handle, acceptedAt: new Date(Date.parse(handle.acceptedAt) + 1000).toISOString() } }];
    const binding = f.panes.get("specifier")!;
    expect(selectNativeExtensionScope(native, ordinary, binding)).toBeUndefined();
    expect(selectNativeExtensionScope(native, [{ ...ordinary[0]!, handle: { ...ordinary[0]!.handle,
      target: { ...handle.target, session: { source: "herdr:codex", kind: "id", value: "foreign" } } } }], binding)?.state).toBe("settled");
  });

  it("retains a held run and reports diagnostics when reporting its drive failure also fails", async () => {
    const drive = vi.fn(async () => { throw new Error("unknown delivery"); }), log = vi.fn();
    const pump = new WorkflowExtensionPump({ inspect: async () => ({ runs: [{ runId: "run-native", coreCreated: true, extensionStatus: "running" }] }), drive },
      async () => { throw new Error("notice unavailable"); }, log);
    await pump.tick(); await pump.drain(); await pump.tick(); await pump.drain();
    expect(pump.snapshot().heldRunIds).toEqual(["run-native"]);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("run-native", expect.any(Error));
  });

  it("reads only the selected pane outbox without cloning the full native journal", async () => {
    const f = await delivery(); await f.native.prepare(f.intent);
    const clone = vi.spyOn(globalThis, "structuredClone");
    const paneOutbox = await f.native.outboundForPane("unrelated-pane");
    expect(paneOutbox).toEqual([]);
    expect(clone.mock.calls.some(([value]) => value && typeof value === "object" && "inbox" in value)).toBe(false);
    clone.mockRestore();
  });

  it("does not let a read projection mutate the journal's cached authority", async () => {
    const f = await delivery(); await f.native.prepare(f.intent);
    const selected = await f.native.outboundForPane("w:specifier");
    selected[0]!.status = "cancelled";
    expect((await f.native.outboundForPane("w:specifier"))[0]!.status).toBe("queued");
    await expect(f.journal.project(state => { state.outbound.push(selected[0]!); return null; })).rejects.toThrow(TypeError);
    expect((await f.native.outboundForPane("w:specifier"))[0]!.status).toBe("queued");
  });
});
