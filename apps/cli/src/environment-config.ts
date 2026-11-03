import { z } from "zod";
import { ProviderFailoverPolicySchema } from "@bflow/contracts";
import { presetAssignment, roleModelPreset } from "@bflow/agent-providers";
import { lstatSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { AgentRoleSchema, RepositoryToolPolicySchema, WorkflowDefinitionSchema, RoleProfilePinSchema } from "@bflow/contracts";
import { migrateLegacyContext7Config } from "./deepwiki-migration.js";
import { EMPTY_ROLES_AFTER_MIGRATION_MESSAGE, migrateDirectorRoles } from "./director-roles-migration.js";
import { createDefaultRepositoryConfig, loadRepositoryConfig, parseRepositoryConfig, resolveReadableConfigPath } from "./config.js";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "./config-format.js";
import { identifyRepository, type RepositoryIdentity } from "./repository.js";
import type { BflowRepositoryConfig, InitCommandOutput } from "./types.js";
import type { AgentRole } from "@bflow/contracts";

export const EnvironmentProviderSchema = z.enum(["claude", "codex", "agy"]);
export type EnvironmentProvider = z.infer<typeof EnvironmentProviderSchema>;

export const DEFAULT_PROVIDER_BY_CLI: Record<EnvironmentProvider, string> = {
  claude: "anthropic",
  codex: "openai",
  agy: "google"
};

const EnvironmentProfileNameSchema = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, "Profile names may contain only letters, numbers, dots, underscores and hyphens.");

export const EnvironmentProfileDefaultsSchema = z.object({
  codex: z.object({ "profile-name": EnvironmentProfileNameSchema.optional() }).strict().optional(),
  claude: z.object({ "profile-name": EnvironmentProfileNameSchema.optional() }).strict().optional(),
  agy: z.object({ "profile-name": EnvironmentProfileNameSchema.optional() }).strict().optional()
}).strict();

export const EnvironmentIntegratedToolToggleSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional()
}).strict();

export const EnvironmentRtkToolConfigSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  cliCommandProfiles: z.array(z.string().trim().min(1)).optional()
}).strict();

export const EnvironmentMempalaceToolConfigSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  wing: z.string().trim().min(1).optional(),
  serviceId: z.string().trim().min(1).optional()
}).strict();

export const EnvironmentToolsConfigSchema = z.object({
  rtk: EnvironmentRtkToolConfigSchema.optional(),
  gitnexus: EnvironmentIntegratedToolToggleSchema.optional(),
  mempalace: EnvironmentMempalaceToolConfigSchema.optional(),
  "chrome-devtools-mcp": EnvironmentIntegratedToolToggleSchema.optional()
}).strict();
export type EnvironmentToolsConfig = z.infer<typeof EnvironmentToolsConfigSchema>;

/** Governance roles plus `sos`, the emergency rescue agent spawned on demand by an exact `BFLOWSOS` chat turn. */
export const EnvironmentRoleNameSchema = z.union([AgentRoleSchema, z.literal("sos")]);
export type EnvironmentRoleName = z.infer<typeof EnvironmentRoleNameSchema>;

export const EnvironmentRoleConfigSchema = z
  .object({
    role: EnvironmentRoleNameSchema,
    cli: z.string().trim().min(1),
    "profile-name": EnvironmentProfileNameSchema.optional(),
    specialistProfile: RoleProfilePinSchema.optional(),
    model: z.string().trim().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    required: z.boolean().optional(),
    permissionMode: z.enum(["restricted", "workspace_auto", "unattended_isolated"]).optional(),
    fallbackCli: EnvironmentProviderSchema.optional(),
    failover: ProviderFailoverPolicySchema.optional(),
    requiredEnv: z.array(z.string().trim().min(1)).optional(),
    skills: z.array(z.string().trim().min(1)).optional(),
    unsupportedFlags: z.array(z.string().trim().min(1)).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role === "sos" && value.specialistProfile)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["specialistProfile"], message: "The sos role cannot select a specialist profile." });
    if (value.role === "sos" && value.failover)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["failover"], message: "The sos role does not support failover." });
    if (value.specialistProfile && (value.role === "conversation" || value.role === "coordinator"))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["specialistProfile"], message: "Only specialist governance roles may select a specialist profile." });
    if (value.failover && (value.failover.role !== value.role || !value.model || !value["profile-name"]))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["failover"], message: "Failover requires the same governance role and explicit primary model/profile" });
    if (value.cli === "agy" && value.effort !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["effort"], message: "Agy configures effort in the model name; omit the effort field." });
    }
  });
