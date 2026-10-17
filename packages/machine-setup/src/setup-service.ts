import path from "node:path";
import type { MachineSetupPlan, SetupReceipt } from "@bflow/contracts";
import { AssumeYesApprover, type SetupApprover } from "./approval.js";
import { BuiltinSetupDoctor, type DoctorInput, type MachineDoctorReport, type SetupDoctor } from "./doctor.js";
import { executePlan, WINDOWS_NOT_VERIFIED } from "./executor.js";
import { ToolInstallerRegistry } from "./installer-registry.js";
import { defaultMachineConfig, loadMachineConfig, MachineConfigSchema, type MachineConfig, type MachineConfigLoadResult } from "./machine-config.js";
import { EnvironmentManifestComponent } from "./manifest.js";
import { McpConfigComponent } from "./mcp-registry.js";
import { PathComponent } from "./path-manager.js";
import { buildSetupPlan, DOCTOR_STEP_ID, type SetupPreview } from "./plan.js";
import { defaultHostEnvironment, detectPlatform, detectPlatformWithProbe } from "./platform.js";
import { NodeCommandRunner } from "./runner.js";
import { selectServiceManager, ServicesComponent, type ServiceManager } from "./service-manager.js";
import { createSkillsComponent, type SkillsSynchronizer } from "./skills.js";
import { SetupStateStore } from "./state-store.js";
import { probeTools, TOOL_CATALOG, ToolObservationSchema, type ToolObservation } from "./tools.js";
import type { CommandRunner, HostEnvironment, PlatformProfile, SetupComponent, SetupContext } from "./types.js";

export const MACHINE_CONFIG_FILE = "machine.json";
export const CONFIG_REPAIR_NEEDED = "machine config invalid; run setup --repair";

export type SetupMode = SetupContext["mode"];
export type SetupOutcome =
  | "healthy"
  | "changes_pending"
  | "applied"
  | "partially_applied"
  | "failed"
  | "blocked"
  | "approval_declined"
  | "unsupported_platform";

export interface SetupRunReport {
  mode: SetupMode;
  platform: PlatformProfile;
  observations: ToolObservation[];
  configStatus: MachineConfigLoadResult["status"];
  plan: MachineSetupPlan | null;
  preview: SetupPreview | null;
  receipts: SetupReceipt[];
  doctor: MachineDoctorReport | null;
  /** `<stepId>: <target>` for machine-wide targets (planned in dry_run, applied in apply/repair). */
  machineWideChanges: string[];
  outcome: SetupOutcome;
  diagnostics: string[];
}

export interface ComponentFactoryInput {
  platform: PlatformProfile;
  store: SetupStateStore;
  runner: CommandRunner;
  config: MachineConfig;
  observations: readonly ToolObservation[];
  env: Record<string, string | undefined>;
}

export interface MachineSetupServiceOptions {
  /** Add integration components while retaining the default path/skills/manifest composition. */
  decorateComponents?: (components: readonly SetupComponent[], input: ComponentFactoryInput) => readonly SetupComponent[];
  /** False when a composed, approved component persists the resolved machine configuration. */
  persistMachineConfig?: boolean;
  /** Already resolved by the caller (including isolated roots). */
  platform?: PlatformProfile;
  /** Desired config supplied by the caller; an invalid on-disk config still requires repair. */
  config?: MachineConfig;
  /** Executable launcher installed in the owned managed bin directory. */
  launcher?: { nodeBinary: string; entrypoint: string };
  /** Read-only native/plugin probes, merged by tool id on initial and post-install observation. */
  additionalToolObservations?: (platform: PlatformProfile, config: MachineConfig) => Promise<readonly ToolObservation[]>;
  host?: HostEnvironment;
  runner?: CommandRunner;
  registry?: ToolInstallerRegistry;
  skills?: SkillsSynchronizer;
  doctor?: SetupDoctor;
  serviceManager?: ServiceManager;
  /** Approver used without `assumeYes`; a factory receives the run's state store. */
  approver: SetupApprover | ((deps: { store: SetupStateStore; now: () => Date }) => SetupApprover);
  /** Replaces the default components (path, role-skills, mcp-config, services, environment-manifest). */
  components?: readonly SetupComponent[] | ((input: ComponentFactoryInput) => readonly SetupComponent[]);
  now?: () => Date;
  stepTimeoutMs?: number;
  /** Test seam: replaces the catalog's known install directories during tool probing. */
  knownInstallDirs?: (platform: PlatformProfile) => string[];
}

