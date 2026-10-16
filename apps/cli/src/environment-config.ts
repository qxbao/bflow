import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { AgentRoleSchema, WorkflowDefinitionSchema, type AgentRole } from "@bflow/contracts";
import { createDefaultRepositoryConfig, loadRepositoryConfig } from "./config.js";
import { identifyRepository, type RepositoryIdentity } from "./repository.js";
import type { BflowRepositoryConfig, InitCommandOutput } from "./types.js";

export interface EnvironmentConfig extends BflowRepositoryConfig {
  readonly environment: {
    readonly repositoryId: string;
    readonly workspaceRoot: string;
    readonly sessionName: string;
    readonly herdrBinary: string;
    readonly roles: readonly { readonly role: AgentRole; readonly cli: string; readonly required: boolean }[];
    readonly sdd: { readonly minimumLevel: "lightweight" | "full"; readonly approvalRequired: boolean };
    readonly tdd: { readonly policy: "conditional" };
    readonly verification: { readonly maxIterations: number; readonly onExhausted: "require_human" };
    readonly concurrency: { readonly maxConcurrency: number };
    readonly startupTimeoutMs: number;
    readonly shutdownTimeoutMs: number;
  };
}
export const ENVIRONMENT_CONFIG_PATH = ".bflow/config.yaml";

