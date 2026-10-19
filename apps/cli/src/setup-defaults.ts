import { delimiter, dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { OperationResult, ToolInstallRequest, ToolInstaller } from "@bflow/contracts";
import { MachineConfigSchema, TOOL_CATALOG, ToolInstallerRegistry, defaultMachineConfig, findExecutable,
  type MachineConfig, type PlatformProfile, type ToolObservation } from "@bflow/machine-setup";

export interface DefaultSetupInventory {
  toolId: string;
  status: "pinned" | "operator_configured" | "manual";
  version?: string;
  executable?: string;
  diagnostic: string;
  documentation?: string;
}
export interface DefaultSetupLaunchRequirement {
  toolId: "gitnexus" | "chrome-devtools-mcp";
  executable: string;
  args: string[];
  requirements: string[];
}

/** Read-only composition of the reviewed catalog and machine preferences.
 * Does not install software, start services, connect MCP, write native provider settings or log in. */
/** Provider configuration confined under an isolated root (BFLOW_HOME / setup isolatedRoot). Agy has no
 * documented configuration-directory variable, so it is intentionally absent and native activation is deferred. */
export interface IsolatedProviderHomes {
  homeDirectory: string;
  claudeConfigDir?: string;
  codexHome?: string;
}
export function isolatedProviderHomes(isolatedRoot: string): IsolatedProviderHomes {
  const providers = resolve(isolatedRoot, "providers");
  return { homeDirectory: join(providers, "home"), claudeConfigDir: join(providers, "claude"), codexHome: join(providers, "codex") };
}

export async function createDefaultSetupConfiguration(options: {
  platform: PlatformProfile;
  config?: MachineConfig;
  registry?: ToolInstallerRegistry;
  projectRoot?: string;
  isolation?: IsolatedProviderHomes;
}): Promise<{ config: MachineConfig; registry: ToolInstallerRegistry; diagnostics: string[];
  inventory: DefaultSetupInventory[]; launchRequirements: DefaultSetupLaunchRequirement[];
  additionalToolObservations: (platform: PlatformProfile, config: MachineConfig) => Promise<ToolObservation[]> }> {
  const { platform } = options;
  const config = MachineConfigSchema.parse(options.config ?? {
    ...defaultMachineConfig(), providers: ["claude", "codex", "agy"]
  });
  const registry = options.registry ?? new ToolInstallerRegistry();
  const leaf = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
  const catalog = leaf.defaultToolCatalog(platform.os, platform.arch);
  const nativeSupported = (platform.os === "linux" || platform.os === "darwin") && ["x64", "arm64"].includes(platform.arch) && config.providers.length > 0;
  const nativePins = nativeSupported ? leaf.defaultNativeToolPins() : [];
  const manual: { toolId: string; diagnostic: string; documentation: string }[] = catalog.manual
    .filter((item: { toolId: string }) => !nativePins.some((pin: { toolId: string }) => pin.toolId === item.toolId));
  const installer: ToolInstaller = new leaf.ManagedToolInstaller({ managedRoot: join(platform.paths.data, "tools"), pins: catalog.pins });
  if (catalog.pins.length > 0 && !registry.get(installer.installerId)) {
    const registration = registry.register(installer);
    if (!registration.ok) throw new Error(registration.error.message);
  }
  const explicitTools = new Set(config.toolPins.map(pin => pin.toolId));
  const providerExecutables: Partial<Record<"claude" | "codex" | "agy", string>> = {};
  for (const provider of config.providers) {
    const catalogEntry = TOOL_CATALOG.find(entry => entry.toolId === provider);
    const directories = [...platform.pathEntries, ...(catalogEntry?.knownInstallDirs(platform) ?? [])];
    const nodePlatform = platform.os === "other" ? "linux" : platform.os;
    const executable = await findExecutable(provider, directories, nodePlatform);
    if (executable) providerExecutables[provider] = executable;
    providerExecutables[provider] ??= join(platform.paths.data, "tools", provider,
      provider === "agy" ? "agy" : join("node_modules", ".bin", provider));
  }
  const nativePath = [...new Set([...platform.pathEntries, ...Object.values(providerExecutables).map(path => dirname(path))])].join(delimiter);
  const nativeHost = { ...leaf.systemToolHost,
    run: (executable: string, args: readonly string[], runOptions?: { environment?: Readonly<Record<string, string>> }) =>
      leaf.systemToolHost.run(executable, args, { ...runOptions, environment: { ...runOptions?.environment, PATH: nativePath } }) };
  const nativeInspectors = new Map<string, { inspect(request: ToolInstallRequest): Promise<OperationResult<{ status: string; diagnostics: string[] }>> }>();
  for (const pin of nativePins) {
    const nativeInstaller = new leaf.NativeProvidersToolInstaller({ managedRoot: join(platform.paths.data, "tools"),
      pin, providers: config.providers, host: nativeHost,
      configuration: { homeDirectory: options.isolation?.homeDirectory ?? platform.homeDir,
        ...(options.isolation ? { isolation: { ...options.isolation } } : {}), executables: providerExecutables } });
    nativeInspectors.set(nativeInstaller.installerId, nativeInstaller);
    if (!registry.get(nativeInstaller.installerId)) {
      const registration = registry.register(nativeInstaller);
      if (!registration.ok) throw Error(registration.error.message);
    }
  }
  const allPins = [...catalog.pins, ...nativePins];
  const descriptors = allPins.filter((pin: { toolId: string }) => !explicitTools.has(pin.toolId))
    .map((pin: { toolId: string; installerId: string; version: string; source: string; integrity: string; recipe: { kind: string } }) => ({
      schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
      method: pin.recipe.kind === "npm" ? "npm" : "verified_archive", version: pin.version,
      source: pin.source, integrity: pin.integrity, platforms: [platform.os], requiresElevation: false
    }));
  const merged = MachineConfigSchema.parse({ ...config, toolPins: [...config.toolPins, ...descriptors] });
  const inventory: DefaultSetupInventory[] = merged.toolPins.map(pin => {
    const builtIn = catalog.pins.find((candidate: { toolId: string; installerId: string; version: string; integrity: string; source: string }) =>
      candidate.toolId === pin.toolId && candidate.installerId === pin.installerId && candidate.version === pin.version &&
      candidate.integrity === pin.integrity && candidate.source === pin.source);
    return { toolId: pin.toolId, status: explicitTools.has(pin.toolId) ? "operator_configured" : "pinned", version: pin.version,
      ...(builtIn ? { executable: (pin.toolId === "claude" || pin.toolId === "codex" || pin.toolId === "agy") && providerExecutables[pin.toolId]
        ? providerExecutables[pin.toolId]
        : join(platform.paths.data, "tools", pin.toolId, leaf.managedToolExecutable(builtIn)) } : {}),
      diagnostic: "Installation requires the approved machine setup plan. Binary presence does not prove provider authentication, native plugin activation or MCP readiness." };
  });
  for (const pin of nativePins) {
    const entry = inventory.find(item => item.toolId === pin.toolId);
    if (entry) entry.diagnostic = `Native installation for ${config.providers.join(", ")} through each provider's documented CLI, with policy-preserving Bflow namespace and exact active-cache/worker probes. Approval includes the provider's native configuration changes. Interrupted native delivery remains unknown and is never replayed automatically.`;
  }
  inventory.push(...manual.map(item => ({ ...item, status: "manual" as const })));
  const diagnostics = manual.map(item => `${item.toolId}: ${item.diagnostic} ${item.documentation}`);
  diagnostics.push("claude/codex/agy: Complete each selected provider's own login flow; setup does not create credentials or widen permissions.");
  diagnostics.push("GitNexus 1.6.12 uses PolyForm-Noncommercial-1.0.0; review eligibility or obtain the upstream commercial license before approving installation. Its npm native dependency build scripts execute during the approved install.");
  diagnostics.push("Pinned npm entry tarballs are checksum-verified; transitive npm dependencies are resolved by npm and are not a fully locked offline dependency bundle.");
  const launchRequirements: DefaultSetupLaunchRequirement[] = [];
  for (const toolId of ["gitnexus", "chrome-devtools-mcp"] as const) {
    const entry = inventory.find(item => item.toolId === toolId);
    if (!entry?.executable) continue;
    launchRequirements.push({ toolId, executable: entry.executable,
      args: toolId === "gitnexus" ? ["mcp"] : ["--no-usage-statistics", "--no-performance-crux"],
      requirements: toolId === "gitnexus"
        ? ["Gateway scoped registration and MCP initialize/tools/list verification", "Verified repository index, allowed repository paths and a single index writer", "Node ^22.18.0 or >=24.11.0 for the selected upstream release"]
        : ["Gateway scoped registration and MCP initialize/tools/list verification", "Verified Chrome executable, Bflow-owned per-task userDataDir and exclusive browser resource lease"] });
  }
  const additionalToolObservations = async (currentPlatform: PlatformProfile, currentConfig: MachineConfig): Promise<ToolObservation[]> => {
    const observations: ToolObservation[] = [];
    for (const pin of currentConfig.toolPins) {
      const native = pin.toolId === "superpowers";
      const managedMcpPin = (pin.toolId === "gitnexus" || pin.toolId === "chrome-devtools-mcp")
        ? catalog.pins.find((candidate: { toolId: string; installerId: string; version: string; source: string; integrity: string }) =>
          candidate.toolId === pin.toolId && candidate.installerId === pin.installerId && candidate.version === pin.version &&
          candidate.source === pin.source && candidate.integrity === pin.integrity) : undefined;
      if (!native && (!managedMcpPin || registry.get(pin.installerId) !== installer)) continue;
      const resolved = currentPlatform.os === "other" ? null : registry.resolve(pin.toolId, currentPlatform.os, [pin]);
      const observation: ToolObservation = { toolId: pin.toolId, status: "missing", resolvedPath: null, realPath: null,
        version: null, binaryDigest: null, pathMissingDir: null, required: true, diagnostics: [] };
      if (managedMcpPin) observation.diagnostics.push("Gateway requires the exact verified managed installation; an external CLI does not establish the approved launch identity.");
      if (!resolved) { observation.diagnostics.push("No native provider installer registered for this explicit pin"); observations.push(observation); continue; }
      const inspector = native ? nativeInspectors.get(pin.installerId) : new leaf.ManagedToolInstaller({
        managedRoot: join(currentPlatform.paths.data, "tools"), pins: [managedMcpPin] });
      if (!inspector) { observation.diagnostics.push("No read-only native inspection is registered for this operator pin"); observations.push(observation); continue; }
      const receipt = await inspector.inspect({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
        version: pin.version, source: pin.source, integrity: pin.integrity, destination: join(currentPlatform.paths.data, "tools", pin.toolId),
        scope: { kind: "machine", machineId: currentPlatform.machineId },
        idempotencyKey: `install:${currentPlatform.machineId}:${pin.toolId}:${pin.version}:${pin.integrity}` });
      if (!receipt.ok) {
        observation.diagnostics.push(receipt.error.message);
        // A missing provider login is deferred to the owner; the message stays visible as the remediation.
        const details = receipt.error.details;
        if (typeof details === "object" && details !== null && !Array.isArray(details) && details.ownerAction === "subscription_login_required")
          observation.ownerAction = receipt.error.message;
      }
      else {
        observation.diagnostics.push(...receipt.value.diagnostics);
        if (receipt.value.status === "already_satisfied") {
          observation.status = "present"; observation.version = pin.version;
          if (managedMcpPin) {
            observation.resolvedPath = join(currentPlatform.paths.data, "tools", pin.toolId, leaf.managedToolExecutable(managedMcpPin));
            try {
              observation.realPath = await realpath(observation.resolvedPath!);
              const binaryHash = createHash("sha256");
              for await (const chunk of createReadStream(observation.realPath!)) binaryHash.update(chunk);
              observation.binaryDigest = binaryHash.digest("hex");
            } catch (error) {
              observation.status = "probe_failed"; observation.version = null; observation.binaryDigest = null;
              observation.diagnostics.push(`Managed executable changed during inspection: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        else if (receipt.value.status === "unknown") observation.status = "probe_failed";
      }
      observations.push(observation);
    }
    return observations;
  };
  return { config: merged, registry, diagnostics, inventory, launchRequirements, additionalToolObservations };
}
