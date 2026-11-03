import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { WebPageSchema, WebActivityEntrySchema } from "@bflow/contracts";
import { interactionProjectId } from "../../src/interaction/client.js";
import { hostInteractionQuery } from "../../src/interaction/views.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { state, run } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const Page = WebPageSchema(WebActivityEntrySchema);
const ALLOWED = ["entryId", "occurredAt", "kind", "role", "action", "runId", "taskId", "outcome"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "web-activity-"));
  dirs.push(root);
  const repositoryPath = join(root, "repo"), hostDir = join(root, "state/host/host-1");
  const manifestDir = join(repositoryPath, ".bflow/state/panes");
  await mkdir(hostDir, { recursive: true }); await mkdir(manifestDir, { recursive: true });
  await mkdir(join(root, "state/agentic/journal"), { recursive: true });
  const pane = { schemaVersion: 2, bindingId: "b", sessionId: "host-1", role: "conversation", agentId: "conv", workspaceId: "ws", tabId: "tab",
    paneId: "pane", provider: "claude", agentKind: "claude", cwd: repositoryPath, isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    transportState: "idle", boundAt: "2026-10-28T00:00:00.000Z", permanent: true };
  await writeFile(join(manifestDir, "host-1.manifest.json"), JSON.stringify({ schemaVersion: 2, sessionId: "host-1", projectName: "P",
    workspaceRoot: repositoryPath, herdrWorkspaceId: "ws", herdrTabId: "tab", status: "up", conversationSessionId: "conversation-1",
    activeRunIds: [], panes: [pane, { ...pane, bindingId: "bc", role: "coordinator", agentId: "coord", paneId: "pane-c" }], attachTarget: { role: "conversation", paneId: "pane" },
    createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z" }));
  const foreign = run("run-foreign");
  await writeFile(join(root, "state/agentic/journal/state.json"),
    JSON.stringify({ ...state([run(), { ...foreign, delegation: { ...foreign.delegation, sessionId: "other-session" } }]), repository: repositoryPath }));
  const log = TaskActivityLog.open(join(root, "state/agentic/task-activity.jsonl"));
  const configuration = { repositoryPath, sessionId: "host-1", directory: hostDir, socketPath: join(hostDir, "host.sock"), token: "tok-secret-value", herdrBinary: "herdr" };
  const projectId = interactionProjectId(repositoryPath);
  const query = (extra: Record<string, unknown>) => hostInteractionQuery(configuration as never, { kind: "activity", projectId, ...extra }, { ready: true });
  return { log, query, repositoryPath, root };
}

it("only run in session is readable", async () => {
  const f = await fixture();
  await f.log.record({ kind: "progress", role: "developer", action: "edit", runId: "run-foreign" });
  expect(await f.query({ runId: "run-foreign" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(await f.query({ runId: "run-unknown" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(await f.query({ runId: "run-1" })).toMatchObject({ ok: true });
});

it("entries pass redaction allowlist", async () => {
  const f = await fixture();
  await f.log.record({ kind: "tool", role: "developer", action: "run-tests", runId: "run-1", taskId: "task-1", attemptId: "att-1",
    outcome: `failed token=abc123 at ${f.repositoryPath}/secret.ts`, durationMs: 5, shortId: "x", runLabel: "label", messageType: "task.assignment",
    reason: "PRIVATE-REASON", artifacts: ["artifact://PRIVATE-ARTIFACT"] });
  await f.log.record({ kind: "tool", role: "developer", action: "other", runId: "run-other" });
  const result = await f.query({ runId: "run-1" }) as { ok: true; value: unknown };
  expect(result.ok).toBe(true);
  const page = Page.parse(result.value);
  expect(page.items).toHaveLength(1);
  const item = page.items[0]!;
  expect(Object.keys(item).every(k => ALLOWED.includes(k))).toBe(true);
  expect(item).toMatchObject({ kind: "tool", role: "developer", action: "run-tests", runId: "run-1", taskId: "task-1" });
  const text = JSON.stringify(result);
  for (const secret of ["PRIVATE-REASON", "PRIVATE-ARTIFACT", "abc123", f.repositoryPath, "att-1", "label"]) expect(text).not.toContain(secret);
});

it("cursor uses entry id and unknown cursor restarts safely", async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) await f.log.record({ kind: "progress", role: "developer", action: `step-${i}`, runId: "run-1" });
  const first = Page.parse((await f.query({ runId: "run-1" }) as { value: unknown }).value);
  expect(first.items).toHaveLength(25);
  expect(first.items[0]!.action).toBe("step-29");
  expect(first.nextCursor).toBe(first.items.at(-1)!.entryId);
  const second = Page.parse((await f.query({ runId: "run-1", cursor: first.nextCursor }) as { value: unknown }).value);
  expect(second.items.map(i => i.action)).toEqual(["step-4", "step-3", "step-2", "step-1", "step-0"]);
  expect(second.nextCursor).toBeUndefined();
  const restarted = await f.query({ runId: "run-1", cursor: "no-such-entry" }) as { ok: boolean; value: unknown };
  expect(restarted.ok).toBe(true);
  expect(Page.parse(restarted.value)).toEqual(first);
});

it("missing log returns empty page, not success claim", async () => {
  const f = await fixture();
  const result = await f.query({ runId: "run-1" }) as { ok: true; value: unknown };
  expect(result).toMatchObject({ ok: true, value: { apiVersion: 1, items: [] } });
  expect(JSON.stringify(result)).not.toMatch(/success|succeeded|completed/i);
  await writeFile(f.log.path, "not json\n{broken");
  expect(await f.query({ runId: "run-1" })).toMatchObject({ ok: true, value: { items: [] } });
});
