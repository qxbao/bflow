import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DirectorWaitResultSchema } from "@bflow/contracts";
import { z } from "zod";

const StateSchema = z.object({
  version: z.literal(1), generation: z.string().uuid(), threadId: z.string().uuid(),
  cursor: z.string().min(1).max(512).regex(/^m\d+\.i\d+(?:\.b\d+)?\.r[A-Za-z0-9_-]+$/),
  touchedAt: z.string().datetime(),
  status: z.enum(["armed", "queueing", "queued", "cancelled", "wake_failed"])
}).strict();
export type DirectorWatchState = z.infer<typeof StateSchema>;
const WAIT_MS = 45_000;
const STALE_MS = 120_000;
const LOCK_STALE_MS = 60_000;
const LOCK_DEADLINE_MS = 2000;
const execFileAsync = promisify(execFile);
const watchTransitions = new Map<string, Promise<void>>();
const SESSION_STOPPED_ARM_MESSAGE = "session_stopped_by_user: Người dùng đã dừng phiên Bflow; không đặt watcher ngủ. Báo cho người dùng và kết thúc lượt.";

/** A failing stop check fails toward stopping: a watcher must never keep a session alive on an unreadable marker. */
async function stoppedSafely(stopped: () => Promise<boolean>): Promise<boolean> {
  try { return await stopped(); } catch { return true; }
}

export async function queueCodexDirectorThread(input: {
  executable: string; cwd: string; threadId: string; message: string; env: Record<string, string | undefined>;
}): Promise<void> {
  const env = { ...input.env };
  delete env.BFLOW_DIRECTOR_TOKEN;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_TOOL_CALL_ID;
  delete env.CODEX_CI;
  const result = await execFileAsync(input.executable, ["queue", "--thread", input.threadId, "--message", input.message, "--resume"],
    { cwd: input.cwd, env: env as NodeJS.ProcessEnv, timeout: 15_000, maxBuffer: 8192 });
  if (/(?:failed|could not|unable).*resume|resume.*(?:failed|could not|unable)/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error("Codex queued the wake, but resume was not confirmed");
  }
}

function statePath(root: string, sessionName: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionName) || sessionName.includes("..")) throw new Error("Invalid Director session name");
  return join(root, ".bflow", "state", "director-watch", `${sessionName}.json`);
}

/** Cross-process serialization for the short marker transitions; never held during a long wait or queue call. */
export async function withCodexDirectorWatchLock<T>(root: string, sessionName: string, action: () => Promise<T>): Promise<T> {
  const lock = resolve(`${statePath(root, sessionName)}.lock`);
  // mkdir retries provide exclusion across processes, but no FIFO ordering.
  // In this process a later cancellation must follow an already-requested arm,
  // even when both are waiting for the same filesystem lock.
  const previous = watchTransitions.get(lock) ?? Promise.resolve();
  const transition = previous.then(() => withWatchFileLock(lock, action));
  const settled = transition.then(() => undefined, () => undefined);
  watchTransitions.set(lock, settled);
  try { return await transition; }
  finally { if (watchTransitions.get(lock) === settled) watchTransitions.delete(lock); }
}

async function withWatchFileLock<T>(lock: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const held = await stat(lock);
        if (held.isDirectory() && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lock).catch(() => undefined);
        }
      } catch { /* another process released it */ }
      if (Date.now() >= deadline) throw new Error("Director watcher state is busy; retry after the other command finishes");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await action(); }
  finally { await rmdir(lock); }
}

