import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { z } from "zod";
import { OfficialProviderPluginAdapter } from "./provider-plugins.js";
import { readRegular } from "./files.js";
import {
  CURRENT_PLATFORM_SCHEMA_VERSION, SetupApplyRequestSchema, SetupReceiptSchema, SetupStepSchema,
  ToolCapabilitySchema, ToolInstallRequestSchema, VerifiedToolExecutableIdentitySchema,
  type ContractError, type OperationOptions, type OperationResult, type SetupApplyRequest,
  type SetupReceipt, type SetupStep, type ToolCapability, type ToolInstallRequest, type ToolInstaller,
  type VerifiedToolExecutableIdentity
} from "@bflow/contracts";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const fail = <T>(message: string, code: "validation" | "conflict" | "not_found" | "corruption" = "validation"): OperationResult<T> =>
  ({ ok: false, error: { code, retryable: code === "conflict", message } as ContractError });
const versionError = <T>(value: unknown): OperationResult<T> | null => {
  const inspect = (candidate: unknown): number | null => {
    if (typeof candidate !== "object" || candidate === null || !("schemaVersion" in candidate)) return null;
    const received = candidate.schemaVersion;
    return typeof received === "number" && Number.isInteger(received) && received >= 0 && received !== CURRENT_PLATFORM_SCHEMA_VERSION
      ? received : null;
  };
  const root = value && typeof value === "object" ? value as { step?: { toolInstall?: unknown } } : null;
  const received = inspect(value) ?? inspect(root?.step) ?? inspect(root?.step?.toolInstall);
  return received === null ? null : { ok: false, error: { code: "unsupported_version", retryable: false,
    supportedVersions: [3], receivedVersion: received, message: "Unsupported platform schema version" } };
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): OperationResult<T> => {
  const wrongVersion = versionError<T>(value);
  if (wrongVersion) return wrongVersion;
  const result = schema.safeParse(value);
  return result.success ? ok(result.data) : fail(result.error.message);
};

export const ManagedToolPinSchema = z.object({
  toolId: z.enum(["rtk", "gitnexus", "chrome-devtools-mcp", "mempalace", "superpowers", "claude", "codex", "agy", "herdr"]),
  installerId: z.string().min(1), version: z.string().min(1), source: z.string().url(),
  integrity: z.string().regex(/^[0-9a-f]{64}$/),
  recipe: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("npm"), packageName: z.enum(["gitnexus", "chrome-devtools-mcp", "@anthropic-ai/claude-code", "@openai/codex"]),
      executable: z.string().min(1), allowBuildScripts: z.boolean() }).strict(),
    z.object({ kind: z.literal("python_wheel"), packageName: z.literal("mempalace"),
      executable: z.literal("mempalace"), mcpExecutable: z.literal("mempalace-mcp") }).strict(),
    z.object({ kind: z.literal("rtk_archive"), archiveMember: z.enum(["rtk", "./rtk"]) }).strict(),
    z.object({ kind: z.literal("binary"), executable: z.enum(["herdr"]) }).strict(),
    z.object({ kind: z.literal("binary_archive"), archiveMember: z.literal("antigravity"), executable: z.literal("agy") }).strict(),
    z.object({ kind: z.literal("provider_plugin"), provider: z.enum(["claude", "codex", "agy"]) }).strict()
  ]),
  license: z.string().min(1)
}).strict();
export type ManagedToolPin = z.infer<typeof ManagedToolPinSchema>;

/** Relative location of the MCP stdio entry point of a Python wheel installation (null for other recipes). */
export function managedToolMcpExecutable(pin: ManagedToolPin): string | null {
  return pin.recipe.kind === "python_wheel" ? join("bin", pin.recipe.mcpExecutable) : null;
}

/** Stored artifact name. pip/uv require the original wheel filename, so a wheel keeps the reviewed filename. */
function artifactName(pin: ManagedToolPin): string {
  if (pin.recipe.kind === "npm") return "artifact.tgz";
  if (pin.recipe.kind === "python_wheel") return new URL(pin.source).pathname.split("/").pop() ?? "artifact.whl";
  return "artifact";
}

/** The venv interpreter keeps absolute paths in console-script shebangs, which break when staging is renamed
 * into place. These wrappers resolve the venv relative to themselves instead. */
function pythonWheelWrapper(module: string, attribute: string, name: string): string {
  return `#!/bin/sh
SELF=$0
while [ -h "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case $LINK in /*) SELF=$LINK ;; *) SELF=$(dirname "$SELF")/$LINK ;; esac
done
DIR=$(cd "$(dirname "$SELF")/.." && pwd -P)
exec "$DIR/venv/bin/python" -c 'import sys; sys.argv[0] = "${name}"; from ${module} import ${attribute}; sys.exit(${attribute}())' "$@"
`;
}

