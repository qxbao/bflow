import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DirectorWaitResultSchema } from "@bflow/contracts";

export type DirectorNdjsonStatus = "new" | "starting" | "idle" | "sending" | "uncertain" | "stopped";

export interface DirectorNdjsonProtocol {
  encodePrompt(prompt: string): string;
  classifyEvent(value: unknown):
    | { kind: "other"; conversationId?: string }
    | { kind: "turn_complete"; success: boolean; conversationId?: string };
}

export interface DirectorNdjsonSupervisorOptions {
  readonly provider: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stateRoot: string;
  readonly sessionName: string;
  readonly initialPrompt: string;
  readonly protocol: DirectorNdjsonProtocol;
  readonly onTranscript?: (line: string) => void;
  readonly onStatus?: (status: DirectorNdjsonStatus) => void;
}

/**
 * Owns one persistent stream-JSON process. The exclusive marker survives an unclean exit,
 * forcing a human or Runtime reconciliation before another process can send to the same Director.
 */
export class DirectorNdjsonSupervisor {
  readonly #options: DirectorNdjsonSupervisorOptions;
  #process: ChildProcessWithoutNullStreams | undefined;
  #status: DirectorNdjsonStatus = "new";
  #marker: string;
  #generation = randomUUID();
  #conversationId: string | undefined;
  #resolveTurn: ((success: boolean) => void) | undefined;
  #rejectTurn: ((error: Error) => void) | undefined;
  #stdoutBuffer = "";
  #stderrBuffer = "";

