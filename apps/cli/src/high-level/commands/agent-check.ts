import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_ROLES,
  AgentEnvironmentSchema,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type AgentEnvironment,
  type AgentProviderId,
  type JsonValue
} from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import { HIGH_LEVEL_EXIT_CODES, HighLevelError, usageError, validationError } from "../envelope.js";
import { CLI_STATE_DIRECTORY, guarded, requireRepository, StepLog, type HighLevelHandler } from "../context.js";
import { PROVIDERS } from "./skills-sync.js";

export const AGENT_CHECK_SPEC: CommandSpec = {
  name: "agent.check",
  behavior: { summary: "Preflight provider health and readiness without launching it", mutates: "none", retry: "read_only", permissionFlags: [], outcomes: ["ready", "not_ready", "failed"] },
  words: ["agent", "check"],
  positionals: [{ name: "provider", required: true }],
  flags: {
    "--role": { type: "string", choices: AGENT_ROLES.filter(role => role !== "conversation") },
    "--mode": { type: "string", choices: ["restricted", "workspace_auto"] },
    "--session": { type: "string" }
  }
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Preflight provider health/readiness through the P25 adapter registry; never launches the provider. */
export const agentCheck: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("agent.check", log, {}, async () => {
    const provider = args.positionals.provider!;
    if (!(PROVIDERS as readonly string[]).includes(provider))
      throw new HighLevelError(usageError(`Unknown provider '${provider}'. Use one of: ${PROVIDERS.join(", ")}`));
    const role = (args.strings.get("--role") ?? "developer") as AgentEnvironment["role"];
    const mode = (args.strings.get("--mode") ?? "restricted") as "restricted" | "workspace_auto";
    const repository = await requireRepository(ctx.cwd);
    const platform = await ctx.services.machine.platform();
    const environment = await log.check("build-environment", async () => {
      const sessionId = args.strings.get("--session") ?? `check-${sha256(`${repository.id}\0${provider}\0${role}`).slice(0, 16)}`;
      const stateDirectory = join(repository.root, CLI_STATE_DIRECTORY, "providers", provider);
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const scope = { kind: "session" as const, machineId: platform.machineId, repositoryId: repository.id,
        workspaceRoot: repository.root, sessionId };
      const parsed = AgentEnvironmentSchema.safeParse({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        environmentId: `env-${provider}-${role}-${sessionId}`,
        provider: provider as AgentProviderId,
        role,
        scope,
        cwd: repository.root,
        stateDirectory,
        configFingerprint: sha256(JSON.stringify([provider, role, mode, repository.root, platform.machineId])),
        permissionProfile: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          profileId: `cli-check-${mode}`,
          mode,
          scope,
          filesystem: mode === "restricted" ? "read_only" : "workspace_write",
          readableRoots: [repository.root],
          writableRoots: mode === "restricted" ? [] : [repository.root],
          deniedRoots: [join(repository.root, ".bflow", "state")],
          isolation: "provider_policy",
          network: { mode: "deny", allowedHosts: [] },
          allowedTools: [],
          deniedAction: "request_via_conversation",
          allowGlobalPermissionBypass: false
        },
        environmentVariables: {},
        secretBindings: {},
        requiredCapabilityIds: [],
        requiredMcpServiceIds: [],
        skillManifestDigest: sha256("")
      });
      if (!parsed.success)
        throw new HighLevelError(validationError(`Cannot build provider environment: ${parsed.error.issues.map(i => i.message).join("; ")}`,
          { reason: "invalid_environment" }));
      return parsed.data;
    }, value => ({ environmentId: value.environmentId, role: value.role, mode: value.permissionProfile.mode }));

    const health = await log.check("preflight-health", async () => {
      const result = await ctx.services.providers.checkHealth({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION, environment, stage: "preflight", requestedAt: ctx.clock().toISOString()
      }, ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
      if (!result.ok) throw new HighLevelError(result.error);
      return result.value;
    }, value => ({ status: value.status, failed: value.checks.filter(c => c.status !== "passed").map(c => c.check) }));

    const ready = health.status === "ready";
    const data: JsonValue = JSON.parse(JSON.stringify({
      provider, role, stage: health.stage, status: health.status, ready,
      validUntil: health.validUntil,
      checks: health.checks,
      // Preflight readiness is not activated readiness; `bflow up` requires an authenticated launch attestation.
      note: "Preflight only: activated readiness requires a launch attestation from the running pane"
    })) as JsonValue;
    return {
      command: "agent.check", outcome: ready ? "ready" : "not_ready", status: "succeeded",
      exitCode: ready ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY, steps: log.steps, data
    };
  });
};
