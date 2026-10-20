import { z } from "zod";
import { lstatSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { AgentRoleSchema, WorkflowDefinitionSchema } from "@bflow/contracts";
import { createDefaultRepositoryConfig, loadRepositoryConfig, resolveReadableConfigPath } from "./config.js";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "./config-format.js";
import { identifyRepository, type RepositoryIdentity } from "./repository.js";
import type { BflowRepositoryConfig, InitCommandOutput } from "./types.js";

export const EnvironmentProviderSchema = z.enum(["claude", "codex", "agy"]);
export type EnvironmentProvider = z.infer<typeof EnvironmentProviderSchema>;

export const DEFAULT_PROVIDER_BY_CLI: Record<EnvironmentProvider, string> = {
  claude: "anthropic",
  codex: "openai",
  agy: "google"
};

const EnvironmentProfileNameSchema = z.string().trim().regex(/^[A-Za-z0-9._-]+$/, "Profile names may contain only letters, numbers, dots, underscores and hyphens.");

export const EnvironmentProfileDefaultsSchema = z.object({
  codex: z.object({ "profile-name": EnvironmentProfileNameSchema.optional() }).strict().optional(),
  claude: z.object({ "profile-name": EnvironmentProfileNameSchema.optional() }).strict().optional(),
  agy: z.object({ "profile-name": EnvironmentProfileNameSchema.optional() }).strict().optional()
}).strict();

export const EnvironmentRoleConfigSchema = z
  .object({
    role: AgentRoleSchema,
    cli: z.string().trim().min(1),
    "profile-name": EnvironmentProfileNameSchema.optional(),
    model: z.string().trim().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    required: z.boolean().optional(),
    permissionMode: z.enum(["restricted", "workspace_auto", "unattended_isolated"]).optional(),
    fallbackCli: EnvironmentProviderSchema.optional(),
    requiredEnv: z.array(z.string().trim().min(1)).optional(),
    skills: z.array(z.string().trim().min(1)).optional(),
    unsupportedFlags: z.array(z.string().trim().min(1)).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cli === "agy" && value.effort !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["effort"], message: "Agy configures effort in the model name; omit the effort field." });
    }
  });
export type EnvironmentRoleConfig = z.infer<typeof EnvironmentRoleConfigSchema>;

