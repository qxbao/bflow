import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCodexFailure } from "../../src/agentic/provider-failure-reader.js";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
it("reads only current structured native errors from the pinned session transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-failure-reader-")); directories.push(root);
  const path = join(root, "rollout.jsonl"), timestamp = "2026-10-28T00:00:01.000Z";
  const metadata = { type: "session_meta", payload: { id: "session-1" } };
  const write = async (events: unknown[]) => writeFile(path, [metadata, ...events].map(item => JSON.stringify(item)).join("\n"));
  const input = { path, root, nativeSessionId: "session-1", acceptedAt: "2026-10-28T00:00:00.000Z" };
  await write([{ timestamp, type: "event_msg", payload: { type: "agent_message", message: '{"type":"error","codex_error_info":"usage_limit_exceeded"}' } }]);
  expect(await readCodexFailure(input)).toBeUndefined();
  await write([{ timestamp, type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded", message: "secret" } }]);
  const result = await readCodexFailure(input);
  expect(result?.event).toMatchObject({ type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(await readCodexFailure({ ...input, nativeSessionId: "different" })).toBeUndefined();
  expect(await readCodexFailure({ ...input, acceptedAt: "2026-10-28T00:00:02.000Z" })).toBeUndefined();
  await write([{ timestamp, type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } },
    { timestamp, type: "event_msg", payload: { type: "task_started" } }]);
  expect(await readCodexFailure(input)).toBeUndefined();
});
it("reads a transcript reached through a symlinked ancestor but rejects a symlinked transcript file", async () => {
  const real = await mkdtemp(join(tmpdir(), "bflow-failure-reader-real-")); directories.push(real);
  const link = `${real}-link`; directories.push(link);
  await symlink(real, link);
  const metadata = { type: "session_meta", payload: { id: "session-1" } };
  const event = { timestamp: "2026-10-28T00:00:01.000Z", type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } };
  await writeFile(join(real, "rollout.jsonl"), [metadata, event].map(item => JSON.stringify(item)).join("\n"));
  const input = { path: join(link, "rollout.jsonl"), root: link, nativeSessionId: "session-1", acceptedAt: "2026-10-28T00:00:00.000Z" };
  expect((await readCodexFailure(input))?.event).toMatchObject({ payload: { codex_error_info: "usage_limit_exceeded" } });
  await symlink(join(real, "rollout.jsonl"), join(real, "alias.jsonl"));
  expect(await readCodexFailure({ ...input, path: join(link, "alias.jsonl") })).toBeUndefined();
});
