import {
  AgentConfigurationSchema,
  AgentResolutionContextSchema,
  IdentifierSchema,
  type AgentConfiguration,
  type AgentRegistry,
  type AgentResolutionContext,
  type ArtifactReference,
  type ContractError,
  type JsonValue,
  type OperationOptions,
  type OperationResult
} from "@ai-flow/contracts";

export type ArtifactKind = ArtifactReference["kind"];

export const MVP_ROLES = ["planner", "developer", "reviewer", "qa"] as const;
export type MvpRole = (typeof MVP_ROLES)[number];

export function isMvpRole(value: unknown): value is MvpRole {
  return typeof value === "string" && (MVP_ROLES as readonly string[]).includes(value);
}

export const MvpRoleSchema: {
  safeParse(value: unknown): { success: true; data: MvpRole } | { success: false; error: { message: string } };
  parse(value: unknown): MvpRole;
} = {
  safeParse(value: unknown) {
    if (isMvpRole(value)) {
      return { success: true, data: value };
    }
    return {
      success: false,
      error: { message: `Invalid MVP role: ${String(value)}. Expected one of: ${MVP_ROLES.join(", ")}` }
    };
  },
  parse(value: unknown): MvpRole {
    if (isMvpRole(value)) {
      return value;
    }
    throw new Error(`Invalid MVP role: ${String(value)}. Expected one of: ${MVP_ROLES.join(", ")}`);
  }
};

export interface RoleExecutionSettings {
  readonly paneId?: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly terminalId?: string;
  readonly args?: readonly string[];
}

export interface RoleAgentSettings {
  readonly provider: string;
  readonly kind: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly readOnlyWorkspace: boolean;
  readonly allowTaskDelegation: false;
  readonly requiresIndependentTestVerification: true;
  readonly execution?: RoleExecutionSettings;
}

export interface MvpRoleProfile {
  readonly role: MvpRole;
  readonly title: string;
  readonly description: string;
  readonly defaultCapabilities: readonly string[];
  readonly allowedInputArtifactKinds: readonly ArtifactKind[];
  readonly producedArtifactKinds: readonly ArtifactKind[];
  readonly readOnlyWorkspace: boolean;
  readonly allowTaskDelegation: false;
  readonly requiresIndependentTestVerification: true;
}

export const MVP_ROLE_PROFILES: Readonly<Record<MvpRole, MvpRoleProfile>> = Object.freeze({
  planner: Object.freeze({
    role: "planner" as const,
    title: "Workflow Planner & Decomposition Agent",
    description: "Decomposes high-level requirements into deterministic DAG tasks with clear acceptance criteria and artifact dependencies.",
    defaultCapabilities: Object.freeze(["planning", "task-decomposition", "dag-design"] as const),
    allowedInputArtifactKinds: Object.freeze(["document", "report", "agent-output"] as const),
    producedArtifactKinds: Object.freeze(["document", "agent-output"] as const),
    readOnlyWorkspace: true,
    allowTaskDelegation: false as const,
    requiresIndependentTestVerification: true as const
  }),
  developer: Object.freeze({
    role: "developer" as const,
    title: "Implementation & Coding Agent",
    description: "Implements task changes within an isolated worktree branch and produces patches and unit test results.",
    defaultCapabilities: Object.freeze(["coding", "worktree-implementation", "unit-testing"] as const),
    allowedInputArtifactKinds: Object.freeze(["document", "report", "patch", "test-result", "agent-output"] as const),
    producedArtifactKinds: Object.freeze(["patch", "test-result", "agent-output", "log"] as const),
    readOnlyWorkspace: false,
    allowTaskDelegation: false as const,
    requiresIndependentTestVerification: true as const
  }),
  reviewer: Object.freeze({
    role: "reviewer" as const,
    title: "Code Review & Security Audit Agent",
    description: "Performs read-only code review, security audits, and maintainability checks against task acceptance criteria.",
    defaultCapabilities: Object.freeze(["code-review", "security-audit", "maintainability-review"] as const),
    allowedInputArtifactKinds: Object.freeze(["document", "patch", "test-result", "report", "agent-output", "log"] as const),
    producedArtifactKinds: Object.freeze(["report", "agent-output"] as const),
    readOnlyWorkspace: true,
    allowTaskDelegation: false as const,
    requiresIndependentTestVerification: true as const
  }),
  qa: Object.freeze({
    role: "qa" as const,
    title: "Quality Assurance & Test Verification Agent",
    description: "Verifies test execution evidence and acceptance criteria without trusting agent self-assertions.",
    defaultCapabilities: Object.freeze(["qa-verification", "test-validation", "acceptance-checking"] as const),
    allowedInputArtifactKinds: Object.freeze(["document", "patch", "test-result", "report", "log", "agent-output"] as const),
    producedArtifactKinds: Object.freeze(["test-result", "report", "agent-output"] as const),
    readOnlyWorkspace: true,
    allowTaskDelegation: false as const,
    requiresIndependentTestVerification: true as const
  })
});