export interface SetupRunOptions {
  mode: SetupMode;
  assumeYes?: boolean;
  signal?: AbortSignal;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class MachineSetupService {
  private readonly host: HostEnvironment;
  private readonly runner: CommandRunner;
  private readonly registry: ToolInstallerRegistry;
  private readonly doctor: SetupDoctor;
  private readonly now: () => Date;

  constructor(private readonly options: MachineSetupServiceOptions) {
    this.host = options.host ?? defaultHostEnvironment();
    this.runner = options.runner ?? new NodeCommandRunner();
    this.registry = options.registry ?? new ToolInstallerRegistry();
    this.doctor = options.doctor ?? new BuiltinSetupDoctor();
    this.now = options.now ?? (() => new Date());
  }

  /** Never throws for operational failures; they are reported in the outcome and diagnostics. */
  async run(opts: SetupRunOptions): Promise<SetupRunReport> {
    let platform: PlatformProfile;
    const early: string[] = [];
    try {
      platform = this.options.platform ?? await detectPlatformWithProbe(this.host);
    } catch (e) {
      platform = detectPlatform(this.host);
      early.push(`elevation probe failed: ${msg(e)}`);
    }
    const report: SetupRunReport = {
      mode: opts.mode, platform, observations: [], configStatus: "absent", plan: null, preview: null,
      receipts: [], doctor: null, machineWideChanges: [], outcome: "failed", diagnostics: early
    };
    try {
      await this.runInner(opts, report);
    } catch (e) {
      report.outcome = "failed";
      report.diagnostics.push(`setup failed unexpectedly: ${msg(e)}`);
    }
    return report;
  }

  private async runInner(opts: SetupRunOptions, report: SetupRunReport): Promise<void> {
    const { mode } = opts;
    const platform = report.platform;
    const now = this.now;
    const readOnly = mode === "check" || mode === "dry_run";
    const store = new SetupStateStore(platform.paths, { uid: platform.uid, now, readOnly });
    const ctx: SetupContext = { platform, runner: this.runner, mode, now, ...(opts.signal ? { signal: opts.signal } : {}) };
    const configPath = path.join(platform.paths.config, MACHINE_CONFIG_FILE);

    const explicitConfig = this.options.config === undefined ? null : MachineConfigSchema.safeParse(this.options.config);
    if (explicitConfig && !explicitConfig.success) {
      report.configStatus = "invalid";
      report.diagnostics.push(`invalid explicit machine config: ${explicitConfig.error.message}`);
      report.outcome = "blocked";
      return;
    }
    let loaded = await loadMachineConfig(configPath);
    const configBroken = loaded.status === "invalid" || loaded.status === "unsupported_version";
    if (configBroken && mode === "repair") {
      const repaired = await this.repairConfig(store, configPath);
      if (!repaired.ok) {
        report.configStatus = loaded.status;
        report.diagnostics.push(repaired.message);
        report.outcome = repaired.conflict ? "blocked" : "failed";
        return;
      }
      report.diagnostics.push(`machine config replaced with defaults; previous file backed up (${repaired.backup ?? "none"})`);
      loaded = await loadMachineConfig(configPath);
    } else if (loaded.error) {
      report.diagnostics.push(loaded.error.message);
    }
    report.configStatus = loaded.status;
    const config = explicitConfig?.success ? explicitConfig.data : loaded.config ?? defaultMachineConfig();
    const brokenNow = loaded.status === "invalid" || loaded.status === "unsupported_version";

    const required = new Set<string>([
      ...TOOL_CATALOG.filter((t) => t.defaultRequired).map((t) => t.toolId),
      ...config.providers,
      ...config.toolPins.map((pin) => pin.toolId)
    ]);
    const probe = async (): Promise<ToolObservation[]> => {
      const observed = await probeTools(platform, this.runner, {
        required,
        ...(this.options.knownInstallDirs ? { knownInstallDirs: this.options.knownInstallDirs } : {})
      });
      const native = await this.options.additionalToolObservations?.(platform, config) ?? [];
      const merged = new Map(observed.map((o) => [o.toolId, o]));
      for (const raw of native) {
        const observation = ToolObservationSchema.parse(raw);
        merged.set(observation.toolId, { ...observation, required: required.has(observation.toolId) });
      }
      return [...merged.values()];
    };
    const observations = await probe();
    report.observations = observations;

    const componentInput = { platform, store, runner: this.runner, config, observations, env: this.host.env };
    const builtComponents = this.buildComponents(componentInput);
    const components = this.options.decorateComponents?.(builtComponents.components, componentInput) ?? builtComponents.components;
    const { manifest, diagnostics } = builtComponents;
    report.diagnostics.push(...diagnostics);

    let lastDoctor: MachineDoctorReport | null = null;
    const doctor: SetupDoctor = {
      run: async (c, input) => {
        lastDoctor = await this.doctor.run(c, input);
        return lastDoctor;
      }
    };
    let freshTools = false;
    let componentFailures: NonNullable<DoctorInput["componentFailures"]> = [];
    const doctorInput = async (): Promise<DoctorInput> => {
      loaded = await loadMachineConfig(configPath);
      report.configStatus = loaded.status;
      if (freshTools) report.observations = await probe();
      return { machineId: platform.machineId, observations: report.observations, configStatus: loaded.status, components, componentFailures };
    };
    const runDoctor = async (): Promise<void> => {
      try {
        report.doctor = await doctor.run(ctx, await doctorInput());
      } catch (e) {
        report.diagnostics.push(`doctor failed: ${msg(e)}`);
      }
    };

    if (mode === "check") {
      await runDoctor();
      report.outcome = await this.checkOutcome(ctx, components, report.doctor);
      return;
    }
    if (mode === "apply" && brokenNow) {
      report.diagnostics.push(CONFIG_REPAIR_NEEDED);
      await runDoctor();
      report.outcome = "blocked";
      return;
    }

    const journal = await store.readJournal();
    const previousRevision = journal.ok && journal.value ? journal.value.revision : 0;
    if (!journal.ok) report.diagnostics.push(journal.error.message);
    const built = await buildSetupPlan({
      platform, runner: this.runner, observations, config, components, registry: this.registry, mode,
      previousRevision, now, ...(opts.signal ? { signal: opts.signal } : {})
    });
    if (!built.ok) {
      report.diagnostics.push(built.error.message);
      await runDoctor();
      report.outcome = "failed";
      return;
    }
    const { plan, preview } = built.value;
    componentFailures = built.value.componentFailures;
    report.plan = plan;
    report.preview = preview;
    report.diagnostics.push(...built.value.diagnostics);
    for (const m of preview.manual) report.diagnostics.push(`manual action required for ${m.toolId}: ${m.guidance}`);
    if (preview.needsRepair.length > 0) report.diagnostics.push(`needs repair: ${preview.needsRepair.join(", ")}; run setup --repair`);
    manifest?.bindPlan(plan);

    if (mode === "dry_run") {
      report.machineWideChanges = [...preview.machineWideChanges];
      await runDoctor();
      const pending = plan.steps.some((s) => s.stepId !== DOCTOR_STEP_ID) || preview.needsRepair.length > 0;
      report.outcome = pending ? "changes_pending" : report.doctor?.healthy ? "healthy" : "failed";
      return;
    }

    // apply / repair
    let approvalReceiptId: string | null = null;
    const supported = platform.supportStatus === "supported";
    if (supported && plan.steps.some((s) => s.requiresApproval)) {
      const approver: SetupApprover = opts.assumeYes
        ? new AssumeYesApprover(store, now)
        : typeof this.options.approver === "function"
          ? this.options.approver({ store, now })
          : this.options.approver;
      const decision = await approver.approve(plan, preview);
      if (!decision.approved) {
        report.diagnostics.push(decision.reason);
        await runDoctor();
        report.outcome = "approval_declined";
        return;
      }
      approvalReceiptId = decision.receipt.receiptId;
    }

    freshTools = plan.steps.some((s) => s.action === "install_tool");
    const executed = await executePlan(plan, {
      store, components, registry: this.registry, approvalReceiptId, ctx, preview, doctor, doctorInput,
      ...(this.options.stepTimeoutMs !== undefined ? { stepTimeoutMs: this.options.stepTimeoutMs } : {})
    });
    if (!executed.ok) {
      report.diagnostics.push(executed.error.message);
      await runDoctor();
      report.outcome = executed.error.code === "conflict" ? "blocked" : "failed";
      return;
    }
    report.receipts = executed.value;
    for (const r of executed.value) {
      if (r.status !== "applied" && r.status !== "already_satisfied") {
        for (const d of r.diagnostics) report.diagnostics.push(`${r.stepId}: ${d}`);
      }
    }
    const applied = new Set(executed.value.filter((r) => r.status === "applied").map((r) => r.stepId));
    if (this.options.launcher && applied.has("configure:path")) {
      const shellFile = preview.steps.find((s) => s.stepId === "configure:path")?.targets[0];
      report.diagnostics.push(`PATH updated; open a new terminal or reload ${shellFile ?? "your shell configuration"} to use bflow and managed tools.`);
    }
    report.machineWideChanges = preview.steps
      .filter((s) => s.machineWide && applied.has(s.stepId))
      .flatMap((s) => s.targets.map((t) => `${s.stepId}: ${t}`));

    // Post-check: reuse the doctor step's report when it ran, otherwise run the doctor now.
    const doctorRan = executed.value.some((r) => r.stepId === DOCTOR_STEP_ID && r.status !== "blocked");
    if (doctorRan && lastDoctor) report.doctor = lastDoctor;
    else await runDoctor();
    report.outcome = applyOutcome(executed.value, report.doctor);
  }

  private buildComponents(input: ComponentFactoryInput): {
    components: readonly SetupComponent[];
    manifest: EnvironmentManifestComponent | null;
    diagnostics: string[];
  } {
    const injected = this.options.components;
    if (injected !== undefined) {
      const components = typeof injected === "function" ? injected(input) : injected;
      const manifest = components.find((c): c is EnvironmentManifestComponent => c instanceof EnvironmentManifestComponent) ?? null;
      if (this.options.persistMachineConfig !== false) manifest?.bindMachineConfig(input.config);
      return { components, manifest, diagnostics: [] };
    }
    const { platform, store, runner, config, observations, env } = input;
    const pathComponent = new PathComponent({
      platform, store, env,
      ...(this.options.launcher ? { launcher: this.options.launcher } : {}),
      // Plan PATH ownership before installs: a newly created executable must be usable on the first run.
      observations: [...observations, ...config.toolPins.map((pin) => ({
        pathMissingDir: path.join(platform.paths.data, "tools", pin.toolId,
          ...(pin.method === "npm" || pin.method === "pnpm" ? ["node_modules", ".bin"] : []))
      }))]
    });
    const skills = createSkillsComponent(this.options.skills);
    const mcp = new McpConfigComponent({ platform, store, services: config.mcpServices });
    const manager = this.options.serviceManager ?? selectServiceManager(platform, runner, store);
    const services = new ServicesComponent({ platform, store, manager, services: config.services });
    const manifest = new EnvironmentManifestComponent({
      platform, store, observations, pathComponent,
      ...(this.options.persistMachineConfig !== false ? { config } : {}),
      mcpServiceIds: config.mcpServices.map((s) => s.serviceId),
      serviceIds: config.services.map((s) => s.serviceId),
      skills: skills.component
    });
    const components: SetupComponent[] = [pathComponent, ...(skills.component ? [skills.component] : []), mcp, services, manifest];
    return { components, manifest, diagnostics: skills.diagnostics };
  }

  private async repairConfig(
    store: SetupStateStore,
    configPath: string
  ): Promise<{ ok: true; backup: string | null } | { ok: false; message: string; conflict: boolean }> {
    const lock = await store.acquireLock();
    if (!lock.ok) return { ok: false, message: lock.error.message, conflict: lock.error.code === "conflict" };
    try {
      const b = await store.backupFile(configPath);
      if (!b.ok) return { ok: false, message: `machine config backup failed: ${b.error.message}`, conflict: false };
      const w = await store.writeFileAtomic(configPath, `${JSON.stringify(defaultMachineConfig(), null, 2)}\n`, 0o600);
      if (!w.ok) return { ok: false, message: `machine config rewrite failed: ${w.error.message}`, conflict: false };
      const c = await store.appendChange({
        at: this.now().toISOString(), planId: "config-repair", stepId: "repair:machine-config",
        kind: "repair_config", target: configPath, machineWide: false
      });
      if (!c.ok) return { ok: false, message: `change log write failed: ${c.error.message}`, conflict: false };
      return { ok: true, backup: b.value };
    } finally {
      await lock.value.release();
    }
  }

  /** check: pending when any component's observed state differs from its desired state. */
  private async checkOutcome(
    ctx: SetupContext,
    components: readonly SetupComponent[],
    doctor: MachineDoctorReport | null
  ): Promise<SetupOutcome> {
    if (!doctor || !doctor.healthy) return "failed";
    for (const c of components) {
      try {
        const [o, d] = [await c.observe(ctx), await c.desired(ctx)];
        if (!o.valid || o.stateDigest !== d.digest) return "changes_pending";
      } catch {
        return "failed";
      }
    }
    return "healthy";
  }
}

/** Outcome of an apply/repair run from its receipts and the post-check doctor report. */
export function applyOutcome(receipts: readonly SetupReceipt[], doctor: MachineDoctorReport | null): SetupOutcome {
  const steps = receipts.filter((r) => r.stepId !== DOCTOR_STEP_ID);
  if (steps.some((r) => r.status === "blocked" && r.diagnostics.some((d) => d === WINDOWS_NOT_VERIFIED || /^platform .* not supported$/.test(d)))) {
    return "unsupported_platform";
  }
  const anyApplied = steps.some((r) => r.status === "applied");
  if (steps.some((r) => r.status === "failed" || r.status === "unknown")) return anyApplied ? "partially_applied" : "failed";
  if (steps.some((r) => r.status === "blocked")) return anyApplied ? "partially_applied" : "blocked";
  if (!doctor || !doctor.healthy) return anyApplied ? "partially_applied" : "failed";
  return anyApplied ? "applied" : "healthy";
}