/** Relative executable location inside an owned installation. Native plugins have no standalone executable. */
export function managedToolExecutable(pin: ManagedToolPin): string {
  switch (pin.recipe.kind) {
    case "npm": return join("node_modules", ".bin", pin.recipe.executable);
    case "python_wheel": return join("bin", pin.recipe.executable);
    case "rtk_archive": return "rtk";
    case "binary": case "binary_archive": return pin.recipe.executable;
    case "provider_plugin": return `native:${pin.recipe.provider}`;
  }
}

export interface ProcessResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly signal?: string }
export interface ToolRunOptions {
  cwd?: string; timeoutMs?: number; signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
  input?: string;
}
export interface ToolHost {
  run(executable: string, args: readonly string[], options?: ToolRunOptions): Promise<ProcessResult>;
  download(source: string, target: string, signal?: AbortSignal): Promise<void>;
}

export const systemToolHost: ToolHost = {
  run(executable, args, options) {
    return new Promise((done, reject) => {
      if (options?.signal?.aborted) { reject(new Error("Command cancelled before start")); return; }
      if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647))
        { reject(new Error("Invalid command timeout")); return; }
      const child = spawn(executable, [...args], { cwd: options?.cwd, shell: false,
        env: { ...process.env, ...options?.environment }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", bytes = 0;
      let failure: Error | undefined;
      const stop = (message: string) => { failure ??= new Error(message); child.kill("SIGKILL"); };
      const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => stop("Command timed out"), options.timeoutMs);
      const abort = () => stop("Command cancelled");
      options?.signal?.addEventListener("abort", abort, { once: true });
      const collect = (chunk: Buffer, output: "stdout" | "stderr") => {
        bytes += chunk.length;
        if (bytes > 2_000_000) { stop("Command output exceeded 2 MB"); return; }
        if (output === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
      child.stdin.on("error", () => { /* process may close stdin before consuming the probe */ });
      child.stdin.end(options?.input);
      child.on("error", error => { failure = error; });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        if (failure) { reject(failure); return; }
        done({ exitCode: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1), stdout, stderr,
          ...(signal ? { signal } : {}) });
      });
    });
  },
  async download(source, target, signal) {
    let current = source;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(current, { ...(signal ? { signal } : {}), redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Download redirect limit exceeded");
        const next = new URL(location, current);
        if (next.protocol !== "https:" || next.username || next.password || next.hash) throw new Error("Unsafe download redirect");
        current = next.toString();
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 250_000_000 ? new Error("Download exceeds 250 MB") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as never), limit, createWriteStream(target, { flags: "wx", mode: 0o600 }));
      return;
    }
  }
};

export interface ToolInspection { status: SetupReceipt["status"]; diagnostics: string[]; ownedPaths: string[] }

export interface ManagedToolInstallerOptions {
  readonly managedRoot: string;
  readonly desiredStateContext?: Readonly<Record<string, string>>;
  readonly pins: readonly ManagedToolPin[];
  readonly host?: ToolHost;
  readonly clock?: () => Date;
  readonly providerPlugin?: ProviderPluginAdapter;
}

/** A native provider adapter owns its CLI/config protocol and must verify actual activation. */
export interface ProviderPluginAdapter {
  verify(pin: ManagedToolPin, destination: string): Promise<{ ready: boolean; diagnostic: string }>;
  activate(pin: ManagedToolPin, artifact: string, action: "install" | "update" | "repair",
    options?: OperationOptions): Promise<{ success: boolean; diagnostic: string }>;
  /** true: registered with the provider; false: proven absent; null: could not be determined. */
  registered?(pin: ManagedToolPin): Promise<boolean | null>;
}

