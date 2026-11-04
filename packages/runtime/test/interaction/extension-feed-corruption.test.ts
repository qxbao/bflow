import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { interactionProjectId } from "../../src/interaction/client.js";
import { ensureAgenticHost, queryAgenticHostInteraction } from "../../dist/agentic/host-controller.js";
import { findPrivateRuntimeStateDirectory } from "../../src/private-state.js";
import { digest } from "../../src/agentic/journal.js";
import { state, run, at } from "./fixtures.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Real host subprocess: the invalidate feed must follow workforce content, not observation times or lease heartbeats. */
it.each(["malformed-json", "malformed-projection"])("keeps the feed changing with %s extension routes", async corruption => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "web-workforce-host-"));
  const sessionId = "host-wf";
  const herdrBinary = join(repositoryPath, "herdr-fixture.mjs");
  await writeFile(herdrBinary, ["#!/usr/bin/env node", "process.stdout.write(JSON.stringify({ running: false }) + '\\n');"].join("\n"), { mode: 0o700 });
  const controller = await ensureAgenticHost({ repositoryPath, sessionId, herdrBinary });
  try {
    const root = findPrivateRuntimeStateDirectory(repositoryPath)!;
    const manifestDir = join(repositoryPath, ".bflow/state/panes");
    await mkdir(manifestDir, { recursive: true });
    const pane = { schemaVersion: 2, bindingId: "binding", sessionId, role: "conversation", agentId: "agent", workspaceId: "workspace", tabId: "tab",
      paneId: "pane", provider: "claude", agentKind: "claude", cwd: repositoryPath, isolationMode: "dedicated_pane", readOnlyWorkspace: true,
      transportState: "idle", boundAt: at, permanent: true };
    const manifestPath = join(manifestDir, sessionId + ".manifest.json");
    const writeManifest = (updatedAt: string) => writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, sessionId, projectName: "Project",
      workspaceRoot: repositoryPath, herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: "conversation-1",
      activeRunIds: [], panes: [pane, { ...pane, bindingId: "coordinator-binding", role: "coordinator", agentId: "coordinator", paneId: "coordinator-pane" }],
      attachTarget: { role: "conversation", paneId: "pane" }, createdAt: at, updatedAt }));
    await writeManifest(at);
    const r = run(); r.delegation.metadata = { nativeFamily: "analysis" };
    const routesDirectory = join(root, "agentic/extensions", digest(sessionId), "routes");
    await mkdir(routesDirectory, { recursive: true });
    const corrupt = { ...state([]), repository: repositoryPath, inbox: [{ status: "applied", message: {
      schema_version: 2, message_id: "corrupt-native-route", correlation_id: "correlation", run_id: r.runId,
      sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status", artifact_references: [],
      payload: { kind: "extension.route", route: { runId: r.runId, kind: "analysis", projection: { schemaVersion: 999 } } } } }] };
    await writeFile(join(routesDirectory, "state.json"), corruption === "malformed-json" ? "{" : JSON.stringify(corrupt));
    const outbound = (id: string, expiresAt: string) => ({
      message: { schema_version: 2, message_id: id, correlation_id: "c", run_id: r.runId, sender: { role: "conversation" },
        recipient: { role: "coordinator", agent_id: "coordinator" }, type: "delegation.request", payload: { text: "PRIVATE-PAYLOAD" },
        artifact_references: [] },
      status: "queued", selector: "coordinator", taskId: "message-" + id, attemptId: "attempt-" + id, capabilities: [],
      lease: { leaseId: "lease", agentId: "coordinator", runId: r.runId, taskId: "message-" + id, attemptId: "attempt-" + id, fencingToken: 1,
        version: 1, acquiredAt: at, expiresAt },
    });
    const journalPath = join(root, "agentic/journal/state.json");
    await mkdir(join(root, "agentic/journal"), { recursive: true });
    const writeJournal = (...outs: ReturnType<typeof outbound>[]) =>
      writeFile(journalPath, JSON.stringify({ ...state([r]), repository: repositoryPath, outbound: outs }));
    await writeJournal(outbound("m-1", "2026-10-28T00:10:00.000Z"));
    const projectId = interactionProjectId(repositoryPath);
    const events = async (cursor?: string) => {
      const page = await queryAgenticHostInteraction({ repositoryPath, sessionId }, { projectId, query: cursor ? { cursor } : {} }, "interaction_events") as
        { items: { type: string; cursor: string }[] };
      return page.items;
    };
    const workforce = await queryAgenticHostInteraction({ repositoryPath, sessionId }, { kind: "workforce", projectId }) as
      { ok: boolean; value: { agents: { role: string; work: unknown[] }[] } };
    expect(workforce.ok).toBe(true);
    expect(workforce.value.agents.find(a => a.role === "coordinator")!.work).toHaveLength(1);
    expect(JSON.stringify(workforce)).not.toContain("PRIVATE-PAYLOAD");

    // First read establishes the baseline and returns a reset that carries the cursor.
    let cursor = (await events()).at(-1)!.cursor;
    await sleep(1100);
    expect(await events(cursor)).toEqual([]);
    // Observation time (manifest updatedAt) and a renewed lease are not changes.
    await sleep(1100);
    await writeManifest("2026-10-28T00:00:30.000Z");
    await writeJournal(outbound("m-1", "2026-10-28T00:25:00.000Z"));
    expect(await events(cursor)).toEqual([]);
    // A second handoff is one change, announced once.
    await sleep(1100);
    await writeJournal(outbound("m-1", "2026-10-28T00:25:00.000Z"), outbound("m-2", "2026-10-28T00:25:00.000Z"));
    const changed = await events(cursor);
    expect(changed.map(e => e.type)).toEqual(["invalidate"]);
    cursor = changed.at(-1)!.cursor;
    await sleep(1100);
    expect(await events(cursor)).toEqual([]);
    expect(await readFile(journalPath, "utf8")).toContain("m-2");
  } finally {
    try { await controller.shutdown(); } finally { await rm(repositoryPath, { recursive: true, force: true }); }
  }
}, 30000);
