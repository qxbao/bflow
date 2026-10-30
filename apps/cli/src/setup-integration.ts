import { existsSync, lstatSync, mkdirSync } from "node:fs";
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
  BuiltinSetupDoctor,
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
  type ToolObservation,
  type ProviderLoginProbe
} from "@bflow/machine-setup";
import {
  AgentProviderRegistry,
  AgyProviderAdapter,
  ClaudeProviderAdapter,
  CodexProviderAdapter
} from "@bflow/agent-providers";
import { wrapSetupComponents, setupGatewayDiagnostics, type SetupGatewayRemoteRequirement } from "./setup-gateway.js";
import { formatSetupPreview, readableLabel, SETUP_COMPONENT_LABELS } from "./presentation.js";
import { createDefaultSetupConfiguration, isolatedProviderHomes } from "./setup-defaults.js";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import { ProfileSetupComponent, resolveProfileSetupOptions } from "./profile-setup.js";
import type { CliContext, SetupCommandArgs, SetupCommandOutput } from "./types.js";

export type { SetupCommandOutput };

/** Aliases for compatibility and prompt conformance */
export const SpawnCommandRunner = NodeCommandRunner;
export const DefaultProviderAdapterRegistry = AgentProviderRegistry;

/** Asks the observed provider binary for its own login status; never logs in or writes credentials. */
const probeNativeProviderLogin: ProviderLoginProbe = async observation => {
  const executablePath = observation.realPath ?? observation.resolvedPath ?? undefined;
  const options = executablePath ? { executablePath } : {};
  const adapter = observation.toolId === "claude" ? new ClaudeProviderAdapter(options)
    : observation.toolId === "codex" ? new CodexProviderAdapter(options)
      : observation.toolId === "agy" ? new AgyProviderAdapter(options) : undefined;
  return adapter?.checkNativeLogin();
};

