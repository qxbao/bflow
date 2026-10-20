import type { AgentRole, OperationOptions, OperationResult, SessionManifest } from "@bflow/contracts";
import { resolvePrivateRuntimeStateDirectory, type HostPrepareResponse, type HostRoleLaunch } from "@bflow/runtime";
import { resolve } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { EnvironmentCompositionInput, EnvironmentIntegration } from "./environment.js";
import { buildHostPlatformOptions, loadHostPlatformContext } from "./platform-options.js";
import { readGatewayReadiness } from "./gateway-readiness.js";

export type { HostPrepareResponse, HostRoleLaunch };

/** The persistent P19 host owns its scheduler, authenticated ingress and stores. */
export interface LifecycleHost {
  /** Parsed with `HostPrepareResponseSchema`; `platform.ready === false` means no pane may be started. */
  prepare(options?: OperationOptions): Promise<HostPrepareResponse>;
  activate(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<void>>;
  /** Optional private progressive check; older/mock hosts retain final activation only. */
  verifyRoleStartup?(manifest: SessionManifest, role: AgentRole, options?: OperationOptions): Promise<OperationResult<void>>;
  drainRoleStartup?(): Promise<OperationResult<void>>;
  readonly runtime: NonNullable<EnvironmentIntegration["runtime"]>;
  readonly quiesce: NonNullable<EnvironmentIntegration["quiesce"]>;
  readonly checkpoint: NonNullable<EnvironmentIntegration["checkpoint"]>;
  shutdown(): Promise<void>;
  /**
   * Force-only: stop the recorded host daemon when it cannot speak this CLI's protocol (for example a daemon
   * started from an older build). Durable stores are untouched, so the next `up` recovers from them.
   */
  terminateOwner?(): Promise<void>;
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

  // `.bflow/verification.json` is an optional owner override. When absent, [] is returned and Runtime detects the
  // repository's test runner itself (see docs/verification-runners.md); no user configuration is required.
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
    return activeHost ??= (async () => {
      const runtime = await loadRuntime();
      const behavioralCommands = await readOwnerBehavioralCommands(runtime);
      const context = await loadHostPlatformContext();
      const context7Ready = input.config.environment.context7?.enabled === true
        ? (await readGatewayReadiness(context.stateDirectory, "context7")).status === "ready" : undefined;
      const platform = await buildHostPlatformOptions(input, { context, context7Ready,
        warn: message => process.stderr.write(`Warning: ${message}\n`) });
      return runtime.ensureAgenticHost({
        repositoryPath: input.repository.root,
        sessionId: input.repository.sessionName,
        herdrBinary: input.config.environment.herdrBinary,
        manifestDirectory: resolve(input.repository.root, ".bflow/state/panes"),
        maxDeveloperCapacity: input.config.environment.concurrency.maxConcurrency,
        behavioralCommands,
        platform,
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
    const privateState = resolvePrivateRuntimeStateDirectory(input.repository.root);
    const hostConfigPath = resolve(privateState, "host", input.repository.sessionName, "host.json");
    const runStorePath = resolve(privateState, "agentic/runs.db");
    const hasHostConfig = await lstat(hostConfigPath).then(stat => stat.isFile(), () => false);
    const hasRunStore = await lstat(runStorePath).then(stat => stat.isFile(), () => false);
    if (!hasHostConfig && !hasRunStore) return null;

    activeHost = (async () => {
      const runtime = await loadRuntime();
      if (hasHostConfig) {
        return runtime.openPersistedAgenticHost({ repositoryPath: input.repository.root, sessionId: input.repository.sessionName });
      }
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
    return activeHost;
  };

  return {
    prepare: async options => {
      const prepared: unknown = await (await openForStartup()).prepare(options);
      const { HostPrepareResponseSchema } = await loadRuntime();
      return HostPrepareResponseSchema.parse(prepared);
    },
    activate: async (manifest, options) => (await openForStartup()).activate(manifest, options),
    verifyRoleStartup: async (manifest, role, options) => {
      const host = await openForStartup();
      return host.verifyRoleStartup ? host.verifyRoleStartup(manifest, role, options) : { ok: true, value: undefined };
    },
    drainRoleStartup: async () => {
      const host = await openExistingIfPresent();
      return host?.drainRoleStartup ? host.drainRoleStartup() : { ok: true, value: undefined };
    },
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
    terminateOwner: async () => {
      const directory = resolve(resolvePrivateRuntimeStateDirectory(input.repository.root), "host", input.repository.sessionName);
      await terminateHostOwner(directory);
    },
    close: async () => {
      if (activeHost) await (await activeHost).close();
    }
  };
};

const sleep = (ms: number) => new Promise(accept => setTimeout(accept, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
const commandLine = (pid: number) => new Promise<string>(accept => execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => accept(error ? "" : stdout.trim())));

/**
 * Stops the daemon recorded in `owner.json`. The pid is only signalled when its live command line is this
 * repository session's `host.js daemon <host.json>`, so a recycled pid is never killed.
 */
export async function terminateHostOwner(directory: string): Promise<void> {
  let pid: unknown;
  try { pid = (JSON.parse(await readFile(resolve(directory, "owner.json"), "utf8")) as { pid?: unknown }).pid; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) throw new Error("Host owner receipt has no valid pid; preserve state and inspect bflow doctor");
  const target = Number(pid);
  if (!alive(target)) return;
  const command = await commandLine(target);
  if (!command.includes("host.js") || !command.includes("daemon") || !command.includes(resolve(directory, "host.json")))
    throw new Error(`Process ${target} is not this session's Bflow host; refusing to signal it`);
  process.kill(target, "SIGTERM");
  for (let waited = 0; waited < 5000 && alive(target); waited += 100) await sleep(100);
  if (alive(target)) {
    process.kill(target, "SIGKILL");
    for (let waited = 0; waited < 2000 && alive(target); waited += 100) await sleep(100);
    if (alive(target)) throw new Error(`Host process ${target} did not exit; state was preserved`);
  }
}

/** Legacy prompt-injection path for hosts that return no v3 `launch` profile. Platform-prepared roles never reach it. */
export async function providerRoleArguments(kind: string, role: string, launch: HostRoleLaunch): Promise<readonly string[]> {
  if (kind !== "claude" && kind !== "codex") throw new Error(`Agentic provider '${kind}' is unsupported; select claude or codex.`);
  const panes = await import(new URL("../../../packages/pane-manager/dist/index.js", import.meta.url).href);
  if (typeof panes.buildProviderRoleLaunchFromFiles !== "function") throw new Error("Installed Pane Manager has no trusted provider launch API; rebuild all workspace packages.");
  return panes.buildProviderRoleLaunchFromFiles({ agentKind: kind, role, systemPrompt: launch.systemPrompt,
    mcpConfigFile: launch.mcpConfigFile, hooksSettingsFile: launch.hooksSettingsFile });
}
