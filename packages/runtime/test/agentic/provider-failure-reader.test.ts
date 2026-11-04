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

it("reads the observed structured terminal error only for the current native turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-terminal-failure-")); directories.push(root);
  const path = join(root, "rollout.jsonl"), timestamp = "2026-11-03T02:14:38.652Z";
  const input = { path, root, nativeSessionId: "native-session", acceptedAt: "2026-11-03T02:14:35.785Z" };
  const start = { timestamp: "2026-11-03T02:14:38.451Z", type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } };
  const terminal = { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "current-turn",
    root_turn_id: "current-turn", error: { codex_error_info: "usage_limit_exceeded", message: "private-native-error" } } };
  const write = async (events: unknown[]) => writeFile(path, [{ type: "session_meta", payload: { id: input.nativeSessionId } },
    ...events].map(value => JSON.stringify(value)).join("\n"));
  await write([start, terminal]);
  expect(await readCodexFailure(input)).toEqual({ observedAt: timestamp,
    event: { type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } } });
  expect(await readCodexFailure({ ...input, nativeSessionId: "foreign-session" })).toBeUndefined();
  expect(await readCodexFailure({ ...input, acceptedAt: "2026-11-03T02:14:39.000Z" })).toBeUndefined();
  await write([terminal]); // Missing current-turn anchor is not reconstructed from the terminal event.
  expect(await readCodexFailure(input)).toBeUndefined();
  await write([start, { ...terminal, payload: { ...terminal.payload, turn_id: "old-turn" } }]);
  expect(await readCodexFailure(input)).toBeUndefined();
  await write([start, terminal, { ...start, payload: { ...start.payload, turn_id: "newer-turn" } }]);
  expect(await readCodexFailure(input)).toBeUndefined();
});

it("does not keep a retry error when the current native turn terminates successfully or without a structured code", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-terminal-success-")); directories.push(root);
  const path = join(root, "rollout.jsonl"), timestamp = "2026-11-03T02:14:38.652Z";
  const metadata = { type: "session_meta", payload: { id: "native-session" } };
  const start = { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } };
  const retry = { timestamp, type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } };
  const input = { path, root, nativeSessionId: "native-session", acceptedAt: "2026-11-03T02:14:35.785Z" };
  for (const error of [undefined, { message: "usage_limit_exceeded" }, { codex_error_info: 429 }]) {
    const terminal = { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "current-turn", ...(error ? { error } : {}) } };
    await writeFile(path, [metadata, start, retry, terminal].map(value => JSON.stringify(value)).join("\n"));
    expect(await readCodexFailure(input)).toBeUndefined();
  }
});

it("validates native session metadata larger than the old 16KiB header cap without retaining its instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-large-native-metadata-")); directories.push(root);
  const path = join(root, "rollout.jsonl"), timestamp = "2026-11-03T02:14:38.652Z";
  const input = { path, root, nativeSessionId: "native-session", acceptedAt: "2026-11-03T02:14:35.785Z" };
  const metadata = (size: number) => ({ type: "session_meta", payload: { id: "native-session",
    base_instructions: { text: "private-instructions" + "x".repeat(size) } } });
  const events = [{ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "current-turn", error: { codex_error_info: "usage_limit_exceeded" } } }];
  await writeFile(path, [metadata(24 * 1024), ...events].map(value => JSON.stringify(value)).join("\n"));
  const result = await readCodexFailure(input);
  expect(result?.event).toEqual({ type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } });
  expect(JSON.stringify(result)).not.toContain("private-instructions");
  expect(await readCodexFailure({ ...input, nativeSessionId: "foreign-session" })).toBeUndefined();
  await writeFile(path, [metadata(512 * 1024), ...events].map(value => JSON.stringify(value)).join("\n"));
  expect(await readCodexFailure(input)).toBeUndefined(); // Still bounded; no unvalidated metadata fallback.
});

it("drops a retry error at a terminal boundary when the current turn anchor fell outside the bounded tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-truncated-turn-")); directories.push(root);
  const path = join(root, "rollout.jsonl"), timestamp = "2026-11-03T02:14:38.652Z";
  const input = { path, root, nativeSessionId: "native-session", acceptedAt: "2026-11-03T02:14:35.785Z" };
  const metadata = { type: "session_meta", payload: { id: "native-session" } };
  const start = { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } };
  const padding = { timestamp, type: "event_msg", payload: { type: "agent_message", message: "x".repeat(600 * 1024) } };
  const retry = { timestamp, type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } };
  for (const error of [undefined, { message: "usage_limit_exceeded" }, { codex_error_info: "usage_limit_exceeded" }]) {
    const terminal = { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "current-turn", ...(error ? { error } : {}) } };
    await writeFile(path, [metadata, start, padding, retry, terminal].map(value => JSON.stringify(value)).join("\n"));
    expect(await readCodexFailure(input)).toBeUndefined();
  }
});
