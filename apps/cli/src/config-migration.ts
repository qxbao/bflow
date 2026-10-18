import { constants } from "node:fs";
import { copyFile, link, lstat, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { EnvironmentConfigSchema } from "./environment-config.js";
import { loadRepositoryConfig } from "./config.js";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "./config-format.js";
import { identifyRepository } from "./repository.js";

export interface ConfigMigrationOutput {
  readonly sourcePath: string;
  readonly configPath: string;
  readonly backupPath?: string;
  readonly migrated: boolean;
}

async function pathEntryExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function validateConfig(value: unknown, path: string, repository: Awaited<ReturnType<typeof identifyRepository>>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid legacy configuration at ${path}: expected a YAML/JSON object.`);
  const object = value as Record<string, unknown>;
  if ("environment" in object) {
    const parsed = EnvironmentConfigSchema.safeParse(object);
    if (!parsed.success) throw new Error(`Invalid legacy configuration at ${path}: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
    const config = parsed.data;
    const env = config.environment;
    if (env.repositoryId !== repository.id || env.workspaceRoot !== repository.root || env.sessionName !== repository.sessionName)
      throw new Error(`Invalid legacy configuration at ${path}: repository identity does not match this Git checkout.`);
    if (new Set(env.roles.map(role => role.role)).size !== env.roles.length ||
      !["conversation", "coordinator"].every(role => env.roles.some(item => item.role === role && (item.required ?? true))))
      throw new Error(`Invalid legacy configuration at ${path}: unique roles and required conversation/coordinator roles are mandatory.`);
    return parsed.data;
  }
  const required = ["schemaVersion", "projectName", "runtimeId", "createdAt", "storage", "defaultWorkflow"];
  if (required.some(key => !(key in object))) throw new Error(`Invalid legacy configuration at ${path}: required fields are missing.`);
  return object;
}

export async function migrateRepositoryConfig(cwd: string): Promise<ConfigMigrationOutput> {
  const repository = await identifyRepository(cwd);
  const root = repository.root;
  const target = resolve(root, ".bflow/config.yml");
  const legacy = [resolve(root, ".bflow/config.yaml"), resolve(root, ".bflow/config.json")];
  const backupPaths = legacy.map(path => `${path}.bak`);
  const [targetExists, legacyExists] = await Promise.all([
    pathEntryExists(target),
    Promise.all(legacy.map(pathEntryExists))
  ]);

  if (targetExists) {
    if (legacyExists.some(Boolean)) throw new Error("Cannot migrate: .bflow/config.yml and a legacy config both exist. Resolve the conflict manually; no files were changed.");
    const backupIndex = await Promise.all(backupPaths.map(pathEntryExists)).then(items => items.findIndex(Boolean));
    const backup = backupIndex < 0 ? undefined : backupPaths[backupIndex];
    return { sourcePath: backup ? legacy[backupIndex]! : target, configPath: target, ...(backup ? { backupPath: backup } : {}), migrated: false };
  }

  const existingLegacy = legacy.filter((_, index) => legacyExists[index]);
  if (existingLegacy.length > 1) throw new Error("Cannot migrate: both .bflow/config.yaml and .bflow/config.json exist. Choose the intended config and remove the ambiguity first.");
  let source = existingLegacy[0];
  if (!source) {
    const backups = await Promise.all(backupPaths.map(pathEntryExists));
    const backupIndex = backups.findIndex(Boolean);
    if (backupIndex >= 0) throw new Error("Cannot migrate: a prior backup exists but .bflow/config.yml is missing. Restore or inspect the backup before retrying.");
    throw new Error("No legacy configuration found at .bflow/config.yaml or .bflow/config.json.");
  }

  const initialStat = await lstat(source);
  if (!initialStat.isFile()) throw new Error(`Cannot migrate ${source}: expected a regular file; no files were changed.`);
  const sourceContent = await readFile(source, "utf8");
  let raw: unknown;
  try { raw = parseConfigYaml(sourceContent); }
  catch (error) { throw new Error(`Cannot migrate invalid legacy configuration: ${error instanceof Error ? error.message : String(error)}`); }
  const value = validateConfig(raw, source, repository);
  const loaded = await loadRepositoryConfig(source);
  if (!loaded.ok) throw new Error(`Cannot migrate invalid legacy configuration: ${loaded.error.message}`);
  const backupPath = `${source}.bak`;
  if (await pathEntryExists(backupPath)) {
    if (await readFile(backupPath, "utf8") !== sourceContent)
      throw new Error(`Cannot migrate: backup at ${backupPath} differs from the legacy config. No files were changed.`);
  } else {
    await copyFile(source, backupPath, constants.COPYFILE_EXCL);
    if (await readFile(backupPath, "utf8") !== sourceContent)
      throw new Error(`Cannot migrate: legacy config changed while its backup was being created. Backup retained at ${backupPath}.`);
    const backupHandle = await open(backupPath, "r");
    try { await backupHandle.sync(); } finally { await backupHandle.close(); }
  }
  if (await readFile(source, "utf8") !== sourceContent) {
    throw new Error(`Cannot complete migration: legacy config changed while being backed up. Original and backup were retained at ${source} and ${backupPath}; canonical output was not written.`);
  }
  const output = renderEnvironmentConfigYaml(value);
  const temporary = resolve(root, ".bflow", `.config.yml.${randomUUID()}.tmp`);
  let temporaryHandle;
  try {
    temporaryHandle = await open(temporary, "wx", 0o600);
    await temporaryHandle.writeFile(output, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error(`Cannot write ${target}: ${error instanceof Error ? error.message : String(error)}. Legacy config and backup were preserved.`);
  }
  const finalStat = await lstat(source).catch(error => {
    throw new Error(`Cannot remove legacy config after writing the new config: ${error instanceof Error ? error.message : String(error)}. Restore from ${backupPath} if needed.`);
  });
  if (finalStat.dev !== initialStat.dev || finalStat.ino !== initialStat.ino || await readFile(source, "utf8") !== sourceContent)
    throw new Error(`Migration wrote ${target}, but the legacy config changed during migration and was preserved at ${source}. Original backup: ${backupPath}.`);
  await unlink(source);
  return { sourcePath: source, configPath: target, backupPath, migrated: true };
}
