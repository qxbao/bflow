import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SecretReferenceSchema } from "@bflow/contracts";
import { digest } from "./canonical.js";
import type { ServiceDefinition } from "./machine-config.js";
import type { SetupStateStore } from "./state-store.js";
import type {
  CommandRunner,
  ComponentDesiredState,
  ComponentObservation,
  PlatformProfile,
  SetupComponent,
  SetupContext
} from "./types.js";

export const SERVICE_MARKER = "Managed by bflow";
export const WINDOWS_UNVERIFIED = "windows support not verified";

export interface ServiceInspection {
  installed: boolean;
  /** digest of the installed unit file content, null when not installed. */
  digest: string | null;
  active: boolean;
}

export interface ServiceInstallResult {
  ownedPaths: string[];
  diagnostics: string[];
  /** true when the unit bytes were (re)written. */
  changed: boolean;
}

export interface ServiceManagerOptions {
  /**
   * Isolation namespace for OS unit names. When set, every unit is named
   * `bflow-<namespace>-<serviceId>` (systemd) or `dev.bflow.<namespace>-<serviceId>` (launchd)
   * so an isolated setup can never collide with the user's real units. Undefined keeps the real names.
   */
  namespace?: string;
}

export interface ServiceUnregisterResult {
  /** Unit files removed by this call (empty when nothing was registered). */
  ownedPaths: string[];
  diagnostics: string[];
}

export interface ServiceManager {
  readonly kind: "systemd-user" | "launchd" | "windows-unverified";
  /** Isolation namespace in effect, or undefined for real (non-isolated) unit names. */
  readonly namespace: string | undefined;
  unitPath(serviceId: string): string;
  render(def: ServiceDefinition): string;
  inspect(serviceId: string): Promise<ServiceInspection>;
  install(def: ServiceDefinition): Promise<ServiceInstallResult>;
  /** Ids of installed bflow-marked units (read-only). */
  listInstalled(): Promise<string[]>;
  /** Stops and deletes a bflow-marked unit; only used in repair mode. */
  remove(serviceId: string): Promise<{ ownedPaths: string[]; diagnostics: string[] }>;
  /**
   * Teardown: disables/stops the unit, removes its bflow-marked unit file and reloads the manager.
   * Idempotent: unregistering an absent service succeeds with no owned paths.
   */
  unregister(serviceId: string): Promise<ServiceUnregisterResult>;
}

const ID = /^[a-z0-9-]+$/;
const NAMESPACE = /^[a-z0-9]{1,16}$/;

/**
 * Stable, short namespace derived from an isolated root directory (sha256 of the resolved path).
 * Used as `ServiceManagerOptions.namespace` so isolated unit names differ from real ones.
 */
export function isolatedServiceNamespace(isolatedRoot: string): string {
  return createHash("sha256").update(path.resolve(isolatedRoot), "utf8").digest("hex").slice(0, 12);
}

/** Tears down every bflow-marked unit visible to the manager (used by isolated test/teardown flows). */
export async function unregisterAllServices(
  manager: ServiceManager
): Promise<{ serviceIds: string[]; diagnostics: string[] }> {
  const serviceIds: string[] = [];
  const diagnostics: string[] = [];
  for (const id of await manager.listInstalled()) {
    const r = await manager.unregister(id);
    if (r.ownedPaths.length > 0) serviceIds.push(id);
    diagnostics.push(...r.diagnostics);
  }
  return { serviceIds, diagnostics };
}
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BAD_CHARS = /[\n\r\0]/;

/** Returns an error message when the definition cannot be rendered safely. */
export function validateServiceDefinition(def: ServiceDefinition): string | null {
  if (!ID.test(def.serviceId)) return `invalid service id: ${JSON.stringify(def.serviceId)}`;
  if (BAD_CHARS.test(def.program)) return `service ${def.serviceId}: program contains a control character`;
  for (const a of def.args) {
    if (BAD_CHARS.test(a)) return `service ${def.serviceId}: argument contains a control character`;
  }
  for (const [k, v] of Object.entries(def.env)) {
    if (!ENV_KEY.test(k)) return `service ${def.serviceId}: invalid environment variable name ${JSON.stringify(k)}`;
    if (BAD_CHARS.test(v)) return `service ${def.serviceId}: environment value for ${k} contains a control character`;
  }
  return null;
}

