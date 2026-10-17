import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ContractErrorSchema, JsonValueSchema, type JsonValue } from "@bflow/contracts";
import {
  CommandOutcomeSchema,
  CommandStepSchema,
  conflictError,
  HighLevelCommandNameSchema,
  HighLevelError,
  unknownStateError,
  type CommandIdentity,
  type CommandReport,
  type CommandStep
} from "./envelope.js";

const StoredReportSchema = z
  .object({
    command: HighLevelCommandNameSchema,
    outcome: CommandOutcomeSchema,
    status: z.enum(["accepted", "waiting_user", "succeeded", "failed", "unknown"]),
    exitCode: z.number().int().min(0).max(7),
    steps: z.array(CommandStepSchema),
    data: JsonValueSchema,
    runId: z.string().optional(),
    taskId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    artifacts: z.array(JsonValueSchema).optional(),
    error: ContractErrorSchema.optional()
  })
  .strict();

export const JournalRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: z.string().min(1),
    command: HighLevelCommandNameSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["started", "succeeded", "failed", "unknown"]),
    commandId: z.string().min(1),
    correlationId: z.string().min(1),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    attempts: z.number().int().positive(),
    steps: z.array(CommandStepSchema),
    report: StoredReportSchema.optional()
  })
  .strict();
export type JournalRecord = z.infer<typeof JournalRecordSchema>;

const LockSchema = z.object({ pid: z.number().int().positive(), host: z.string(), token: z.string(), acquiredAt: z.string() }).strict();

/** Deterministic canonical digest of a JSON request. */
export function requestDigest(value: JsonValue): string {
  const canonical = (input: JsonValue): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input !== null && typeof input === "object")
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key]!)}`).join(",")}}`;
    return JSON.stringify(input);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export interface JournalAttempt {
  /** Previous interrupted/failed record when this invocation continues it. */
  readonly previous?: JournalRecord | undefined;
  readonly resumed: boolean;
  /** Persists step progress before the next side effect so an interruption is diagnosable. */
  progress(steps: readonly CommandStep[]): Promise<void>;
  complete(report: CommandReport): Promise<void>;
  release(): Promise<void>;
}

export type JournalBegin =
  | { readonly kind: "execute"; readonly attempt: JournalAttempt }
  | { readonly kind: "replay"; readonly record: JournalRecord };

export interface JournalBeginInput {
  readonly key: string;
  readonly command: JournalRecord["command"];
  readonly request: JsonValue;
  readonly identity: CommandIdentity;
  /** True when the underlying operation reconciles its own partial state and may run again. */
  readonly retrySafe: boolean;
  /** Operator explicitly asked to reconcile an interrupted invocation. */
  readonly resume: boolean;
  readonly now: () => string;
}

/**
 * Per-repository command receipts. A key's lock serializes concurrent invocations; a completed
 * receipt replays without repeating side effects; an interrupted receipt of an operation that is
 * not retry-safe refuses to run again until `--resume` reconciles it.
 */
export class CommandJournal {
  private constructor(readonly directory: string) {}

