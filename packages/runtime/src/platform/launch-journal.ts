import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AgentProviderIdSchema,
  AgentRoleSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256DigestSchema,
  RoleProfilePinSchema
} from "@bflow/contracts";
import type { LaunchJournalEntry, LaunchJournalPort } from "./ports.js";

/** Replay found a malformed, partial or unexpected line. Corruption is reported, never skipped. */
export class LaunchJournalCorruptionError extends Error {
  readonly code = "corruption" as const;

  constructor(message: string) {
    super(message);
    this.name = "LaunchJournalCorruptionError";
  }
}

type FieldCheck = (value: unknown) => boolean;

const MAX_TEXT_LENGTH = 2000;

const checkIdentifier: FieldCheck = (value) => IdentifierSchema.safeParse(value).success;
const checkTimestamp: FieldCheck = (value) => IsoDateTimeSchema.safeParse(value).success;
const checkDigest: FieldCheck = (value) => Sha256DigestSchema.safeParse(value).success;
const checkRole: FieldCheck = (value) => AgentRoleSchema.safeParse(value).success;
const checkProvider: FieldCheck = (value) => AgentProviderIdSchema.safeParse(value).success;
const checkHealthStatus: FieldCheck = (value) => value === "ready" || value === "blocked" || value === "unsupported";
const checkGeneration: FieldCheck = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const checkText: FieldCheck = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH && !value.includes("\0");

interface EntrySpec {
  readonly required: Readonly<Record<string, FieldCheck>>;
  readonly optional?: Readonly<Record<string, FieldCheck>>;
}

/**
 * Strict per-kind schema mirroring `LaunchJournalEntry`. Each field is checked with the
 * exported contract primitive; unknown keys and missing required keys are rejected.
 */
const ENTRY_SPECS: Readonly<Record<LaunchJournalEntry["kind"], EntrySpec>> = {
  intent: {
    required: {
      kind: (v) => v === "intent",
      launchId: checkIdentifier,
      role: checkRole,
      provider: checkProvider,
      environmentId: checkIdentifier,
      configFingerprint: checkDigest,
      launchFingerprint: checkDigest,
      generation: checkGeneration,
      recordedAt: checkTimestamp
    },
    optional: { taskId: checkIdentifier, roleProfile: value => RoleProfilePinSchema.safeParse(value).success }
  },
  attested: {
    required: {
      kind: (v) => v === "attested",
      launchId: checkIdentifier,
      paneId: checkIdentifier,
      receiptId: checkIdentifier,
      recordedAt: checkTimestamp
    }
  },
  activated: {
    required: {
      kind: (v) => v === "activated",
      launchId: checkIdentifier,
      status: checkHealthStatus,
      validUntil: checkTimestamp,
      recordedAt: checkTimestamp
    }
  },
  failed: {
    required: {
      kind: (v) => v === "failed",
      launchId: checkIdentifier,
      code: checkIdentifier,
      message: checkText,
      recordedAt: checkTimestamp
    }
  },
  released: {
    required: {
      kind: (v) => v === "released",
      launchId: checkIdentifier,
      recordedAt: checkTimestamp
    }
  }
};

function validateEntry(value: unknown): LaunchJournalEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(ENTRY_SPECS, kind)) return undefined;
  const spec = ENTRY_SPECS[kind as LaunchJournalEntry["kind"]];
  const optional = spec.optional ?? {};
  for (const [key, check] of Object.entries(spec.required)) {
    if (!Object.prototype.hasOwnProperty.call(record, key) || !check(record[key])) return undefined;
  }
  for (const key of Object.keys(record)) {
    if (Object.prototype.hasOwnProperty.call(spec.required, key)) continue;
    const check = optional[key];
    if (check === undefined || !check(record[key])) return undefined;
  }
  // Every field was checked above against the exported contract primitives.
  return record as unknown as LaunchJournalEntry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Append-only JSONL journal for launch intent, attestation and activation records.
 * Writes are serialized, fsynced before resolving, and never deleted on startup failure.
 */
export class FileLaunchJournal implements LaunchJournalPort {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  append(entry: LaunchJournalEntry): Promise<void> {
    const validated = validateEntry(entry);
    if (validated === undefined) {
      return Promise.reject(new Error("launch journal entry failed schema validation"));
    }
    const line = `${JSON.stringify(validated)}\n`;
    const write = this.queue.then(() => this.writeLine(line));
    this.queue = write.catch(() => undefined);
    return write;
  }

  async entries(): Promise<readonly LaunchJournalEntry[]> {
    await this.queue;
    let text: string;
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) {
      throw new LaunchJournalCorruptionError("launch journal ends with a partial line");
    }

    const lines = text.slice(0, -1).split("\n");
    const entries: LaunchJournalEntry[] = [];
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (line.length === 0) {
        throw new LaunchJournalCorruptionError(`launch journal line ${lineNumber} is empty`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LaunchJournalCorruptionError(`launch journal line ${lineNumber} is not valid JSON`);
      }
      const entry = validateEntry(parsed);
      if (entry === undefined) {
        throw new LaunchJournalCorruptionError(`launch journal line ${lineNumber} failed schema validation`);
      }
      entries.push(entry);
    });
    return entries;
  }

  private async writeLine(line: string): Promise<void> {
    await this.ensureDirectory();
    const handle = await open(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("launch journal path is not a regular file");
      }
      if ((info.mode & 0o777) !== 0o600) {
        await handle.chmod(0o600);
      }
      const created = info.size === 0;
      await handle.writeFile(line, "utf8");
      await handle.sync();
      if (created) await this.syncDirectory();
    } finally {
      await handle.close();
    }
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(`launch journal directory could not be created: ${errorMessage(error)}`);
    }
    const canonical = await realpath(directory);
    if (canonical !== directory) {
      throw new Error("launch journal directory must not contain symlinks");
    }
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error("launch journal parent is not a directory");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`launch journal directory must be private (0700), found ${(info.mode & 0o777).toString(8)}`);
    }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(dirname(this.path), constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
