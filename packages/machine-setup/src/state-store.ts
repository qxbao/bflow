import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  SetupReceiptSchema,
  Sha256DigestSchema,
  type ContractError,
  type OperationResult,
  type SetupReceipt
} from "@bflow/contracts";
import { conflictError, corruption, unsupportedVersion, validationError } from "./errors.js";
import type { PlatformProfile } from "./types.js";

export const JournalSchema = z
  .object({
    schemaVersion: z.literal(3),
    planId: IdentifierSchema,
    planDigest: Sha256DigestSchema,
    revision: z.number().int().nonnegative(),
    steps: z.record(
      IdentifierSchema,
      z
        .object({
          status: z.enum(["started", "finished"]),
          startedAt: IsoDateTimeSchema,
          idempotencyKey: IdentifierSchema,
          /** State observed immediately before the side effect; used to judge safe retry after interruption. */
          expectedStateDigest: Sha256DigestSchema.nullable().optional()
        })
        .strict()
    )
  })
  .strict();
export type SetupJournal = z.infer<typeof JournalSchema>;

export const ApprovalReceiptSchema = z
  .object({
    schemaVersion: z.literal(3),
    receiptId: IdentifierSchema,
    planId: IdentifierSchema,
    planDigest: Sha256DigestSchema,
    machineId: IdentifierSchema,
    stepIds: z.array(IdentifierSchema),
    approvedBy: z.enum(["operator", "assume_yes"]),
    approvedAt: IsoDateTimeSchema
  })
  .strict();
export type ApprovalReceipt = z.infer<typeof ApprovalReceiptSchema>;

export const ChangeLogEntrySchema = z
  .object({
    at: IsoDateTimeSchema,
    planId: IdentifierSchema,
    stepId: IdentifierSchema,
    kind: z.string().min(1),
    target: z.string().min(1),
    machineWide: z.boolean()
  })
  .strict();
export type ChangeLogEntry = z.infer<typeof ChangeLogEntrySchema>;

export interface Lock {
  release(): Promise<void>;
}

export interface SetupStateStoreOptions {
  uid: number | null;
  now: () => Date;
  readOnly?: boolean;
  hostname?: string;
  pid?: number;
}

type Result<T> = OperationResult<T>;
const okr = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: ContractError): Result<T> => ({ ok: false, error });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** Returns an error when `raw` carries a schemaVersion other than 3 (or none). */
function versionError(raw: unknown, what: string): ContractError | null {
  const v = raw !== null && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof v === "number" && v !== 3) return unsupportedVersion(`${what} has unsupported schemaVersion ${v}`, v);
  return null;
}

export class SetupStateStore {
  private readonly uid: number | null;
  private readonly now: () => Date;
  readonly readOnly: boolean;
  private readonly hostname: string;
  private readonly pid: number;

  constructor(
    private readonly paths: PlatformProfile["paths"],
    options: SetupStateStoreOptions
  ) {
    this.uid = options.uid;
    this.now = options.now;
    this.readOnly = options.readOnly ?? false;
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
  }

  private denied<T>(): Result<T> | null {
    return this.readOnly ? fail(validationError("read-only mode: state store writes are disabled")) : null;
  }
  private get setupDir(): string {
    return path.join(this.paths.state, "setup");
  }

  async ensurePrivateDir(dir: string): Promise<Result<void>> {
    const d = this.denied<void>();
    if (d) return d;
    return this.ensureDirInternal(dir);
  }

