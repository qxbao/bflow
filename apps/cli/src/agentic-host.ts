import type { OperationOptions, OperationResult, SessionManifest } from "@bflow/contracts";
import { resolve } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import type { EnvironmentCompositionInput, EnvironmentIntegration } from "./environment.js";

export interface HostRoleLaunch {
  readonly systemPrompt: string;
  readonly mcpConfigFile: string;
  readonly hooksSettingsFile: string;
}
/** The persistent P19 host owns its scheduler, authenticated ingress and stores. */
export interface LifecycleHost {
  prepare(): Promise<{ roleLaunch: Record<string, HostRoleLaunch> }>;
  activate(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<void>>;
  readonly runtime: NonNullable<EnvironmentIntegration["runtime"]>;
  readonly quiesce: NonNullable<EnvironmentIntegration["quiesce"]>;
  readonly checkpoint: NonNullable<EnvironmentIntegration["checkpoint"]>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
}
export type LifecycleHostFactory = (input: EnvironmentCompositionInput) => Promise<LifecycleHost>;

export const openLifecycleHost: LifecycleHostFactory = async input => {
  let activeHost: Promise<LifecycleHost> | undefined;

  const loadRuntime = async () => {
    // Use the installed sibling package entrypoint, as the existing Runtime's
    // concrete workspace composition does. No repository module is executed.
    const runtime = await import(new URL("../../../packages/runtime/dist/index.js", import.meta.url).href);
    if (typeof runtime.ensureAgenticHost !== "function") {
      throw new Error("Installed Runtime has no persistent Agentic host API; rebuild all workspace packages.");
    }
    return runtime;
  };

  const readOwnerBehavioralCommands = async (runtime: Awaited<ReturnType<typeof loadRuntime>>) => {
    const verificationPath = resolve(input.repository.root, ".bflow/verification.json");
    try {
      if (!(await lstat(verificationPath)).isFile() || await realpath(verificationPath) !== verificationPath)
        throw new Error("Owner verification configuration must be a regular file inside this repository");
      const value: unknown = JSON.parse(await readFile(verificationPath, "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value) || !("schemaVersion" in value) || value.schemaVersion !== 1 ||
          !("behavioralCommands" in value) || Object.keys(value).some(key => key !== "schemaVersion" && key !== "behavioralCommands"))
        throw new Error("Invalid owner verification configuration (expected schemaVersion:1 and behavioralCommands)");
      return runtime.parseBehavioralCommands(value.behavioralCommands);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  };

  const openForStartup = (): Promise<LifecycleHost> => {
    if (input.config.environment.roles.some(role => role.cli !== "claude")) {
      return Promise.reject(new Error("The default Agentic host currently requires Claude native hooks. Initialize with --provider claude or supply a verified provider host through BFLOW_ENVIRONMENT_MODULE."));
    }
    return activeHost ??= (async () => {
      const runtime = await loadRuntime();
      const behavioralCommands = await readOwnerBehavioralCommands(runtime);
      return runtime.ensureAgenticHost({
        repositoryPath: input.repository.root,
        sessionId: input.repository.sessionName,
        herdrBinary: input.config.environment.herdrBinary,
        manifestDirectory: resolve(input.repository.root, ".bflow/state/panes"),
        maxDeveloperCapacity: input.config.environment.concurrency.maxConcurrency,
        behavioralCommands,
        policy: {
          sdd: input.config.environment.sdd,
          tdd: input.config.environment.tdd,
          verification: input.config.environment.verification,
          concurrency: input.config.environment.concurrency
        }
      });
    })();
  };

  const openExistingIfPresent = async (): Promise<LifecycleHost | null> => {
    if (activeHost) return activeHost;
    const hostConfigPath = resolve(input.repository.root, ".bflow/state/host", input.repository.sessionName, "host.json");
    const runStorePath = resolve(input.repository.root, ".bflow/state/agentic/runs.db");
    const hasHostConfig = await lstat(hostConfigPath).then(stat => stat.isFile(), () => false);
    const hasRunStore = await lstat(runStorePath).then(stat => stat.isFile(), () => false);
    if (!hasHostConfig && !hasRunStore) return null;

    activeHost = (async () => {
      const runtime = await loadRuntime();
      let behavioralCommands = [];
      if (hasHostConfig) {
        try {
          const persisted: unknown = JSON.parse(await readFile(hostConfigPath, "utf8"));
          if (persisted !== null && typeof persisted === "object" && !Array.isArray(persisted) && "behavioralCommands" in persisted) {
            behavioralCommands = runtime.parseBehavioralCommands(persisted.behavioralCommands);
          }
        } catch {
          behavioralCommands = await readOwnerBehavioralCommands(runtime);
        }
      } else {
        behavioralCommands = await readOwnerBehavioralCommands(runtime);
      }
      return runtime.ensureAgenticHost({
        repositoryPath: input.repository.root,
        sessionId: input.repository.sessionName,
        herdrBinary: input.config.environment.herdrBinary,
        manifestDirectory: resolve(input.repository.root, ".bflow/state/panes"),
        maxDeveloperCapacity: input.config.environment.concurrency.maxConcurrency,
        behavioralCommands,
        ...(hasHostConfig ? {} : {
          policy: {
            sdd: input.config.environment.sdd,
            tdd: input.config.environment.tdd,
            verification: input.config.environment.verification,
            concurrency: input.config.environment.concurrency
          }
        })
      });
    })();
    return activeHost;
  };

  return {
    prepare: async () => (await openForStartup()).prepare(),
    activate: async (manifest, options) => (await openForStartup()).activate(manifest, options),
    runtime: {
      findRuns: async (query, options) => {
        const existing = await openExistingIfPresent();
        if (!existing) return { ok: true, value: { items: [] } };
        return existing.runtime.findRuns(query, options);
      },
      getRun: async (runId, options) => {
        const existing = await openExistingIfPresent();
        if (!existing) return { ok: true, value: null };
        return existing.runtime.getRun(runId, options);
      }
    },
    quiesce: async options => {
      const existing = await openExistingIfPresent();
      if (!existing) return { ok: true, value: undefined };
      return existing.quiesce(options);
    },
    checkpoint: async (command, options) => {
      const existing = await openExistingIfPresent();
      if (!existing) {
        return {
          ok: false,
          error: { code: "not_found", retryable: false, message: "No persistent Agentic host or run store exists to checkpoint." }
        };
      }
      return existing.checkpoint(command, options);
    },
    shutdown: async () => {
      const existing = await openExistingIfPresent();
      if (existing) await existing.shutdown();
    },
    close: async () => {
      if (activeHost) await (await activeHost).close();
    }
  };
};

export async function providerRoleArguments(kind: string, role: string, launch: HostRoleLaunch): Promise<readonly string[]> {
  if (kind !== "claude" && kind !== "codex") throw new Error(`Agentic provider '${kind}' is unsupported; select claude or codex.`);
  const panes = await import(new URL("../../../packages/pane-manager/dist/index.js", import.meta.url).href);
  if (typeof panes.buildProviderRoleLaunchFromFiles !== "function") throw new Error("Installed Pane Manager has no trusted provider launch API; rebuild all workspace packages.");
  return panes.buildProviderRoleLaunchFromFiles({ agentKind: kind, role, ...launch });
}