export function defaultEnvironmentConfig(repository: RepositoryIdentity, name?: string, now = new Date()): EnvironmentConfig {
  return {
    ...createDefaultRepositoryConfig({ projectName: name ?? basename(repository.root), runtimeId: `runtime-${repository.id.slice(0, 20)}`, createdAt: now.toISOString() }),
    environment: {
      repositoryId: repository.id, workspaceRoot: repository.root, sessionName: repository.sessionName,
      herdrBinary: "herdr",
      roles: ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"].map((role) => ({ role: AgentRoleSchema.parse(role), cli: "codex", required: true })),
      sdd: { minimumLevel: "lightweight", approvalRequired: true }, tdd: { policy: "conditional" },
      verification: { maxIterations: 3, onExhausted: "require_human" }, concurrency: { maxConcurrency: 2 },
      startupTimeoutMs: 60_000, shutdownTimeoutMs: 30_000
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a configuration object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}
export async function readEnvironmentConfig(repository: RepositoryIdentity): Promise<EnvironmentConfig> {
  const path = resolve(repository.root, ENVIRONMENT_CONFIG_PATH);
  const base = await loadRepositoryConfig(path);
  if (!base.ok) throw new Error(base.error.message);
  // JSON is the supported YAML 1.2 flow-style subset; no tags, aliases or executable loaders.
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const env = record(record(raw)["environment"]);
  if (env["repositoryId"] !== repository.id || env["workspaceRoot"] !== repository.root || env["sessionName"] !== repository.sessionName)
    throw new Error("Configuration belongs to another repository or was moved. Reconcile its repository identity before use.");
  if (typeof env["herdrBinary"] !== "string" || !env["herdrBinary"].trim()) throw new Error("Invalid Herdr executable");
  const rawRoles = env["roles"];
  if (!Array.isArray(rawRoles) || !rawRoles.length) throw new Error("Missing role configuration");
  const roles = rawRoles.map((value: unknown) => {
    const role = record(value);
    if (typeof role["cli"] !== "string" || !role["cli"].trim() || typeof role["required"] !== "boolean") throw new Error("Invalid role executable/required flag");
    return { role: AgentRoleSchema.parse(role["role"]), cli: role["cli"], required: role["required"] };
  });
  if (new Set(roles.map((r) => r.role)).size !== roles.length || !["conversation", "coordinator"].every((r) => roles.some((role) => role.role === r && role.required)))
    throw new Error("Unique roles and required conversation/coordinator roles are mandatory");
  const sdd = record(env["sdd"]);
  const tdd = record(env["tdd"]);
  const verification = record(env["verification"]);
  const concurrency = record(env["concurrency"]);
  if ((sdd["minimumLevel"] !== "lightweight" && sdd["minimumLevel"] !== "full") || typeof sdd["approvalRequired"] !== "boolean" || tdd["policy"] !== "conditional" ||
      !integer(verification["maxIterations"], 100) || verification["onExhausted"] !== "require_human" || !integer(concurrency["maxConcurrency"], 64) ||
      !integer(env["startupTimeoutMs"], 600_000) || !integer(env["shutdownTimeoutMs"], 600_000)) throw new Error("Invalid SDLC policies, concurrency or timeouts");
  WorkflowDefinitionSchema.parse(base.value.defaultWorkflow);
  return { ...base.value, environment: {
    repositoryId: repository.id, workspaceRoot: repository.root, sessionName: repository.sessionName, herdrBinary: env["herdrBinary"], roles,
    sdd: { minimumLevel: sdd["minimumLevel"], approvalRequired: sdd["approvalRequired"] }, tdd: { policy: "conditional" },
    verification: { maxIterations: verification["maxIterations"], onExhausted: "require_human" },
    concurrency: { maxConcurrency: concurrency["maxConcurrency"] }, startupTimeoutMs: env["startupTimeoutMs"], shutdownTimeoutMs: env["shutdownTimeoutMs"]
  } };
}

export async function initializeEnvironmentConfig(options: {
  readonly cwd: string; readonly dir?: string | undefined; readonly configPath?: string | undefined;
  readonly projectName?: string | undefined; readonly force?: boolean | undefined; readonly clock?: (() => Date) | undefined;
}): Promise<InitCommandOutput> {
  const repository = await identifyRepository(resolve(options.cwd, options.dir ?? "."));
  const configPath = resolve(repository.root, ENVIRONMENT_CONFIG_PATH);
  if (options.configPath !== undefined && resolve(repository.root, options.configPath) !== configPath)
    throw new Error("Environment init writes only .bflow/config.yaml at the Git root.");
  await mkdir(dirname(configPath), { recursive: true });
  // A nested ignore file protects state without modifying the target repository's root ignore rules.
  const ignorePath = resolve(repository.root, ".bflow/.gitignore");
  const rules = ["state/", "logs/", "secrets/", ".env", ".env.*", "data/", "artifacts/", "registry/", "*.db", "*.db-*", "*.log"];
  const existing = await readFile(ignorePath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
  const missing = rules.filter((rule) => !existing.split(/\r?\n/).includes(rule));
  if (missing.length) {
    const ignore = await open(ignorePath, "a", 0o600);
    try { await ignore.writeFile(`${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`); } finally { await ignore.close(); }
  }
  const config = defaultEnvironmentConfig(repository, options.projectName, options.clock?.());
  if (options.force) {
    const existed = existsSync(configPath);
    const file = await open(configPath, "w", 0o600);
    try { await file.writeFile(JSON.stringify(config, null, 2) + "\n"); } finally { await file.close(); }
    return { configPath, config, overwritten: existed };
  }
  try {
    const file = await open(configPath, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(config, null, 2) + "\n"); } finally { await file.close(); }
    return { configPath, config, overwritten: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await loadRepositoryConfig(configPath);
    if (!saved.ok) throw new Error(`Existing configuration was preserved: ${saved.error.message}`);
    return { configPath, config: saved.value, overwritten: false };
  }
}

export async function ensureEnvironmentInitialized(
  targetDir: string,
  options?: {
    readonly force?: boolean | undefined;
    readonly dir?: string | undefined;
    readonly configPath?: string | undefined;
    readonly projectName?: string | undefined;
    readonly clock?: (() => Date) | undefined;
  }
): Promise<InitCommandOutput> {
  return initializeEnvironmentConfig({
    cwd: targetDir,
    dir: options?.dir,
    configPath: options?.configPath,
    projectName: options?.projectName,
    force: options?.force,
    clock: options?.clock
  });
}
