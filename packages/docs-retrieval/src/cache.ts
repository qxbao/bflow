import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CachePolicy {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  /**
   * With an API key the server may answer from libraries only the key's owner can read. Such answers are not cached unless
   * the operator opts in, because the cache is shared by every session on the machine.
   */
  readonly allowAuthenticated: boolean;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export const DEFAULT_CACHE_POLICY: CachePolicy = { enabled: false, ttlSeconds: 3600, allowAuthenticated: false, maxEntries: 500, maxBytes: 16 * 1024 * 1024 };

export interface CacheKeyParts {
  readonly libraryId: string;
  readonly version: string | null;
  readonly query: string;
  readonly language: string | null;
}

export interface CacheEntry {
  readonly libraryId: string;
  readonly version: string | null;
  readonly language: string | null;
  readonly content: string;
  readonly storedAt: string;
  readonly expiresAt: string;
}

export interface CacheStats { hits: number; misses: number; writes: number; evictions: number; expired: number; skippedByPolicy: number }

export interface DocsCache {
  get(key: CacheKeyParts): Promise<CacheEntry | null>;
  set(key: CacheKeyParts, content: string, ttlSeconds: number): Promise<void>;
  /** Removes entries for one library, or everything. Returns how many were removed. */
  invalidate(filter?: { libraryId?: string }): Promise<number>;
  stats(): CacheStats;
}

/** The query text is hashed into the key and never stored, so the cache holds public documentation and nothing the user typed. */
export function cacheKey(parts: CacheKeyParts): string {
  return createHash("sha256").update(JSON.stringify([parts.libraryId, parts.version, parts.query.trim(), parts.language])).digest("hex");
}

/** Whether a response may be cached for the current credential mode. Counts a skip in the stats of the caller. */
export function cachePermitted(policy: CachePolicy, authenticated: boolean): boolean {
  return policy.enabled && policy.ttlSeconds > 0 && (!authenticated || policy.allowAuthenticated);
}

export function emptyStats(): CacheStats {
  return { hits: 0, misses: 0, writes: 0, evictions: 0, expired: 0, skippedByPolicy: 0 };
}

export class MemoryDocsCache implements DocsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly counters = emptyStats();
  constructor(private readonly options: { now?: () => number; maxEntries?: number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }

  async get(parts: CacheKeyParts): Promise<CacheEntry | null> {
    const key = cacheKey(parts);
    const entry = this.entries.get(key);
    if (!entry) { this.counters.misses++; return null; }
    if (Date.parse(entry.expiresAt) <= this.now()) { this.entries.delete(key); this.counters.expired++; this.counters.misses++; return null; }
    this.counters.hits++;
    return entry;
  }
  async set(parts: CacheKeyParts, content: string, ttlSeconds: number): Promise<void> {
    const key = cacheKey(parts);
    const max = this.options.maxEntries ?? 500;
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.counters.evictions++;
    }
    const now = this.now();
    this.entries.set(key, { libraryId: parts.libraryId, version: parts.version, language: parts.language, content,
      storedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSeconds * 1000).toISOString() });
    this.counters.writes++;
  }
  async invalidate(filter?: { libraryId?: string }): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.entries) if (!filter?.libraryId || entry.libraryId === filter.libraryId) { this.entries.delete(key); removed++; }
    return removed;
  }
  stats(): CacheStats { return { ...this.counters }; }
}

/** Private on-disk cache: directory 0700, one 0600 JSON file per key. A damaged or foreign file is a miss, never an error. */
export class FileDocsCache implements DocsCache {
  private readonly counters = emptyStats();
  constructor(private readonly options: { directory: string; now?: () => number; maxEntries?: number; maxBytes?: number }) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private path(key: string) { return join(this.options.directory, `${key}.json`); }

  private async ensure(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await chmod(this.options.directory, 0o700).catch(() => undefined);
  }

  async get(parts: CacheKeyParts): Promise<CacheEntry | null> {
    const file = this.path(cacheKey(parts));
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
      const entry = JSON.parse(await readFile(file, "utf8")) as Partial<CacheEntry> & { schemaVersion?: number };
      if (entry.schemaVersion !== 1 || typeof entry.content !== "string" || typeof entry.expiresAt !== "string" || typeof entry.libraryId !== "string") throw new Error("invalid entry");
      if (Date.parse(entry.expiresAt) <= this.now()) { await rm(file, { force: true }); this.counters.expired++; this.counters.misses++; return null; }
      this.counters.hits++;
      return { libraryId: entry.libraryId, version: entry.version ?? null, language: entry.language ?? null, content: entry.content,
        storedAt: String(entry.storedAt ?? ""), expiresAt: entry.expiresAt };
    } catch {
      this.counters.misses++;
      return null;
    }
  }

  async set(parts: CacheKeyParts, content: string, ttlSeconds: number): Promise<void> {
    await this.ensure();
    const now = this.now();
    const body = JSON.stringify({ schemaVersion: 1, libraryId: parts.libraryId, version: parts.version, language: parts.language, content,
      storedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSeconds * 1000).toISOString() });
    const target = this.path(cacheKey(parts));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.counters.writes++;
    await this.prune();
  }

  private async prune(): Promise<void> {
    const maxEntries = this.options.maxEntries ?? 500;
    const maxBytes = this.options.maxBytes ?? 16 * 1024 * 1024;
    const files: Array<{ file: string; mtime: number; size: number }> = [];
    for (const name of await readdir(this.options.directory).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const info = await lstat(join(this.options.directory, name)).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) files.push({ file: join(this.options.directory, name), mtime: info.mtimeMs, size: info.size });
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((sum, item) => sum + item.size, 0);
    while (files.length > 0 && (files.length > maxEntries || total > maxBytes)) {
      const oldest = files.shift()!;
      await rm(oldest.file, { force: true });
      total -= oldest.size;
      this.counters.evictions++;
    }
  }

  async invalidate(filter?: { libraryId?: string }): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.options.directory).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.options.directory, name);
      if (filter?.libraryId) {
        try { if ((JSON.parse(await readFile(file, "utf8")) as { libraryId?: string }).libraryId !== filter.libraryId) continue; } catch { /* remove unreadable entries too */ }
      }
      await rm(file, { force: true });
      removed++;
    }
    return removed;
  }

  stats(): CacheStats { return { ...this.counters }; }
}