export function getMvpRoleProfile(role: MvpRole): MvpRoleProfile {
  const profile = MVP_ROLE_PROFILES[role];
  if (!profile) {
    throw new Error(`Unknown MVP role: ${String(role)}`);
  }
  return profile;
}

const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const fail = <T>(error: ContractError): OperationResult<T> => ({ ok: false, error });
const validation = (message: string): ContractError => ({ code: "validation", retryable: false, message });

const ALLOWED_SETTINGS_KEYS = new Set([
  "provider",
  "kind",
  "model",
  "temperature",
  "maxTokens",
  "readOnlyWorkspace",
  "allowTaskDelegation",
  "requiresIndependentTestVerification",
  "execution"
]);

const ALLOWED_EXECUTION_KEYS = new Set([
  "paneId",
  "workspaceId",
  "tabId",
  "terminalId",
  "args"
]);

export function parseRoleAgentSettings(
  settings: unknown,
  expectedRole?: MvpRole
): OperationResult<RoleAgentSettings> {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return fail(validation("Role agent settings must be a non-null plain object"));
  }

  const raw = settings as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      return fail(validation(`Unknown setting key: '${key}'`));
    }
  }

  if (typeof raw.provider !== "string" || raw.provider.trim().length === 0) {
    return fail(validation("Settings 'provider' must be a non-empty trimmed string"));
  }
  const provider = raw.provider.trim();

  if (typeof raw.kind !== "string" || raw.kind.trim().length === 0) {
    return fail(validation("Settings 'kind' must be a non-empty trimmed string"));
  }
  const kind = raw.kind.trim();

  let model: string | undefined;
  if ("model" in raw && raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
      return fail(validation("Settings 'model' must be a non-empty trimmed string"));
    }
    model = raw.model.trim();
  }

  let temperature: number | undefined;
  if ("temperature" in raw && raw.temperature !== undefined) {
    if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      return fail(validation("Settings 'temperature' must be a finite number between 0 and 2"));
    }
    temperature = raw.temperature;
  }

  let maxTokens: number | undefined;
  if ("maxTokens" in raw && raw.maxTokens !== undefined) {
    if (typeof raw.maxTokens !== "number" || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0) {
      return fail(validation("Settings 'maxTokens' must be a positive integer"));
    }
    maxTokens = raw.maxTokens;
  }

  let readOnlyWorkspace: boolean;
  if ("readOnlyWorkspace" in raw && raw.readOnlyWorkspace !== undefined) {
    if (typeof raw.readOnlyWorkspace !== "boolean") {
      return fail(validation("Settings 'readOnlyWorkspace' must be a boolean"));
    }
    if (expectedRole && (expectedRole === "planner" || expectedRole === "reviewer" || expectedRole === "qa") && raw.readOnlyWorkspace === false) {
      return fail(validation("Reviewer/Planner/QA role must have readOnlyWorkspace: true"));
    }
    readOnlyWorkspace = raw.readOnlyWorkspace;
  } else {
    readOnlyWorkspace = expectedRole ? MVP_ROLE_PROFILES[expectedRole].readOnlyWorkspace : true;
  }

  if ("allowTaskDelegation" in raw && raw.allowTaskDelegation !== undefined) {
    if (typeof raw.allowTaskDelegation !== "boolean") {
      return fail(validation("Settings 'allowTaskDelegation' must be a boolean"));
    }
    if (raw.allowTaskDelegation === true) {
      return fail(validation("Agents are not allowed to delegate tasks outside workflow scope"));
    }
  }

  if ("requiresIndependentTestVerification" in raw && raw.requiresIndependentTestVerification !== undefined) {
    if (typeof raw.requiresIndependentTestVerification !== "boolean") {
      return fail(validation("Settings 'requiresIndependentTestVerification' must be a boolean"));
    }
    if (raw.requiresIndependentTestVerification === false) {
      return fail(validation("Independent test verification cannot be disabled"));
    }
  }

  let execution: RoleExecutionSettings | undefined;
  if ("execution" in raw && raw.execution !== undefined) {
    if (typeof raw.execution !== "object" || raw.execution === null || Array.isArray(raw.execution)) {
      return fail(validation("Settings 'execution' must be a non-null plain object"));
    }
    const rawExec = raw.execution as Record<string, unknown>;
    for (const key of Object.keys(rawExec)) {
      if (!ALLOWED_EXECUTION_KEYS.has(key)) {
        return fail(validation(`Unknown execution setting key: '${key}'`));
      }
    }

    const execResult: { paneId?: string; workspaceId?: string; tabId?: string; terminalId?: string; args?: readonly string[] } = {};
    const stringFields = ["paneId", "workspaceId", "tabId", "terminalId"] as const;
    for (const field of stringFields) {
      if (field in rawExec && rawExec[field] !== undefined) {
        const val = rawExec[field];
        if (typeof val !== "string" || val.trim().length === 0) {
          return fail(validation(`Execution '${field}' must be a non-empty string`));
        }
        execResult[field] = val.trim();
      }
    }

    if ("args" in rawExec && rawExec.args !== undefined) {
      const rawArgs = rawExec.args;
      if (!Array.isArray(rawArgs)) {
        return fail(validation("Execution 'args' must be an array of strings"));
      }
      for (const arg of rawArgs) {
        if (typeof arg !== "string" || arg.trim().length === 0 || arg.includes("\0")) {
          return fail(validation("Execution 'args' must contain non-empty strings with no NUL characters"));
        }
      }
      execResult.args = Object.freeze([...rawArgs]);
    }
    execution = Object.freeze(execResult);
  }

  return ok({
    provider,
    kind,
    ...(model !== undefined ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    readOnlyWorkspace,
    allowTaskDelegation: false as const,
    requiresIndependentTestVerification: true as const,
    ...(execution !== undefined ? { execution } : {})
  });
}

