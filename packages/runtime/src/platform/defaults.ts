import { join } from "node:path";
import type { AgentProviderId, AgentRole } from "@bflow/contracts";
import {
  AgyProviderAdapter,
  ClaudeProviderAdapter,
  CodexProviderAdapter,
  type ProviderAdapterOptions,
  type ProviderCommandRunner
} from "@bflow/agent-providers";
import type { SkillManager } from "@bflow/skills";
import { RoleEnvironmentResolver } from "./environment.js";
import { FileLaunchJournal } from "./launch-journal.js";
import { GatewayRegistrationManager } from "./gateway-registrations.js";
import { ProviderReadiness } from "./provider-readiness.js";
import { SkillSessionStore } from "./skills-session.js";
import { DefaultPlatformReadinessService } from "./service.js";
import type {
  GatewayControlPort,
  HostLaunchExtras,
  LaunchAttestationSigner,
  ProviderAdapterFactory,
  SkillResolverPort
} from "./ports.js";

export interface ProviderAdapterFactoryOptions {
  readonly runner?: ProviderCommandRunner;
  readonly now?: () => Date;
  /** Constructor-scoped options per provider (executable paths, pins, version floors). */
  readonly perProvider?: Partial<Record<AgentProviderId, ProviderAdapterOptions>>;
}

/**
 * Builds real provider adapters bound to one role launch context. Context fields always win over
 * per-provider defaults so a launch cannot inherit another role's prompt, Gateway access or skills.
 */
export function createProviderAdapterFactory(options: ProviderAdapterFactoryOptions = {}): ProviderAdapterFactory {
  return (provider, context) => {
    const adapterOptions: ProviderAdapterOptions = {
      ...(options.runner !== undefined ? { runner: options.runner } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...options.perProvider?.[provider],
      ...(context.rolePrompt !== undefined ? { rolePrompt: context.rolePrompt } : {}),
      ...(context.model !== undefined ? { model: context.model } : {}),
      ...(context.effort !== undefined ? { effort: context.effort } : {}),
      mcpRegistrations: [...context.mcpRegistrations],
      mcpObservations: [...context.mcpObservations],
      skillManifest: context.skillManifest,
      renderedSkillsContent: context.renderedSkillsContent,
      ...(context.nativeSessionHookCommand !== undefined
        ? { nativeSessionHookCommand: context.nativeSessionHookCommand }
        : {}),
      trustedIssuerKeys: { ...context.trustedIssuerKeys },
      ...(context.liveObservation !== undefined ? { liveObservation: context.liveObservation } : {}),
      ...(context.hostMcpServers !== undefined ? { hostMcpServers: context.hostMcpServers } : {}),
      ...(context.hostHooks !== undefined ? { hostHooks: context.hostHooks } : {}),
      ...(context.mcpTokenEnvironmentNames !== undefined ? { mcpTokenEnvironmentNames: context.mcpTokenEnvironmentNames } : {})
    };
    switch (provider) {
      case "claude":
        return new ClaudeProviderAdapter(adapterOptions);
      case "codex":
        return new CodexProviderAdapter(adapterOptions);
      case "agy":
        return new AgyProviderAdapter(adapterOptions);
    }
  };
}

/** Structural pass-through over the `@bflow/skills` manager; arrow members keep `this` bound. */
export function createSkillResolver(manager: SkillManager): SkillResolverPort {
  return {
    resolve: request => manager.resolve(request),
    sync: request => manager.sync(request),
    verify: manifest => manager.verify(manifest),
    link: manifest => manager.link(manifest),
    recover: digest => manager.recover(digest)
  } satisfies SkillResolverPort;
}

export interface PlatformReadinessServiceOptions {
  /** Host-owned state root; the launch journal lives directly under it. */
  readonly stateDirectory: string;
  readonly skillManager: SkillManager;
  readonly gatewayControl?: GatewayControlPort | undefined;
  readonly gatewayEndpoint?: string | undefined;
  readonly signer: LaunchAttestationSigner;
  readonly providerFactory?: ProviderAdapterFactory | undefined;
  readonly now?: (() => Date) | undefined;
  readonly rolePrompt?: ((role: AgentRole) => string | undefined) | undefined;
  readonly nativeSessionHookCommand?: ((role: AgentRole, taskId?: string) => string | undefined) | undefined;
  readonly hostLaunch?: ((role: AgentRole, taskId?: string) => HostLaunchExtras | undefined) | undefined;
}

/** Wires the P30 readiness components together with the real implementations. */
export function createPlatformReadinessService(options: PlatformReadinessServiceOptions): DefaultPlatformReadinessService {
  const now = options.now;
  const journal = new FileLaunchJournal(join(options.stateDirectory, "launch-journal.jsonl"));
  const providers = new ProviderReadiness({
    factory: options.providerFactory ?? createProviderAdapterFactory({ ...(now ? { now } : {}) }),
    journal,
    ...(now ? { now } : {})
  });
  const gateway = options.gatewayControl && options.gatewayEndpoint !== undefined
    ? new GatewayRegistrationManager({
        control: options.gatewayControl,
        endpoint: options.gatewayEndpoint,
        ...(now ? { now } : {})
      })
    : undefined;
  return new DefaultPlatformReadinessService({
    environments: new RoleEnvironmentResolver(),
    skills: new SkillSessionStore({ resolver: createSkillResolver(options.skillManager) }),
    ...(gateway ? { gateway } : {}),
    providers,
    journal,
    signer: options.signer,
    rolePrompt: options.rolePrompt,
    nativeSessionHookCommand: options.nativeSessionHookCommand,
    hostLaunch: options.hostLaunch,
    now
  });
}
