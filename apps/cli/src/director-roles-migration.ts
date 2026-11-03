import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { fsyncTolerant } from "./fs-resilience.js";

export interface DirectorRolesMigrationOutput {
  readonly configPath: string;
  readonly migrated: boolean;
  /** Roles actually removed from `environment.roles`; empty when the file was left untouched. */
  readonly removedRoles: readonly string[];
  /** The untouched copy of the previous configuration; present only when this call migrated. */
  readonly backupPath?: string;
}

const REMOVED = ["conversation", "coordinator"] as const;
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Removes the retired `conversation`/`coordinator` entries from `environment.roles` (Director replaces them).
 * The previous file is first copied next to it as `config.yml.director-<timestamp>.bak` (owner-only, exclusive create),
 * then the rewritten file replaces it by an atomic rename. A file without those entries is not touched, so repeating
 * the migration writes nothing and no further backup.
 */
export async function migrateDirectorRoles(repositoryRoot: string, options: { readonly now?: () => Date } = {}): Promise<DirectorRolesMigrationOutput> {
  const configPath = join(repositoryRoot, ".bflow", "config.yml");
  let source: string;
  try {
    const info = await lstat(configPath);
    if (!info.isFile()) return { configPath, migrated: false, removedRoles: [] };
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configPath, migrated: false, removedRoles: [] };
    throw error;
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) return { configPath, migrated: false, removedRoles: [] };
  const roles = document.getIn(["environment", "roles"], true);
  if (!isSeq(roles)) return { configPath, migrated: false, removedRoles: [] };
  const removed: string[] = [];
  const kept = roles.items.filter(item => {
    const role = isMap(item) ? item.get("role") : undefined;
    if (typeof role === "string" && (REMOVED as readonly string[]).includes(role)) { removed.push(role); return false; }
    return true;
  });
  if (removed.length === 0) return { configPath, migrated: false, removedRoles: [] };
  roles.items = kept;

  const backupPath = `${configPath}.director-${stamp((options.now ?? (() => new Date()))())}.bak`;
  const backup = await open(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error(`Cannot migrate: backup ${backupPath} already exists. Nothing was changed.`);
    throw error;
  });
  try { await backup.writeFile(source, "utf8"); await fsyncTolerant(backup); } finally { await backup.close(); }

  const temporary = join(repositoryRoot, ".bflow", `.config.yml.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(document.toString(), "utf8");
    await fsyncTolerant(handle);
    await handle.close();
    await rename(temporary, configPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error(`Cannot write ${configPath}: ${error instanceof Error ? error.message : String(error)}. The previous configuration is preserved at ${backupPath}.`);
  }
  return { configPath, migrated: true, removedRoles: [...new Set(removed)], backupPath };
}
