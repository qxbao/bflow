import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseDocument } from "yaml";

export interface Context7MigrationOutput {
  readonly configPath: string;
  readonly migrated: boolean;
  /** The untouched copy of the previous configuration; present only when this call migrated. */
  readonly backupPath?: string;
}

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Rewrites a repository configuration that still carries `environment.context7` so it carries `environment.deepwiki`.
 * `enabled` and `required` are preserved; cache settings and any key-related field are dropped, never copied and never
 * logged. An explicit `deepwiki` block already present wins. The previous file is first saved next to it as
 * `config.yml.context7-<timestamp>.bak` (owner-only). A configuration without a context7 block is left untouched, so
 * repeating the migration changes nothing and writes no further backup.
 */
export async function migrateLegacyContext7Config(repositoryRoot: string, options: { readonly now?: () => Date } = {}): Promise<Context7MigrationOutput> {
  const configPath = join(repositoryRoot, ".bflow", "config.yml");
  let source: string;
  try {
    const info = await lstat(configPath);
    if (!info.isFile()) return { configPath, migrated: false };
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configPath, migrated: false };
    throw error;
  }
  const document = parseDocument(source);
  if (document.errors.length > 0 || !document.hasIn(["environment", "context7"])) return { configPath, migrated: false };

  const legacyNode = document.getIn(["environment", "context7"]) as { toJSON?: () => unknown } | null | undefined;
  const legacy = legacyNode && typeof legacyNode.toJSON === "function" ? legacyNode.toJSON() : legacyNode;
  const fields = typeof legacy === "object" && legacy !== null && !Array.isArray(legacy) ? legacy as Record<string, unknown> : {};
  const carried: Record<string, boolean> = {};
  for (const key of ["enabled", "required"]) if (typeof fields[key] === "boolean") carried[key] = fields[key] as boolean;

  const backupPath = `${configPath}.context7-${stamp((options.now ?? (() => new Date()))())}.bak`;
  const backup = await open(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error(`Cannot migrate: backup ${backupPath} already exists. Nothing was changed.`);
    throw error;
  });
  try { await backup.writeFile(source, "utf8"); await backup.sync(); } finally { await backup.close(); }

  if (!document.hasIn(["environment", "deepwiki"])) document.setIn(["environment", "deepwiki"], document.createNode(carried));
  document.deleteIn(["environment", "context7"]);

  const temporary = join(repositoryRoot, ".bflow", `.config.yml.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(document.toString(), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, configPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error(`Cannot write ${configPath}: ${error instanceof Error ? error.message : String(error)}. The previous configuration is preserved at ${backupPath}.`);
  }
  return { configPath, migrated: true, backupPath };
}
