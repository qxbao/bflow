import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, SessionManifestSchema, type SessionManifest } from "@bflow/contracts";
import { renderConversationNotice, isUserFacingNotice } from "../../src/agentic/conversation-notice-render.js";
import { executeHostIdleCheck, type HostIdleCheckWorkspaceLike } from "../../src/agentic/host.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { evaluateIdleCheck, type IdleCheckPing, type PaneFact, type RunFacts } from "../../src/agentic/run-watchdog.js";

const T0 = Date.parse("2026-11-02T03:00:00.000Z");
const SEC = 1000;
const IDLE = T0 + 181 * SEC;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return { runId: "run-1", status: "implementing", live: true, lastActivityAt: T0, awaitingHuman: false, activeHandoff: false,
    pendingDecisions: [], ...overrides };
}
const idlePanes: PaneFact[] = [{ role: "coordinator", status: "idle", paneId: "p1" }, { role: "developer", status: "done", paneId: "p2" }];
const evaluate = (runs: RunFacts[], panes: PaneFact[] = idlePanes, now = IDLE, pings: ReadonlyMap<string, IdleCheckPing> = new Map(), activeVerificationRunIds: string[] = []) =>
  evaluateIdleCheck({ now, runs, panes, pings, activeVerificationRunIds });

describe("evaluateIdleCheck", () => {
  it("asks for a check when a live run is quiet and no agent is working", () => {
    expect(evaluate([run()])).toEqual([{ runId: "run-1", episodeKey: `run-1@${T0}`, idleSince: T0, attempt: 1 }]);
  });

  it("flags a handoff that never settles, which the stall report skips", () => {
    expect(evaluate([run({ activeHandoff: true })]).map(check => check.runId)).toEqual(["run-1"]);
  });

  it("stays quiet while any agent in the session is working", () => {
    expect(evaluate([run()], [...idlePanes, { role: "reviewer", status: "working", paneId: "p3" }])).toEqual([]);
  });

  it("stays quiet before the idle window has passed", () => {
    expect(evaluate([run()], idlePanes, T0 + 180 * SEC)).toEqual([]);
  });

  it.each<[string, Partial<RunFacts>]>([
    ["a finished run", { live: false }],
    ["a human gate", { awaitingHuman: true }],
    ["a pending user decision", { pendingDecisions: [{ approvalId: "apr-1", requestedAt: "2026-11-02T03:00:00.000Z" }] }],
    ["work Runtime itself owns", { runtimeWork: true }],
    ["a blocker already reported to the user", { reportedBlocker: true }]
  ])("does not treat %s as strange", (_label, overrides) => {
    expect(evaluate([run(overrides)])).toEqual([]);
  });

  it("does not treat a running host verification as strange", () => {
    expect(evaluate([run()], idlePanes, IDLE, new Map(), ["run-1"])).toEqual([]);
  });

  it("repeats only after the wait and stops after three pings for one episode", () => {
    const key = `run-1@${T0}`;
    expect(evaluate([run()], idlePanes, IDLE + 299 * SEC, new Map([[key, { pings: 1, lastAt: IDLE }]]))).toEqual([]);
    expect(evaluate([run()], idlePanes, IDLE + 300 * SEC, new Map([[key, { pings: 1, lastAt: IDLE }]])))
      .toMatchObject([{ attempt: 2 }]);
    expect(evaluate([run()], idlePanes, IDLE + 3600 * SEC, new Map([[key, { pings: 3, lastAt: IDLE }]]))).toEqual([]);
  });

  it("starts over when the run shows new activity", () => {
    const stale = new Map([[`run-1@${T0}`, { pings: 3, lastAt: IDLE }]]);
    const lastActivityAt = T0 + 60 * SEC;
    expect(evaluate([run({ lastActivityAt })], idlePanes, lastActivityAt + 181 * SEC, stale))
      .toEqual([{ runId: "run-1", episodeKey: `run-1@${lastActivityAt}`, idleSince: lastActivityAt, attempt: 1 }]);
  });
});

