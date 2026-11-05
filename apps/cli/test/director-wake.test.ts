import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  armCodexDirectorWatch, cancelCodexDirectorWatch, isCodexDirectorWakePrompt,
  queueCodexDirectorThread, readCodexDirectorWatchStatus, runCodexDirectorWatch, withCodexDirectorWatchLock
} from "../src/director-wake.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "bflow-director-wake-")); roots.push(dir); return dir; }
const threadId = "123e4567-e89b-42d3-a456-426614174000";
const token = "token-id.private-secret";
const cursor = "m4.i0.b2.rZmVlZDox";
const empty = { cursor, timedOut: true, messages: [], issues: [], runtimeEvents: [], mailbox: [] };
const event = { cursor: "m5.i0.b2.rZmVlZDoy", timedOut: false, messages: [{ schemaVersion: 1, seq: 5, messageId: "message-5", author: "user", channel: "web", text: "Làm tiếp", at: "2026-11-05T00:00:00.000Z" }], issues: [], runtimeEvents: [], mailbox: [] };

describe("Codex Director event wake", () => {
  it("keeps the model idle through empty waits and queues one wake without acknowledging the event", async () => {
    const dir = await root(); const spawned: string[] = [];
    const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async generation => { spawned.push(generation); } });
    expect(spawned).toEqual([state.generation]);
    const seenCursors: string[] = []; const queued: { thread: string; message: string; env: Record<string, string | undefined> }[] = [];
    let calls = 0;
    await runCodexDirectorWatch({ root: dir, sessionName: "session", generation: state.generation,
      wait: async value => { seenCursors.push(value); return calls++ < 2 ? empty : event; },
      queue: async (thread, message, env) => { queued.push({ thread, message, env }); },
      delay: async () => {} });
    expect(seenCursors).toEqual([cursor, cursor, cursor]);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.thread).toBe(threadId);
    expect(queued[0]!.message).toContain(cursor);
    expect(queued[0]!.message).not.toContain(token);
    expect(queued[0]!.env.BFLOW_DIRECTOR_TOKEN).toBeUndefined();
    await expect(isCodexDirectorWakePrompt(dir, "session", queued[0]!.message)).resolves.toBe(true);
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("queued");
    const next = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor: "m5.i0.b2.rZmVlZDoy", spawn: async () => {} });
    expect(next.generation).not.toBe(state.generation);
    expect(JSON.stringify(await readFile(join(dir, ".bflow", "state", "director-watch", "session.json"), "utf8"))).not.toContain(token);
  });

  it("does not queue after a real manual prompt invalidates the watch", async () => {
    const dir = await root(); const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    let queued = 0;
    await runCodexDirectorWatch({ root: dir, sessionName: "session", generation: state.generation,
      wait: async () => { await cancelCodexDirectorWatch(dir, "session"); return event; },
      queue: async () => { queued++; }, delay: async () => {} });
    expect(queued).toBe(0);
  });

  it("serializes prompt cancellation before queue admission", async () => {
    const dir = await root(); const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    let release!: () => void; let held!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { held = resolve; });
    const holder = withCodexDirectorWatchLock(dir, "session", async () => { held(); await gate; });
    await entered;
    const cancel = cancelCodexDirectorWatch(dir, "session");
    let queued = 0;
    const watch = runCodexDirectorWatch({ root: dir, sessionName: "session", generation: state.generation,
      wait: async () => event, queue: async () => { queued++; }, delay: async () => {} });
    release(); await Promise.all([holder, cancel, watch]);
    expect(queued).toBe(0);
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("cancelled");
  });
  it("does not lose a cancellation racing the first watcher arm", async () => {
    const dir = await root(); let release!: () => void; let held!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { held = resolve; });
    const holder = withCodexDirectorWatchLock(dir, "session", async () => { held(); await gate; });
    await entered;
    const arm = armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    const cancel = cancelCodexDirectorWatch(dir, "session");
    release(); await Promise.all([holder, arm, cancel]);
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("cancelled");
  });
  it("does not restore an armed marker after a prompt arrives during an admitted queue", async () => {
    const dir = await root(); const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    let release!: () => void; let queued!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { queued = resolve; });
    const watch = runCodexDirectorWatch({ root: dir, sessionName: "session", generation: state.generation,
      wait: async () => event, queue: async () => { queued(); await gate; }, delay: async () => {} });
    await entered;
    await cancelCodexDirectorWatch(dir, "session");
    release(); await watch;
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("cancelled");
  });

  it("does not let an old watcher queue after it was cancelled and a new watcher armed", async () => {
    const dir = await root(); const first = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    await cancelCodexDirectorWatch(dir, "session");
    const second = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    let queued = 0;
    await runCodexDirectorWatch({ root: dir, sessionName: "session", generation: first.generation,
      wait: async () => { throw new Error("obsolete watcher must not wait"); }, queue: async () => { queued++; }, delay: async () => {} });
    expect(queued).toBe(0);
    expect(second.generation).not.toBe(first.generation);
  });

  it("recognizes a queued wake after cancellation but not after a new generation replaces it", async () => {
    const dir = await root(); const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    const prompt = `BFLOW_DIRECTOR_WAKE ${state.generation} ${cursor}`;
    expect(await isCodexDirectorWakePrompt(dir, "session", prompt)).toBe(true);
    await cancelCodexDirectorWatch(dir, "session");
    expect(await isCodexDirectorWakePrompt(dir, "session", prompt)).toBe(true);
    await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    expect(await isCodexDirectorWakePrompt(dir, "session", prompt)).toBe(false);
  });
  it("refuses an invalid cursor before starting a watcher", async () => {
    const dir = await root(); let spawned = false;
    await expect(armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor: "invalid", spawn: async () => { spawned = true; } })).rejects.toThrow();
    expect(spawned).toBe(false);
  });
  it("does not replace a corrupt marker that might represent uncertain delivery", async () => {
    const dir = await root(); const markerDir = join(dir, ".bflow", "state", "director-watch");
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, "session.json"), "{broken");
    await expect(armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} })).rejects.toThrow("marker invalid");
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("invalid");
  });
  it("refuses an uninitialized Runtime cursor before suspending", async () => {
    const dir = await root(); let spawned = false;
    await expect(armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor: "m4.i0.b2.r", spawn: async () => { spawned = true; } })).rejects.toThrow("Runtime cursor");
    expect(spawned).toBe(false);
  });
  it("fails closed when another watcher is already armed", async () => {
    const dir = await root(); const first = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    await expect(armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} })).rejects.toThrow("already armed");
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("armed");
    expect(await isCodexDirectorWakePrompt(dir, "session", `BFLOW_DIRECTOR_WAKE ${first.generation} ${cursor}`)).toBe(true);
  });
  it("replaces a stale armed watcher after its heartbeat expires", async () => {
    const dir = await root();
    const first = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {}, now: () => new Date("2026-11-05T00:00:00.000Z") });
    const second = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {}, now: () => new Date("2026-11-05T00:03:00.000Z") });
    expect(second.generation).not.toBe(first.generation);
    expect(await isCodexDirectorWakePrompt(dir, "session", `BFLOW_DIRECTOR_WAKE ${first.generation} ${cursor}`)).toBe(false);
  });

  it("executes codex queue with the exact thread and no Director token in argv or child environment", async () => {
    const dir = await root(); const executable = join(dir, "codex"); const output = join(dir, "queued.json");
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),token:process.env.BFLOW_DIRECTOR_TOKEN,nestedThread:process.env.CODEX_THREAD_ID,home:process.env.CODEX_HOME}));\n`);
    await chmod(executable, 0o700);
    await queueCodexDirectorThread({ executable, cwd: dir, threadId, message: "BFLOW_DIRECTOR_WAKE sample", env: { ...process.env, BFLOW_DIRECTOR_TOKEN: token, CODEX_THREAD_ID: threadId, CODEX_HOME: dir } });
    const recorded = JSON.parse(await readFile(output, "utf8"));
    expect(recorded.argv).toEqual(["queue", "--thread", threadId, "--message", "BFLOW_DIRECTOR_WAKE sample", "--resume"]);
    expect(recorded.token).toBeUndefined();
    expect(recorded.nestedThread).toBeUndefined();
    expect(recorded.home).toBe(dir);
    expect(JSON.stringify(recorded)).not.toContain(token);
  });

  it("records uncertain queue delivery and never resends the wake", async () => {
    const dir = await root(); const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    const seen: string[] = []; const delays: number[] = []; let queues = 0;
    await runCodexDirectorWatch({ root: dir, sessionName: "session", generation: state.generation,
      wait: async value => { seen.push(value); return event; },
      queue: async () => { queues++; throw new Error("queue timeout after send"); },
      delay: async ms => { delays.push(ms); } });
    expect(seen).toEqual([cursor]);
    expect(queues).toBe(1);
    expect(delays).toEqual([]);
    expect(await readCodexDirectorWatchStatus(dir, "session")).toBe("wake_failed");
    await expect(armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} })).rejects.toThrow("reconcile");
    const resumed = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor: "m5.i0.b2.rZmVlZDoy", spawn: async () => {} });
    expect(resumed.status).toBe("armed");
  });

  it("treats a successful queue with a failed resume warning as uncertain without adding another message", async () => {
    const dir = await root(); const executable = join(dir, "codex");
    await writeFile(executable, "#!/bin/sh\necho 'Warning: failed to resume thread on local daemon' >&2\nexit 0\n");
    await chmod(executable, 0o700);
    await expect(queueCodexDirectorThread({ executable, cwd: dir, threadId, message: "wake", env: {} })).rejects.toThrow("resume");
  });

  it("keeps the Director cursor across empty waits and gives event-only wakes a summary inspect hint", async () => {
    const dir = await root(); const state = await armCodexDirectorWatch({ root: dir, sessionName: "session", threadId, cursor, spawn: async () => {} });
    const seen: string[] = []; let message = "";
    await runCodexDirectorWatch({ root: dir, sessionName: "session", generation: state.generation,
      wait: async value => {
        seen.push(value);
        return seen.length === 1 ? { ...empty, cursor: "m4.i0.b2.rZmVlZC0x" }
          : { ...empty, cursor: "m4.i0.b2.rZmVlZC0y", timedOut: false, runtimeEvents: [{ type: "projection.run", summary: "changed" }] };
      },
      queue: async (_thread, wake) => { message = wake; }, delay: async () => {} });
    expect(seen).toEqual([cursor, cursor]);
    expect(message).toContain(cursor);
    expect(message).toContain("inspect");
    expect(message).toContain("view summary");
    expect(message).toContain("projection.run");
  });
});
