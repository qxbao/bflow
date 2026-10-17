import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256DigestSchema,
  type OperationResult
} from "@bflow/contracts";
import { z } from "zod";
import { digest } from "./canonical.js";
import { loadMachineConfig, MachineConfigSchema, type MachineConfig } from "./machine-config.js";
import { unsupportedVersion, validationError } from "./errors.js";
import type { PathComponent } from "./path-manager.js";
import type { SetupStateStore } from "./state-store.js";
import type { ToolObservation } from "./tools.js";
import type {
  ComponentDesiredState,
  ComponentObservation,
  PlatformProfile,
  SetupComponent,
  SetupContext
} from "./types.js";

export const ENVIRONMENT_MANIFEST_FILE = "environment.json";

const ManifestToolObservationSchema = z.object({
  toolId: IdentifierSchema,
  status: z.enum(["present", "missing", "version_mismatch", "path_missing", "unparseable_version", "probe_failed"]),
  version: z.string().nullable(), resolvedPath: z.string().nullable(), binaryDigest: Sha256DigestSchema.nullable()
}).strict();

export const AfterSetupToolsSnapshotSchema = z.object({
  phase: z.literal("after_setup"), observedAt: IsoDateTimeSchema,
  tools: z.array(ManifestToolObservationSchema), snapshotDigest: Sha256DigestSchema
}).strict().refine(({ snapshotDigest, ...body }) => digest(body) === snapshotDigest,
  { message: "post-setup observation snapshot checksum mismatch" });

export const EnvironmentManifestSchema = z
  .object({
    schemaVersion: z.literal(3),
    machineId: IdentifierSchema,
    generatedAt: IsoDateTimeSchema,
    platform: z
      .object({
        os: z.enum(["linux", "darwin", "win32", "other"]),
        arch: z.string().min(1),
        shell: z.enum(["bash", "zsh", "fish", "sh", "pwsh", "cmd", "unknown"]),
        supportStatus: z.enum(["supported", "designed_unverified", "unsupported"])
      })
      .strict(),
    paths: z
      .object({ config: z.string().min(1), data: z.string().min(1), state: z.string().min(1), managedBin: z.string().min(1) })
      .strict(),
    tools: z.array(ManifestToolObservationSchema),
    /** Existing tools remain the exact pre-plan snapshot covered by the approved digest. */
    toolsSnapshotPhase: z.literal("before_setup").optional(),
    afterSetupTools: AfterSetupToolsSnapshotSchema.optional(),
    pathBlock: z.object({ target: z.string().min(1), dirs: z.array(z.string().min(1)) }).strict().nullable(),
    mcpServiceIds: z.array(IdentifierSchema),
    serviceIds: z.array(IdentifierSchema),
    skillsDigest: z.string().min(1).nullable(),
    lastPlan: z
      .object({ planId: IdentifierSchema, planDigest: Sha256DigestSchema, revision: z.number().int().positive() })
      .strict()
      .nullable()
  })
  .strict();
export type EnvironmentManifest = z.infer<typeof EnvironmentManifestSchema>;
export type ManifestPlanRef = NonNullable<EnvironmentManifest["lastPlan"]>;

/** Approved state, including the original tool snapshot. Post-setup observations are supplemental evidence. */
type ManifestBody = Omit<EnvironmentManifest, "generatedAt" | "lastPlan" | "afterSetupTools">;

export function parseEnvironmentManifest(raw: unknown): OperationResult<EnvironmentManifest> {
  const v = raw !== null && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof v === "number" && v !== 3) {
    return { ok: false, error: unsupportedVersion(`environment manifest has unsupported schemaVersion ${v}`, v) };
  }
  const parsed = EnvironmentManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: validationError(`invalid environment manifest: ${parsed.error.message}`) };
  return { ok: true, value: parsed.data };
}

/** Original approved fields retain digest coverage; new post-setup evidence has its own checksum. */
export function manifestSatisfactionDigest(m: ManifestBody | EnvironmentManifest): string {
  const { generatedAt: _g, lastPlan: _l, afterSetupTools: _p, ...body } = m as EnvironmentManifest;
  return digest(body);
}

