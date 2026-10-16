import type { OperationOptions, OperationResult, SessionManifest } from "@bflow/contracts";
import { resolve } from "node:path";
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
  if (input.config.environment.roles.some(role => role.cli !== "claude")) {
    throw new Error("The default Agentic host currently requires Claude native hooks. Initialize with --provider claude or supply a verified provider host through BFLOW_ENVIRONMENT_MODULE.");
  }
  // Use the installed sibling package entrypoint, as the existing Runtime's
  // concrete workspace composition does. No repository module is executed.
  const runtime = await import(new URL("../../../packages/runtime/dist/index.js", import.meta.url).href);
  if (typeof runtime.ensureAgenticHost !== "function") throw new Error("Installed Runtime has no persistent Agentic host API; rebuild all workspace packages.");
  return runtime.ensureAgenticHost({ repositoryPath: input.repository.root,
    sessionId: input.repository.sessionName, herdrBinary: input.config.environment.herdrBinary,
    manifestDirectory: resolve(input.repository.root, ".bflow/state/panes"),
    maxDeveloperCapacity: input.config.environment.concurrency.maxConcurrency,
    policy: { sdd: input.config.environment.sdd, tdd: input.config.environment.tdd,
      verification: input.config.environment.verification, concurrency: input.config.environment.concurrency }
  });
};

export async function providerRoleArguments(kind: string, role: string, launch: HostRoleLaunch): Promise<readonly string[]> {
  if (kind !== "claude" && kind !== "codex") throw new Error(`Agentic provider '${kind}' is unsupported; select claude or codex.`);
  const panes = await import(new URL("../../../packages/pane-manager/dist/index.js", import.meta.url).href);
  if (typeof panes.buildProviderRoleLaunchFromFiles !== "function") throw new Error("Installed Pane Manager has no trusted provider launch API; rebuild all workspace packages.");
  return panes.buildProviderRoleLaunchFromFiles({ agentKind: kind, role, ...launch });
}
