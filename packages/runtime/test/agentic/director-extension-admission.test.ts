import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDelegationRequest } from "@bflow/conversation";
import { DelegationRequestSchema } from "@bflow/contracts";
import { startDirectorWork } from "../../src/agentic/host-director-mode.js";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { directorExtensionFixture, extensionDelegation } from "../helpers/director-extension.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe("Director extension admission", () => {
  it("admits analysis before the Runtime run exists and replays without another route or run", async () => {
    const f = await fixture({ director: true, intake: false }), e = await directorExtensionFixture();
    const manifest = { ...unwrap(await f.panes.getManifest()), conversationSessionId: "session-native" };
    const calls: string[] = [];
    const extensions = await e.create({ isLegacyImplementationRun: async runId => {
      const exists = (await f.runtime.inspect() as any).runs.some((run: any) => run.runId === runId);
      calls.push(`legacy:${exists}`); return exists;
    } });
    const input = { key: "director:user-analysis", title: "Health analysis", objective: "Specify health", kind: "spike" as const,
      sddLevel: "lightweight" as const, priority: "normal" as const, requestedAt: "2026-11-04T00:00:00.000Z", nativeFamily: "analysis" as const,
      acceptanceCriteria: [{ description: "Traceable health specification", verificationMethod: "manual_review" as const }] };
    // Fixture Runtime reads its own manifest too.
    const original = f.panes.getManifest.bind(f.panes); f.panes.getManifest = async () => ({ ...await original(), value: manifest });
    const deps = { manifest: () => manifest, build: buildDelegationRequest,
      admitExtension: async (request: any) => { calls.push("extension"); return extensions.admit(request); },
      admitDirectorWork: async (request: any) => { calls.push("runtime"); return f.runtime.admitDirectorWork(request); }, log: vi.fn(async () => {}) };
    const first = await startDirectorWork(deps, input);
    expect(calls).toEqual(["extension", "legacy:false", "runtime"]);
    expect(await extensions.inspect(first.runId)).toMatchObject({ kind: "analysis" });
    const routes = new AgenticJournal(e.options.journalDirectory, e.a.repo);
    const count = await routes.exclusive(async state => state.inbox.length);
    expect(await startDirectorWork(deps, input)).toEqual(first);
    expect(await routes.exclusive(async state => state.inbox.length)).toBe(count);
    expect((await f.runtime.inspect() as any).runs).toHaveLength(1);
    expect(await extensions.admit((await f.runtime.inspect(first.runId) as any).delegation)).toBe("analysis");
  });

  it.each([
    { requestedBy: "web", metadata: { origin: "director", nativeFamily: "analysis" } },
    { requestedBy: "director", metadata: { nativeFamily: "analysis" } },
    { requestedBy: "conversation", metadata: { origin: "director", nativeFamily: "analysis" } },
    { requestedBy: "director", sessionId: "foreign" }
  ])("refuses a foreign Director delegation %j", async overrides => {
    const e = await directorExtensionFixture(), host = await e.create();
    await expect(host.admit({ ...extensionDelegation(), ...overrides } as any)).rejects.toThrow(/admission|delegation|session|requestedBy/i);
    expect(await host.owns("run-native")).toBe(false);
  });

  it("uses implementation by default per run despite the session's analysis pack and stores no route", async () => {
    const e = await directorExtensionFixture(), host = await e.create();
    expect(await host.admit({ ...extensionDelegation(), metadata: { origin: "director" } })).toBe("implementation");
    expect(await host.owns("run-native")).toBe(false);
    expect(await new AgenticJournal(e.options.journalDirectory, e.a.repo).exclusive(async state => state.inbox)).toEqual([]);
  });

  it("validates nativeFamily against the pinned pack and rejects unknown families", async () => {
    const e = await directorExtensionFixture(), host = await e.create();
    for (const nativeFamily of ["qa", "other"]) await expect(host.admit({ ...extensionDelegation(), metadata: { origin: "director", nativeFamily } })).rejects.toThrow();
  });

  it("accepts nativeFamily through the exported delegation metadata contract", () => {
    expect(DelegationRequestSchema.parse(extensionDelegation()).metadata?.nativeFamily).toBe("analysis");
  });
});
