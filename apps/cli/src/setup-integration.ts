import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type {
  MachineSetupPlan as SetupPlan,
  SetupReceipt,
  ToolInstaller
} from "@bflow/contracts";
import {
  MachineSetupService,
  SetupStateStore,
  ToolInstallerRegistry,
  selectServiceManager,
  detectPlatform,
  loadMachineConfig,
  defaultMachineConfig,
  defaultHostEnvironment,
  NodeCommandRunner,
  AssumeYesApprover,
  NonInteractiveApprover,
  buildSetupPlan,
  probeTools,
  MACHINE_CONFIG_FILE,
  type PlatformProfile,
  type CommandRunner,
  type MachineConfig,
  type ServiceManager,
  type ToolObservation
} from "@bflow/machine-setup";
import {
  createDefaultProviderRegistry,
  AgentProviderRegistry
} from "@bflow/agent-providers";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import type { CliContext, SetupCommandArgs, SetupCommandOutput } from "./types.js";

export type { SetupCommandOutput };

/** Aliases for compatibility and prompt conformance */
export const SpawnCommandRunner = NodeCommandRunner;
export const DefaultProviderAdapterRegistry = AgentProviderRegistry;

/** Dynamic loaders for packages not in apps/cli/package.json */
async function loadToolInstallerModule(): Promise<any> {
  return import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
}

async function loadSkillsModule(): Promise<any> {
  return import(new URL("../../../packages/skills/dist/index.js", import.meta.url).href);
}

/** Issues a formal v3 setup approval receipt */
export function issueSetupApproval(
  plan: SetupPlan,
  approvedBy = "cli-operator",
  now: () => Date = () => new Date()
): SetupReceipt {
  const stepIds = plan.steps.filter((s) => s.requiresApproval).map((s) => s.stepId);
  const approvedAt = now().toISOString();
  const rawDigest = JSON.stringify({ planDigest: plan.planDigest, stepIds, approvedBy, approvedAt });
  const hash = createHash("sha256").update(rawDigest).digest("hex").slice(0, 24);
  return {
    schemaVersion: 3 as const,
    receiptId: `approval-${hash}`,
    planId: plan.planId,
    planDigest: plan.planDigest,
    machineId: plan.machineId,
    stepIds,
    approvedBy: approvedBy as any,
    approvedAt
  } as unknown as SetupReceipt;
}