export const EnvironmentConfigEnvironmentSchema = z
  .object({
    repositoryId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    sessionName: z.string().min(1),
    herdrBinary: z.string().min(1),
    roles: z.array(EnvironmentRoleConfigSchema).min(1),
    defaults: EnvironmentProfileDefaultsSchema.optional(),
    sdd: z
      .object({
        minimumLevel: z.enum(["lightweight", "full"]),
        approvalRequired: z.boolean()
      })
      .strict(),
    tdd: z
      .object({
        policy: z.literal("conditional")
      })
      .strict(),
    verification: z
      .object({
        maxIterations: z.number().int().min(1).max(100),
        onExhausted: z.literal("require_human")
      })
      .strict(),
    concurrency: z
      .object({
        maxConcurrency: z.number().int().min(1).max(64)
      })
      .strict(),
    startupTimeoutMs: z.number().int().min(1).max(600_000),
    shutdownTimeoutMs: z.number().int().min(1).max(600_000),
    allowProviderFallback: z.boolean().optional(),
    permissions: z
      .object({
        mode: z.enum(["restricted", "workspace_auto", "unattended_isolated"]).optional(),
        isolation: z.enum(["provider_policy", "os_sandbox", "container"]).optional(),
        trustedWorkspace: z.boolean().optional(),
        unsupportedFlags: z.array(z.string().trim().min(1)).optional()
      })
      .strict()
      .optional(),
    requiredMcpServices: z.array(z.string().trim().min(1)).optional(),
    requiredTools: z.array(z.string().trim().min(1)).optional(),
    /** Context7 documentation lookups through the shared Gateway. Absent means off: nothing leaves the machine unless a repository opts in. */
    context7: z
      .object({
        enabled: z.boolean().optional(),
        /** True: `bflow up` fails and `doctor` fails when Context7 is not ready. False (default): a warning, and roles start without it. */
        required: z.boolean().optional(),
        cache: z
          .object({
            enabled: z.boolean().optional(),
            ttlSeconds: z.number().int().min(60).max(604_800).optional(),
            /** Cache answers obtained with an API key. Off by default: such answers can come from libraries only the key's owner may read. */
            allowAuthenticated: z.boolean().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    skills: z
      .object({
        required: z.boolean().optional(),
        catalogDir: z.string().trim().min(1).optional(),
        bindingsPath: z.string().trim().min(1).optional(),
        requiredSkills: z.array(z.string().trim().min(1)).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const EnvironmentConfigSchema = z
  .object({
    schemaVersion: z.literal("1"),
    projectName: z.string().min(1),
    runtimeId: z.string().min(1),
    createdAt: z.string().min(1),
    storage: z
      .object({
        runStorePath: z.string().min(1),
        artifactStoreRoot: z.string().min(1),
        registryStateFile: z.string().min(1)
      })
      .strict(),
    defaultWorkflow: WorkflowDefinitionSchema,
    environment: EnvironmentConfigEnvironmentSchema
  })
  .strict();

export interface EnvironmentConfig extends BflowRepositoryConfig {
  readonly environment: z.infer<typeof EnvironmentConfigEnvironmentSchema>;
}
export const ENVIRONMENT_CONFIG_PATH = ".bflow/config.yml";

export function defaultEnvironmentConfig(repository: RepositoryIdentity, name?: string, now = new Date(), provider: EnvironmentProvider = "codex"): EnvironmentConfig {
  if (provider !== "claude" && provider !== "codex" && provider !== "agy") throw new Error("Provider must be claude, codex, or agy");
  return {
    ...createDefaultRepositoryConfig({ projectName: name ?? basename(repository.root), runtimeId: `runtime-${repository.id.slice(0, 20)}`, createdAt: now.toISOString() }),
    environment: {
      repositoryId: repository.id, workspaceRoot: repository.root, sessionName: repository.sessionName,
      herdrBinary: "herdr",
      roles: ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"].map((role) => ({ role: AgentRoleSchema.parse(role), cli: provider, required: true })),
      sdd: { minimumLevel: "lightweight", approvalRequired: true }, tdd: { policy: "conditional" },
      verification: { maxIterations: 3, onExhausted: "require_human" }, concurrency: { maxConcurrency: 2 },
      startupTimeoutMs: 300_000, shutdownTimeoutMs: 30_000,
      context7: { enabled: true, required: false }
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
  const path = resolveReadableConfigPath(repository.root);
  const base = await loadRepositoryConfig(path);
  if (!base.ok) throw new Error(base.error.message);
  const raw: unknown = parseConfigYaml(await readFile(path, "utf8"));
  const env = record(record(raw)["environment"]);
  if (env["repositoryId"] !== repository.id || env["workspaceRoot"] !== repository.root || env["sessionName"] !== repository.sessionName)
    throw new Error("Configuration belongs to another repository or was moved. Reconcile its repository identity before use.");
  if (typeof env["herdrBinary"] !== "string" || !env["herdrBinary"].trim()) throw new Error("Invalid Herdr executable");
  const rawRoles = env["roles"];
  if (!Array.isArray(rawRoles) || !rawRoles.length) throw new Error("Missing role configuration");
  const roles = rawRoles.map((value: unknown) => {
    return EnvironmentRoleConfigSchema.parse(value);
  });
  if (new Set(roles.map((r) => r.role)).size !== roles.length || !["conversation", "coordinator"].every((r) => roles.some((role) => role.role === r && (role.required ?? true))))
    throw new Error("Unique roles and required conversation/coordinator roles are mandatory");
  const sdd = record(env["sdd"]);
  const tdd = record(env["tdd"]);
  const verification = record(env["verification"]);
  const concurrency = record(env["concurrency"]);
  if ((sdd["minimumLevel"] !== "lightweight" && sdd["minimumLevel"] !== "full") || typeof sdd["approvalRequired"] !== "boolean" || tdd["policy"] !== "conditional" ||
      !integer(verification["maxIterations"], 100) || verification["onExhausted"] !== "require_human" || !integer(concurrency["maxConcurrency"], 64) ||
      !integer(env["startupTimeoutMs"], 600_000) || !integer(env["shutdownTimeoutMs"], 600_000)) throw new Error("Invalid SDLC policies, concurrency or timeouts");
  WorkflowDefinitionSchema.parse(base.value.defaultWorkflow);
  const parsedEnv = EnvironmentConfigEnvironmentSchema.parse({
    ...env,
    roles
  });
  return { ...base.value, environment: parsedEnv };
}

export async function initializeEnvironmentConfig(options: {
  readonly cwd: string; readonly dir?: string | undefined; readonly configPath?: string | undefined;
  readonly projectName?: string | undefined; readonly force?: boolean | undefined; readonly clock?: (() => Date) | undefined;
  readonly provider?: EnvironmentProvider | undefined;
}): Promise<InitCommandOutput> {
  const repository = await identifyRepository(resolve(options.cwd, options.dir ?? "."));
  const configPath = resolve(repository.root, ENVIRONMENT_CONFIG_PATH);
  const configExists = (() => {
    try {
      const info = lstatSync(configPath);
      if (!info.isFile()) throw new Error(`Configuration path ${configPath} must be a regular file, not a symlink or directory.`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  })();
  if (options.configPath !== undefined && resolve(repository.root, options.configPath) !== configPath)
    throw new Error("Environment init writes only .bflow/config.yml at the Git root.");
  const legacyPath = [".bflow/config.yaml", ".bflow/config.json"].map(p => resolve(repository.root, p)).find(path => {
    try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  if (!configExists && legacyPath)
    throw new Error(`Legacy configuration exists at ${legacyPath}; preserve it and run 'bflow config-migrate' before init or up.`);
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
  const config = defaultEnvironmentConfig(repository, options.projectName, options.clock?.(), options.provider);
  if (options.force) {
    const existed = configExists;
    const file = await open(configPath, "w", 0o600);
    try { await file.writeFile(renderEnvironmentConfigYaml(config)); } finally { await file.close(); }
    return { configPath, config, overwritten: existed };
  }
  try {
    const file = await open(configPath, "wx", 0o600);
    try { await file.writeFile(renderEnvironmentConfigYaml(config)); } finally { await file.close(); }
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
    readonly provider?: EnvironmentProvider | undefined;
    readonly clock?: (() => Date) | undefined;
  }
): Promise<InitCommandOutput> {
  return initializeEnvironmentConfig({
    cwd: targetDir,
    dir: options?.dir,
    configPath: options?.configPath,
    projectName: options?.projectName,
    provider: options?.provider,
    force: options?.force,
    clock: options?.clock
  });
}