  /** Validates every bflow-owned level from the owned root down to `dir`. */
  private async ensureDirInternal(dir: string): Promise<Result<void>> {
    const resolved = path.resolve(dir);
    for (const root of [this.paths.state, this.paths.config, this.paths.data]) {
      const r = path.resolve(root);
      const rel = path.relative(r, resolved);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        let cur = r;
        const first = await this.ensureOneDir(cur);
        if (!first.ok) return first;
        for (const part of rel === "" ? [] : rel.split(path.sep)) {
          cur = path.join(cur, part);
          const res = await this.ensureOneDir(cur);
          if (!res.ok) return res;
        }
        return okr(undefined);
      }
    }
    return this.ensureOneDir(resolved);
  }

  private isOwnedPath(p: string): boolean {
    return [this.paths.state, this.paths.config, this.paths.data].some((root) => {
      const rel = path.relative(path.resolve(root), path.resolve(p));
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  }

  private async ensureOneDir(dir: string): Promise<Result<void>> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await lstat(dir);
      if (st.isSymbolicLink()) return fail(validationError(`refusing symlinked bflow directory: ${dir}`));
      if (!st.isDirectory()) return fail(validationError(`not a directory: ${dir}`));
      if (this.uid !== null && st.uid !== this.uid)
        return fail(validationError(`bflow directory is owned by another uid: ${dir}`));
      if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
      return okr(undefined);
    } catch (e) {
      return fail(validationError(`cannot prepare directory ${dir}: ${errMsg(e)}`));
    }
  }

  async writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<Result<void>> {
    const d = this.denied<void>();
    if (d) return d;
    const parent = path.dirname(file);
    if (this.isOwnedPath(parent)) {
      const dirRes = await this.ensureDirInternal(parent);
      if (!dirRes.ok) return dirRes;
    } else {
      try {
        const st = await stat(parent);
        if (!st.isDirectory()) return fail(validationError(`not a directory: ${parent}`));
      } catch (e) {
        return fail(validationError(`cannot write into ${parent}: ${errMsg(e)}`));
      }
    }
    return this.writeAtomicInternal(file, data, mode);
  }

  private async writeAtomicInternal(file: string, data: string | Uint8Array, mode = 0o600): Promise<Result<void>> {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
      try {
        await fh.writeFile(data);
        await fh.chmod(mode);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
      return okr(undefined);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      return fail(validationError(`atomic write failed for ${file}: ${errMsg(e)}`));
    }
  }

  private async appendLine(file: string, line: string): Promise<Result<void>> {
    const dirRes = await this.ensureDirInternal(path.dirname(file));
    if (!dirRes.ok) return dirRes;
    try {
      const fh = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
      try {
        await fh.writeFile(`${line}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return okr(undefined);
    } catch (e) {
      return fail(validationError(`append failed for ${file}: ${errMsg(e)}`));
    }
  }

  async backupFile(file: string): Promise<Result<string | null>> {
    const d = this.denied<string | null>();
    if (d) return d;
    let content: Buffer;
    try {
      if (!(await stat(file)).isFile()) return fail(validationError(`cannot back up non-file: ${file}`));
      content = await readFile(file);
    } catch (e) {
      if (code(e) === "ENOENT") return okr(null);
      return fail(validationError(`cannot read ${file} for backup: ${errMsg(e)}`));
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    const createdAt = this.now().toISOString();
    const base = `${createdAt.replace(/[:.]/g, "-")}-${sha256.slice(0, 8)}`;
    const backups = path.join(this.paths.state, "backups");
    const dirRes = await this.ensureDirInternal(backups);
    if (!dirRes.ok) return dirRes;
    try {
      for (let n = 0; n < 1000; n++) {
        const slot = path.join(backups, n === 0 ? base : `${base}-${n}`);
        try {
          await mkdir(slot, { mode: 0o700 });
        } catch (e) {
          if (code(e) === "EEXIST") continue;
          throw e;
        }
        const target = path.join(slot, path.basename(file));
        await copyFile(file, target, fsConstants.COPYFILE_EXCL);
        await chmod(target, 0o600);
        const idx = await this.appendLine(
          path.join(backups, "index.jsonl"),
          JSON.stringify({ original: file, backup: target, sha256, createdAt })
        );
        if (!idx.ok) return idx;
        return okr(target);
      }
      return fail(validationError("could not allocate a unique backup directory"));
    } catch (e) {
      return fail(validationError(`backup failed for ${file}: ${errMsg(e)}`));
    }
  }

  async acquireLock(): Promise<Result<Lock>> {
    const d = this.denied<Lock>();
    if (d) return d;
    const dirRes = await this.ensureDirInternal(this.paths.state);
    if (!dirRes.ok) return dirRes;
    const lockPath = path.join(this.paths.state, "setup.lock");
    const content = JSON.stringify({ pid: this.pid, hostname: this.hostname, startedAt: this.now().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        try {
          await fh.writeFile(content);
          await fh.sync();
        } finally {
          await fh.close();
        }
        return okr({
          release: async () => {
            try {
              if ((await readFile(lockPath, "utf8")) === content) await rm(lockPath, { force: true });
            } catch {
              // lock already gone
            }
          }
        });
      } catch (e) {
        if (code(e) !== "EEXIST") return fail(validationError(`cannot create lock: ${errMsg(e)}`));
      }
      let existing: string;
      try {
        existing = await readFile(lockPath, "utf8");
      } catch (e) {
        if (code(e) === "ENOENT") continue;
        return fail(validationError(`cannot read lock: ${errMsg(e)}`));
      }
      if (attempt === 0 && this.isStale(existing)) {
        try {
          if ((await readFile(lockPath, "utf8")) === existing) await rm(lockPath, { force: true });
        } catch {
          // raced; retry
        }
        continue;
      }
      return fail(conflictError(`another setup operation holds ${lockPath}`));
    }
    return fail(conflictError(`another setup operation holds ${lockPath}`));
  }

  private isStale(raw: string): boolean {
    let info: { pid?: unknown; hostname?: unknown };
    try {
      info = JSON.parse(raw) as typeof info;
    } catch {
      return false;
    }
    if (typeof info.pid !== "number" || !Number.isInteger(info.pid) || info.pid <= 0) return false;
    if (info.hostname !== this.hostname) return false;
    try {
      process.kill(info.pid, 0);
      return false;
    } catch (e) {
      return code(e) === "ESRCH";
    }
  }

  async readJournal(): Promise<Result<SetupJournal | null>> {
    return this.readJsonDoc(path.join(this.setupDir, "journal.json"), JournalSchema, "journal");
  }

  async writeJournal(journal: SetupJournal): Promise<Result<void>> {
    const d = this.denied<void>();
    if (d) return d;
    const parsed = JournalSchema.safeParse(journal);
    if (!parsed.success) return fail(validationError(`invalid journal: ${parsed.error.message}`));
    const dirRes = await this.ensureDirInternal(this.setupDir);
    if (!dirRes.ok) return dirRes;
    return this.writeAtomicInternal(path.join(this.setupDir, "journal.json"), JSON.stringify(parsed.data));
  }

  private async readJsonDoc<S extends z.ZodTypeAny>(
    file: string,
    schema: S,
    what: string
  ): Promise<Result<z.infer<S> | null>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if (code(e) === "ENOENT") return okr(null);
      return fail(validationError(`cannot read ${what}: ${errMsg(e)}`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(corruption(`${what} is not valid JSON: ${file}`));
    }
    const ve = versionError(raw, what);
    if (ve) return fail(ve);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return fail(validationError(`invalid ${what}: ${parsed.error.message}`));
    return okr(parsed.data as z.infer<S>);
  }

  async appendReceipt(receipt: SetupReceipt): Promise<Result<void>> {
    const d = this.denied<void>();
    if (d) return d;
    const parsed = SetupReceiptSchema.safeParse(receipt);
    if (!parsed.success) return fail(validationError(`invalid receipt: ${parsed.error.message}`));
    return this.appendLine(path.join(this.setupDir, "receipts.jsonl"), JSON.stringify(parsed.data));
  }

  async readReceipts(): Promise<Result<SetupReceipt[]>> {
    const lines = await this.readLines(path.join(this.setupDir, "receipts.jsonl"));
    if (!lines.ok) return lines;
    const out: SetupReceipt[] = [];
    for (const [i, line] of lines.value.entries()) {
      const n = i + 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return fail(corruption(`receipts.jsonl line ${n} is not valid JSON`));
      }
      const ve = versionError(raw, `receipts.jsonl line ${n}`);
      if (ve) return fail(ve);
      const parsed = SetupReceiptSchema.safeParse(raw);
      if (!parsed.success) return fail(corruption(`receipts.jsonl line ${n} is not a valid receipt`));
      out.push(parsed.data);
    }
    return okr(out);
  }

  async latestReceipt(idempotencyKey: string): Promise<Result<SetupReceipt | null>> {
    const all = await this.readReceipts();
    if (!all.ok) return all;
    for (let i = all.value.length - 1; i >= 0; i--) {
      if (all.value[i]!.idempotencyKey === idempotencyKey) return okr(all.value[i]!);
    }
    return okr(null);
  }

  private async readLines(file: string): Promise<Result<string[]>> {
    try {
      const text = await readFile(file, "utf8");
      return okr(text.split("\n").filter((l) => l.trim() !== ""));
    } catch (e) {
      if (code(e) === "ENOENT") return okr([]);
      return fail(validationError(`cannot read ${file}: ${errMsg(e)}`));
    }
  }

  private approvalPath(receiptId: string): Result<string> {
    if (!SAFE_ID.test(receiptId) || receiptId.includes("..") || receiptId.length > 200)
      return fail(validationError(`unsafe approval receipt id: ${receiptId}`));
    return okr(path.join(this.setupDir, "approvals", `${receiptId}.json`));
  }

  async writeApproval(approval: ApprovalReceipt): Promise<Result<void>> {
    const d = this.denied<void>();
    if (d) return d;
    const parsed = ApprovalReceiptSchema.safeParse(approval);
    if (!parsed.success) return fail(validationError(`invalid approval receipt: ${parsed.error.message}`));
    const p = this.approvalPath(parsed.data.receiptId);
    if (!p.ok) return p;
    const dirRes = await this.ensureDirInternal(path.dirname(p.value));
    if (!dirRes.ok) return dirRes;
    return this.writeAtomicInternal(p.value, JSON.stringify(parsed.data));
  }

  async readApproval(receiptId: string): Promise<Result<ApprovalReceipt | null>> {
    const p = this.approvalPath(receiptId);
    if (!p.ok) return p;
    return this.readJsonDoc(p.value, ApprovalReceiptSchema, "approval receipt");
  }

  async appendChange(entry: ChangeLogEntry): Promise<Result<void>> {
    const d = this.denied<void>();
    if (d) return d;
    const parsed = ChangeLogEntrySchema.safeParse(entry);
    if (!parsed.success) return fail(validationError(`invalid change log entry: ${parsed.error.message}`));
    return this.appendLine(path.join(this.setupDir, "changes.jsonl"), JSON.stringify(parsed.data));
  }

  async readChanges(): Promise<Result<ChangeLogEntry[]>> {
    const lines = await this.readLines(path.join(this.setupDir, "changes.jsonl"));
    if (!lines.ok) return lines;
    const out: ChangeLogEntry[] = [];
    for (const [i, line] of lines.value.entries()) {
      try {
        const parsed = ChangeLogEntrySchema.safeParse(JSON.parse(line));
        if (!parsed.success) return fail(corruption(`changes.jsonl line ${i + 1} is not a valid entry`));
        out.push(parsed.data);
      } catch {
        return fail(corruption(`changes.jsonl line ${i + 1} is not valid JSON`));
      }
    }
    return okr(out);
  }
}
