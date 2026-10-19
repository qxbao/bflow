import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, join, resolve } from "node:path";
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
  InteractiveApprover,
  NonInteractiveApprover,
  isolatedPlatformProfile,
  isolatedServiceNamespace,
  type SetupOutcome,
  type SetupPreview,
  type MachineDoctorReport,
  type SetupComponent,
  type ComponentFactoryInput,
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
  AgentProviderRegistry
} from "@bflow/agent-providers";
import { wrapSetupComponents, setupGatewayDiagnostics, type SetupGatewayRemoteRequirement } from "./setup-gateway.js";
import { context7KeyFingerprint, readKeyFromStream, readStoredContext7Key, validateContext7ApiKey } from "./context7-secret.js";
import { describeExistingContext7, detectExistingContext7 } from "./context7-detect.js";
import { formatSetupPreview, readableLabel, SETUP_COMPONENT_LABELS } from "./presentation.js";
import { identifyRepository } from "./repository.js";
import { createDefaultSetupConfiguration, isolatedProviderHomes } from "./setup-defaults.js";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import type { CliContext, SetupCommandArgs, SetupCommandOutput } from "./types.js";

export type { SetupCommandOutput };

/** Aliases for compatibility and prompt conformance */
export const SpawnCommandRunner = NodeCommandRunner;
export const DefaultProviderAdapterRegistry = AgentProviderRegistry;

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
  onProgress?: ((step: string) => void) | undefined,
  observer?: { detail(message: string): void; confirm<T>(action: () => Promise<T>): Promise<T> } | undefined
): Promise<SetupCommandOutput> {
  const diagnostics: string[] = [];
  const progress = (step: string) => { try { onProgress?.(step); } catch { /* presentation must not affect setup */ } };
  const detail = (message: string) => { try { observer?.detail(message); } catch { /* observational only */ } };

  // 1. Resolve Platform
  progress("Checking machine platform and setup scope...");
  let platform: PlatformProfile = context?.setup?.platform ?? detectPlatform(defaultHostEnvironment());
  const isolatedRoot = context?.setup?.isolatedRoot ?? process.env.BFLOW_HOME;
  if (isolatedRoot) {
    platform = isolatedPlatformProfile(platform, isolatedRoot);
    // Provider CLIs (Codex) refuse a missing CODEX_HOME and PathManager writes rc files under homeDir: create the
    // isolated provider homes up front so nothing falls back to, or fails instead of, the real user's home.
  }

  // 2. Resolve Runner & Store
  progress("Checking setup state and approvals...");
  const baseRunner: CommandRunner = context?.setup?.runner ?? new NodeCommandRunner();
  const runner: CommandRunner = !observer ? baseRunner : { run: async (argv, options) => {
    const command = basename(argv[0] ?? "command");
    const startedAt = Date.now();
    // Arguments/output can contain account data or secrets; show process boundaries only.
    detail(`Running ${command}`);
    try {
      const result = await baseRunner.run(argv, options);
      detail(`${command}: ${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      return result;
    } catch (error) { detail(`${command}: interrupted or failed`); throw error; }
  } };
  const readOnly = args.mode === "check" || args.mode === "dry_run";
  const store = new SetupStateStore(platform.paths, {
    uid: platform.uid,
    now: () => new Date(),
    readOnly
  });

  // 3. Resolve Tool Installers & Capabilities
  progress("Checking pinned tool installers...");

  let installerRegistry: ToolInstallerRegistry;
  if (context?.setup?.toolInstaller instanceof ToolInstallerRegistry) {
    installerRegistry = context.setup.toolInstaller;
  } else {
    installerRegistry = new ToolInstallerRegistry();
    if (context?.setup?.toolInstaller) {
      const registered = installerRegistry.register(context.setup.toolInstaller as ToolInstaller);
      if (!registered.ok) throw new Error(registered.error.message);
    }
  }

  // 4. Resolve Service Manager
  progress("Checking service manager capabilities...");
  // Isolated setups namespace OS unit names so they can never collide with (or be linked into) the user's real units.
  const serviceManager: ServiceManager =
    context?.setup?.serviceManager ?? selectServiceManager(platform, runner, store,
      isolatedRoot ? { namespace: isolatedServiceNamespace(isolatedRoot) } : {});

  // 6. Resolve Skills Catalog & Synchronizer
  progress("Checking approved skills catalog...");
  const skillsMod = await loadSkillsModule();
  const selectedCatalog = args.catalogDir ?? context?.setup?.catalogDir;
  const candidateDirs = selectedCatalog
    ? [resolve(context?.cwd ?? process.cwd(), selectedCatalog)]
    : [fileURLToPath(new URL("../../../skills", import.meta.url))];

  let catalogDir: string | undefined;
  for (const dir of candidateDirs) {
    if (existsSync(dir) && existsSync(join(dir, "roles", "bindings.json"))) {
      catalogDir = dir;
      break;
    }
  }

  if (!catalogDir) throw new Error("The required skills catalog is unavailable. Restore the bundled skills or pass --catalog-dir with a valid catalog.");

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
      skillsMod.RoleSkillBindingsSchema.parse(JSON.parse(bindingsContent));

      const storeRoot = join(platform.paths.data, "skills-store");
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
        syncedManifests: 0,
        storeRoot
      };
    } catch (e) {
      throw new Error(`Failed to load skills catalog: ${e instanceof Error ? e.message : String(e)}`);
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

  let launchRequirements: Awaited<ReturnType<typeof createDefaultSetupConfiguration>>["launchRequirements"] = [];
  let repositoryRoot: string | undefined;
  let inventory: Awaited<ReturnType<typeof createDefaultSetupConfiguration>>["inventory"] = [];
  let additionalToolObservations: Awaited<ReturnType<typeof createDefaultSetupConfiguration>>["additionalToolObservations"] | undefined;
  if (!context?.setup?.machineSetup && !context?.setup?.toolInstaller) {
    progress("Loading the supported tool and agent CLI installation catalog...");
    const target = resolve(context?.cwd ?? process.cwd(), args.dir ?? ".");
    try { repositoryRoot = (await identifyRepository(target)).root; }
    catch (error) { if (args.dir) throw error; }
    const defaults = await createDefaultSetupConfiguration({ platform, projectRoot: repositoryRoot ?? target,
      // Isolated setup must never write the real provider homes; the isolation is passed explicitly, not via global state.
      ...(isolatedRoot ? { isolation: isolatedProviderHomes(isolatedRoot) } : {}),
      ...(context?.setup?.machineConfig || existsSync(configPath) ? { config: machineConfig } : {}),
      registry: installerRegistry });
    machineConfig = defaults.config;
    installerRegistry = defaults.registry;
    inventory = defaults.inventory;
    launchRequirements = defaults.launchRequirements;
    additionalToolObservations = defaults.additionalToolObservations;
    diagnostics.push(...defaults.diagnostics);
  }

  // Context7 is a hosted MCP service shared through the Gateway: nothing to install, one optional API key.
  const remoteServices: SetupGatewayRemoteRequirement[] = [];
  let context7ApiKey: string | undefined;
  if (!context?.setup?.machineSetup && !context?.setup?.toolInstaller && !args.noContext7 && (platform.os === "linux" || platform.os === "darwin")) {
    const injected = context?.setup?.context7ApiKey;
    if (args.context7ApiKeyStdin && injected === undefined && process.stdin.isTTY)
      throw new Error("--context7-api-key-stdin reads the key from standard input; pipe it in, for example: printf %s \"$KEY\" | bflow setup --apply --context7-api-key-stdin");
    // A key the caller handed over explicitly (stdin or injection) must be valid. One merely present in the environment is advisory:
    // a stale value must not abort an unrelated read-only `--check`.
    const explicit = args.context7ApiKeyStdin ? (injected ?? await readKeyFromStream(process.stdin)) : injected;
    if (args.context7ApiKeyStdin && (explicit === undefined || explicit.trim() === "")) throw new Error("The Context7 API key read from standard input is empty.");
    const supplied = explicit ?? process.env.CONTEXT7_API_KEY;
    if (supplied !== undefined && supplied.trim() !== "") {
      const validated = validateContext7ApiKey(supplied);
      if (validated.ok) context7ApiKey = validated.key;
      else if (explicit !== undefined) throw new Error(validated.reason);
      else diagnostics.push(`CONTEXT7_API_KEY in the environment is ignored: ${validated.reason}`);
    }
    const stored = await readStoredContext7Key(platform.paths);
    if (stored.status === "unsafe" || stored.status === "invalid") diagnostics.push(`Context7: the stored API key is ignored (${stored.reason}) and Context7 runs anonymously until it is stored again.`);
    const activeKey = context7ApiKey ?? (stored.status === "ok" ? stored.key : undefined);
    remoteServices.push({ toolId: "context7", authenticated: activeKey !== undefined, keyFingerprint: activeKey !== undefined ? context7KeyFingerprint(activeKey) : null });
    diagnostics.push(`Context7 (https://mcp.context7.com/mcp) is shared through the Gateway and sends library names and documentation questions to that service. It runs ${activeKey !== undefined ? "with an API key" : "anonymously with lower rate limits; store a key with --context7-api-key-stdin or CONTEXT7_API_KEY"}. Disable it with --no-context7.`);
    if (!isolatedRoot) {
      const host = defaultHostEnvironment();
      diagnostics.push(...describeExistingContext7(await detectExistingContext7({ homeDirectory: host.homeDir,
        codexHome: host.env.CODEX_HOME ? resolve(host.env.CODEX_HOME) : join(host.homeDir, ".codex"), runner: { run: (command, options) => runner.run([...command], options) } })));
    }
  }

  if (launchRequirements.length) {
    diagnostics.push(...setupGatewayDiagnostics({ launchRequirements, ...(repositoryRoot ? { repositoryRoot } : {}), gatewayStateDirectory: platform.paths.state }));
  }

  if (onProgress) {
    const observedRegistry = new ToolInstallerRegistry();
    for (const installerId of new Set(machineConfig.toolPins.map(pin => pin.installerId))) {
      const installer = installerRegistry.get(installerId);
      if (!installer) continue;
      observedRegistry.register({ installerId, plan: (request, options) => installer.plan(request, options),
        reconcile: (request, options) => {
          progress(`Checking installation of ${request.step.componentId}...`);
          return installer.reconcile(request, options);
        },
        apply: async (request, options) => {
          progress(`Installing ${request.step.componentId}...`);
          const result = await installer.apply(request, options);
          detail(`${request.step.componentId}: ${result.ok ? "installation receipt received" : "installation failed"}`);
          return result;
        } });
    }
    installerRegistry = observedRegistry;
  }

  const decorateComponents = (components: readonly SetupComponent[], input: ComponentFactoryInput) => {
    const composed = launchRequirements.length || remoteServices.length ? wrapSetupComponents(components, { ...input, serviceManager, launchRequirements,
      remoteServices, ...(context7ApiKey !== undefined && (args.mode === "apply" || args.mode === "repair") ? { context7ApiKey } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {}) }) : components;
    return !onProgress ? composed : composed.map(component => ({ componentId: component.componentId, action: component.action,
      rollback: component.rollback, observe: component.observe.bind(component), desired: component.desired.bind(component),
      apply: async (ctx: Parameters<SetupComponent["apply"]>[0]) => {
        progress(`${SETUP_COMPONENT_LABELS[component.componentId] ?? readableLabel(component.componentId)}...`);
        const result = await component.apply(ctx);
        for (const diagnostic of result.diagnostics) detail(diagnostic);
        return result;
      } }));
  };

  // 8. Execute Machine Setup
  progress(`Building ${args.mode} setup plan...`);
  const machineSetup: any =
    context?.setup?.machineSetup ??
    new MachineSetupService({
      runner,
      platform,
      config: machineConfig,
      launcher: { nodeBinary: process.execPath, entrypoint: fileURLToPath(new URL("../dist/bin.js", import.meta.url)) },
      registry: installerRegistry,
      skills: synchronizer,
      ...(additionalToolObservations ? { additionalToolObservations } : {}),
      serviceManager,
      persistMachineConfig: launchRequirements.length === 0 && remoteServices.length === 0,
      decorateComponents,
      approver: args.yes
        ? new AssumeYesApprover(store, () => new Date())
        : !context?.setup?.confirm && (args.json || !process.stdin.isTTY || !process.stderr.isTTY)
          ? new NonInteractiveApprover()
          : new InteractiveApprover(async text => {
            const notes = diagnostics.filter(note => /license|PolyForm|build scripts/i.test(note));
            if (inventory.some(item => item.toolId === "superpowers"))
              notes.push(`Native plugins update the ${machineConfig.providers.join(", ")} configuration folders in this account.`);
            const preview = [...notes, text].join("\n\n");
            // Keep injected approval callbacks plain for programmatic consumers.
            const prompt = formatSetupPreview(preview, !context?.setup?.confirm && Boolean(context?.presentation?.stderrColor) && !args.json);
            const ask = async () => {
              if (context?.setup?.confirm) return context.setup.confirm(prompt);
              if (args.json || !process.stdin.isTTY || !process.stderr.isTTY) return false;
              const terminal = createInterface({ input: process.stdin, output: process.stderr });
              try { return /^(y|yes)$/i.test((await terminal.question(`${prompt} [y/N] `)).trim()); }
              finally { terminal.close(); }
            };
            return observer ? observer.confirm(ask) : ask();
          }, store, () => new Date()),
      now: () => new Date()
    });

  // Isolated provider homes are created only when changes may apply (never in check/dry-run), after validation:
  // Codex refuses a missing CODEX_HOME and PathManager writes rc files under homeDir, so nothing may fall back to
  // the real user's home.
  const ensureIsolatedHomes = () => {
    if (!isolatedRoot || args.mode === "check" || args.mode === "dry_run") return;
    const providerHomes = isolatedProviderHomes(isolatedRoot);
    for (const directory of [platform.homeDir, providerHomes.homeDirectory, providerHomes.claudeConfigDir, providerHomes.codexHome])
      if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  };

  let plan: SetupPlan | undefined;
  let receipt: SetupReceipt | undefined;
  let toolObservations: ToolObservation[] = [];
  let toolsReported = false;
  let receipts: SetupReceipt[] = [];
  let outcome: SetupOutcome | undefined;
  let setupPreview: SetupPreview | undefined;
  let doctor: MachineDoctorReport | undefined;

  if (typeof machineSetup.plan === "function") {
    // Custom machineSetup engine supporting explicit plan / apply
    const planRes = await machineSetup.plan({ mode: args.mode, config: machineConfig });
    plan = planRes.plan ?? planRes;
    setupPreview = planRes.preview;
    if (Array.isArray(planRes.diagnostics)) diagnostics.push(...planRes.diagnostics);
    if (Array.isArray(planRes.tools)) toolObservations = planRes.tools;

    if (args.mode === "apply" || args.mode === "repair") {
      let approval: any = undefined;
      if (plan?.steps?.some((s: any) => s.requiresApproval) && args.yes) {
        approval = issueSetupApproval(plan, "cli-operator");
        await store.writeApproval(approval);
      }
      if (typeof machineSetup.apply === "function") {
        ensureIsolatedHomes();
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
    ensureIsolatedHomes();
    // Standard MachineSetupService execution
    progress(`Running ${args.mode} setup checks...`);
    const report = await machineSetup.run({
      mode: args.mode,
      assumeYes: args.yes
    });
    diagnostics.push(...(report.diagnostics ?? []));
    outcome = report.outcome;
    setupPreview = report.preview ?? undefined;
    doctor = report.doctor ?? undefined;
    receipts = report.receipts ?? [];
    toolsReported = Array.isArray(report.observations);
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
      throw new Error(built.error.message);
    }
  }

  const resolvedPlan = plan;

  if (toolObservations.length === 0 && !toolsReported) {
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
    ...(serviceManager.namespace ? { serviceUnitNamespace: serviceManager.namespace } : {}),
    plan: resolvedPlan,
    ...(setupPreview ? { preview: setupPreview } : {}),
    ...(receipt ? { receipt } : {}),
    receipts,
    inventory,
    ...(outcome ? { outcome } : {}),
    ...(doctor ? { doctor } : {}),
    tools,
    skills: { ...skillsInfo, installedSkillCount: receipts.some(item => item.stepId === "resolve_skills:role-skills" &&
      ["applied", "already_satisfied"].includes(item.status)) || doctor?.checks.some(check => check.checkId === "role-skills" && check.status === "passed")
      ? skillsInfo.skillCount : 0 },
    diagnostics
  };
}