  static async open(directory: string): Promise<CommandJournal> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Command journal is not a directory: ${directory}`);
    return new CommandJournal(directory);
  }

  private paths(key: string) {
    const id = createHash("sha256").update(key).digest("hex");
    return { record: join(this.directory, `${id}.json`), lock: join(this.directory, `${id}.lock`) };
  }

  async read(key: string): Promise<JournalRecord | undefined> {
    let text: string;
    try { text = await readFile(this.paths(key).record, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = JournalRecordSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.idempotencyKey !== key)
      throw new HighLevelError({ code: "corruption", retryable: false, message: `Command receipt for '${key}' is corrupt` });
    return parsed.data;
  }

  private async acquire(key: string): Promise<() => Promise<void>> {
    const { lock } = this.paths(key);
    const token = randomUUID();
    const body = JSON.stringify({ pid: process.pid, host: hostname(), token, acquiredAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lock, "wx", 0o600);
        try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        return async () => {
          try {
            const current = LockSchema.safeParse(JSON.parse(await readFile(lock, "utf8")));
            if (current.success && current.data.token === token) await unlink(lock);
          } catch { /* Lock already released. */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let holder: z.infer<typeof LockSchema> | undefined;
      try { holder = LockSchema.parse(JSON.parse(await readFile(lock, "utf8"))); } catch { holder = undefined; }
      // A lock that cannot be read may be mid-write by a live owner; treat it as busy.
      if (holder === undefined || holder.host !== hostname() || processAlive(holder.pid))
        throw new HighLevelError(conflictError(`Another invocation is running for idempotency key '${key}'`,
          { reason: "busy", ...(holder !== undefined ? { holderPid: holder.pid } : {}) }));
      // Only one process can move a stale lock aside; the loser retries and observes the new owner.
      const stale = `${lock}.stale-${randomUUID()}`;
      try { await rename(lock, stale); await unlink(stale); } catch { /* Another process recovered it. */ }
    }
    throw new HighLevelError(conflictError(`Another invocation is running for idempotency key '${key}'`, { reason: "busy" }));
  }

  /**
   * Runs `action` while holding the named lock. A concurrent holder makes this throw a busy
   * conflict instead of waiting, so callers never interleave writes to shared state.
   */
  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(`lock:${name}`);
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async begin(input: JournalBeginInput): Promise<JournalBegin> {
    const release = await this.acquire(input.key);
    try {
      const digest = requestDigest(input.request);
      const previous = await this.read(input.key);
      if (previous !== undefined && (previous.requestDigest !== digest || previous.command !== input.command))
        throw new HighLevelError(conflictError(
          `Idempotency key '${input.key}' was already used for a different request`, { reason: "idempotency_key_reuse" }));
      if (previous?.status === "succeeded" && previous.report !== undefined) {
        await release();
        return { kind: "replay", record: previous };
      }
      const interrupted = previous !== undefined && (previous.status === "started" || previous.status === "unknown");
      if (interrupted && !input.retrySafe && !input.resume) {
        const lastStep = previous.steps.at(-1);
        throw new HighLevelError(unknownStateError(
          `A previous '${input.command}' invocation (${previous.commandId}) did not finish` +
          `${lastStep !== undefined ? ` after step '${lastStep.id}'` : ""}; its side effects are unknown. ` +
          "Inspect state, then re-run with --resume to reconcile instead of repeating it blindly.",
          { reason: "interrupted", previousCommandId: previous.commandId, lastStep: lastStep?.id ?? null }));
      }
      const { record: path } = this.paths(input.key);
      const startedAt = input.now();
      let current: JournalRecord = {
        schemaVersion: 1,
        idempotencyKey: input.key,
        command: input.command,
        requestDigest: digest,
        status: "started",
        commandId: input.identity.commandId,
        correlationId: input.identity.correlationId,
        startedAt,
        updatedAt: startedAt,
        attempts: (previous?.attempts ?? 0) + 1,
        steps: []
      };
      await writeAtomic(path, JSON.stringify(current));
      let released = false;
      const attempt: JournalAttempt = {
        previous,
        resumed: interrupted,
        progress: async steps => {
          current = { ...current, steps: [...steps], updatedAt: input.now() };
          await writeAtomic(path, JSON.stringify(current));
        },
        complete: async report => {
          const status = report.status === "unknown" ? "unknown" : report.status === "failed" ? "failed" :
            report.status === "waiting_user" ? "failed" : "succeeded";
          const stored = StoredReportSchema.parse(JSON.parse(JSON.stringify({ ...report, replayed: undefined })));
          current = { ...current, status, steps: [...report.steps], report: stored, updatedAt: input.now() };
          await writeAtomic(path, JSON.stringify(current));
        },
        release: async () => { if (!released) { released = true; await release(); } }
      };
      return { kind: "execute", attempt };
    } catch (error) {
      await release();
      throw error;
    }
  }
}

export function reportFromRecord(record: JournalRecord): CommandReport {
  const report = record.report!;
  return {
    ...report,
    exitCode: report.exitCode as CommandReport["exitCode"],
    artifacts: report.artifacts as CommandReport["artifacts"],
    replayed: true
  };
}