async function save(root: string, sessionName: string, state: DirectorWatchState): Promise<void> {
  const path = statePath(root, sessionName);
  await mkdir(join(root, ".bflow", "state", "director-watch"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(StateSchema.parse(state)), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function read(root: string, sessionName: string): Promise<DirectorWatchState | undefined> {
  const path = statePath(root, sessionName);
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.size > 4096) throw new Error("Director watcher marker invalid");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = StateSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch { /* malformed marker is not an absent marker */ }
  throw new Error("Director watcher marker invalid");
}

export async function armCodexDirectorWatch(input: {
  root: string; sessionName: string; threadId: string; cursor: string;
  spawn: (generation: string) => Promise<void>;
  now?: () => Date;
  /** True when the user stopped the session (or the stop marker is unreadable): the watcher must not be armed. */
  stopped?: () => Promise<boolean>;
}): Promise<DirectorWatchState> {
  if (input.stopped && await stoppedSafely(input.stopped)) throw new Error(SESSION_STOPPED_ARM_MESSAGE);
  if (!/\.r[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error("Runtime cursor is not initialized; call director_wait before suspending");
  const now = input.now?.() ?? new Date();
  const state = StateSchema.parse({ version: 1, generation: randomUUID(), threadId: input.threadId, cursor: input.cursor, touchedAt: now.toISOString(), status: "armed" });
  await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
    const previous = await read(input.root, input.sessionName);
    if ((previous?.status === "armed" || previous?.status === "queueing") && now.getTime() - Date.parse(previous.touchedAt) < STALE_MS)
      throw new Error("Director watcher already armed");
    if (previous?.status === "wake_failed" && previous.cursor === input.cursor)
      throw new Error("Director wake delivery is uncertain; reconcile the event with director_wait before suspending again");
    await save(input.root, input.sessionName, state);
  });
  try { await input.spawn(state.generation); }
  catch (error) {
    await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
      const current = await read(input.root, input.sessionName);
      if (current?.generation === state.generation && current.status === "armed")
        await save(input.root, input.sessionName, { ...current, status: "cancelled" });
    });
    throw error;
  }
  return state;
}

export async function cancelCodexDirectorWatch(root: string, sessionName: string): Promise<void> {
  try {
    await withCodexDirectorWatchLock(root, sessionName, async () => {
      const current = await read(root, sessionName);
      if (current && current.status !== "cancelled") await save(root, sessionName, { ...current, status: "cancelled" });
    });
  } catch (error) {
    // A fake or read-only repository with no watcher must not make the prompt hook fail before it records the user.
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "EACCES", "EROFS"].includes(code ?? "")) {
      try { if (!(await read(root, sessionName))) return; } catch { return; }
    }
    throw error;
  }
}

/** Fast path for a bound Codex hook: a different provider thread cannot cancel this Director's watcher. */
export async function cancelCodexDirectorWatchIfThread(root: string, sessionName: string, threadId: string): Promise<boolean> {
  let existing: DirectorWatchState | undefined;
  try { existing = await read(root, sessionName); } catch { return false; }
  if (!existing || existing.threadId !== threadId) return false;
  return withCodexDirectorWatchLock(root, sessionName, async () => {
    const current = await read(root, sessionName);
    if (!current || current.threadId !== threadId) return false;
    if (current.status !== "cancelled") await save(root, sessionName, { ...current, status: "cancelled" });
    return true;
  });
}

export async function readCodexDirectorWatchStatus(root: string, sessionName: string): Promise<DirectorWatchState["status"] | "absent" | "invalid"> {
  try { return (await read(root, sessionName))?.status ?? "absent"; }
  catch { return "invalid"; }
}

export async function isCodexDirectorWakePrompt(root: string, sessionName: string, prompt: string): Promise<boolean> {
  const current = await read(root, sessionName);
  return current !== undefined && prompt.startsWith(`BFLOW_DIRECTOR_WAKE ${current.generation} ${current.cursor}`);
}

/** A queued wake may arrive after a newer suspension replaced its marker; it is still machine input, never user intent. */
export function isCodexDirectorWakeMarker(prompt: string): boolean {
  return /^BFLOW_DIRECTOR_WAKE [0-9a-fA-F-]{36} m\d+\.i\d+(?:\.b\d+)?\.r[A-Za-z0-9_-]*(?:\n|$)/.test(prompt);
}