export interface EnvironmentManifestComponentOptions {
  platform: PlatformProfile;
  store: SetupStateStore;
  /** Tool snapshot of this run (taken before the plan). */
  observations: readonly ToolObservation[];
  pathComponent?: PathComponent | null;
  mcpServiceIds: readonly string[];
  serviceIds: readonly string[];
  /** Skills component; its desired digest is recorded. */
  skills?: SetupComponent | null;
  config?: MachineConfig;
}

/** Writes `<state>/environment.json`. Records no environment values or secrets. */
export class EnvironmentManifestComponent implements SetupComponent {
  readonly componentId = "environment-manifest";
  readonly action = "configure" as const;
  readonly rollback = "restore_owned_config" as const;

  private readonly opts: EnvironmentManifestComponentOptions;
  private planned: ManifestBody | null = null;
  private lastPlan: ManifestPlanRef | null = null;
  private machineConfig: MachineConfig | null = null;
  private postSetupProbe: (() => Promise<readonly ToolObservation[]>) | null = null;

  constructor(options: EnvironmentManifestComponentOptions) {
    this.opts = options;
    if (options.config) this.bindMachineConfig(options.config);
  }

  get filePath(): string {
    return path.join(this.opts.platform.paths.state, ENVIRONMENT_MANIFEST_FILE);
  }

  /** Resolved machine configuration is persisted under the same approved component step. */
  bindMachineConfig(config: MachineConfig): void {
    this.machineConfig = MachineConfigSchema.parse(config);
  }

  /** Invoked only inside the approved manifest apply, after predecessor installation steps. */
  bindPostSetupProbe(probe: () => Promise<readonly ToolObservation[]>): void {
    this.postSetupProbe = probe;
  }

  private configFile(): string {
    return path.join(this.opts.platform.paths.config, "machine.json");
  }

  private satisfactionDigest(manifest: string | null, config: MachineConfig | null): string | null {
    return this.machineConfig ? digest({ manifest, config }) : manifest;
  }

  /** Plan recorded as `lastPlan` when the manifest is (re)written. */
  bindPlan(plan: ManifestPlanRef): void {
    this.lastPlan = { planId: plan.planId, planDigest: plan.planDigest, revision: plan.revision };
  }

  private async body(ctx: SetupContext): Promise<ManifestBody> {
    const p = this.opts.platform;
    let pathBlock: ManifestBody["pathBlock"] = null;
    const pc = this.opts.pathComponent;
    const target = pc ? pc.targetFile() : null;
    if (pc && target !== null) pathBlock = { target, dirs: await pc.desiredDirs() };
    let skillsDigest: string | null = null;
    if (this.opts.skills) {
      try {
        skillsDigest = (await this.opts.skills.desired(ctx)).digest;
      } catch {
        skillsDigest = null;
      }
    }
    return {
      schemaVersion: 3,
      machineId: p.machineId,
      platform: { os: p.os, arch: p.arch, shell: p.shell, supportStatus: p.supportStatus },
      paths: { ...p.paths },
      toolsSnapshotPhase: "before_setup",
      tools: this.opts.observations.map((o) => ({
        toolId: o.toolId,
        status: o.status,
        version: o.version,
        resolvedPath: o.resolvedPath,
        binaryDigest: o.binaryDigest
      })),
      pathBlock,
      mcpServiceIds: [...new Set(this.opts.mcpServiceIds)].sort(),
      serviceIds: [...new Set(this.opts.serviceIds)].sort(),
      skillsDigest
    };
  }