export interface CreateMvpRoleConfigInput {
  readonly agentId?: string;
  readonly role: MvpRole;
  readonly provider: string;
  readonly kind: string;
  readonly model?: string;
  readonly transport?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly maxConcurrentTasks?: number;
  readonly capabilities?: readonly string[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly execution?: RoleExecutionSettings;
  readonly metadata?: Record<string, JsonValue>;
}

export function createMvpRoleConfiguration(
  input: CreateMvpRoleConfigInput
): OperationResult<AgentConfiguration> {
  if (!isMvpRole(input.role)) {
    return fail(validation(`Invalid MVP role: ${String(input.role)}. Expected one of: ${MVP_ROLES.join(", ")}`));
  }

  if (typeof input.provider !== "string" || input.provider.trim().length === 0) {
    return fail(validation("Configuration 'provider' must be a non-empty trimmed string"));
  }
  if (typeof input.kind !== "string" || input.kind.trim().length === 0) {
    return fail(validation("Configuration 'kind' must be a non-empty trimmed string"));
  }

  const profile = MVP_ROLE_PROFILES[input.role];
  const agentId = input.agentId ?? `${input.role}-default`;
  const transport = input.transport ?? "herdr";
  const enabled = input.enabled ?? true;
  const priority = input.priority ?? 10;
  const maxConcurrentTasks = input.maxConcurrentTasks ?? 1;

  const idParsed = IdentifierSchema.safeParse(agentId);
  if (!idParsed.success) {
    return fail(validation(`Invalid agentId '${agentId}': ${idParsed.error.message}`));
  }

  const capabilities = input.capabilities
    ? [...new Set([...profile.defaultCapabilities, ...input.capabilities])]
    : [...profile.defaultCapabilities];

  const rawSettings: Record<string, unknown> = {
    provider: input.provider,
    kind: input.kind,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    readOnlyWorkspace: profile.readOnlyWorkspace,
    allowTaskDelegation: false,
    requiresIndependentTestVerification: true,
    ...(input.execution !== undefined ? { execution: input.execution } : {})
  };

  const settingsResult = parseRoleAgentSettings(rawSettings, input.role);
  if (!settingsResult.ok) {
    return settingsResult;
  }

  const candidate = {
    agentId,
    role: input.role,
    transport,
    enabled,
    priority,
    maxConcurrentTasks,
    capabilities,
    settings: settingsResult.value as unknown as JsonValue,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };

  const schemaParsed = AgentConfigurationSchema.safeParse(candidate);
  if (!schemaParsed.success) {
    return fail(validation(`Agent configuration schema validation failed: ${schemaParsed.error.message}`));
  }

  return ok(schemaParsed.data);
}

export type MvpRoleOverridesMap = Partial<
  Record<MvpRole, Partial<Omit<CreateMvpRoleConfigInput, "role">>>
>;

const DEFAULT_ROLE_SPECS: Readonly<Record<MvpRole, { provider: string; kind: string; model: string }>> = Object.freeze({
  planner: Object.freeze({ provider: "anthropic", kind: "claude-code", model: "claude-3-7-sonnet" }),
  developer: Object.freeze({ provider: "openai", kind: "codex", model: "gpt-4.1" }),
  reviewer: Object.freeze({ provider: "anthropic", kind: "claude-code", model: "claude-3-7-sonnet" }),
  qa: Object.freeze({ provider: "google", kind: "gemini-cli", model: "gemini-2.5-pro" })
});

export function createDefaultMvpConfigurations(
  overrides?: MvpRoleOverridesMap
): OperationResult<readonly AgentConfiguration[]> {
  const configs: AgentConfiguration[] = [];

  for (const role of MVP_ROLES) {
    const spec = DEFAULT_ROLE_SPECS[role];
    const roleOverride = overrides?.[role];

    const input: CreateMvpRoleConfigInput = {
      role,
      provider: roleOverride?.provider ?? spec.provider,
      kind: roleOverride?.kind ?? spec.kind,
      model: roleOverride?.model ?? spec.model,
      ...(roleOverride?.agentId !== undefined ? { agentId: roleOverride.agentId } : {}),
      ...(roleOverride?.transport !== undefined ? { transport: roleOverride.transport } : {}),
      ...(roleOverride?.enabled !== undefined ? { enabled: roleOverride.enabled } : {}),
      ...(roleOverride?.priority !== undefined ? { priority: roleOverride.priority } : {}),
      ...(roleOverride?.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: roleOverride.maxConcurrentTasks } : {}),
      ...(roleOverride?.capabilities !== undefined ? { capabilities: roleOverride.capabilities } : {}),
      ...(roleOverride?.temperature !== undefined ? { temperature: roleOverride.temperature } : {}),
      ...(roleOverride?.maxTokens !== undefined ? { maxTokens: roleOverride.maxTokens } : {}),
      ...(roleOverride?.execution !== undefined ? { execution: roleOverride.execution } : {}),
      ...(roleOverride?.metadata !== undefined ? { metadata: roleOverride.metadata } : {})
    };

    const result = createMvpRoleConfiguration(input);
    if (!result.ok) {
      return result;
    }
    configs.push(result.value);
  }