export type EnvironmentRoleConfig = z.infer<typeof EnvironmentRoleConfigSchema>;
export type EnvironmentGovernanceRoleConfig = EnvironmentRoleConfig & { role: AgentRole };

export function isGovernanceRoleConfig(role: EnvironmentRoleConfig): role is EnvironmentGovernanceRoleConfig {
  return role.role !== "sos";
}

export const EnvironmentConfigEnvironmentSchema = z
  .object({
    repositoryId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    sessionName: z.string().min(1),
    herdrBinary: z.string().min(1),
    roles: z.array(EnvironmentRoleConfigSchema).min(1),
    specialistProfiles: z.array(z.object({ path: z.string().min(1).max(1000), pin: RoleProfilePinSchema }).strict()).max(128)
      .refine(entries => new Set(entries.map(entry => `${entry.pin.profileId}@${entry.pin.version}`)).size === entries.length,
        "Specialist profile ID/version must be unique").optional(),
    defaults: EnvironmentProfileDefaultsSchema.optional(),
    workflowPack: z.object({ path: z.string().min(1), id: z.string().min(1), version: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
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
        onExhausted: z.literal("require_human"),
        regressionScope: z.enum(["affected", "full", "mapped_only"]).default("affected"),
        reviewTimeoutMs: z.number().int().min(60_000).max(3_600_000).optional()
      })
      .strict(),
    fastPath: z
      .object({
        mode: z.enum(["auto", "off"]).default("auto")
      })
      .strict()
      .default({ mode: "auto" }),
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
    tools: EnvironmentToolsConfigSchema.optional(),
    toolPolicy: RepositoryToolPolicySchema.optional(),
    /** DeepWiki public-repository documentation through the shared Gateway. Enabled by default unless explicitly set to enabled: false. */
    deepwiki: z
      .object({
        enabled: z.boolean().optional(),
        /** True: `bflow up` fails and `doctor` fails when DeepWiki is not ready. False (default): a warning, and roles start without it. */
        required: z.boolean().optional()
      })
      .strict()
      .optional(),
    skills: z
      .object({
        required: z.boolean().optional(),
        catalogDir: z.string().trim().min(1).optional(),
        bindingsPath: z.string().trim().min(1).optional(),
        requiredSkills: z.array(z.string().trim().min(1)).optional(),
        pins: z.array(z.object({ skillId: z.string().min(1), version: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/), approvalReceiptId: z.string().min(1) }).strict()).optional()
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
  /** Read-time warnings (for example a legacy conversation/coordinator entry that was ignored); never persisted. */
  readonly diagnostics?: readonly string[] | undefined;
}
/** Roles of the retired v2 layout; the Director (the user's own CLI) replaces them and they never get a pane. */
export const LEGACY_DIRECTOR_REPLACED_ROLES = ["conversation", "coordinator"] as const;
export const LEGACY_ROLES_IGNORED_WARNING = "Đã bỏ qua vai conversation/coordinator (Director thay thế). Chạy `bflow config-migrate` để gỡ khỏi cấu hình.";
export const isLegacyDirectorRole = (role: string): boolean => (LEGACY_DIRECTOR_REPLACED_ROLES as readonly string[]).includes(role);
export const ENVIRONMENT_CONFIG_PATH = ".bflow/config.yml";

export function defaultEnvironmentConfig(repository: RepositoryIdentity, name?: string, now = new Date(), provider: EnvironmentProvider = "codex"): EnvironmentConfig {
  if (provider !== "claude" && provider !== "codex" && provider !== "agy") throw new Error("Provider must be claude, codex, or agy");
  return {
    ...createDefaultRepositoryConfig({ projectName: name ?? basename(repository.root), runtimeId: `runtime-${repository.id.slice(0, 20)}`, createdAt: now.toISOString() }),
    environment: {
      repositoryId: repository.id,
      workspaceRoot: repository.root,
      sessionName: repository.sessionName,
      herdrBinary: "herdr",
      roles: ["planner", "architect", "specifier", "developer", "reviewer", "qa", "sos"].map((role) => ({
        role: EnvironmentRoleNameSchema.parse(role),
        cli: provider,
        required: role !== "developer" && role !== "sos"
      })),
      defaults: {
        codex: {},
        claude: {},
        agy: {}
      },
      sdd: { minimumLevel: "lightweight", approvalRequired: true },
      tdd: { policy: "conditional" },
      verification: { maxIterations: 3, onExhausted: "require_human", regressionScope: "affected" },
      fastPath: { mode: "auto" },
      concurrency: { maxConcurrency: 2 },
      startupTimeoutMs: 300_000,
      shutdownTimeoutMs: 30_000,
      allowProviderFallback: false,
      permissions: {
        mode: "workspace_auto",
        isolation: "provider_policy",
        trustedWorkspace: true
      },
      tools: {
        rtk: { enabled: true, required: false },
        gitnexus: { enabled: true, required: false },
        mempalace: { enabled: true, required: false },
        "chrome-devtools-mcp": { enabled: true, required: false }
      },
      deepwiki: {
        enabled: true,
        required: false
      },
      skills: {
        required: false,
        requiredSkills: []
      }
    }
  };
}

/** Role → provider/model rows written by `bflow init`, as shown in its summary table. */
export interface RolePresetSummaryRow {
  readonly role: EnvironmentRoleName;
  readonly cli: string;
  readonly model?: string | undefined;
  readonly required: boolean;
  readonly note?: string | undefined;
}
export interface RolePresetReport {
  /** The CLI preset that produced (or would produce) the rows; absent when an update kept every saved choice. */
  readonly provider?: EnvironmentProvider | undefined;
  readonly applied: boolean;
  readonly roles: readonly RolePresetSummaryRow[];
}

/** Replaces each role's provider/model with the static preset of the chosen CLI; other role fields are kept. */
export function applyRoleModelPreset(config: EnvironmentConfig, provider: EnvironmentProvider): EnvironmentConfig {
  const roles = config.environment.roles.map(role => presetRole(role, provider));
  return EnvironmentConfigSchema.parse({ ...config, environment: { ...config.environment, roles } });
}

function presetRole(role: EnvironmentRoleConfig, provider: EnvironmentProvider): EnvironmentRoleConfig {
  const assignment = presetAssignment(provider, role.role);
  const { model: _model, effort: _effort, ...rest } = role;
  return EnvironmentRoleConfigSchema.parse({ ...rest, cli: assignment.cli, ...(assignment.model ? { model: assignment.model } : {}) });
}

export function summarizeRolePresets(config: BflowRepositoryConfig, provider: EnvironmentProvider | undefined, applied: boolean): RolePresetReport {
  const environment = (config as Partial<EnvironmentConfig>).environment;
  const preset = provider ? roleModelPreset(provider) : undefined;
  return {
    ...(provider ? { provider } : {}),
    applied,
    roles: (environment?.roles ?? []).map(role => {
      const fallback = preset?.roles[role.role]?.fallbackReason;
      return {
        role: role.role,
        cli: role.cli,
        ...(role.model ? { model: role.model } : {}),
        required: role.required ?? (role.role !== "developer" && role.role !== "sos"),
        ...(applied && fallback && role.cli !== provider ? { note: fallback } : {})
      };
    })
  };
}

export function upsertEnvironmentConfig(
  base: EnvironmentConfig,
  saved: EnvironmentConfig,
  options?: {
    readonly projectName?: string | undefined;
    readonly provider?: EnvironmentProvider | undefined;
  }
): EnvironmentConfig {
  const baseEnv = base.environment;
  const savedEnv = saved.environment;
  const baseRoleNames = new Set(baseEnv.roles.map((r) => r.role));
  // Without --provider every saved choice is kept. With it, a role whose CLI changes takes the preset's CLI and model,
  // because a model or effort chosen for another CLI is not valid for the new one; a role already on that CLI keeps its model.
  const mergeSavedRole = (savedRole: EnvironmentRoleConfig, baseRole?: EnvironmentRoleConfig): EnvironmentRoleConfig => {
    const baseFields = baseRole ? (({ model: _model, effort: _effort, ...rest }: EnvironmentRoleConfig) => rest)(baseRole) : {};
    const mergedRole: Record<string, unknown> = { ...baseFields, ...savedRole };
    if (options?.provider) {
      const assignment = presetAssignment(options.provider, savedRole.role);
      if (assignment.cli !== savedRole.cli) {
        mergedRole["cli"] = assignment.cli;
        delete mergedRole["model"];
        delete mergedRole["effort"];
        if (assignment.model) mergedRole["model"] = assignment.model;
      }
    }
    if (mergedRole["cli"] === "agy") delete mergedRole["effort"];
    return EnvironmentRoleConfigSchema.parse(mergedRole);
  };
  const mergedRoles: EnvironmentRoleConfig[] = [
    ...baseEnv.roles.map((baseRole) => {
      const savedRole = savedEnv.roles.find((r) => r.role === baseRole.role);
      return savedRole ? mergeSavedRole(savedRole, baseRole) : baseRole;
    }),
    ...savedEnv.roles
      .filter((savedRole) => !baseRoleNames.has(savedRole.role))
      .map((savedRole) => mergeSavedRole(savedRole))
  ];

  const mergedEnv: z.infer<typeof EnvironmentConfigEnvironmentSchema> = {
    ...baseEnv,
    ...savedEnv,
    repositoryId: baseEnv.repositoryId,
    workspaceRoot: baseEnv.workspaceRoot,
    sessionName: baseEnv.sessionName,
    herdrBinary: savedEnv.herdrBinary || baseEnv.herdrBinary,
    roles: mergedRoles,
    defaults: {
      codex: { ...baseEnv.defaults?.codex, ...savedEnv.defaults?.codex },
      claude: { ...baseEnv.defaults?.claude, ...savedEnv.defaults?.claude },
      agy: { ...baseEnv.defaults?.agy, ...savedEnv.defaults?.agy }
    },
    sdd: { ...baseEnv.sdd, ...savedEnv.sdd },
    tdd: { ...baseEnv.tdd, ...savedEnv.tdd },
    verification: { ...baseEnv.verification, ...savedEnv.verification },
    fastPath: { ...baseEnv.fastPath, ...savedEnv.fastPath },
    concurrency: { ...baseEnv.concurrency, ...savedEnv.concurrency },
    startupTimeoutMs: savedEnv.startupTimeoutMs ?? baseEnv.startupTimeoutMs,
    shutdownTimeoutMs: savedEnv.shutdownTimeoutMs ?? baseEnv.shutdownTimeoutMs,
    allowProviderFallback: savedEnv.allowProviderFallback ?? baseEnv.allowProviderFallback,
    permissions: {
      ...baseEnv.permissions,
      ...savedEnv.permissions
    },
    tools: {
      rtk: { ...baseEnv.tools?.rtk, ...savedEnv.tools?.rtk },
      gitnexus: { ...baseEnv.tools?.gitnexus, ...savedEnv.tools?.gitnexus },
      mempalace: { ...baseEnv.tools?.mempalace, ...savedEnv.tools?.mempalace },
      "chrome-devtools-mcp": { ...baseEnv.tools?.["chrome-devtools-mcp"], ...savedEnv.tools?.["chrome-devtools-mcp"] }
    },
    deepwiki: {
      ...baseEnv.deepwiki,
      ...savedEnv.deepwiki
    },
    skills: {
      ...baseEnv.skills,
      ...savedEnv.skills
    }
  };

  return EnvironmentConfigSchema.parse({
    schemaVersion: base.schemaVersion,
    projectName: options?.projectName ?? (saved.projectName || base.projectName),
    runtimeId: saved.runtimeId || base.runtimeId,
    createdAt: saved.createdAt || base.createdAt,
    storage: {
      ...base.storage,
      ...saved.storage
    },
    defaultWorkflow: saved.defaultWorkflow ?? base.defaultWorkflow,
    environment: mergedEnv
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a configuration object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}
/**
 * A configuration written by an earlier release carries `environment.context7`. It is read as `environment.deepwiki` with only
 * `enabled` and `required` carried over (cache settings and any key-related field are dropped); an explicit `deepwiki` block wins.
 * Nothing is written here: `bflow init --update` and `migrateLegacyContext7Config` rewrite the file with a backup.
 */
function withLegacyContext7Read(env: Record<string, unknown>): Record<string, unknown> {
  if (!("context7" in env)) return env;
  const { context7, ...rest } = env;
  if (rest["deepwiki"] !== undefined) return rest;
  const legacy = typeof context7 === "object" && context7 !== null && !Array.isArray(context7) ? context7 as Record<string, unknown> : {};
  const carried: Record<string, boolean> = {};
  for (const key of ["enabled", "required"]) if (typeof legacy[key] === "boolean") carried[key] = legacy[key] as boolean;
  return { ...rest, deepwiki: carried };
}

/** Value-free diagnostic, safe to show verbatim. */
export const CONFIG_REPOSITORY_IDENTITY_MISMATCH = "Configuration belongs to another repository or was moved. Reconcile its repository identity before use.";
export async function readEnvironmentConfig(repository: RepositoryIdentity, content?: string): Promise<EnvironmentConfig> {
  const path = resolveReadableConfigPath(repository.root);
  try {
    const source = content ?? await readFile(path, "utf8");
    const base = parseRepositoryConfig(source, path);
    if (!base.ok) throw new Error(base.error.message);
    const raw: unknown = parseConfigYaml(source);
    const env = withLegacyContext7Read(record(record(raw)["environment"]));
    if (env["repositoryId"] !== repository.id || env["workspaceRoot"] !== repository.root || env["sessionName"] !== repository.sessionName)
      throw new Error(CONFIG_REPOSITORY_IDENTITY_MISMATCH);
    if (typeof env["herdrBinary"] !== "string" || !env["herdrBinary"].trim()) throw new Error("Invalid Herdr executable");
    const rawRoles = env["roles"];
    if (!Array.isArray(rawRoles) || !rawRoles.length) throw new Error("Missing role configuration");
    const parsedRoles = rawRoles.map((value: unknown, index: number) => {
      return EnvironmentRoleConfigSchema.parse(value, { path: ["environment", "roles", index] });
    });
    const roles = parsedRoles.filter(role => !isLegacyDirectorRole(role.role));
    if (roles.length === 0 && parsedRoles.length > 0) throw new Error(EMPTY_ROLES_AFTER_MIGRATION_MESSAGE.replace(" Không có tệp nào bị thay đổi.", ""));
    const diagnostics = roles.length !== parsedRoles.length ? [LEGACY_ROLES_IGNORED_WARNING] : [];
    if (new Set(parsedRoles.map((r) => r.role)).size !== parsedRoles.length) throw new Error("Unique roles are mandatory");
    const sdd = record(env["sdd"]);
    const tdd = record(env["tdd"]);
    const verification = record(env["verification"]);
    const concurrency = record(env["concurrency"]);
    if ((sdd["minimumLevel"] !== "lightweight" && sdd["minimumLevel"] !== "full") || typeof sdd["approvalRequired"] !== "boolean" || tdd["policy"] !== "conditional" ||
        !integer(verification["maxIterations"], 100) || verification["onExhausted"] !== "require_human" ||
        (verification["regressionScope"] !== undefined && !["affected", "full", "mapped_only"].includes(String(verification["regressionScope"]))) ||
        (verification["reviewTimeoutMs"] !== undefined && (typeof verification["reviewTimeoutMs"] !== "number" || !Number.isSafeInteger(verification["reviewTimeoutMs"]) ||
          Number(verification["reviewTimeoutMs"]) < 60_000 || Number(verification["reviewTimeoutMs"]) > 3_600_000)) ||
        (env["fastPath"] !== undefined && (typeof env["fastPath"] !== "object" || env["fastPath"] === null || Array.isArray(env["fastPath"]) ||
          ((env["fastPath"] as Record<string, unknown>)["mode"] !== undefined && !["auto", "off"].includes(String((env["fastPath"] as Record<string, unknown>)["mode"]))))) ||
        !integer(concurrency["maxConcurrency"], 64) ||
        !integer(env["startupTimeoutMs"], 600_000) || !integer(env["shutdownTimeoutMs"], 600_000)) throw new Error("Invalid SDLC policies, concurrency or timeouts");
    WorkflowDefinitionSchema.parse(base.value.defaultWorkflow);
    const parsedEnv = EnvironmentConfigEnvironmentSchema.parse({
      ...env,
      roles
    }, { path: ["environment"] });
    return { ...base.value, environment: parsedEnv, ...(diagnostics.length ? { diagnostics } : {}) };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const issue = error.issues[0]!;
    const field = issue.path.reduce<string>((result, part) => typeof part === "number"
      ? `${result}[${part}]` : `${result}${result ? "." : ""}${part}`, "");
    throw new Error(`Invalid ${relative(repository.root, path)}: ${field}: ${issue.message}`);
  }
}

export async function initializeEnvironmentConfig(options: {
  readonly cwd: string; readonly dir?: string | undefined; readonly configPath?: string | undefined;
  readonly projectName?: string | undefined; readonly force?: boolean | undefined; readonly update?: boolean | undefined;
  readonly clock?: (() => Date) | undefined; readonly provider?: EnvironmentProvider | undefined;
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
  const presetProvider = options.provider ?? "codex";
  const config = applyRoleModelPreset(defaultEnvironmentConfig(repository, options.projectName, options.clock?.(), presetProvider), presetProvider);
  if (options.update) {
    let mergedConfig = config;
    let reportProvider: EnvironmentProvider | undefined = presetProvider;
    let removedRoles: readonly string[] = [];
    if (configExists) {
      // The retired conversation/coordinator roles are removed first, with a backup (Director replaces them).
      removedRoles = (await migrateDirectorRoles(repository.root, { skipWhenEmpty: true })).removedRoles;
      // 0. A configuration from an earlier release is migrated first: a timestamped backup, then context7 becomes deepwiki.
      await migrateLegacyContext7Config(repository.root);
      // 1. Lưu tạm các giá trị config hiện tại trong bộ nhớ (validate trước khi xoá).
      const savedBase = await loadRepositoryConfig(configPath);
      if (!savedBase.ok) throw new Error(`Cannot update invalid configuration: ${savedBase.error.message}`);
      const raw = record(parseConfigYaml(await readFile(configPath, "utf8")));
      const rawEnv = withLegacyContext7Read(record(raw["environment"]));
      const savedConfig = EnvironmentConfigSchema.parse({
        ...savedBase.value,
        environment: {
          ...rawEnv,
          repositoryId: repository.id,
          workspaceRoot: repository.root,
          sessionName: repository.sessionName
        }
      });
      // Roles new to this release follow the CLI the first saved specialist role already uses unless --provider picks another preset.
      // The retired conversation/coordinator entries are dropped here (the file is rewritten without them).
      savedConfig.environment.roles = savedConfig.environment.roles.filter(role => !isLegacyDirectorRole(role.role));
      const savedCoordinator = EnvironmentProviderSchema.safeParse(savedConfig.environment.roles[0]?.cli);
      const savedProvider = savedCoordinator.success ? savedCoordinator.data : undefined;
      const baseProvider = options.provider ?? savedProvider ?? presetProvider;
      const base = baseProvider === presetProvider ? config
        : applyRoleModelPreset(defaultEnvironmentConfig(repository, options.projectName, options.clock?.(), baseProvider), baseProvider);
      reportProvider = options.provider;
      // 2. Xoá file config cũ đi.
      await unlink(configPath);
      // 3. Upsert giá trị cũ vào cấu trúc default mới (kèm comment và các trường mới).
      mergedConfig = upsertEnvironmentConfig(base, savedConfig, {
        projectName: options.projectName,
        provider: options.provider
      });
    }
    const file = await open(configPath, "wx", 0o600);
    try { await file.writeFile(renderEnvironmentConfigYaml(mergedConfig)); } finally { await file.close(); }
    return { configPath, config: mergedConfig, overwritten: configExists, updated: true,
      ...(removedRoles.length ? { removedRoles } : {}),
      rolePresets: summarizeRolePresets(mergedConfig, reportProvider, reportProvider !== undefined) };
  }
  if (options.force) {
    const existed = configExists;
    const file = await open(configPath, "w", 0o600);
    try { await file.writeFile(renderEnvironmentConfigYaml(config)); } finally { await file.close(); }
    return { configPath, config, overwritten: existed, rolePresets: summarizeRolePresets(config, presetProvider, true) };
  }
  try {
    const file = await open(configPath, "wx", 0o600);
    try { await file.writeFile(renderEnvironmentConfigYaml(config)); } finally { await file.close(); }
    return { configPath, config, overwritten: false, rolePresets: summarizeRolePresets(config, presetProvider, true) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await loadRepositoryConfig(configPath);
    if (!saved.ok) throw new Error(`Existing configuration was preserved: ${saved.error.message}`);
    const savedEnvironment = await readEnvironmentConfig(repository).catch(() => undefined);
    return { configPath, config: saved.value, overwritten: false,
      ...(savedEnvironment ? { rolePresets: summarizeRolePresets(savedEnvironment, undefined, false) } : {}) };
  }
}

export async function ensureEnvironmentInitialized(
  targetDir: string,
  options?: {
    readonly force?: boolean | undefined;
    readonly update?: boolean | undefined;
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
    update: options?.update,
    clock: options?.clock
  });
}