  private async load(): Promise<{ state: "absent" } | { state: "invalid"; reason: string } | { state: "valid"; manifest: EnvironmentManifest }> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
      return { state: "invalid", reason: `cannot read environment manifest: ${(e as Error).message}` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { state: "invalid", reason: "environment manifest is not valid JSON" };
    }
    const parsed = parseEnvironmentManifest(raw);
    if (!parsed.ok) return { state: "invalid", reason: parsed.error.message };
    return { state: "valid", manifest: parsed.value };
  }

  async observe(_ctx: SetupContext): Promise<ComponentObservation> {
    const loaded = await this.load();
    const diagnostics = loaded.state === "invalid" ? [`${loaded.reason}; it will be regenerated`] : [];
    const manifestDigest = loaded.state === "valid" ? manifestSatisfactionDigest(loaded.manifest) : null;
    const snapshotMissing = this.postSetupProbe !== null && loaded.state === "valid" && !loaded.manifest.afterSetupTools;
    if (snapshotMissing) diagnostics.push("post-setup tool observation is missing; the manifest will be refreshed");
    if (!this.machineConfig) return { stateDigest: manifestDigest, valid: !snapshotMissing, diagnostics };
    const config = await loadMachineConfig(this.configFile());
    if (config.status === "invalid" || config.status === "unsupported_version") {
      return { stateDigest: null, valid: false, diagnostics: [...diagnostics, "machine config requires repair"] };
    }
    return {
      stateDigest: this.satisfactionDigest(manifestDigest, config.status === "absent" ? null : config.config ?? null),
      valid: !snapshotMissing, diagnostics
    };
  }

  async desired(ctx: SetupContext): Promise<ComponentDesiredState> {
    this.planned = await this.body(ctx);
    return {
      digest: this.satisfactionDigest(manifestSatisfactionDigest(this.planned), this.machineConfig)!,
      summary: `Record the environment manifest in ${this.filePath}`,
      targets: [this.filePath, ...(this.machineConfig ? [this.configFile()] : [])],
      machineWide: false,
      repairNeeded: false
    };
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (ctx.mode === "check" || ctx.mode === "dry_run") {
      return { ownedPaths: [], diagnostics: [`environment manifest skipped in ${ctx.mode} mode; nothing written`] };
    }
    const ownedPaths: string[] = [];
    if (this.machineConfig) {
      const file = this.configFile();
      const previous = await loadMachineConfig(file);
      if (previous.status === "invalid" || previous.status === "unsupported_version") {
        return { ownedPaths: [], diagnostics: ["machine config requires repair; refusing to replace it"] };
      }
      if (previous.status === "absent" || digest(previous.config) !== digest(this.machineConfig)) {
        if (previous.status !== "absent") {
          const backup = await this.opts.store.backupFile(file);
          if (!backup.ok) return { ownedPaths: [], diagnostics: [`machine config backup failed: ${backup.error.message}`] };
        }
        const written = await this.opts.store.writeFileAtomic(file, `${JSON.stringify(this.machineConfig, null, 2)}\n`, 0o600);
        if (!written.ok) return { ownedPaths: [], diagnostics: [`machine config write failed: ${written.error.message}`] };
      }
      ownedPaths.push(file);
    }
    // Write exactly the content whose digest was planned.
    const body = this.planned ?? (await this.body(ctx));
    const loaded = await this.load();
    if (!this.postSetupProbe && loaded.state === "valid" && manifestSatisfactionDigest(loaded.manifest) === manifestSatisfactionDigest(body)) {
      return { ownedPaths: [...ownedPaths, this.filePath], diagnostics: [] };
    }
    let afterSetupTools: EnvironmentManifest["afterSetupTools"];
    if (this.postSetupProbe) {
      const tools = (await this.postSetupProbe()).map(({ toolId, status, version, resolvedPath, binaryDigest }) =>
        ManifestToolObservationSchema.parse({ toolId, status, version, resolvedPath, binaryDigest }));
      const snapshot = { phase: "after_setup" as const, observedAt: ctx.now().toISOString(), tools };
      afterSetupTools = AfterSetupToolsSnapshotSchema.parse({ ...snapshot, snapshotDigest: digest(snapshot) });
    }
    const full = EnvironmentManifestSchema.safeParse({ ...body, generatedAt: ctx.now().toISOString(), lastPlan: this.lastPlan,
      ...(afterSetupTools ? { afterSetupTools } : {}) });
    if (!full.success) return { ownedPaths: [], diagnostics: [`invalid environment manifest: ${full.error.message}`] };
    if (loaded.state !== "absent") {
      const b = await this.opts.store.backupFile(this.filePath);
      if (!b.ok) return { ownedPaths: [], diagnostics: [`backup failed: ${b.error.message}`] };
    }
    const w = await this.opts.store.writeFileAtomic(this.filePath, `${JSON.stringify(full.data, null, 2)}\n`, 0o600);
    if (!w.ok) return { ownedPaths: [], diagnostics: [`environment manifest write failed: ${w.error.message}`] };
    return { ownedPaths: [...ownedPaths, this.filePath], diagnostics: [] };
  }
}