interface OwnedMarker { toolId: string; installerId: string; version: string; integrity: string; source: string; executable: string; license: string; recipeDigest: string; }
const markerSchema = z.object({ toolId: z.string(), installerId: z.string(), version: z.string(), integrity: z.string(), source: z.string(),
  executable: z.string(), license: z.string(), recipeDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const activationIntentSchema = z.object({ schemaVersion: z.literal(3), desiredStateDigest: z.string(), stage: z.string(),
  toolId: z.string(), installerId: z.string() }).strict();

export class ManagedToolInstaller implements ToolInstaller {
  readonly installerId: string;
  readonly #root: string;
  readonly #desiredStateContext: Readonly<Record<string, string>> | undefined;
  readonly #pins: Map<string, ManagedToolPin>;
  readonly #host: ToolHost;
  readonly #clock: () => Date;
  readonly #providerPlugin: ProviderPluginAdapter | undefined;

  constructor(options: ManagedToolInstallerOptions) {
    if (!isAbsolute(options.managedRoot)) throw new Error("managedRoot must be absolute");
    this.#root = resolve(options.managedRoot);
    this.#desiredStateContext = options.desiredStateContext;
    this.#pins = new Map();
    for (const raw of options.pins) {
      const pin = ManagedToolPinSchema.parse(raw);
      if (this.#pins.has(pin.toolId)) throw new Error(`Duplicate tool pin: ${pin.toolId}`);
      const url = new URL(pin.source);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Pinned source must be HTTPS without credentials or fragment");
      if ((pin.recipe.kind === "npm" || pin.recipe.kind === "provider_plugin" || pin.recipe.kind === "python_wheel") &&
        !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pin.version)) throw new Error("Package/plugin version must be exact");
      if (pin.toolId === "rtk" && pin.recipe.kind !== "rtk_archive") throw new Error("RTK must use the rtk-ai release binary archive");
      if (pin.toolId === "rtk" && (url.hostname !== "github.com" || !url.pathname.startsWith("/rtk-ai/rtk/releases/download/")))
        throw new Error("RTK source must be an official rtk-ai/rtk release asset");
      if (pin.toolId === "gitnexus" && (pin.recipe.kind !== "npm" || pin.recipe.packageName !== "gitnexus")) throw new Error("GitNexus must use its official npm package");
      if (pin.toolId === "chrome-devtools-mcp" && (pin.recipe.kind !== "npm" || pin.recipe.packageName !== "chrome-devtools-mcp")) throw new Error("Chrome DevTools MCP must use its official npm package");
      if (pin.toolId === "mempalace" && (pin.recipe.kind !== "python_wheel" || url.hostname !== "files.pythonhosted.org" ||
        !url.pathname.startsWith("/packages/") || !/^mempalace-\d+\.\d+\.\d+-py3-none-any\.whl$/.test(artifactName(pin))))
        throw new Error("MemPalace must use its official PyPI wheel");
      if (pin.recipe.kind === "python_wheel" && pin.toolId !== "mempalace") throw new Error("Python wheel recipe is reserved for MemPalace");
      if (pin.toolId === "superpowers" && pin.recipe.kind !== "provider_plugin") throw new Error("Superpowers must use a provider plugin route");
      const providerPackage = pin.toolId === "claude" ? "@anthropic-ai/claude-code" : pin.toolId === "codex" ? "@openai/codex" : null;
      if (providerPackage && (pin.recipe.kind !== "npm" || pin.recipe.packageName !== providerPackage))
        throw new Error("Provider CLI must use its official npm package");
      if (pin.toolId === "herdr" && (pin.recipe.kind !== "binary" || url.hostname !== "github.com" ||
        !url.pathname.startsWith("/herdrdev/herdr/releases/download/"))) throw new Error("Herdr must use an official release binary");
      if (pin.toolId === "agy" && (pin.recipe.kind !== "binary_archive" || url.hostname !== "storage.googleapis.com" ||
        !url.pathname.startsWith("/antigravity-public/antigravity-cli/"))) throw new Error("Agy must use an official native archive");
      if (pin.recipe.kind === "binary" && pin.toolId !== "herdr") throw new Error("Binary recipe is reserved for Herdr");
      if (pin.recipe.kind === "binary_archive" && pin.toolId !== "agy") throw new Error("Native archive recipe is reserved for Agy");
      this.#pins.set(pin.toolId, pin);
    }
    this.installerId = options.pins[0]?.installerId ?? "bflow-managed-tools";
    if ([...this.#pins.values()].some(pin => pin.installerId !== this.installerId)) throw new Error("Mixed installer IDs");
    this.#host = options.host ?? systemToolHost;
    this.#clock = options.clock ?? (() => new Date());
    this.#providerPlugin = options.providerPlugin ?? new OfficialProviderPluginAdapter({ host: this.#host,
      configuration: { managedRoot: join(this.#root, ".native") } });
  }

  #pin(request: ToolInstallRequest): ManagedToolPin | null {
    const pin = this.#pins.get(request.toolId);
    return pin && pin.installerId === request.installerId && pin.version === request.version &&
      pin.source === request.source && pin.integrity === request.integrity ? pin : null;
  }

  async #destination(path: string): Promise<boolean> {
    const relativePath = relative(this.#root, resolve(path));
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return false;
    const pieces = relativePath.split(sep);
    if (pieces.some(part => !part || part === "." || part === "..")) return false;
    let cursor = this.#root;
    for (const piece of pieces.slice(0, -1)) {
      try { const info = await lstat(cursor); if (info.isSymbolicLink() || !info.isDirectory()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      cursor = join(cursor, piece);
    }
    try { const info = await lstat(cursor); if (info.isSymbolicLink() || !info.isDirectory()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    try { if ((await lstat(path)).isSymbolicLink()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    return true;
  }

  async plan(raw: ToolInstallRequest, _options?: OperationOptions): Promise<OperationResult<SetupStep>> {
    const parsed = parse(ToolInstallRequestSchema, raw);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const pin = this.#pin(request);
    if (!pin) return fail("Tool pin is absent or does not match approved source, version and integrity", "not_found");
    if (!(await this.#destination(request.destination))) return fail("Destination escapes managed root or traverses a symlink");
    if (pin.recipe.kind === "provider_plugin" && !this.#providerPlugin)
      return fail("Provider plugin adapter is not configured", "not_found");
    if (pin.recipe.kind === "provider_plugin" && request.scope.kind !== "machine")
      return fail("Native provider plugins require an approved machine setup scope");
    return ok(SetupStepSchema.parse({ schemaVersion: 3,
      stepId: `install-${request.toolId}${pin.recipe.kind === "provider_plugin" ? `-${pin.recipe.provider}` : ""}`, action: "install_tool",
      componentId: request.toolId, level: request.scope.kind, scope: request.scope, dependsOn: [],
      desiredStateDigest: digest(JSON.stringify({ toolId: request.toolId, version: request.version, source: request.source,
        integrity: request.integrity, destination: resolve(request.destination), recipe: pin.recipe, license: pin.license,
        ...(this.#desiredStateContext ? { context: this.#desiredStateContext } : {}) })),
      expectedStateDigest: null, requiresApproval: request.scope.kind === "machine",
      rollback: pin.recipe.kind === "provider_plugin" ? "manual" : "remove_owned_install",
      toolInstall: request, idempotencyKey: request.idempotencyKey }));
  }

  async #marker(path: string): Promise<OwnedMarker | null> {
    try {
      if (!(await lstat(path)).isDirectory()) return null;
      const markerPath = join(path, ".bflow-tool.json");
      if (!(await lstat(markerPath)).isFile()) return null;
      return markerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
    }
    catch { return null; }
  }

  async #receipt(request: SetupApplyRequest, status: SetupReceipt["status"], diagnostics: string[], ownedPaths: string[] = []): Promise<SetupReceipt> {
    return SetupReceiptSchema.parse({ schemaVersion: 3, receiptId: randomUUID(), planId: request.planId,
      planDigest: request.planDigest, stepId: request.step.stepId, scope: request.step.scope, status,
      desiredStateDigest: request.step.desiredStateDigest,
      observedStateDigest: status === "applied" || status === "already_satisfied" ? request.step.desiredStateDigest : null,
      ownedPaths, ...(request.approvalReceiptId ? { approvalReceiptId: request.approvalReceiptId } : {}),
      observedAt: this.#clock().toISOString(), diagnostics, idempotencyKey: request.step.idempotencyKey });
  }

  async #validated(raw: SetupApplyRequest): Promise<OperationResult<{ request: SetupApplyRequest; pin: ManagedToolPin }>> {
    const parsed = parse(SetupApplyRequestSchema, raw);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    if (!request.step.toolInstall) return fail("Only install_tool steps are handled by ToolInstaller");
    const planned = await this.plan(request.step.toolInstall);
    if (!planned.ok) return planned;
    if (JSON.stringify(planned.value) !== JSON.stringify(request.step)) return fail("Setup step differs from approved install plan", "conflict");
    const pin = this.#pin(request.step.toolInstall);
    if (!pin) return fail("Tool pin missing", "not_found");
    return ok({ request, pin });
  }

  /** Read-only readiness inspection; no setup approval or synthetic authority is needed. */
  async inspect(raw: ToolInstallRequest, _options?: OperationOptions): Promise<OperationResult<ToolInspection>> {
    const planned = await this.plan(raw);
    if (!planned.ok) return planned;
    const request = planned.value.toolInstall!;
    const pin = this.#pin(request);
    if (!pin) return fail("Tool pin missing", "not_found");
    return ok(await this.#observe(request.destination, pin, planned.value.desiredStateDigest));
  }

  /**
   * Inspect the executable behind an exact approved pin. A PATH probe or version label alone
   * never produces identity evidence; the owned marker, pinned artifact, and functional probe
   * must all still pass at the moment this method runs.
   * Only a fully verified executable returns the strict exported identity contract. Other
   * states use the OperationResult error branch, never a partial identity object.
   */
  async inspectExecutable(raw: ToolInstallRequest, _options?: OperationOptions): Promise<OperationResult<VerifiedToolExecutableIdentity>> {
    const planned = await this.plan(raw);
    if (!planned.ok) return planned;
    const request = planned.value.toolInstall!;
    const pin = this.#pin(request);
    if (!pin) return fail("Tool pin missing", "not_found");
    const observation = await this.#observe(request.destination, pin, planned.value.desiredStateDigest);
    if (observation.status !== "already_satisfied") return fail(observation.diagnostics.join("; ") || "Managed executable is not verified");
    if (pin.recipe.kind === "provider_plugin") return fail("Provider plugins do not expose a Bflow-managed executable identity");
    try {
      const destination = await realpath(request.destination);
      const executable = await realpath(join(destination, managedToolExecutable(pin)));
      if (!executable.startsWith(`${destination}${sep}`)) throw new Error("Executable escaped its managed installation");
      const info = await stat(executable);
      if (!info.isFile()) throw new Error("Managed executable is not a regular file");
      const executableDigest = await digestFile(executable);
      return ok(VerifiedToolExecutableIdentitySchema.parse({ schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        toolId: pin.toolId, version: pin.version, artifactIntegrity: pin.integrity,
        desiredStateDigest: planned.value.desiredStateDigest, executablePath: executable, executableDigest }));
    } catch (error) {
      return fail(`Managed executable identity could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async reconcile(raw: SetupApplyRequest, _options?: OperationOptions): Promise<OperationResult<SetupReceipt>> {
    const validated = await this.#validated(raw);
    if (!validated.ok) return validated;
    const { request, pin } = validated.value;
    const observation = await this.#observe(request.step.toolInstall!.destination, pin, request.step.desiredStateDigest);
    return ok(await this.#receipt(request, observation.status, observation.diagnostics, observation.ownedPaths));
  }

  async #observe(destination: string, pin: ManagedToolPin, desiredStateDigest: string): Promise<ToolInspection> {
    const observed = (status: SetupReceipt["status"], diagnostics: string[], ownedPaths: string[] = []): ToolInspection =>
      ({ status, diagnostics, ownedPaths });
    if (pin.recipe.kind === "provider_plugin") {
      try {
        const pendingPath = `${destination}.native-pending.json`;
        const intent = activationIntentSchema.parse(JSON.parse(await readRegular(pendingPath)));
        if (intent.desiredStateDigest !== desiredStateDigest || intent.toolId !== pin.toolId ||
          intent.installerId !== pin.installerId || !intent.stage.startsWith(`${resolve(destination)}.staging-`))
          return observed( "unknown", ["Another unresolved native activation owns this destination"], [pendingPath]);
        let observationPath = intent.stage;
        try { await lstat(observationPath); } catch { observationPath = destination; }
        let observation = await this.#providerPlugin!.verify(pin, observationPath);
        // Older interrupted activations wrote native metadata only after the command returned.
        // The retained installation may still prove this exact desired pin in the active cache.
        if (!observation.ready && observationPath !== destination) {
          const existing = await this.#providerPlugin!.verify(pin, destination);
          // The installed destination is what the owner relies on; an unrecorded stage cannot explain its failure.
          if (existing.ready || !(await this.#hasNativeRecord(observationPath))) { observation = existing; observationPath = destination; }
        }
        if (!observation.ready && await this.#providerPlugin!.registered?.(pin) === false)
          return observed( "blocked", [observation.diagnostic, "Interrupted native activation left nothing registered with the provider; the next apply discards it and retries"],
            [observationPath, pendingPath]);
        return observed( observation.ready ? "already_satisfied" : "unknown",
          [observation.diagnostic, "Native activation intent retained; no automatic replay"], [observationPath, pendingPath]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return observed( "unknown", ["Native activation intent could not be reconciled"]);
      }
    }
    const marker = await this.#marker(destination);
    if (!marker) {
      if (pin.recipe.kind === "provider_plugin" && this.#providerPlugin) {
        try {
          const observation = await this.#providerPlugin.verify(pin, destination);
          if (observation.ready) return observed( "already_satisfied",
            [`Existing provider plugin verified without claiming ownership: ${observation.diagnostic}`]);
        } catch { /* report the missing or unowned destination below */ }
      }
      try { await lstat(destination); return observed( "blocked", ["Destination exists without a valid Bflow ownership marker"]); }
      catch { return observed( "blocked", ["Tool is not installed"]); }
    }
    if (marker.toolId !== pin.toolId || marker.installerId !== pin.installerId || marker.version !== pin.version || marker.integrity !== pin.integrity ||
      marker.source !== pin.source || marker.license !== pin.license || marker.recipeDigest !== digest(JSON.stringify(pin.recipe)))
      return observed( "blocked", ["Installed tool differs from approved pin"], [destination]);
    const probe = await this.#probe(destination, pin);
    return observed( probe ? "already_satisfied" : "blocked", [probe ? "Pinned tool verified" : "Executable verification failed"], [destination]);
  }

  async #probe(destination: string, pin: ManagedToolPin): Promise<boolean> {
    const artifact = join(destination, artifactName(pin));
    try { if (await digestFile(artifact) !== pin.integrity) return false; }
    catch { return false; }
    if (pin.recipe.kind === "provider_plugin") {
      try { return (await this.#providerPlugin?.verify(pin, destination))?.ready === true; }
      catch { return false; }
    }
    const executable = join(destination, managedToolExecutable(pin));
    try {
      const path = await realpath(executable);
      const canonicalDestination = await realpath(destination);
      if (!path.startsWith(`${canonicalDestination}${sep}`)) return false;
      const version = await this.#host.run(executable, ["--version"], { timeoutMs: 30_000 });
      const escapedVersion = pin.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (version.exitCode !== 0 || !new RegExp(`(^|[^0-9])${escapedVersion}(?![0-9.])`).test(version.stdout + version.stderr)) return false;
      if (pin.recipe.kind === "npm") {
        z.object({ name: z.literal(pin.recipe.packageName), version: z.literal(pin.version),
          license: z.literal(pin.license) }).passthrough().parse(JSON.parse(await readFile(join(destination, "node_modules", pin.recipe.packageName, "package.json"), "utf8")));
      }
      if (pin.toolId === "rtk") {
        const gain = await this.#host.run(executable, ["gain"], { timeoutMs: 15_000 });
        return gain.exitCode === 0 && (gain.stdout + gain.stderr).trim().length > 0;
      }
      return true;
    } catch { return false; }
  }

  async apply(raw: SetupApplyRequest, options?: OperationOptions): Promise<OperationResult<SetupReceipt>> {
    const validated = await this.#validated(raw);
    if (!validated.ok) return validated;
    const { request, pin } = validated.value;
    const destination = resolve(request.step.toolInstall!.destination);
    if (options?.signal?.aborted) return ok(await this.#receipt(request, "blocked", ["Operation cancelled before install"]));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (!(await this.#destination(destination))) return fail("Destination changed to an unsafe path before installation");
    const lockPath = `${destination}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { return ok(await this.#receipt(request, "blocked", ["Another install or repair owns the destination lock"])); }
    const stage = `${destination}.staging-${randomUUID()}`;
    const pendingPath = `${destination}.native-pending.json`;
    let preserveStage = false;
    let backup: string | null = null;
    try {
      if (pin.recipe.kind === "provider_plugin") await this.#discardUndelivered(destination, pin, request.step.desiredStateDigest);
      const current = await this.reconcile(request);
      if (current.ok && current.value.status === "already_satisfied") return current;
      if (current.ok && current.value.status === "unknown") return current;
      try {
        await lstat(destination);
        const marker = await this.#marker(destination);
        if (!marker || marker.toolId !== pin.toolId || marker.installerId !== pin.installerId)
          return ok(await this.#receipt(request, "blocked", ["Destination belongs to another tool or installer"]));
      }
      catch { /* absent */ }
      await mkdir(stage, { mode: 0o700 });
      const artifact = join(stage, artifactName(pin));
      await this.#host.download(pin.source, artifact, options?.signal);
      if (await digestFile(artifact) !== pin.integrity) return ok(await this.#receipt(request, "failed", ["Downloaded artifact SHA-256 mismatch"]));
      if (pin.recipe.kind === "npm") {
        const result = await this.#host.run("npm", ["install", "--prefix", stage, "--no-save", "--package-lock=false",
          ...(pin.recipe.allowBuildScripts ? [] : ["--ignore-scripts"]), artifact], { timeoutMs: options?.timeoutMs ?? 180_000,
          ...(options?.signal ? { signal: options.signal } : {}) });
        if (result.exitCode !== 0) return ok(await this.#receipt(request, "failed", [`npm install exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`]));
        const manifest = JSON.parse(await readFile(join(stage, "node_modules", pin.recipe.packageName, "package.json"), "utf8")) as { name?: string; version?: string; license?: string };
        if (manifest.name !== pin.recipe.packageName || manifest.version !== pin.version) return ok(await this.#receipt(request, "failed", ["Installed package identity/version mismatch"]));
        if (manifest.license !== pin.license) return ok(await this.#receipt(request, "failed", ["Installed package license differs from reviewed pin"]));
      } else if (pin.recipe.kind === "python_wheel") {
        const failure = await this.#installPythonWheel(stage, artifact, pin, options);
        if (failure) return ok(await this.#receipt(request, "failed", [failure]));
      } else if (pin.recipe.kind === "binary") {
        await copyFile(artifact, join(stage, pin.recipe.executable));
        await chmod(join(stage, pin.recipe.executable), 0o700);
      } else if (pin.recipe.kind === "rtk_archive" || pin.recipe.kind === "binary_archive") {
        const listing = await this.#host.run("tar", ["-tzf", artifact], { timeoutMs: 60_000 });
        if (listing.exitCode !== 0 || !listing.stdout.split("\n").includes(pin.recipe.archiveMember)) return ok(await this.#receipt(request, "failed", ["RTK archive lacks expected binary"]));
        const extracted = await this.#host.run("tar", ["-xzf", artifact, "-C", stage, pin.recipe.archiveMember], { timeoutMs: 60_000 });
        if (extracted.exitCode !== 0) return ok(await this.#receipt(request, "failed", ["RTK archive extraction failed"]));
        const binary = join(stage, pin.recipe.archiveMember);
        const info = await lstat(binary);
        if (!info.isFile() || info.isSymbolicLink()) return ok(await this.#receipt(request, "failed", ["RTK archive member is not a regular binary"]));
        if (pin.recipe.kind === "binary_archive") await rename(binary, join(stage, pin.recipe.executable));
        await chmod(join(stage, managedToolExecutable(pin)), 0o700);
      } else {
        const marker = await this.#marker(destination);
        const action = !marker ? "install" : marker.version !== pin.version ? "update" : "repair";
        const intentFile = await open(pendingPath, "wx", 0o600);
        try { await intentFile.writeFile(JSON.stringify({ schemaVersion: 3, desiredStateDigest: request.step.desiredStateDigest,
          stage, toolId: pin.toolId, installerId: pin.installerId })); await intentFile.sync(); }
        finally { await intentFile.close(); }
        preserveStage = true;
        let activation;
        try { activation = await this.#providerPlugin!.activate(pin, artifact, action, options); }
        catch (error) { return ok(await this.#receipt(request, "unknown", [`Provider plugin activation interrupted: ${String(error)}`], [stage, pendingPath])); }
        if (!activation.success) return ok(await this.#receipt(request, "unknown", [activation.diagnostic], [stage, pendingPath]));
        const observation = await this.#providerPlugin!.verify(pin, stage);
        if (!observation.ready)
          return ok(await this.#receipt(request, "unknown", [observation.diagnostic], [stage, pendingPath]));
      }
      const executable = managedToolExecutable(pin);
      await writeFile(join(stage, ".bflow-tool.json"), JSON.stringify({ toolId: pin.toolId, installerId: pin.installerId, version: pin.version,
        integrity: pin.integrity, source: pin.source, executable, license: pin.license,
        recipeDigest: digest(JSON.stringify(pin.recipe)) }), { mode: 0o600 });
      // Verify in stage before replacing a known-good installation.
      if (!(await this.#probe(stage, pin))) return ok(await this.#receipt(request, "failed", ["Installed executable did not pass version/function probe"]));
      try { await stat(destination); backup = `${destination}.previous-${randomUUID()}`; await rename(destination, backup); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await rename(stage, destination); }
      catch (error) { if (backup) await rename(backup, destination); throw error; }
      if (pin.recipe.kind === "provider_plugin") await rm(pendingPath, { force: true });
      preserveStage = false;
      return ok(await this.#receipt(request, "applied", [backup ? `Previous owned install retained at ${backup}` : "Installed and verified"], [destination, ...(backup ? [backup] : [])]));
    } catch (error) {
      return ok(await this.#receipt(request, "unknown", [`Install interrupted or failed: ${String(error)}`],
        [...(backup ? [backup] : []), ...(preserveStage ? [stage, pendingPath] : [])]));
    } finally {
      if (!preserveStage) await rm(stage, { recursive: true, force: true });
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  /** Creates a private venv in the stage and installs the digest-verified wheel. Returns a failure diagnostic or null.
   * Transitive Python dependencies are resolved by uv/pip and are not a fully locked offline bundle. */
  async #installPythonWheel(stage: string, artifact: string, pin: ManagedToolPin, options?: OperationOptions): Promise<string | null> {
    if (pin.recipe.kind !== "python_wheel") return "Not a Python wheel recipe";
    const timeout = { timeoutMs: options?.timeoutMs ?? 600_000, ...(options?.signal ? { signal: options.signal } : {}) };
    const environment = { UV_PYTHON_DOWNLOADS: "never", PIP_REQUIRE_VIRTUALENV: "0", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
    const venv = join(stage, "venv");
    const python = join(venv, "bin", "python");
    const uv = await this.#host.run("uv", ["--version"], { timeoutMs: 15_000 }).catch(() => null);
    const attempts: Array<{ name: string; create: () => Promise<ProcessResult>; install: () => Promise<ProcessResult> }> = [];
    if (uv?.exitCode === 0) attempts.push({ name: "uv",
      create: () => this.#host.run("uv", ["venv", "--quiet", venv], { ...timeout, environment }),
      install: () => this.#host.run("uv", ["pip", "install", "--quiet", "--python", python, artifact], { ...timeout, environment }) });
    attempts.push({ name: "python3",
      create: () => this.#host.run("python3", ["-m", "venv", venv], { ...timeout, environment }),
      install: () => this.#host.run(python, ["-m", "pip", "install", "--quiet", artifact], { ...timeout, environment }) });
    let failure = "no Python runtime found";
    let installed = false;
    for (const attempt of attempts) {
      await rm(venv, { recursive: true, force: true });
      if (options?.signal?.aborted) return "Operation cancelled before install";
      const created = await attempt.create().catch(error => ({ exitCode: 1, stdout: "", stderr: String(error) }));
      if (created.exitCode !== 0) { failure = `${attempt.name} virtualenv creation failed: ${created.stderr.slice(0, 300)}`; continue; }
      const result = await attempt.install().catch(error => ({ exitCode: 1, stdout: "", stderr: String(error) }));
      if (result.exitCode !== 0) { failure = `${attempt.name} package install exited ${result.exitCode}: ${result.stderr.slice(0, 400)}`; continue; }
      installed = true; break;
    }
    if (!installed) return `Python install failed (need uv or python3 >= 3.9 on PATH): ${failure}`;
    const identity = await this.#host.run(python, ["-c",
      "import importlib.metadata as m; d = m.distribution('mempalace'); print(d.metadata['Name'], d.version, d.metadata.get('License-Expression') or d.metadata.get('License') or '')"],
      { timeoutMs: 30_000, environment });
    const [name, version, ...license] = identity.stdout.trim().split(/\s+/);
    if (identity.exitCode !== 0 || name?.toLowerCase() !== pin.recipe.packageName || version !== pin.version)
      return "Installed package identity/version mismatch";
    if (license.join(" ") !== pin.license) return "Installed package license differs from reviewed pin";
    const bin = join(stage, "bin");
    await mkdir(bin, { mode: 0o700 });
    await writeFile(join(bin, pin.recipe.executable), pythonWheelWrapper("mempalace.cli", "main", pin.recipe.executable), { mode: 0o700 });
    await writeFile(join(bin, pin.recipe.mcpExecutable), pythonWheelWrapper("mempalace.mcp_proxy", "main", pin.recipe.mcpExecutable), { mode: 0o700 });
    return null;
  }

  /** An interrupted native activation is retained as unknown, because replaying a mutation that may have happened is unsafe.
   * When the provider's own inventory proves nothing was registered, there is nothing to replay: archive the intent and
   * drop its stage so the install can run again. Callers hold the destination lock. */
  async #discardUndelivered(destination: string, pin: ManagedToolPin, desiredStateDigest: string): Promise<void> {
    const pendingPath = `${destination}.native-pending.json`;
    let intent;
    try { intent = activationIntentSchema.parse(JSON.parse(await readRegular(pendingPath))); }
    catch { return; }
    if (intent.desiredStateDigest !== desiredStateDigest || intent.toolId !== pin.toolId ||
      intent.installerId !== pin.installerId || !intent.stage.startsWith(`${destination}.staging-`)) return;
    let observationPath = intent.stage;
    try { await lstat(observationPath); } catch { observationPath = destination; }
    const observation = await this.#providerPlugin!.verify(pin, observationPath);
    // A stage that never recorded native metadata made no provider mutation of its own: once the owned
    // destination proves this exact pin in the provider's active cache, the intent is resolved.
    const resolved = !observation.ready && observationPath !== destination && !(await this.#hasNativeRecord(observationPath)) &&
      await this.#marker(destination) !== null && (await this.#providerPlugin!.verify(pin, destination)).ready;
    if (!resolved && (observation.ready || await this.#providerPlugin!.registered?.(pin) !== false)) return;
    await rename(pendingPath, `${pendingPath}.reviewed-${randomUUID()}`);
    await rm(intent.stage, { recursive: true, force: true });
  }

  async #hasNativeRecord(stage: string): Promise<boolean> {
    try { return (await lstat(join(stage, ".bflow-native.json"))).isFile(); } catch { return false; }
  }

  /** Explicit operator recovery after inspecting an uncertain native mutation; never called by apply/reconcile. */
  async retryNativeAfterReview(raw: SetupApplyRequest, expectedIntentDigest: string, options?: OperationOptions): Promise<OperationResult<SetupReceipt>> {
    const validated = await this.#validated(raw);
    if (!validated.ok) return validated;
    const { request, pin } = validated.value;
    if (pin.recipe.kind !== "provider_plugin" || !/^[a-f0-9]{64}$/.test(expectedIntentDigest)) return fail("Invalid native recovery request");
    const destination = resolve(request.step.toolInstall!.destination);
    const pendingPath = `${destination}.native-pending.json`;
    const lock = await open(`${destination}.lock`, "wx", 0o600).catch(() => null);
    if (!lock) return fail("Another setup operation owns this destination", "conflict");
    const reviewed = `${pendingPath}.reviewed-${randomUUID()}`;
    let oldStage = "";
    try {
      const content = await readRegular(pendingPath);
      const intent = activationIntentSchema.parse(JSON.parse(content));
      if (digest(content) !== expectedIntentDigest || intent.desiredStateDigest !== request.step.desiredStateDigest ||
        !intent.stage.startsWith(`${destination}.staging-`)) return fail("Native activation intent changed after operator review", "conflict");
      oldStage = intent.stage;
      await rename(pendingPath, reviewed);
    } finally { await lock.close(); await rm(`${destination}.lock`, { force: true }); }
    const result = await this.apply(request, options);
    if (!result.ok) return result;
    return ok(SetupReceiptSchema.parse({ ...result.value, ownedPaths: [...result.value.ownedPaths, reviewed, oldStage],
      diagnostics: [...result.value.diagnostics, "Prior native mutation was explicitly reviewed before this retry"] }));
  }
}

export function createToolCapability(toolId: "rtk" | "gitnexus" | "chrome-devtools-mcp" | "mempalace" | "context7" | "superpowers", version: string, repositoryId: string): ToolCapability {
  const definitions = {
    rtk: { kind: "cli_only", operations: ["optimize_output", "gain"], resource: { sharing: "concurrent", maxConcurrency: 64 } },
    gitnexus: { kind: "stdio_mcp", operations: ["query", "context", "impact"], resource: { sharing: "exclusive", resourceKey: `gitnexus-${repositoryId}` } },
    "chrome-devtools-mcp": { kind: "stdio_mcp", operations: ["list_pages", "new_page", "navigate_page"], resource: { sharing: "exclusive", resourceKey: `chrome-${repositoryId}` } },
    mempalace: { kind: "stdio_mcp", operations: ["mempalace_search"], resource: { sharing: "concurrent", maxConcurrency: 16 } },
    context7: { kind: "native_remote_mcp", operations: ["resolve-library-id", "query-docs"], resource: { sharing: "concurrent", maxConcurrency: 16 } },
    superpowers: { kind: "cli_only", operations: ["skills_instruction"], resource: { sharing: "concurrent", maxConcurrency: 64 } }
  } as const;
  return ToolCapabilitySchema.parse({ schemaVersion: 3, toolId, version, ...definitions[toolId], required: false });
}
