import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DirectorWaitResultSchema } from "@bflow/contracts";
import { z } from "zod";

const StateSchema = z.object({
  version: z.literal(1), generation: z.string().uuid(), threadId: z.string().uuid(),
  cursor: z.string().min(1).max(512).regex(/^m\d+\.i\d+(?:\.b\d+)?\.r[A-Za-z0-9_-]*$/),
  touchedAt: z.string().datetime(),
  status: z.enum(["armed", "queued", "cancelled", "wake_failed"])
}).strict();
export type DirectorWatchState = z.infer<typeof StateSchema>;
const WAIT_MS = 45_000;
const STALE_MS = 120_000;
const execFileAsync = promisify(execFile);

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

async function save(root: string, sessionName: string, state: DirectorWatchState): Promise<void> {
  const path = statePath(root, sessionName);
  await mkdir(join(root, ".bflow", "state", "director-watch"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(StateSchema.parse(state)), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function read(root: string, sessionName: string): Promise<DirectorWatchState | undefined> {
  try {
    const path = statePath(root, sessionName);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4096) return undefined;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return StateSchema.safeParse(parsed).data;
  } catch { return undefined; }
}

export async function armCodexDirectorWatch(input: {
  root: string; sessionName: string; threadId: string; cursor: string;
  spawn: (generation: string) => Promise<void>;
  now?: () => Date;
}): Promise<DirectorWatchState> {
  const now = input.now?.() ?? new Date();
  const previous = await read(input.root, input.sessionName);
  if (previous?.status === "armed" && now.getTime() - Date.parse(previous.touchedAt) < STALE_MS) throw new Error("Director watcher already armed");
  if (previous?.status === "wake_failed" && previous.cursor === input.cursor)
    throw new Error("Director wake delivery is uncertain; reconcile the event with director_wait before suspending again");
  const state = StateSchema.parse({ version: 1, generation: randomUUID(), threadId: input.threadId, cursor: input.cursor, touchedAt: now.toISOString(), status: "armed" });
  await save(input.root, input.sessionName, state);
  try { await input.spawn(state.generation); }
  catch (error) { await cancelCodexDirectorWatch(input.root, input.sessionName); throw error; }
  return state;
}

export async function cancelCodexDirectorWatch(root: string, sessionName: string): Promise<void> {
  const current = await read(root, sessionName);
  if (current && current.status !== "cancelled") await save(root, sessionName, { ...current, status: "cancelled" });
}

export async function readCodexDirectorWatchStatus(root: string, sessionName: string): Promise<DirectorWatchState["status"] | "absent"> {
  return (await read(root, sessionName))?.status ?? "absent";
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
}): Promise<void> {
  let failures = 0;
  for (;;) {
    const state = await read(input.root, input.sessionName);
    if (!state || state.status !== "armed" || state.generation !== input.generation) return;
    let result: z.infer<typeof DirectorWaitResultSchema>;
    try { result = DirectorWaitResultSchema.parse(await input.wait(state.cursor, WAIT_MS)); failures = 0; }
    catch (error) {
      if (/Director token rejected/i.test(String(error))) return;
      failures++;
      await input.delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      continue;
    }
    if (result.timedOut || (result.messages.length + result.issues.length + result.runtimeEvents.length + (result.mailbox?.length ?? 0)) === 0) {
      const latest = await read(input.root, input.sessionName);
      if (!latest || latest.generation !== input.generation || latest.status !== "armed") return;
      await save(input.root, input.sessionName, { ...latest, touchedAt: new Date().toISOString() });
      continue;
    }
    const latest = await read(input.root, input.sessionName);
    if (!latest || latest.generation !== input.generation || latest.status !== "armed") return;
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BFLOW_DIRECTOR_TOKEN;
    const runtimeHint = result.runtimeEvents.length > 0
      ? ` Nếu director_wait không trả sự kiện Runtime, gọi inspect cho run liên quan: ${result.runtimeEvents.slice(0, 8).map(item => `${item.type}${item.runId ? ` ${item.runId}` : ""}`).join(", ")}.`
      : "";
    const message = `BFLOW_DIRECTOR_WAKE ${state.generation} ${state.cursor}\nBflow có sự kiện mới. Gọi director_wait với cursor trên, xử lý mọi mục, rồi chạy bflow director suspend với cursor mới và kết thúc lượt.${runtimeHint}`;
    try {
      await input.queue(state.threadId, message, env);
      const current = await read(input.root, input.sessionName);
      if (current?.generation === input.generation && current.status === "armed")
        await save(input.root, input.sessionName, { ...current, status: "queued" });
      return;
    }
    catch {
      // A timeout or nonzero queue result may still have delivered the message. Never resend without reconciliation.
      const current = await read(input.root, input.sessionName);
      if (current?.generation === input.generation && current.status === "armed")
        await save(input.root, input.sessionName, { ...current, status: "wake_failed" });
      return;
    }
  }
}