/** Secret references are never inlined: `K=secret://x` becomes `BFLOW_SECRET_REF_K=secret://x`. */
function envEntries(def: ServiceDefinition): [string, string][] {
  return Object.keys(def.env)
    .sort()
    .map((k): [string, string] => {
      const v = def.env[k]!;
      if (SecretReferenceSchema.safeParse(v).success) {
        return [`BFLOW_SECRET_REF_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, v];
      }
      return [k, v];
    });
}

const sdQuote = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

abstract class FileServiceManager implements ServiceManager {
  abstract readonly kind: "systemd-user" | "launchd";
  protected abstract readonly dir: string;
  /** Unit-name prefix before the service id: `bflow-` or `bflow-<namespace>-`. */
  protected abstract readonly prefix: string;
  /** Unit-name suffix after the service id (`.service`, `.plist`). */
  protected abstract readonly suffix: string;
  abstract render(def: ServiceDefinition): string;
  protected abstract isActive(serviceId: string): Promise<boolean>;
  protected abstract activate(def: ServiceDefinition, unit: string, replaced: boolean): Promise<string[]>;
  /** Disables/stops by unit name. `ignoreFailure` is used when nothing was registered (idempotent teardown). */
  protected abstract deactivate(serviceId: string, ignoreFailure?: boolean): Promise<string[]>;
  /** Post-removal manager reload; `ignoreFailure` as above. */
  protected abstract reloadAfterRemoval(ignoreFailure: boolean): Promise<string[]>;

  constructor(
    protected readonly platform: PlatformProfile,
    protected readonly runner: CommandRunner,
    protected readonly store: SetupStateStore,
    readonly namespace: string | undefined = undefined
  ) {
    if (namespace !== undefined && !NAMESPACE.test(namespace)) throw new Error(`invalid service namespace: ${namespace}`);
  }

  /** Service id embedded in a unit file name, or null when the file is not a unit of this manager. */
  protected idOf(fileName: string): string | null {
    if (!fileName.startsWith(this.prefix) || !fileName.endsWith(this.suffix)) return null;
    const id = fileName.slice(this.prefix.length, fileName.length - this.suffix.length);
    return id === "" ? null : id;
  }

  unitPath(serviceId: string): string {
    return path.join(this.dir, `${this.prefix}${serviceId}${this.suffix}`);
  }

  /** Name the OS manager knows the unit by (systemd `<name>.service`, launchd label). */
  protected abstract labelOf(serviceId: string): string;

  /** Runs one argv; returns a diagnostic on failure, null on success. */
  protected async exec(argv: string[], ignoreFailure = false): Promise<string | null> {
    try {
      const r = await this.runner.run(argv, { timeoutMs: 30_000 });
      if (r.exitCode === 0 || ignoreFailure) return null;
      const why = r.timedOut ? "timed out" : `exit ${r.exitCode}`;
      return `${argv.join(" ")} failed (${why}): ${r.stderr.trim()}`;
    } catch (e) {
      return ignoreFailure ? null : `${argv.join(" ")} could not run: ${errMsg(e)}`;
    }
  }

  protected async read(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  async inspect(serviceId: string): Promise<ServiceInspection> {
    const content = await this.read(this.unitPath(serviceId));
    if (content === null) return { installed: false, digest: null, active: false };
    return { installed: true, digest: digest(content), active: await this.isActive(serviceId) };
  }

  async install(def: ServiceDefinition): Promise<ServiceInstallResult> {
    const bad = validateServiceDefinition(def);
    if (bad !== null) return { ownedPaths: [], diagnostics: [bad], changed: false };
    const unit = this.unitPath(def.serviceId);
    const content = this.render(def);
    const existing = await this.read(unit);
    if (existing === content) {
      // Identical bytes: do not rewrite, but retry activation if the unit is not running.
      if (await this.isActive(def.serviceId)) return { ownedPaths: [unit], diagnostics: [], changed: false };
      return { ownedPaths: [unit], diagnostics: await this.activate(def, unit, false), changed: false };
    }
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (e) {
      return { ownedPaths: [], diagnostics: [`cannot create ${this.dir}: ${errMsg(e)}`], changed: false };
    }
    if (existing !== null) {
      const b = await this.store.backupFile(unit);
      if (!b.ok) return { ownedPaths: [], diagnostics: [`backup failed: ${b.error.message}`], changed: false };
    }
    const w = await this.store.writeFileAtomic(unit, content, 0o644);
    if (!w.ok) return { ownedPaths: [], diagnostics: [`unit write failed: ${w.error.message}`], changed: false };
    const diagnostics = await this.activate(def, unit, existing !== null);
    return { ownedPaths: [unit], diagnostics, changed: true };
  }

  async listInstalled(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names.sort()) {
      const id = this.idOf(n);
      if (id === null || !ID.test(id)) continue;
      try {
        const file = path.join(this.dir, n);
        if (!(await stat(file)).isFile()) continue;
        if ((await readFile(file, "utf8")).includes(SERVICE_MARKER)) out.push(id);
      } catch {
        // unreadable: not ours to report
      }
    }
    return out;
  }

  async remove(serviceId: string): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (!ID.test(serviceId)) return { ownedPaths: [], diagnostics: [`invalid service id: ${serviceId}`] };
    const unit = this.unitPath(serviceId);
    const existing = await this.read(unit);
    if (existing === null) return { ownedPaths: [], diagnostics: [] };
    if (!existing.includes(SERVICE_MARKER)) {
      return { ownedPaths: [], diagnostics: [`${unit} is not marked as bflow-managed; not removed`] };
    }
    const b = await this.store.backupFile(unit);
    if (!b.ok) return { ownedPaths: [], diagnostics: [`backup failed: ${b.error.message}`] };
    const diagnostics = await this.deactivate(serviceId);
    try {
      await rm(unit, { force: true });
    } catch (e) {
      diagnostics.push(`cannot remove ${unit}: ${errMsg(e)}`);
    }
    return { ownedPaths: [unit], diagnostics };
  }

  async unregister(serviceId: string): Promise<ServiceUnregisterResult> {
    if (!ID.test(serviceId)) return { ownedPaths: [], diagnostics: [`invalid service id: ${serviceId}`] };
    const unit = this.unitPath(serviceId);
    const existing = await this.read(unit);
    if (existing !== null && !existing.includes(SERVICE_MARKER)) {
      return { ownedPaths: [], diagnostics: [`${unit} is not marked as bflow-managed; not removed`] };
    }
    const owned = existing !== null;
    // Disable by name first, while the unit file still exists. When nothing is registered the
    // manager's "unknown unit" failure is the expected idempotent outcome, so it is not reported.
    const diagnostics = await this.deactivate(serviceId, !owned);
    if (owned) {
      try {
        await rm(unit, { force: true });
      } catch (e) {
        diagnostics.push(`cannot remove ${unit}: ${errMsg(e)}`);
      }
    }
    diagnostics.push(...(await this.reloadAfterRemoval(!owned)));
    return { ownedPaths: owned ? [unit] : [], diagnostics };
  }
}

export class SystemdUserServiceManager extends FileServiceManager {
  readonly kind = "systemd-user" as const;
  protected readonly dir: string;

  protected readonly prefix: string;
  protected readonly suffix = ".service";

  constructor(platform: PlatformProfile, runner: CommandRunner, store: SetupStateStore, options: ServiceManagerOptions = {}) {
    super(platform, runner, store, options.namespace);
    // paths.config is $XDG_CONFIG_HOME/bflow, so its parent is the XDG config home.
    this.dir = path.join(path.dirname(platform.paths.config), "systemd", "user");
    this.prefix = options.namespace === undefined ? "bflow-" : `bflow-${options.namespace}-`;
  }

  protected labelOf(serviceId: string): string {
    return `${this.prefix}${serviceId}${this.suffix}`;
  }

  render(def: ServiceDefinition): string {
    const lines = [
      `# ${SERVICE_MARKER} (do not edit; regenerated by bflow setup)`,
      "[Unit]",
      `Description=bflow service ${def.serviceId}`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${[def.program, ...def.args].map(sdQuote).join(" ")}`,
      `Restart=${def.keepAlive ? "on-failure" : "no"}`,
      ...envEntries(def).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
      "",
      "[Install]",
      "WantedBy=default.target",
      ""
    ];
    return lines.join("\n");
  }

  protected async isActive(serviceId: string): Promise<boolean> {
    try {
      const r = await this.runner.run(["systemctl", "--user", "is-active", this.labelOf(serviceId)], {
        timeoutMs: 10_000
      });
      return r.exitCode === 0 && r.stdout.trim() === "active";
    } catch {
      return false;
    }
  }

  protected async activate(def: ServiceDefinition, unit: string, replaced: boolean): Promise<string[]> {
    const argvs = [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit]
    ];
    if (replaced) argvs.push(["systemctl", "--user", "try-restart", this.labelOf(def.serviceId)]);
    for (const argv of argvs) {
      const d = await this.exec(argv);
      if (d !== null) return [d];
    }
    return [];
  }

  protected async deactivate(serviceId: string, ignoreFailure = false): Promise<string[]> {
    const d = await this.exec(["systemctl", "--user", "disable", "--now", this.labelOf(serviceId)], ignoreFailure);
    return d === null ? [] : [d];
  }

  protected async reloadAfterRemoval(ignoreFailure: boolean): Promise<string[]> {
    const d = await this.exec(["systemctl", "--user", "daemon-reload"], ignoreFailure);
    return d === null ? [] : [d];
  }
}

export class LaunchdServiceManager extends FileServiceManager {
  readonly kind = "launchd" as const;
  protected readonly dir: string;

  protected readonly prefix: string;
  protected readonly suffix = ".plist";

  constructor(platform: PlatformProfile, runner: CommandRunner, store: SetupStateStore, options: ServiceManagerOptions = {}) {
    super(platform, runner, store, options.namespace);
    this.dir = path.join(platform.homeDir, "Library", "LaunchAgents");
    this.prefix = options.namespace === undefined ? "dev.bflow." : `dev.bflow.${options.namespace}-`;
  }

  protected labelOf(serviceId: string): string {
    return `${this.prefix}${serviceId}`;
  }

  private get domain(): string | null {
    return this.platform.uid === null ? null : `gui/${this.platform.uid}`;
  }

  render(def: ServiceDefinition): string {
    const env = envEntries(def);
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      `<!-- ${SERVICE_MARKER} (do not edit; regenerated by bflow setup) -->`,
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>${xml(this.labelOf(def.serviceId))}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...[def.program, ...def.args].map((a) => `    <string>${xml(a)}</string>`),
      "  </array>"
    ];
    if (env.length > 0) {
      lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
      for (const [k, v] of env) lines.push(`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`);
      lines.push("  </dict>");
    }
    lines.push(
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      def.keepAlive ? "  <true/>" : "  <false/>",
      "</dict>",
      "</plist>",
      ""
    );
    return lines.join("\n");
  }

  protected async isActive(serviceId: string): Promise<boolean> {
    if (this.domain === null) return false;
    try {
      const r = await this.runner.run(["launchctl", "print", `${this.domain}/${this.labelOf(serviceId)}`], {
        timeoutMs: 10_000
      });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  override async install(def: ServiceDefinition): Promise<ServiceInstallResult> {
    if (this.domain === null) {
      return { ownedPaths: [], diagnostics: ["cannot determine the user id for launchd; nothing written"], changed: false };
    }
    return super.install(def);
  }

  protected async activate(def: ServiceDefinition, unit: string): Promise<string[]> {
    const target = `${this.domain}/${this.labelOf(def.serviceId)}`;
    await this.exec(["launchctl", "bootout", target], true);
    const d = await this.exec(["launchctl", "bootstrap", this.domain!, unit]);
    return d === null ? [] : [d];
  }

  protected async deactivate(serviceId: string): Promise<string[]> {
    if (this.domain === null) return [];
    await this.exec(["launchctl", "bootout", `${this.domain}/${this.labelOf(serviceId)}`], true);
    return [];
  }

  protected async reloadAfterRemoval(): Promise<string[]> {
    return [];
  }
}

export class WindowsUnverifiedServiceManager implements ServiceManager {
  readonly kind = "windows-unverified" as const;
  readonly namespace = undefined;
  unitPath(): string {
    return "";
  }
  render(): string {
    return "";
  }
  async inspect(): Promise<ServiceInspection> {
    return { installed: false, digest: null, active: false };
  }
  async install(): Promise<ServiceInstallResult> {
    return { ownedPaths: [], diagnostics: [WINDOWS_UNVERIFIED], changed: false };
  }
  async listInstalled(): Promise<string[]> {
    return [];
  }
  async remove(): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    return { ownedPaths: [], diagnostics: [WINDOWS_UNVERIFIED] };
  }
  async unregister(): Promise<ServiceUnregisterResult> {
    return { ownedPaths: [], diagnostics: [WINDOWS_UNVERIFIED] };
  }
}

export function selectServiceManager(
  platform: PlatformProfile,
  runner: CommandRunner,
  store: SetupStateStore,
  options: ServiceManagerOptions = {}
): ServiceManager {
  if (platform.os === "linux") return new SystemdUserServiceManager(platform, runner, store, options);
  if (platform.os === "darwin") return new LaunchdServiceManager(platform, runner, store, options);
  return new WindowsUnverifiedServiceManager();
}

export interface ServicesComponentOptions {
  platform: PlatformProfile;
  store: SetupStateStore;
  manager: ServiceManager;
  services: readonly ServiceDefinition[];
}

export class ServicesComponent implements SetupComponent {
  readonly componentId = "services";
  readonly action = "configure" as const;
  readonly rollback = "remove_owned_install" as const;

  private readonly manager: ServiceManager;
  private readonly services: readonly ServiceDefinition[];

  constructor(options: ServicesComponentOptions) {
    this.manager = options.manager;
    this.services = options.services;
  }

  private inputErrors(): string[] {
    const errs: string[] = [];
    const seen = new Set<string>();
    for (const s of this.services) {
      if (seen.has(s.serviceId)) errs.push(`duplicate service id: ${s.serviceId}`);
      seen.add(s.serviceId);
      const e = validateServiceDefinition(s);
      if (e !== null) errs.push(e);
    }
    return errs;
  }

  private valid(): ServiceDefinition[] {
    const seen = new Set<string>();
    return this.services.filter((s) => {
      if (seen.has(s.serviceId) || validateServiceDefinition(s) !== null) return false;
      seen.add(s.serviceId);
      return true;
    });
  }

  private async stale(): Promise<string[]> {
    const wanted = new Set(this.services.map((s) => s.serviceId));
    return (await this.manager.listInstalled()).filter((id) => !wanted.has(id));
  }

  async observe(_ctx: SetupContext): Promise<ComponentObservation> {
    if (this.manager.kind === "windows-unverified") {
      return { stateDigest: null, valid: true, diagnostics: [WINDOWS_UNVERIFIED] };
    }
    const diagnostics = this.inputErrors();
    const installed: Record<string, { content: string; active: boolean }> = {};
    for (const s of this.valid()) {
      const i = await this.manager.inspect(s.serviceId);
      if (!i.installed || i.digest === null) continue;
      installed[s.serviceId] = { content: i.digest, active: i.active };
      if (!i.active) diagnostics.push(`service ${s.serviceId} (${this.manager.unitPath(s.serviceId)}) is installed but not active`);
    }
    for (const id of await this.stale()) {
      diagnostics.push(`stale bflow unit not in desired set: ${this.manager.unitPath(id)} (reported, not removed)`);
    }
    return {
      stateDigest: digest(installed),
      valid: this.inputErrors().length === 0,
      diagnostics
    };
  }

  async desired(_ctx: SetupContext): Promise<ComponentDesiredState> {
    if (this.manager.kind === "windows-unverified") {
      return {
        digest: digest("windows-unsupported"),
        summary: "OS services on Windows are not verified",
        targets: [],
        machineWide: false,
        repairNeeded: false
      };
    }
    const rendered: Record<string, { content: string; active: boolean }> = {};
    for (const s of this.valid()) rendered[s.serviceId] = { content: digest(this.manager.render(s)), active: true };
    const errs = this.inputErrors();
    return {
      digest: digest(rendered),
      summary:
        errs.length > 0
          ? `Invalid service definitions: ${errs.join("; ")}`
          : `Install ${this.services.length} user-scope ${this.manager.kind} service unit(s)` +
            (this.manager.namespace === undefined ? "" : ` in isolated namespace ${this.manager.namespace}`),
      targets: this.valid().map((s) => this.manager.unitPath(s.serviceId)),
      machineWide: false,
      repairNeeded: false
    };
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (this.manager.kind === "windows-unverified") return { ownedPaths: [], diagnostics: [WINDOWS_UNVERIFIED] };
    if (ctx.mode === "check" || ctx.mode === "dry_run") {
      return { ownedPaths: [], diagnostics: [`service apply skipped in ${ctx.mode} mode; nothing written`] };
    }
    const errs = this.inputErrors();
    if (errs.length > 0) return { ownedPaths: [], diagnostics: errs };
    const ownedPaths: string[] = [];
    const diagnostics: string[] = [];
    for (const s of this.services) {
      const r = await this.manager.install(s);
      ownedPaths.push(...r.ownedPaths);
      diagnostics.push(...r.diagnostics);
    }
    if (ctx.mode === "repair") {
      for (const id of await this.stale()) {
        const r = await this.manager.remove(id);
        ownedPaths.push(...r.ownedPaths);
        diagnostics.push(...r.diagnostics);
      }
    }
    return { ownedPaths, diagnostics };
  }
}