export async function executeSetupCommand(
  args: SetupCommandArgs,
  context?: CliContext,
  onProgress?: ((step: string) => void) | undefined
): Promise<SetupCommandOutput> {
  const diagnostics: string[] = [];
  const progress = (step: string) => { try { onProgress?.(step); } catch { /* presentation must not affect setup */ } };

  // 1. Resolve Platform
  progress("Checking machine platform and setup scope...");
  let platform: PlatformProfile = context?.setup?.platform ?? detectPlatform(defaultHostEnvironment());
  const isolatedRoot = context?.setup?.isolatedRoot ?? process.env.BFLOW_HOME;
  if (isolatedRoot) {
    platform = {
      ...platform,
      paths: {
        config: join(isolatedRoot, "config"),
        data: join(isolatedRoot, "data"),
        state: join(isolatedRoot, "state"),
        managedBin: join(isolatedRoot, "data", "bin")
      }
    };
  } else if (args.dir) {
    const scopedRoot = resolve(context?.cwd ?? process.cwd(), args.dir);
    platform = {
      ...platform,
      paths: {
        config: join(scopedRoot, ".bflow", "config"),
        data: join(scopedRoot, ".bflow", "data"),
        state: join(scopedRoot, ".bflow", "state"),
        managedBin: join(scopedRoot, ".bflow", "data", "bin")
      }
    };
  }

  // Ensure state & config directories exist with 0o700 mode
  await mkdir(platform.paths.state, { recursive: true, mode: 0o700 });
  await mkdir(platform.paths.config, { recursive: true, mode: 0o700 });
  await mkdir(platform.paths.data, { recursive: true, mode: 0o700 });
  await chmod(platform.paths.state, 0o700);
  await chmod(platform.paths.config, 0o700);
  await chmod(platform.paths.data, 0o700);

  // 2. Resolve Runner & Store
  progress("Checking setup state and approvals...");
  const runner: CommandRunner = context?.setup?.runner ?? new NodeCommandRunner();
  const readOnly = args.mode === "check" || args.mode === "dry_run";
  const store = new SetupStateStore(platform.paths, {
    uid: platform.uid,
    now: () => new Date(),
    readOnly
  });

  // 3. Resolve Tool Installers & Capabilities
  progress("Checking pinned tool installers...");
  const toolMod = await loadToolInstallerModule();
  const capabilityRegistryPath = join(platform.paths.state, "tool-capabilities.json");
  const capabilityRegistry = new toolMod.FileToolCapabilityRegistry(capabilityRegistryPath);
  void capabilityRegistry;

  let installerRegistry: ToolInstallerRegistry;
  if (context?.setup?.toolInstaller instanceof ToolInstallerRegistry) {
    installerRegistry = context.setup.toolInstaller;
  } else {
    installerRegistry = new ToolInstallerRegistry();
    if (context?.setup?.toolInstaller) {
      installerRegistry.register(context.setup.toolInstaller as ToolInstaller);
    } else {
      const managedToolsDir = join(platform.paths.data, "tools");
      await mkdir(managedToolsDir, { recursive: true, mode: 0o700 });
      await chmod(managedToolsDir, 0o700);
      const managedInstaller = new toolMod.ManagedToolInstaller({
        managedRoot: managedToolsDir,
        pins: []
      });
      installerRegistry.register(managedInstaller);
    }
  }

  // 4. Resolve Service Manager
  progress("Checking service manager capabilities...");
  const serviceManager: ServiceManager =
    context?.setup?.serviceManager ?? selectServiceManager(platform, runner, store);

  // 5. Resolve Providers
  progress("Checking agent provider capabilities...");
  const providers: AgentProviderRegistry =
    context?.setup?.providers ?? createDefaultProviderRegistry();
  void providers;

  // 6. Resolve Skills Catalog & Synchronizer
  progress("Checking approved skills catalog...");
  const skillsMod = await loadSkillsModule();
  const candidateDirs = [
    args.catalogDir,
    context?.setup?.catalogDir,
    args.dir ? resolve(context?.cwd ?? process.cwd(), args.dir, "skills") : undefined,
    resolve(context?.cwd ?? process.cwd(), "skills"),
    resolve(fileURLToPath(import.meta.url), "../../../../skills")
  ].filter((d): d is string => typeof d === "string" && d.trim().length > 0);

  let catalogDir: string | undefined;
  for (const dir of candidateDirs) {
    if (existsSync(dir) && existsSync(join(dir, "roles", "bindings.json"))) {
      catalogDir = dir;
      break;
    }
  }

  let skillsInfo = {
    catalogLoaded: false,
    skillCount: 0,
    syncedManifests: 0,
    storeRoot: join(platform.paths.data, "skills-store")
  };
  let synchronizer: any = undefined;

  if (catalogDir) {
    try {
      const catalog = await skillsMod.loadSkillCatalog(catalogDir, {
        source: "builtin",
        supportedCommands: SUPPORTED_CLI_COMMANDS
      });
      const bindingsContent = await readFile(join(catalogDir, "roles", "bindings.json"), "utf8");
      const bindings = skillsMod.RoleSkillBindingsSchema.parse(JSON.parse(bindingsContent));

      const storeRoot = join(platform.paths.data, "skills-store");
      await mkdir(storeRoot, { recursive: true, mode: 0o700 });
      await chmod(storeRoot, 0o700);
      const skillFileStore = new skillsMod.SkillFileStore(storeRoot);
      const skillManager =
        context?.setup?.skillManager ??
        new skillsMod.SkillManager({
          store: skillFileStore,
          supportedCommands: SUPPORTED_CLI_COMMANDS,
          approvedBuiltinDigests: catalog.map((item: any) => item.definition.digest)
        });

      synchronizer = new skillsMod.SkillsSetupSynchronizer(
        skillManager,
        skillFileStore,
        catalog.map((item: any) => ({
          root: item.directory,
          source: "builtin",
          expectedDigest: item.definition.digest
        }))
      );

      skillsInfo = {
        catalogLoaded: true,
        skillCount: catalog.length,
        syncedManifests: Object.keys(bindings.bindings).length,
        storeRoot
      };
    } catch (e) {
      diagnostics.push(`Failed to load skills catalog: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7. Resolve Machine Config
  progress("Loading machine configuration...");
  const configPath = join(platform.paths.config, MACHINE_CONFIG_FILE);
  let machineConfig: MachineConfig = context?.setup?.machineConfig ?? defaultMachineConfig();
  if (!context?.setup?.machineConfig && existsSync(configPath)) {
    const loaded = await loadMachineConfig(configPath);
    if (loaded.config) machineConfig = loaded.config;
  }

  // 8. Execute Machine Setup
  progress(`Building ${args.mode} setup plan...`);
  const machineSetup: any =
    context?.setup?.machineSetup ??
    new MachineSetupService({
      runner,
      registry: installerRegistry,
      skills: synchronizer,
      serviceManager,
      approver: args.yes
        ? new AssumeYesApprover(store, () => new Date())
        : new NonInteractiveApprover(),
      now: () => new Date()
    });

  let plan: SetupPlan | undefined;
  let receipt: SetupReceipt | undefined;
  let toolObservations: ToolObservation[] = [];

  if (typeof machineSetup.plan === "function") {
    // Custom machineSetup engine supporting explicit plan / apply
    const planRes = await machineSetup.plan({ mode: args.mode, config: machineConfig });
    plan = planRes.plan ?? planRes;
    if (Array.isArray(planRes.diagnostics)) diagnostics.push(...planRes.diagnostics);
    if (Array.isArray(planRes.tools)) toolObservations = planRes.tools;

    if (args.mode === "apply" || args.mode === "repair") {
      let approval: any = undefined;
      if (plan?.steps?.some((s: any) => s.requiresApproval) && args.yes) {
        approval = issueSetupApproval(plan, "cli-operator");
        await store.writeApproval(approval);
      }
      if (typeof machineSetup.apply === "function") {
        progress("Applying approved setup steps...");
        const applyRes = await machineSetup.apply({ mode: args.mode, config: machineConfig, approval });
        if (applyRes) {
          progress("Checking setup receipt...");
          receipt =
            applyRes.receipt ??
            (Array.isArray(applyRes.receipts)
              ? applyRes.receipts.find((r: any) => r.stepId !== "verify:doctor") ?? applyRes.receipts[0]
              : Array.isArray(applyRes)
                ? applyRes[0]
                : applyRes);
          if (Array.isArray(applyRes.diagnostics)) diagnostics.push(...applyRes.diagnostics);
          if (Array.isArray(applyRes.tools)) toolObservations = applyRes.tools;
        }
      }
    }
  } else if (typeof machineSetup.run === "function") {
    // Standard MachineSetupService execution
    progress(`Running ${args.mode} setup checks...`);
    const report = await machineSetup.run({
      mode: args.mode,
      assumeYes: args.yes
    });
    diagnostics.push(...(report.diagnostics ?? []));
    plan = report.plan ?? undefined;
    receipt = report.receipts?.find((r: any) => r.stepId !== "verify:doctor") ?? report.receipts?.[0];
    toolObservations = report.observations ?? [];
  }

  // Ensure plan is always populated
  if (!plan) {
    progress("Finalizing setup plan...");
    const built = await buildSetupPlan({
      platform,
      runner,
      observations: toolObservations,
      config: machineConfig,
      components: [],
      registry: installerRegistry,
      mode: args.mode,
      previousRevision: 0,
      now: () => new Date()
    });
    if (built.ok) {
      plan = built.value.plan;
    } else {
      plan = {
        schemaVersion: 3,
        planId: `setup-${args.mode}`,
        machineId: platform.machineId,
        revision: 1,
        planDigest: "0".repeat(64),
        createdAt: new Date().toISOString(),
        idempotencyKey: `setup-fallback-${Date.now()}`,
        steps: []
      };
    }
  }

  const resolvedPlan: SetupPlan = plan ?? {
    schemaVersion: 3,
    planId: `setup-${args.mode}`,
    machineId: platform.machineId,
    revision: 1,
    planDigest: "0".repeat(64),
    createdAt: new Date().toISOString(),
    idempotencyKey: `setup-fallback-${Date.now()}`,
    steps: []
  };

  if (toolObservations.length === 0) {
    try {
      progress("Checking installed tools...");
      toolObservations = await probeTools(platform, runner, { required: new Set() });
    } catch {
      // Ignore probe failures in test/isolated environments
    }
  }

  const tools = toolObservations.map((o: any) => {
    const version = o.detectedVersion ?? o.version;
    return {
      toolId: o.toolId,
      status: o.status,
      ...(version ? { version } : {})
    };
  });

  progress("Summarizing setup results...");

  return {
    mode: args.mode,
    machineId: platform.machineId,
    os: platform.os,
    serviceManagerKind: serviceManager.kind,
    plan: resolvedPlan,
    ...(receipt ? { receipt } : {}),
    tools,
    skills: skillsInfo,
    diagnostics
  };
}
