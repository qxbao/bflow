import { open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentConfigurationSchema, AgentLeaseSchema } from "@bflow/contracts";
import type { AgentConfiguration, AgentLease, OperationOptions } from "@bflow/contracts";

export interface StoredLease { lease: AgentLease; active: boolean }
export interface StoredReceipt { fingerprint: string; kind: "lease" | "void"; lease?: AgentLease }
export interface RegistryState {
  schemaVersion: 1;
  configurations: Record<string, AgentConfiguration>;
  leases: Record<string, StoredLease>;
  nextFencing: Record<string, number>;
  receipts: Record<string, StoredReceipt>;
  lastNow: string;
}

const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const initialState = (): RegistryState => ({ schemaVersion: 1, configurations: dictionary(), leases: dictionary(), nextFencing: dictionary(), receipts: dictionary(), lastNow: "1970-01-01T00:00:00.000Z" });

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid registry state object");
  return value as Record<string, unknown>;
}

function decodeState(raw: string): RegistryState {
  const value = object(JSON.parse(raw));
  if (value.schemaVersion !== 1) throw new Error("Unsupported registry state version");
  const configurations = dictionary<AgentConfiguration>();
  for (const [id, config] of Object.entries(object(value.configurations))) {
    const parsed = AgentConfigurationSchema.parse(config);
    if (parsed.agentId !== id) throw new Error("Registry configuration key mismatch");
    configurations[id] = parsed;
  }
  const leases = dictionary<StoredLease>();
  for (const [id, entry] of Object.entries(object(value.leases))) {
    const item = object(entry);
    const lease = AgentLeaseSchema.parse(item.lease);
    if (lease.leaseId !== id || typeof item.active !== "boolean") throw new Error("Invalid registry lease entry");
    leases[id] = { lease, active: item.active };
  }
  const nextFencing = dictionary<number>();
  for (const [id, token] of Object.entries(object(value.nextFencing))) {
    if (!Number.isSafeInteger(token) || (token as number) < 0) throw new Error(`Invalid fencing token for ${id}`);
    nextFencing[id] = token as number;
  }
  for (const entry of Object.values(leases)) {
    if ((nextFencing[entry.lease.agentId] ?? 0) < entry.lease.fencingToken) throw new Error("Fencing watermark is lower than an issued token");
  }
  const receipts = dictionary<StoredReceipt>();
  for (const [key, item] of Object.entries(object(value.receipts))) {
    const receipt = object(item);
    if (typeof receipt.fingerprint !== "string" || (receipt.kind !== "lease" && receipt.kind !== "void")) throw new Error("Invalid registry receipt");
    if (receipt.kind === "lease") {
      receipts[key] = { fingerprint: receipt.fingerprint, kind: "lease", lease: AgentLeaseSchema.parse(receipt.lease) };
    } else receipts[key] = { fingerprint: receipt.fingerprint, kind: "void" };
  }
  if (typeof value.lastNow !== "string" || !Number.isFinite(Date.parse(value.lastNow))) throw new Error("Invalid registry clock watermark");
  return { schemaVersion: 1, configurations, leases, nextFencing, receipts, lastNow: value.lastNow };
}

export class RegistryLockTimeout extends Error {}
export class RegistryOptionsError extends Error {}

/** Single-host durable store. All reads and mutations use the same process-shared lock. */
export class FileRegistryStore {
  constructor(readonly stateFile: string, readonly operationClock: () => number = Date.now) {
    if (!stateFile) throw new Error("An explicit registry stateFile is required");
  }

  async transaction<T>(action: (state: RegistryState) => T, options?: OperationOptions): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 5_000;
    const absolute = options?.deadline === undefined ? Infinity : Date.parse(options.deadline);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || (options?.deadline !== undefined && !Number.isFinite(absolute))) {
      throw new RegistryOptionsError("Invalid registry timeout or deadline");
    }
    const deadline = Math.min(this.operationClock() + timeoutMs, absolute);
    const checkBudget = () => {
      if (options?.signal?.aborted) throw new DOMException("Registry operation aborted", "AbortError");
      if (this.operationClock() >= deadline) throw new RegistryLockTimeout("Registry operation deadline elapsed before commit; inspect stale lock before retrying");
    };
    checkBudget();
    await mkdir(dirname(this.stateFile), { recursive: true });
    const lockFile = `${this.stateFile}.lock`;
    let lock: Awaited<ReturnType<typeof open>>;
    for (;;) {
      checkBudget();
      try { lock = await open(lockFile, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        checkBudget();
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(15, Math.max(0, deadline - this.operationClock()))));
      }
    }
    try {
      checkBudget();
      let state: RegistryState;
      try { state = decodeState(await readFile(this.stateFile, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = initialState();
      }
      const before = JSON.stringify(state);
      checkBudget();
      const result = action(state);
      if (JSON.stringify(state) !== before) {
        const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
        let committed = false;
        try {
          checkBudget();
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
          finally { await file.close(); }
          checkBudget();
          await rename(temporary, this.stateFile);
          committed = true;
        } finally {
          if (!committed) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        const directory = await open(dirname(this.stateFile), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return result;
    } finally {
      await lock.close();
      await unlink(lockFile);
    }
  }
}
