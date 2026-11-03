import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SessionManifestSchema, SessionManifestV3Schema, type SessionManifest, type SessionManifestV2, type SessionManifestV3 } from "@bflow/contracts";
import { RolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
import type { PermanentTopologyRole, RolePaneManagerConfig } from "../src/types.js";
import { DirectorHerdrFake } from "./support/director-herdr-fake.js";

const ROOT = "/workspace/sample-project";
const SESSION = "bf-fixture-session";
const COMMAND = ["/usr/bin/node", "/opt/bflow/apps/cli/dist/bin.js", "progress", "--follow"];
const QUOTED = "'/usr/bin/node' '/opt/bflow/apps/cli/dist/bin.js' 'progress' '--follow'";

function setup(overrides: Partial<RolePaneManagerConfig> = {}, store = new InMemorySessionManifestStore()) {
  const fake = new DirectorHerdrFake();
  let now = Date.parse("2026-11-03T10:00:00.000Z");
  const config: RolePaneManagerConfig = {
    sessionId: SESSION, projectName: "sample-project", workspaceRoot: ROOT, defaultAgentKind: "codex",
    layout: "director", progressCommand: COMMAND, permanentRoles: ["planner"], ...overrides
  };
  const manager = new RolePaneManager({ config, runner: fake, store, clock: () => new Date(now) });
  return { fake, store, manager, advance: (ms: number) => { now += ms; } };
}

async function storedV3(store: InMemorySessionManifestStore): Promise<SessionManifestV3> {
  const loaded = await store.load(SESSION);
  if (!loaded.ok || loaded.value === null) throw new Error("manifest missing");
  return SessionManifestV3Schema.parse(loaded.value);
}

async function legacyManifest(status: SessionManifestV2["status"]): Promise<SessionManifest> {
  const raw: unknown = JSON.parse(await readFile(new URL("../../contracts/test/fixtures/session-manifest-v2-real.json", import.meta.url), "utf8"));
  const parsed = SessionManifestSchema.parse(raw);
  if (parsed.schemaVersion !== 2) throw new Error("fixture is not v2");
  return { ...parsed, status, conversationSessionId: "conv-legacy-123" };
}

describe("RolePaneManager director layout", () => {
  it("builds a v3 session with a progress tab and no Conversation/Coordinator panes", async () => {
    const { fake, store, manager } = setup({ permanentRoles: undefined });
    const result = await manager.initializeTopology();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe(3);
    const manifest = await storedV3(store);
    expect(SessionManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.status).toBe("up");
    expect(manifest.panes.map(pane => pane.role).sort()).toEqual(["architect", "planner", "qa", "reviewer", "specifier"]);
    // No Conversation/Coordination tab, and no chat/coordinator agent was started.
    const tabLabels = fake.calls.filter(args => args[0] === "tab" && args[1] === "create").map(args => args[args.indexOf("--label") + 1]);
    expect(tabLabels).not.toContain("conversation");
    expect(tabLabels.sort()).toEqual(["coordination", "verification"]);
    const started = fake.calls.filter(args => args[0] === "agent" && args[1] === "start").map(args => args[2]);
    expect(started).not.toContain("chat");
    expect(started).not.toContain("coordinator");
    // The workspace root pane is the progress pane: renamed, running the quoted command, and the attach target.
    const create = fake.calls.find(args => args[0] === "workspace" && args[1] === "create")!;
    expect(create).toEqual(["workspace", "create", "--cwd", ROOT, "--label", "sample-project", "--no-focus"]);
    const progress = manifest.progressPane!;
    expect(progress).toMatchObject({ phase: "running", command: COMMAND, restarts: [] });
    expect(fake.calls).toContainEqual(["tab", "rename", progress.tabId, "progress"]);
    expect(fake.calls).toContainEqual(["pane", "rename", progress.paneId, "progress"]);
    expect(fake.calls).toContainEqual(["pane", "run", progress.paneId, QUOTED]);
    expect(manifest.herdrTabId).toBe(progress.tabId);
    expect(manifest.attachTarget).toEqual({ role: "progress", tabId: progress.tabId, paneId: progress.paneId, terminalId: progress.terminalId });
    expect(fake.calls.filter(args => args[0] === "agent" && args[1] === "focus")).toHaveLength(0);
    expect(fake.calls.at(-1)).toEqual(["tab", "focus", progress.tabId]);
  });

  it.each<PermanentTopologyRole>(["chat", "coordinator"])("refuses a %s pane before any side effect", async role => {
    const { fake, manager } = setup({ permanentRoles: ["planner", role] });
    const result = await manager.initializeTopology();
    expect(result).toEqual({ ok: false, error: { code: "validation", retryable: false, message: "Director layout cannot start conversation/coordinator panes" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("requires a progress command for the director layout", () => {
    expect(() => new RolePaneManager({ config: { sessionId: SESSION, projectName: "p", workspaceRoot: ROOT, layout: "director" } }))
      .toThrow("RolePaneManagerConfig.progressCommand is required for the director layout");
  });

  it("refuses to adopt a running v2 session", async () => {
    const store = new InMemorySessionManifestStore();
    await store.save(await legacyManifest("up"));
    const { fake, manager } = setup({}, store);
    const result = await manager.reconcileTopology();
    expect(result).toEqual({ ok: false, error: { code: "conflict", retryable: true,
      message: "Phiên v2 (có pane Conversation/Coordinator) đang chạy. Chạy `bflow down` rồi `bflow up` để nâng cấp lên phiên Director." } });
    expect(fake.calls).toHaveLength(0);
  });

  it("replaces a stopped v2 session with a v3 manifest that keeps its interaction session id", async () => {
    const store = new InMemorySessionManifestStore();
    await store.save(await legacyManifest("down"));
    const { manager } = setup({}, store);
    const result = await manager.reconcileTopology();
    expect(result.ok).toBe(true);
    const manifest = await storedV3(store);
    expect(manifest.conversationSessionId).toBe("conv-legacy-123");
    expect(manifest.panes.some(pane => pane.role === "conversation" || pane.role === "coordinator")).toBe(false);
    expect(manifest.status).toBe("up");
  });

  it("focuses the progress tab without an agent focus", async () => {
    const { fake, manager, store } = setup();
    expect((await manager.initializeTopology()).ok).toBe(true);
    const progress = (await storedV3(store)).progressPane!;
    const before = fake.calls.length;
    const focused = await manager.focusProgressPane();
    expect(focused).toEqual({ ok: true, value: { tabId: progress.tabId, paneId: progress.paneId, terminalId: progress.terminalId } });
    const workspaceId = (await storedV3(store)).herdrWorkspaceId;
    expect(fake.calls.slice(before)).toEqual([["workspace", "focus", workspaceId], ["tab", "focus", progress.tabId]]);
  });

  it("reports a v2 session from focusProgressPane", async () => {
    const store = new InMemorySessionManifestStore();
    await store.save(await legacyManifest("up"));
    const { manager } = setup({}, store);
    expect(await manager.focusProgressPane()).toEqual({ ok: false,
      error: { code: "validation", retryable: false, message: "Session is a v2 session; run bflow down then bflow up" } });
  });

  it("restarts an exited viewer, degrades after the sixth restart in ten minutes", async () => {
    const { fake, manager, store, advance } = setup();
    expect((await manager.initializeTopology()).ok).toBe(true);
    const paneId = (await storedV3(store)).progressPane!.paneId;
    for (let restart = 1; restart <= 5; restart++) {
      fake.exitForeground(paneId);
      advance(30_000);
      const ensured = await manager.ensureProgressPane();
      expect(ensured.ok && ensured.value.phase).toBe("running");
      expect((await storedV3(store)).status).toBe("up");
    }
    fake.exitForeground(paneId);
    advance(30_000);
    const failed = await manager.ensureProgressPane();
    expect(failed.ok && failed.value.phase).toBe("failed");
    const manifest = await storedV3(store);
    expect(manifest.status).toBe("degraded");
    expect(manifest.progressPane?.restarts).toHaveLength(5);
    expect(fake.count("pane", "run")).toBe(6);
  });

  it("never replays an uncertain launch and returns to up once the command is observed", async () => {
    const { fake, manager, store } = setup();
    expect((await manager.initializeTopology()).ok).toBe(true);
    const paneId = (await storedV3(store)).progressPane!.paneId;
    fake.exitForeground(paneId);
    fake.launchStarts = false;
    const uncertain = await manager.ensureProgressPane();
    expect(uncertain.ok && uncertain.value.phase).toBe("launch_unknown");
    expect((await storedV3(store)).status).toBe("degraded");
    fake.occupy(paneId, [...COMMAND]);
    const confirmed = await manager.ensureProgressPane();
    expect(confirmed.ok && confirmed.value.phase).toBe("running");
    expect((await storedV3(store)).status).toBe("up");
    expect(fake.count("pane", "run")).toBe(2);
  });

  it("reconciles the progress pane from topology health and recreates a missing pane", async () => {
    const { fake, manager, store } = setup();
    expect((await manager.initializeTopology()).ok).toBe(true);
    const before = (await storedV3(store)).progressPane!;
    fake.removePane(before.paneId);
    const health = await manager.inspectTopologyHealth();
    expect(health.ok).toBe(true);
    const manifest = await storedV3(store);
    expect(manifest.progressPane?.paneId).not.toBe(before.paneId);
    expect(manifest.progressPane?.phase).toBe("running");
    expect(manifest.attachTarget.paneId).toBe(manifest.progressPane?.paneId);
    expect(manifest.status).toBe("up");
  });

  it("closes the owned progress pane on shutdown and keeps the v3 manifest", async () => {
    const { fake, manager, store } = setup();
    expect((await manager.initializeTopology()).ok).toBe(true);
    const progress = (await storedV3(store)).progressPane!;
    const stopped = await manager.shutdownTopology();
    expect(stopped.ok && stopped.value.status).toBe("down");
    expect(fake.calls).toContainEqual(["pane", "close", progress.paneId]);
    expect(fake.panes.has(progress.paneId)).toBe(false);
    expect((await storedV3(store)).schemaVersion).toBe(3);
  });

  it("starts a fresh progress pane after down/up", async () => {
    const { fake, manager, store } = setup();
    expect((await manager.initializeTopology()).ok).toBe(true);
    expect((await manager.shutdownTopology()).ok).toBe(true);
    const restarted = await manager.reconcileTopology();
    expect(restarted.ok).toBe(true);
    const manifest = await storedV3(store);
    expect(manifest.status).toBe("up");
    expect(manifest.progressPane).toMatchObject({ phase: "running", restarts: [] });
    expect(fake.count("pane", "run")).toBe(2);
  });

  it("stops a running v2 session so it can be upgraded", async () => {
    const store = new InMemorySessionManifestStore();
    await store.save(await legacyManifest("up"));
    const { manager } = setup({}, store);
    const stopped = await manager.shutdownTopology();
    expect(stopped.ok && stopped.value.status).toBe("down");
    expect(stopped.ok && stopped.value.schemaVersion).toBe(2);
  });
});