describe("executeHostIdleCheck", () => {
  async function fixture(runs: RunFacts[], panes = [{ role: "coordinator", paneId: "p1" }], status = "idle") {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-idle-check-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const receipts = new HostReceiptJournal(join(root, "receipts"), join(root, "repo"), "session-1");
    const workspace: HostIdleCheckWorkspaceLike = { runtime: {
      watchdogSnapshot: async () => runs.map(item => ({ ...item, pendingDecisionRequests: [] })),
      ports: { panes: { getManifest: async () => ({ ok: true, value: manifest(panes) }) } }
    } } as unknown as HostIdleCheckWorkspaceLike;
    const pings = new Map<string, IdleCheckPing>();
    const state = { workspace: workspace as HostIdleCheckWorkspaceLike | undefined, manifest: manifest(panes), quiesced: false, closing: false };
    const pass = (now: number) => executeHostIdleCheck({ readState: () => state, receipts, activeHostVerifications: new Map(), pings,
      observeAgent: async () => ({ status }), now });
    return { receipts, pass, pings, state };
  }
  function manifest(panes: { role: string; paneId: string }[]): SessionManifest {
    const at = new Date(T0).toISOString(), bind = (role: string, paneId: string) => PaneBindingSchema.parse({
      schemaVersion: 2, bindingId: `${role}-binding`, sessionId: "session-1", role, agentId: role, paneId, workspaceId: "workspace", tabId: "tab",
      provider: "claude", agentKind: "claude", cwd: "/repo", worktreePath: "/repo", readOnlyWorkspace: role !== "developer", isolationMode: "dedicated_pane",
      transportState: "idle", boundAt: at, session: { source: "herdr:claude", kind: "id", value: `${role}-session` } });
    return SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "session-1", projectName: "bflow-test", workspaceRoot: "/repo",
      herdrWorkspaceId: "workspace", herdrTabId: "tab", conversationSessionId: "session-1", status: "up", activeRunIds: ["run-1"],
      attachTarget: { role: "conversation", paneId: "pane-conversation" }, createdAt: at, updatedAt: at,
      panes: [bind("conversation", "pane-conversation"), ...panes.map(pane => bind(pane.role, pane.paneId))] });
  }

  it("wakes Conversation with one notice that is not a card for the user to answer", async () => {
    const { receipts, pass } = await fixture([run()]);
    await pass(IDLE);
    await pass(IDLE + 60 * SEC);
    const notices = await receipts.unsurfacedConversationNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "conversation.progress", senderRole: "runtime", runId: "run-1" });
    expect(notices[0]!.shortId).toBeUndefined();
    const rendered = renderConversationNotice(notices[0]!);
    expect(isUserFacingNotice(rendered)).toBe(false);
    expect(rendered.display).toContain("Việc #1");
    expect(rendered.display).toContain("3 phút");
  });

  it("does not write a notice while an agent is working", async () => {
    const { receipts, pass } = await fixture([run()], [{ role: "coordinator", paneId: "p1" }], "working");
    await pass(IDLE);
    expect(await receipts.unsurfacedConversationNotices()).toEqual([]);
  });

  it("counts an unreadable pane as not working", async () => {
    const { receipts, state } = await fixture([run()]);
    await executeHostIdleCheck({ readState: () => state, receipts, activeHostVerifications: new Map(), pings: new Map(),
      observeAgent: async () => { throw new Error("pane gone"); }, now: IDLE });
    expect(await receipts.unsurfacedConversationNotices()).toHaveLength(1);
  });

  it("does not ping a run again after a host restart forgets its count", async () => {
    const { receipts, pass, pings } = await fixture([run()]);
    await pass(IDLE);
    pings.clear();
    await pass(IDLE + 60 * SEC);
    expect(await receipts.unsurfacedConversationNotices()).toHaveLength(1);
    expect(pings.get(`run-1@${T0}`)).toMatchObject({ pings: 1 });
  });

  it("forgets the counts of episodes that have ended", async () => {
    const { pass, pings } = await fixture([run()]);
    pings.set("run-old@1", { pings: 2, lastAt: T0 });
    await pass(IDLE);
    expect([...pings.keys()]).toEqual([`run-1@${T0}`]);
  });

  it("never runs in a Director session (manifest v3) and still runs in a v2 session", async () => {
    const { receipts, pass, state } = await fixture([run()]);
    const at = new Date(T0).toISOString();
    const specialists = state.manifest.panes.filter(pane => !["conversation", "coordinator"].includes(pane.role));
    const director = SessionManifestSchema.parse({ schemaVersion: 3, sessionId: "session-1", projectName: "bflow-test", workspaceRoot: "/repo",
      herdrWorkspaceId: "workspace", herdrTabId: "tab", conversationSessionId: "session-1", status: "up", activeRunIds: ["run-1"], panes: specialists,
      progressPane: { tabId: "tab-progress", paneId: "pane-progress", command: ["bflow", "progress", "--follow"], phase: "running", restarts: [] },
      attachTarget: { role: "progress", tabId: "tab-progress", paneId: "pane-progress" }, createdAt: at, updatedAt: at });
    const v2 = state.manifest;
    let snapshots = 0;
    const runtime = (state.workspace as unknown as { runtime: { watchdogSnapshot: (...args: unknown[]) => Promise<unknown> } }).runtime;
    const snapshot = runtime.watchdogSnapshot;
    runtime.watchdogSnapshot = async (...args) => { snapshots++; return snapshot(...args); };
    state.manifest = director;
    await pass(IDLE);
    await pass(IDLE + 3600 * SEC);
    expect(snapshots).toBe(0);
    expect(await receipts.unsurfacedConversationNotices()).toEqual([]);
    state.manifest = v2;
    await pass(IDLE);
    expect(snapshots).toBe(1);
    expect(await receipts.unsurfacedConversationNotices()).toHaveLength(1);
  });

  it("does nothing once the host has started closing", async () => {
    const { receipts, pass, state } = await fixture([run()]);
    state.closing = true;
    await pass(IDLE);
    expect(await receipts.unsurfacedConversationNotices()).toEqual([]);
  });
});
