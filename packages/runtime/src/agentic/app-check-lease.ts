import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Host-local exclusive lease for the real-app browser resource. The state lives in one file under a directory, so separate
 * `AppCheckBrowserLeases` instances on the same directory see each other. It is same-UID and host-local only: it is not a
 * distributed or network-filesystem lock. Mutations take an exclusive lock file; writes are temp-file + rename.
 */

const STATE_FILE = "app-check-leases.json";
const LOCK_FILE = "app-check-leases.lock";
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

const LeaseSchema = z.object({
  leaseId: z.string().min(1),
  resourceKey: z.string().min(1),
  holder: z.string().min(1),
  fencingToken: z.number().int().positive(),
  acquiredAt: z.string().min(1),
  expiresAt: z.string().min(1)
}).strict();
const StateSchema = z.object({
  schemaVersion: z.literal(1),
  resources: z.record(z.object({ fencingToken: z.number().int().min(0), current: LeaseSchema.optional() }).strict())
}).strict();

export interface AppCheckLease {
  readonly leaseId: string;
  readonly resourceKey: string;
  readonly holder: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

type LeaseState = z.infer<typeof StateSchema>;

export type AppCheckAcquireResult =
  | { readonly ok: true; readonly lease: AppCheckLease }
  | { readonly ok: false; readonly code: "busy"; readonly holder: string; readonly expiresAt: string };

export type AppCheckLeaseCheck =
  | { readonly ok: true; readonly lease: AppCheckLease }
  | { readonly ok: false; readonly code: "lease_lost" | "lease_expired" };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AppCheckLeaseLockTimeout extends Error {
  constructor() { super("app-check lease lock is held by another writer"); this.name = "AppCheckLeaseLockTimeout"; }
}

export class AppCheckBrowserLeases {
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {}

  async acquire(resourceKey: string, holder: string, ttlMs: number): Promise<AppCheckAcquireResult> {
    return this.mutate<AppCheckAcquireResult>(async state => {
      const entry = state.resources[resourceKey] ?? { fencingToken: 0 };
      const at = this.now();
      if (entry.current && at.getTime() < Date.parse(entry.current.expiresAt))
        return { result: { ok: false, code: "busy", holder: entry.current.holder, expiresAt: entry.current.expiresAt }, write: false };
      // The token is monotonic per resource: a takeover after expiry always gets a larger token than the stale holder.
      const lease: AppCheckLease = { leaseId: randomUUID(), resourceKey, holder, fencingToken: entry.fencingToken + 1,
        acquiredAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString() };
      state.resources[resourceKey] = { fencingToken: lease.fencingToken, current: lease };
      return { result: { ok: true, lease }, write: true };
    });
  }

  async renew(lease: AppCheckLease, ttlMs: number): Promise<AppCheckLeaseCheck> {
    return this.mutate<AppCheckLeaseCheck>(async state => {
      const checked = this.check(state, lease);
      if (!checked.ok) return { result: checked, write: false };
      const renewed: AppCheckLease = { ...checked.lease, expiresAt: new Date(this.now().getTime() + ttlMs).toISOString() };
      state.resources[lease.resourceKey] = { fencingToken: renewed.fencingToken, current: renewed };
      return { result: { ok: true, lease: renewed }, write: true };
    });
  }

  /** Read-only check. Writers replace the state file atomically, so no lock is needed to observe it. */
  async assertCurrent(lease: AppCheckLease): Promise<AppCheckLeaseCheck> {
    return this.check(await this.read(), lease);
  }

  /** Removes the lease only when it is still the current one. Missing or foreign leases are a no-op. */
  async release(lease: AppCheckLease): Promise<void> {
    await this.mutate(async state => {
      if (state.resources[lease.resourceKey]?.current?.leaseId !== lease.leaseId) return { result: undefined, write: false };
      state.resources[lease.resourceKey] = { fencingToken: lease.fencingToken };
      return { result: undefined, write: true };
    });
  }

  private check(state: LeaseState, lease: AppCheckLease): AppCheckLeaseCheck {
    const current = state.resources[lease.resourceKey]?.current;
    if (!current || current.leaseId !== lease.leaseId || current.fencingToken !== lease.fencingToken) return { ok: false, code: "lease_lost" };
    if (this.now().getTime() >= Date.parse(current.expiresAt)) return { ok: false, code: "lease_expired" };
    return { ok: true, lease: current };
  }

  private async mutate<T>(change: (state: LeaseState) => Promise<{ result: T; write: boolean }>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, LOCK_FILE);
    await acquireLock(lock);
    try {
      const state = await this.read();
      const outcome = await change(state);
      if (outcome.write) await this.write(state);
      return outcome.result;
    } finally {
      await rm(lock, { force: true });
    }
  }

  private async read(): Promise<LeaseState> {
    let text: string;
    try { text = await readFile(join(this.directory, STATE_FILE), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, resources: {} };
      throw error;
    }
    // A corrupted state file fails closed: no lease is granted or confirmed from unreadable state.
    return StateSchema.parse(JSON.parse(text));
  }

  private async write(state: LeaseState): Promise<void> {
    const file = join(this.directory, STATE_FILE);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, file);
  }
}

async function acquireLock(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) { await rm(lock, { force: true }); continue; }
      if (Date.now() >= deadline) throw new AppCheckLeaseLockTimeout();
      await sleep(LOCK_RETRY_MS);
    }
  }
}