export async function runCodexDirectorWatch(input: {
  root: string; sessionName: string; generation: string;
  wait: (cursor: string, timeoutMs: number) => Promise<unknown>;
  queue: (threadId: string, message: string, env: Record<string, string | undefined>) => Promise<void>;
  delay: (ms: number) => Promise<void>;
  /** True once the user stopped the session. Defaults to never stopped. */
  stopped?: () => Promise<boolean>;
}): Promise<void> {
  let failures = 0;
  const isStopped = (): Promise<boolean> => input.stopped ? stoppedSafely(input.stopped) : Promise.resolve(false);
  /** Marks this generation cancelled so no wake can be queued. Returns after the transition. */
  const cancelForStop = async (): Promise<void> => {
    await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
      const current = await read(input.root, input.sessionName);
      if (current?.generation === input.generation && (current.status === "armed" || current.status === "queueing"))
        await save(input.root, input.sessionName, { ...current, status: "cancelled" });
    });
  };
  for (;;) {
    const state = await read(input.root, input.sessionName);
    if (!state || state.status !== "armed" || state.generation !== input.generation) return;
    if (await isStopped()) { await cancelForStop(); return; }
    let result: z.infer<typeof DirectorWaitResultSchema>;
    try { result = DirectorWaitResultSchema.parse(await input.wait(state.cursor, WAIT_MS)); failures = 0; }
    catch (error) {
      if (/Director token rejected/i.test(String(error))) return;
      if (await isStopped()) { await cancelForStop(); return; }
      failures++;
      await input.delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      continue;
    }
    if (result.timedOut || (result.messages.length + result.issues.length + result.runtimeEvents.length + (result.mailbox?.length ?? 0)) === 0) {
      const active = await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
        const latest = await read(input.root, input.sessionName);
        if (!latest || latest.generation !== input.generation || latest.status !== "armed") return false;
        await save(input.root, input.sessionName, { ...latest, touchedAt: new Date().toISOString() });
        return true;
      });
      if (!active) return;
      continue;
    }
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BFLOW_DIRECTOR_TOKEN;
    const runtimeHint = result.runtimeEvents.length > 0
      ? ` Nếu director_wait không trả sự kiện Runtime, gọi inspect view summary cho các run đang hoạt động; tín hiệu: ${result.runtimeEvents.slice(0, 8).map(item => item.type).join(", ")}.`
      : "";
    const message = `BFLOW_DIRECTOR_WAKE ${state.generation} ${state.cursor}\nBflow có sự kiện mới. Gọi director_wait với cursor trên, xử lý mọi mục, rồi gọi director_suspend MCP với cursor mới và threadId ${state.threadId}; kết thúc lượt.${runtimeHint}`;
    const admission = await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
      const current = await read(input.root, input.sessionName);
      if (!current || current.generation !== input.generation || current.status !== "armed") return undefined;
      if (await isStopped()) {
        await save(input.root, input.sessionName, { ...current, status: "cancelled" });
        return undefined;
      }
      await save(input.root, input.sessionName, { ...current, status: "queueing" });
      // Start the queue mutation before releasing the lock, so cancellation cannot slip between admission and send.
      const pending = input.queue(state.threadId, message, env);
      void pending.catch(() => undefined); // Keep the rejection handled until the lock is released and we can await it.
      return { pending };
    });
    if (!admission) return;
    try {
      await admission.pending;
      await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
        const current = await read(input.root, input.sessionName);
        if (current?.generation === input.generation && current.status === "queueing")
          await save(input.root, input.sessionName, { ...current, status: "queued" });
      });
      return;
    }
    catch {
      // A timeout or nonzero queue result may still have delivered the message. Never resend without reconciliation.
      await withCodexDirectorWatchLock(input.root, input.sessionName, async () => {
        const current = await read(input.root, input.sessionName);
        if (current?.generation === input.generation && current.status === "queueing")
          await save(input.root, input.sessionName, { ...current, status: "wake_failed" });
      });
      return;
    }
  }
}