async function loadSkillsModule(): Promise<any> {
  return import("@bflow/skills");
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
  observer?: { detail(message: string): void; important?(message: string): void; units?(completed: number, total: number, label: string): void; confirm<T>(action: () => Promise<T>): Promise<T> } | undefined
): Promise<SetupCommandOutput> {
  const diagnostics: string[] = [];
  const progress = (step: string) => { try { onProgress?.(step); } catch { /* presentation must not affect setup */ } };
  const detail = (message: string) => { try { observer?.detail(message); } catch { /* observational only */ } };
  const important = (message: string) => {
    try {
      if (observer?.important) observer.important(message);
      else observer?.detail(message);
    } catch { /* observational only */ }
  };

  // 1. Resolve Platform
  progress("Đang kiểm tra nền tảng máy và phạm vi thiết lập...");
  let platform: PlatformProfile = context?.setup?.platform ?? detectPlatform(defaultHostEnvironment());
  const isolatedRoot = context?.setup?.isolatedRoot ?? process.env.BFLOW_HOME;
  if (isolatedRoot) {
    platform = isolatedPlatformProfile(platform, isolatedRoot);
    // Provider CLIs (Codex) refuse a missing CODEX_HOME and PathManager writes rc files under homeDir: create the
    // isolated provider homes up front so nothing falls back to, or fails instead of, the real user's home.
  }

  // 2. Resolve Runner & Store
  progress("Đang kiểm tra trạng thái thiết lập và quyền phê duyệt...");
  const baseRunner: CommandRunner = context?.setup?.runner ?? new NodeCommandRunner();
  const runner: CommandRunner = !observer ? baseRunner : { run: async (argv, options) => {
    const command = basename(argv[0] ?? "command");
    const startedAt = Date.now();
    // Arguments/output can contain account data or secrets; show process boundaries only.
    detail(`Đang chạy ${command}`);
    try {
      const result = await baseRunner.run(argv, options);
      const observe = result.timedOut || result.exitCode !== 0 ? important : detail;
      observe(`${command}: ${result.timedOut ? "hết thời gian chờ" : `mã thoát ${result.exitCode ?? "không rõ"}`} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      return result;
    } catch (error) { important(`${command}: bị gián đoạn hoặc thất bại`); throw error; }
  } };
  const readOnly = args.mode === "check" || args.mode === "dry_run";
  const store = new SetupStateStore(platform.paths, {
    uid: platform.uid,
    now: () => new Date(),
    readOnly
  });

  // 3. Resolve Tool Installers & Capabilities
  progress("Đang kiểm tra trình cài đặt các công cụ đã ghim...");

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
  progress("Đang kiểm tra trình quản lý dịch vụ hệ thống...");
  // Isolated setups namespace OS unit names so they can never collide with (or be linked into) the user's real units.
  const serviceManager: ServiceManager =
    context?.setup?.serviceManager ?? selectServiceManager(platform, runner, store,
      isolatedRoot ? { namespace: isolatedServiceNamespace(isolatedRoot) } : {});

  // 6. Resolve Skills Catalog & Synchronizer
  progress("Đang kiểm tra danh mục kỹ năng được phê duyệt...");
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
  progress("Đang tải cấu hình máy...");
  const configPath = join(platform.paths.config, MACHINE_CONFIG_FILE);
  let machineConfig: MachineConfig = context?.setup?.machineConfig ?? defaultMachineConfig();
  if (!context?.setup?.machineConfig && existsSync(configPath)) {
    const loaded = await loadMachineConfig(configPath);
    if (loaded.config) machineConfig = loaded.config;
  }

  if (args.dir !== undefined) {
    diagnostics.push(
      `bflow setup operates at machine scope; --dir '${args.dir}' does not bind the Gateway to a repository. Run 'bflow init --dir ${args.dir}' to index that repository and register its GitNexus service.`
    );
  }

  let launchRequirements: Awaited<ReturnType<typeof createDefaultSetupConfiguration>>["launchRequirements"] = [];
  let inventory: Awaited<ReturnType<typeof createDefaultSetupConfiguration>>["inventory"] = [];
  let additionalToolObservations: Awaited<ReturnType<typeof createDefaultSetupConfiguration>>["additionalToolObservations"] | undefined;
  if (!context?.setup?.machineSetup && !context?.setup?.toolInstaller) {
    progress("Đang tải danh mục cài đặt công cụ và agent CLI được hỗ trợ...");
    const defaults = await createDefaultSetupConfiguration({ platform,
      // Isolated setup must never write the real provider homes; the isolation is passed explicitly, not via global state.
      ...(isolatedRoot ? { isolation: isolatedProviderHomes(isolatedRoot) } : {}),
      ...(context?.setup?.machineConfig || existsSync(configPath) ? { config: machineConfig } : {}),
      registry: installerRegistry, onUnits: (completed, total, label) => { try { observer?.units?.(completed, total, label); } catch {} } });
    machineConfig = defaults.config;
    installerRegistry = defaults.registry;
    inventory = defaults.inventory;
    launchRequirements = defaults.launchRequirements;
    additionalToolObservations = defaults.additionalToolObservations;
    diagnostics.push(...defaults.diagnostics);
  }

  // DeepWiki is a hosted MCP service shared through the Gateway: nothing to install and no credential. A leftover Context7 key
  // (environment variable or file from an earlier release) is neither read nor forwarded; only its presence is mentioned.
  const remoteServices: SetupGatewayRemoteRequirement[] = [];
  if (!context?.setup?.machineSetup && !context?.setup?.toolInstaller && !args.noDeepWiki && (platform.os === "linux" || platform.os === "darwin")) {
    remoteServices.push({ toolId: "deepwiki" });
    diagnostics.push("DeepWiki (https://mcp.deepwiki.com/mcp) is shared through the Gateway and sends public repository names and documentation questions to that service. It needs no API key. Disable it with --no-deepwiki.");
    if ((process.env.CONTEXT7_API_KEY ?? "").trim() !== "")
      diagnostics.push("CONTEXT7_API_KEY in the environment is ignored; DeepWiki needs no API key and the legacy value is never read or forwarded.");
    if (existsSync(join(platform.paths.state, "secrets", "context7-api-key")))
      diagnostics.push("A Context7 key file from an earlier release remains in the private state directory; it is ignored and never read. Delete it when it is no longer needed.");
  }

  if (launchRequirements.length) {
    diagnostics.push(...setupGatewayDiagnostics({
      launchRequirements,
      gatewayStateDirectory: platform.paths.state,
      gatewayConfigDirectory: platform.paths.config
    }));
  }

  if (onProgress) {
    const observedRegistry = new ToolInstallerRegistry();
    for (const installerId of new Set(machineConfig.toolPins.map(pin => pin.installerId))) {
      const installer = installerRegistry.get(installerId);
      if (!installer) continue;
      observedRegistry.register({ installerId, plan: (request, options) => installer.plan(request, options),
        reconcile: (request, options) => {
          progress(`Đang kiểm tra cài đặt của ${request.step.componentId}...`);
          return installer.reconcile(request, options);
        },
        apply: async (request, options) => {
          progress(`Đang cài đặt ${request.step.componentId}...`);
          const result = await installer.apply(request, options);
          (result.ok ? detail : important)(`${request.step.componentId}: ${result.ok ? "đã nhận biên nhận cài đặt" : "cài đặt thất bại"}`);
          return result;
        } });
    }
    installerRegistry = observedRegistry;
  }

  // An injected platform is the machine being set up: never fall back to this process user's home/isolator state.
  const profileSourceEnvironment = context?.setup?.platform
    ? { homeDir: context.setup.platform.homeDir, env: {} as Record<string, string | undefined> }
    : defaultHostEnvironment();
  const profileSetupOptions = resolveProfileSetupOptions({
    helperPath: fileURLToPath(new URL("../isolation/lib/profile_sync.py", import.meta.url)),
    homeDirectory: profileSourceEnvironment.homeDir,
    environment: profileSourceEnvironment.env,
    ...(isolatedRoot ? { isolatedRoot } : {}),
    expectedIdentity: JSON.stringify(machineConfig.toolPins.filter(pin => pin.toolId === "superpowers")
      .map(({ toolId, installerId, version, source, integrity }) => ({ toolId, installerId, version, source, integrity }))),
    pythonCandidates: [profileSourceEnvironment.env.AI_ISOLATOR_PY, "python3", "python"].filter((value): value is string => Boolean(value))
  });
  const profileTargets = join(profileSetupOptions.stateRoot, "profiles");
  let hasProfileDirectory = false;
  try { lstatSync(profileTargets); hasProfileDirectory = true; } catch { /* No existing profiles: setup creates none. */ }
  const profileSetup = hasProfileDirectory ? new ProfileSetupComponent(profileSetupOptions) : undefined;

  const decorateComponents = (components: readonly SetupComponent[], input: ComponentFactoryInput) => {
    let composed = launchRequirements.length || remoteServices.length ? wrapSetupComponents(components, { ...input, serviceManager, launchRequirements,
      remoteServices }) : components;
    if (profileSetup) composed = [...composed, profileSetup];
    return !onProgress ? composed : composed.map(component => ({ componentId: component.componentId, action: component.action,
      rollback: component.rollback, observe: component.observe.bind(component), desired: component.desired.bind(component),
      apply: async (ctx: Parameters<SetupComponent["apply"]>[0]) => {
        progress(`${SETUP_COMPONENT_LABELS[component.componentId] ?? readableLabel(component.componentId)}...`);
        const result = await component.apply(ctx);
        for (const diagnostic of result.diagnostics) {
          (/\b(warn(?:ing)?|fail(?:ed|ure)?|blocked|unknown|interrupted|unsupported|requires?|missing)\b/i.test(diagnostic) ? important : detail)(diagnostic);
        }
        return result;
      } }));
  };

  // 8. Execute Machine Setup
  progress(`Đang lập kế hoạch thiết lập (${args.mode})...`);
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
      // Isolated or injected machines keep provider state elsewhere; only the real account's login can be read here.
      ...(context?.setup?.probeProviderLogin || (!isolatedRoot && !context?.setup?.platform)
        ? { doctor: new BuiltinSetupDoctor({ probeLogin: context?.setup?.probeProviderLogin ?? probeNativeProviderLogin }) } : {}),
      persistMachineConfig: launchRequirements.length === 0 && remoteServices.length === 0,
      decorateComponents,
      approver: args.yes
        ? new AssumeYesApprover(store, () => new Date())
        : !context?.setup?.confirm && (args.json || !process.stdin.isTTY || !process.stderr.isTTY)
          ? new NonInteractiveApprover()
          : new InteractiveApprover(async text => {
            const notes = diagnostics.filter(note => /license|PolyForm|build scripts/i.test(note));
            if (inventory.some(item => item.toolId === "superpowers"))
              notes.push(`Plugin tích hợp sẽ cập nhật thư mục cấu hình của ${machineConfig.providers.join(", ")} trên tài khoản này.`);
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
        progress("Đang áp dụng các bước thiết lập đã phê duyệt...");
        const applyRes = await machineSetup.apply({ mode: args.mode, config: machineConfig, approval });
        if (applyRes) {
          progress("Đang kiểm tra biên nhận thiết lập...");
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
    progress(`Đang chạy kiểm tra thiết lập (${args.mode})...`);
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
    progress("Đang hoàn tất kế hoạch thiết lập...");
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
      progress("Đang kiểm tra các công cụ đã cài đặt...");
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

  progress("Đang tổng hợp kết quả thiết lập...");

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