  return ok(Object.freeze(configs));
}

export async function seedMvpAgentRegistry(
  registry: AgentRegistry,
  overrides?: MvpRoleOverridesMap,
  options?: OperationOptions
): Promise<OperationResult<readonly AgentConfiguration[]>> {
  const configsResult = createDefaultMvpConfigurations(overrides);
  if (!configsResult.ok) {
    return configsResult;
  }

  for (const config of configsResult.value) {
    const upsertResult = await registry.upsert(config, options);
    if (!upsertResult.ok) {
      return upsertResult;
    }
  }

  return ok(configsResult.value);
}

export interface ResolvedMvpRoleAgent {
  readonly configuration: AgentConfiguration;
  readonly settings: RoleAgentSettings;
  readonly profile: MvpRoleProfile;
}

export async function resolveMvpRoleAgent(
  registry: AgentRegistry,
  role: MvpRole,
  context: AgentResolutionContext,
  options?: OperationOptions
): Promise<OperationResult<ResolvedMvpRoleAgent | null>> {
  if (!isMvpRole(role)) {
    return fail(validation(`Invalid MVP role: ${String(role)}`));
  }

  const contextParsed = AgentResolutionContextSchema.safeParse(context);
  if (!contextParsed.success) {
    return fail(validation(`Invalid agent resolution context: ${contextParsed.error.message}`));
  }

  const resolveResult = await registry.resolve(role, contextParsed.data, options);
  if (!resolveResult.ok) {
    return resolveResult;
  }
  if (!resolveResult.value) {
    return ok(null);
  }

  const settingsResult = parseRoleAgentSettings(resolveResult.value.settings, role);
  if (!settingsResult.ok) {
    return settingsResult;
  }

  const profile = getMvpRoleProfile(role);
  return ok({
    configuration: resolveResult.value,
    settings: settingsResult.value,
    profile
  });
}