  constructor(options: DirectorNdjsonSupervisorOptions) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.sessionName) || options.sessionName.includes("..") ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(options.provider)) throw new Error("Invalid Director supervisor identity");
    this.#options = options;
    this.#marker = join(options.stateRoot, ".bflow", "state", "director-supervisor", `${options.sessionName}-${options.provider}.json`);
  }

  status(): DirectorNdjsonStatus { return this.#status; }
  conversationId(): string | undefined { return this.#conversationId; }

  async start(): Promise<void> {
    if (this.#status !== "new") throw new Error("Director supervisor already started");
    await mkdir(dirname(this.#marker), { recursive: true, mode: 0o700 });
    try {
      const file = await open(this.#marker, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, generation: this.#generation, status: "starting", pid: process.pid })); }
      finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let previous = "Director supervisor already running or unreconciled";
        try {
          const state = JSON.parse(await readFile(this.#marker, "utf8")) as { status?: unknown };
          if (state.status === "sending" || state.status === "uncertain") previous = "Director delivery uncertain; reconcile before starting another process";
        } catch { /* A corrupt marker is also unreconciled. */ }
        throw new Error(previous);
      }
      throw error;
    }
    this.#setStatus("starting");
    const env = Object.fromEntries(Object.entries(this.#options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    try {
      const child = spawn(this.#options.executable, [...this.#options.args], {
        cwd: this.#options.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false
      });
      this.#process = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.#receive(chunk));
      child.stderr.on("data", (chunk: string) => {
        this.#stderrBuffer = (this.#stderrBuffer + chunk).slice(-8192);
        this.#emit(this.#redact(chunk));
      });
      child.once("error", () => this.#onExit());
      child.once("exit", () => this.#onExit());
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      await this.#send(this.#options.initialPrompt);
    } catch (error) {
      if (this.status() !== "uncertain") {
        this.#setStatus("stopped");
        await rm(this.#marker, { force: true });
      }
      throw error;
    }
  }

  async sendWake(prompt: string): Promise<void> {
    if (this.#status !== "idle") throw new Error(`Director cannot accept wake while ${this.#status}`);
    await this.#send(prompt);
  }

  async stop(): Promise<void> {
    const wasUncertain = this.#status === "uncertain" || this.#status === "sending";
    if (this.#process && this.#process.exitCode === null) this.#process.kill("SIGTERM");
    this.#process = undefined;
    this.#rejectTurn?.(new Error("Director process stopped; delivery uncertain"));
    this.#rejectTurn = undefined; this.#resolveTurn = undefined;
    if (wasUncertain) { this.#setStatus("uncertain"); return; }
    this.#setStatus("stopped");
    await rm(this.#marker, { force: true });
  }

  async #send(prompt: string): Promise<void> {
    const child = this.#process;
    if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error("Director process unavailable");
    if (this.#status !== "idle" && this.#status !== "starting") throw new Error("Director turn already pending");
    const line = this.#options.protocol.encodePrompt(prompt);
    if (line.includes("\n") || line.includes("\r")) throw new Error("Director protocol encoded more than one line");
    // Persist intent before writing bytes. Any crash from here through conclusive result is uncertain.
    this.#setStatus("sending");
    try { await this.#persist("sending"); }
    catch (error) { this.#setStatus("uncertain"); throw error; }
    const result = new Promise<boolean>((resolve, reject) => { this.#resolveTurn = resolve; this.#rejectTurn = reject; });
    try {
      await new Promise<void>((resolve, reject) => child.stdin.write(`${line}\n`, error => error ? reject(error) : resolve()));
      if (!(await result)) throw new Error("Director turn failed; delivery occurred but completion was not successful");
      await this.#persist("idle");
      this.#setStatus("idle");
    } catch (error) {
      await this.#persist("uncertain");
      this.#setStatus("uncertain");
      throw new Error(`Director delivery uncertain: ${this.#redact(String(error))}`);
    } finally {
      this.#resolveTurn = undefined; this.#rejectTurn = undefined;
    }
  }

  #receive(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (this.#stdoutBuffer.length > 1024 * 1024) { this.#process?.kill("SIGTERM"); return; }
    for (;;) {
      const at = this.#stdoutBuffer.indexOf("\n");
      if (at < 0) return;
      const raw = this.#stdoutBuffer.slice(0, at);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(at + 1);
      this.#emit(this.#redact(raw));
      let event: unknown;
      try { event = JSON.parse(raw); } catch { continue; }
      const classification = this.#options.protocol.classifyEvent(event);
      if (classification.conversationId) this.#conversationId = classification.conversationId;
      if (classification.kind === "turn_complete") this.#resolveTurn?.(classification.success);
    }
  }

  #onExit(): void {
    if (this.#status === "stopped" || this.#status === "uncertain") return;
    if (this.#status === "sending" || this.#status === "starting") {
      this.#setStatus("uncertain");
      void this.#persist("uncertain").catch(() => undefined);
      this.#rejectTurn?.(new Error("Director process exited before a conclusive result"));
    } else {
      this.#setStatus("uncertain");
      void this.#persist("uncertain").catch(() => undefined);
    }
  }

  async #persist(status: DirectorNdjsonStatus): Promise<void> {
    const temporary = `${this.#marker}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, generation: this.#generation,
      status, pid: this.#process?.pid ?? null, conversationId: this.#conversationId ?? null }), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.#marker);
  }

  #setStatus(status: DirectorNdjsonStatus): void {
    this.#status = status;
    try { this.#options.onStatus?.(status); } catch { /* A display callback cannot change delivery state. */ }
  }
  #emit(line: string): void { try { this.#options.onTranscript?.(line); } catch { /* best effort display */ } }
  #redact(value: string): string {
    const secret = this.#options.env.BFLOW_DIRECTOR_TOKEN;
    return secret ? value.split(secret).join("[redacted]") : value;
  }
}

export const agyDirectorProtocol: DirectorNdjsonProtocol = {
  encodePrompt: prompt => JSON.stringify({ event: "user", message: { content: prompt } }),
  classifyEvent(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "other" };
    const event = value as Record<string, unknown>;
    if (event.event !== "result" || typeof event.result !== "object" || event.result === null || Array.isArray(event.result)) return { kind: "other" };
    const result = event.result as Record<string, unknown>;
    return { kind: "turn_complete", success: result.status === "SUCCESS",
      ...(typeof result.conversation_id === "string" ? { conversationId: result.conversation_id } : {}) };
  }
};

/** One suspension only. The caller must rearm with a cursor acknowledged by a later model turn. */
export async function waitAndWakeDirector(input: {
  readonly cursor: string;
  readonly wait: (cursor: string, timeoutMs: number) => Promise<unknown>;
  readonly wake: (message: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<"woken" | "cancelled"> {
  for (;;) {
    if (input.signal?.aborted) return "cancelled";
    const result = DirectorWaitResultSchema.parse(await input.wait(input.cursor, input.timeoutMs ?? 45_000));
    if (input.signal?.aborted) return "cancelled";
    if (result.timedOut || result.messages.length + result.issues.length + result.runtimeEvents.length + (result.mailbox?.length ?? 0) === 0) continue;
    const hint = result.runtimeEvents.length > 0
      ? ` Runtime events: ${result.runtimeEvents.slice(0, 8).map(item => item.type).join(", ")}. Inspect active runs if director_wait has no Runtime items.`
      : "";
    await input.wake(`BFLOW_DIRECTOR_WAKE ${input.cursor}\nCall director_wait with this cursor, process all items, and suspend again with the returned cursor.${hint}`);
    return "woken";
  }
}
