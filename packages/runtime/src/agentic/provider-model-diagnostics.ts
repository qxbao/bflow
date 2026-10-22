import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentHealthRequestSchema, AgentHealthResultSchema, SkillManifestSchema, canonicalReceiptJson,
  type OperationOptions
} from "@bflow/contracts";
import { scrubDiagnosticText } from "@bflow/agent-providers";
import { createProviderAdapterFactory, type ProviderAdapterFactoryOptions } from "../platform/defaults.js";
import { IsolatorProfileResolver, type IsolatorProfileResolverPort } from "../platform/isolator-profile.js";
import { RoleEnvironmentResolver } from "../platform/environment.js";
import { AgenticHostPlatformOptionsSchema, RolePreflightSummarySchema, type AgenticHostPlatformOptions } from "../platform/host-options.js";
import { createHostProviderFactoryOptions, requirementFor } from "./host-platform.js";

export interface ProviderModelDiagnosticsInput {
  readonly platform: AgenticHostPlatformOptions;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Explicit inference diagnostic. Never prepares launches, grants Gateway access, or changes session readiness. */
export async function probeConfiguredProviderModels(
  input: ProviderModelDiagnosticsInput, operation?: OperationOptions,
  deps: { readonly factoryOptions?: ProviderAdapterFactoryOptions; readonly profiles?: IsolatorProfileResolverPort } = {}
): Promise<readonly ReturnType<typeof RolePreflightSummarySchema.parse>[]> {
  const platform = AgenticHostPlatformOptionsSchema.parse(input.platform);
  const workspaceRoot = await realpath(input.workspaceRoot);
  const environment = input.environment ?? process.env;
  const trusted = createHostProviderFactoryOptions(platform, environment);
  const factory = createProviderAdapterFactory({
    ...deps.factoryOptions,
    perProvider: {
      ...deps.factoryOptions?.perProvider,
      codex: { ...deps.factoryOptions?.perProvider?.codex, ...trusted.perProvider.codex, executionProbe: "required" },
      claude: { ...deps.factoryOptions?.perProvider?.claude, executionProbe: "required" },
      agy: { ...deps.factoryOptions?.perProvider?.agy, executionProbe: "required" }
    }
  });
  const profiles = deps.profiles ?? new IsolatorProfileResolver({ environment,
    ...(platform.isolatorStateRoot === undefined ? {} : { stateRoot: platform.isolatorStateRoot }) });
  const seen = new Set<string>();
  const results: ReturnType<typeof RolePreflightSummarySchema.parse>[] = [];
  const stateDirectory = await realpath(await mkdtemp(join(tmpdir(), "bflow-model-check-")));
  try {
    for (const role of platform.roles) {
      if (!role.required) continue;
      const key = canonicalReceiptJson({ provider: role.provider, profile: role.profileName ?? null,
        model: role.model ?? null, effort: role.effort ?? null, environment: role.environmentVariables ?? {} });
      if (seen.has(key)) continue;
      seen.add(key);
      const base = { role: role.role, provider: role.provider, required: true };
      try {
        if (operation?.signal?.aborted) throw new Error("Model diagnostic cancelled");
        const selected = role.profileName === undefined ? undefined : await profiles.resolve(role.provider, role.profileName, operation);
        if (selected !== undefined && !selected.ok) throw new Error(selected.error.message);
        const profile = selected?.ok ? selected.value : undefined;
        const identity = { machineId: platform.machineId, repositoryId: platform.repositoryId, workspaceRoot,
          sessionId: input.sessionId, generation: 1, stateDirectory };
        const resolved = new RoleEnvironmentResolver().resolve(identity, {
          ...requirementFor(role, {}, workspaceRoot), permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [],
          toolIds: [], skillSelections: []
        }, { skillManifestDigest: "0".repeat(64) });
        if (!resolved.ok) throw new Error(resolved.error.message);
        const agentEnvironment = resolved.value;
        await mkdir(agentEnvironment.stateDirectory, { recursive: true, mode: 0o700 });
        const skillManifest = SkillManifestSchema.parse({ schemaVersion: 3, manifestId: "model-diagnostic",
          environmentId: agentEnvironment.environmentId, scope: agentEnvironment.scope, role: role.role, provider: role.provider,
          digest: agentEnvironment.skillManifestDigest, skills: [], bindings: [] });
        const options = { timeoutMs: 75_000, ...operation };
        const adapter = factory(role.provider, {
          ...(role.model === undefined ? {} : { model: role.model }),
          ...(role.effort === undefined ? {} : { effort: role.effort }),
          ...(profile === undefined ? {} : { isolatorEnvironment: profile.environment }),
          ...(profile?.backendUrl === undefined ? {} : { codexBackendUrl: profile.backendUrl }),
          mcpRegistrations: [], mcpObservations: [], skillManifest, renderedSkillsContent: "", trustedIssuerKeys: {}
        }, options);
        const outcome = await adapter.checkHealth(AgentHealthRequestSchema.parse({
          schemaVersion: 3, stage: "preflight", environment: agentEnvironment, requestedAt: new Date().toISOString()
        }), options);
        if (!outcome.ok) throw new Error(outcome.error.message);
        const health = AgentHealthResultSchema.parse(outcome.value);
        // These are model diagnostics, never substitute readiness for permissions, skills, MCP or native binding.
        const checks = health.checks.filter(check => ["binary", "version", "authentication"].includes(check.check));
        const ready = checks.length === 3 && checks.every(check => check.status === "passed") &&
          checks.some(check => check.check === "authentication" && check.code === "auth_ok");
        results.push(RolePreflightSummarySchema.parse({ ...base, status: ready ? "ready" : "blocked", checks,
          message: `Model execution ${ready ? "verified" : "failed"} (profile ${role.profileName ?? "default"}, model ${role.model ?? "default"}); inference usage may be charged.` }));
      } catch (error) {
        results.push(RolePreflightSummarySchema.parse({ ...base, status: "error", checks: [],
          message: scrubDiagnosticText(error instanceof Error ? error.message : String(error)) }));
      }
    }
    return results;
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
}
