import { join } from "node:path";
import type { ToolInstaller } from "@bflow/contracts";
import { MachineConfigSchema, ToolInstallerRegistry, defaultMachineConfig,
  type MachineConfig, type PlatformProfile } from "@bflow/machine-setup";

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
export async function createDefaultSetupConfiguration(options: {
  platform: PlatformProfile;
  config?: MachineConfig;
  registry?: ToolInstallerRegistry;
}): Promise<{ config: MachineConfig; registry: ToolInstallerRegistry; diagnostics: string[];
  inventory: DefaultSetupInventory[]; launchRequirements: DefaultSetupLaunchRequirement[] }> {
  const { platform } = options;
  const config = MachineConfigSchema.parse(options.config ?? {
    ...defaultMachineConfig(), providers: ["claude", "codex", "agy"]
  });
  const registry = options.registry ?? new ToolInstallerRegistry();
  const leaf = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
  const catalog = leaf.defaultToolCatalog(platform.os, platform.arch);
  const manual: { toolId: string; diagnostic: string; documentation: string }[] = catalog.manual;
  const installer: ToolInstaller = new leaf.ManagedToolInstaller({ managedRoot: join(platform.paths.data, "tools"), pins: catalog.pins });
  if (catalog.pins.length > 0 && !registry.get(installer.installerId)) {
    const registration = registry.register(installer);
    if (!registration.ok) throw new Error(registration.error.message);
  }
  const explicitTools = new Set(config.toolPins.map(pin => pin.toolId));
  const descriptors = catalog.pins.filter((pin: { toolId: string }) => !explicitTools.has(pin.toolId))
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
      ...(builtIn ? { executable: join(platform.paths.data, "tools", pin.toolId, leaf.managedToolExecutable(builtIn)) } : {}),
      diagnostic: "Installation requires the approved machine setup plan. Binary presence does not prove provider authentication, native plugin activation or MCP readiness." };
  });
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
  return { config: merged, registry, diagnostics, inventory, launchRequirements };
}
