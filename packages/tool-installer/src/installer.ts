import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  CURRENT_PLATFORM_SCHEMA_VERSION, SetupApplyRequestSchema, SetupReceiptSchema, SetupStepSchema,
  ToolCapabilitySchema, ToolInstallRequestSchema,
  type ContractError, type OperationOptions, type OperationResult, type SetupApplyRequest,
  type SetupReceipt, type SetupStep, type ToolCapability, type ToolInstallRequest, type ToolInstaller
} from "@bflow/contracts";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const fail = <T>(message: string, code: "validation" | "conflict" | "not_found" | "corruption" = "validation"): OperationResult<T> =>
  ({ ok: false, error: { code, retryable: code === "conflict", message } as ContractError });
const versionError = <T>(value: unknown): OperationResult<T> | null => {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) return null;
  const received = value.schemaVersion;
  return typeof received === "number" && Number.isInteger(received) && received >= 0 && received !== CURRENT_PLATFORM_SCHEMA_VERSION
    ? { ok: false, error: { code: "unsupported_version", retryable: false, supportedVersions: [3], receivedVersion: received, message: "Unsupported platform schema version" } }
    : null;
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): OperationResult<T> => {
  const wrongVersion = versionError<T>(value);
  if (wrongVersion) return wrongVersion;
  const result = schema.safeParse(value);
  return result.success ? ok(result.data) : fail(result.error.message);
};

export const ManagedToolPinSchema = z.object({
  toolId: z.enum(["rtk", "claude-mem", "gitnexus", "chrome-devtools-mcp", "superpowers"]),
  installerId: z.string().min(1), version: z.string().min(1), source: z.string().url(),
  integrity: z.string().regex(/^[0-9a-f]{64}$/),
  recipe: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("npm"), packageName: z.enum(["claude-mem", "gitnexus", "chrome-devtools-mcp"]),
      executable: z.string().min(1), allowBuildScripts: z.boolean() }).strict(),
    z.object({ kind: z.literal("rtk_archive"), archiveMember: z.enum(["rtk", "./rtk"]) }).strict(),
    z.object({ kind: z.literal("provider_plugin"), provider: z.enum(["claude", "codex", "agy"]) }).strict()
  ]),
  license: z.string().min(1)
}).strict();
export type ManagedToolPin = z.infer<typeof ManagedToolPinSchema>;

export interface ProcessResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export interface ToolHost {
  run(executable: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessResult>;
  download(source: string, target: string, signal?: AbortSignal): Promise<void>;
}

export const systemToolHost: ToolHost = {
  run(executable, args, options) {
    return new Promise((done, reject) => {
      const child = spawn(executable, [...args], { cwd: options?.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], signal: options?.signal });
      let stdout = "", stderr = "";
      const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 2_000_000) child.kill("SIGTERM"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 2_000_000) child.kill("SIGTERM"); });
      child.on("error", error => { if (timer) clearTimeout(timer); reject(error); });
      child.on("close", code => { if (timer) clearTimeout(timer); done({ exitCode: code ?? 1, stdout, stderr }); });
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

export interface ManagedToolInstallerOptions {
  readonly managedRoot: string;
  readonly pins: readonly ManagedToolPin[];
  readonly host?: ToolHost;
  readonly clock?: () => Date;
}

interface OwnedMarker { toolId: string; version: string; integrity: string; source: string; executable: string; }
const markerSchema = z.object({ toolId: z.string(), version: z.string(), integrity: z.string(), source: z.string(), executable: z.string() }).strict();

export class ManagedToolInstaller implements ToolInstaller {
  readonly installerId: string;
  readonly #root: string;
  readonly #pins: Map<string, ManagedToolPin>;
  readonly #host: ToolHost;
  readonly #clock: () => Date;

  constructor(options: ManagedToolInstallerOptions) {
    if (!isAbsolute(options.managedRoot)) throw new Error("managedRoot must be absolute");
    this.#root = resolve(options.managedRoot);
    this.#pins = new Map();
    for (const raw of options.pins) {
      const pin = ManagedToolPinSchema.parse(raw);
      if (this.#pins.has(pin.toolId)) throw new Error(`Duplicate tool pin: ${pin.toolId}`);
      const url = new URL(pin.source);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Pinned source must be HTTPS without credentials or fragment");
      if (pin.recipe.kind === "npm" && !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pin.version)) throw new Error("npm package version must be exact");
      if (pin.toolId === "claude-mem" && pin.recipe.kind === "npm") throw new Error("Claude-Mem npm SDK is not a plugin installation; use provider-specific installation");
      if (pin.toolId === "rtk" && pin.recipe.kind !== "rtk_archive") throw new Error("RTK must use the rtk-ai release binary archive");
      if (pin.toolId === "gitnexus" && (pin.recipe.kind !== "npm" || pin.recipe.packageName !== "gitnexus")) throw new Error("GitNexus must use its official npm package");
      if (pin.toolId === "chrome-devtools-mcp" && (pin.recipe.kind !== "npm" || pin.recipe.packageName !== "chrome-devtools-mcp")) throw new Error("Chrome DevTools MCP must use its official npm package");
      if (pin.toolId === "superpowers" && pin.recipe.kind !== "provider_plugin") throw new Error("Superpowers must use a provider plugin route");
      if (pin.toolId === "gitnexus" && pin.license !== "PolyForm-Noncommercial-1.0.0") throw new Error("GitNexus license must be reviewed for the pinned version");
      this.#pins.set(pin.toolId, pin);
    }
    this.installerId = options.pins[0]?.installerId ?? "bflow-managed-tools";
    if ([...this.#pins.values()].some(pin => pin.installerId !== this.installerId)) throw new Error("Mixed installer IDs");
    this.#host = options.host ?? systemToolHost;
    this.#clock = options.clock ?? (() => new Date());
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
    if (pin.recipe.kind === "provider_plugin") return fail("Native plugin installation needs a provider-specific verified installer; use the documented manual route", "not_found");
    return ok(SetupStepSchema.parse({ schemaVersion: 3, stepId: `install-${request.toolId}`, action: "install_tool",
      componentId: request.toolId, level: request.scope.kind, scope: request.scope, dependsOn: [],
      desiredStateDigest: digest(JSON.stringify({ toolId: request.toolId, version: request.version, source: request.source, integrity: request.integrity, destination: resolve(request.destination) })),
      expectedStateDigest: null, requiresApproval: request.scope.kind === "machine", rollback: "remove_owned_install",
      toolInstall: request, idempotencyKey: request.idempotencyKey }));
  }

  async #marker(path: string): Promise<OwnedMarker | null> {
    try { return markerSchema.parse(JSON.parse(await readFile(join(path, ".bflow-tool.json"), "utf8"))); }
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

  async reconcile(raw: SetupApplyRequest, _options?: OperationOptions): Promise<OperationResult<SetupReceipt>> {
    const validated = await this.#validated(raw);
    if (!validated.ok) return validated;
    const { request, pin } = validated.value;
    const destination = request.step.toolInstall!.destination;
    const marker = await this.#marker(destination);
    if (!marker) {
      try { await lstat(destination); return ok(await this.#receipt(request, "blocked", ["Destination exists without a valid Bflow ownership marker"])); }
      catch { return ok(await this.#receipt(request, "blocked", ["Tool is not installed"])); }
    }
    if (marker.toolId !== pin.toolId || marker.version !== pin.version || marker.integrity !== pin.integrity || marker.source !== pin.source)
      return ok(await this.#receipt(request, "blocked", ["Installed tool differs from approved pin"], [destination]));
    const probe = await this.#probe(destination, pin);
    return ok(await this.#receipt(request, probe ? "already_satisfied" : "blocked", [probe ? "Pinned tool verified" : "Executable verification failed"], [destination]));
  }

  async #probe(destination: string, pin: ManagedToolPin): Promise<boolean> {
    if (pin.recipe.kind === "provider_plugin") return false;
    const executable = pin.recipe.kind === "rtk_archive" ? join(destination, "rtk") : join(destination, "node_modules", ".bin", pin.recipe.executable);
    try {
      const path = await realpath(executable);
      const canonicalDestination = await realpath(destination);
      if (!path.startsWith(`${canonicalDestination}${sep}`)) return false;
      const version = await this.#host.run(executable, ["--version"], { timeoutMs: 15_000 });
      if (version.exitCode !== 0 || !version.stdout.includes(pin.version) && !version.stderr.includes(pin.version)) return false;
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
    const lockPath = `${destination}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { return ok(await this.#receipt(request, "blocked", ["Another install or repair owns the destination lock"])); }
    const stage = `${destination}.staging-${randomUUID()}`;
    let backup: string | null = null;
    try {
      const current = await this.reconcile(request);
      if (current.ok && current.value.status === "already_satisfied") return current;
      try { await lstat(destination); if (!(await this.#marker(destination))) return ok(await this.#receipt(request, "blocked", ["Unowned destination cannot be replaced"])); }
      catch { /* absent */ }
      await mkdir(stage, { mode: 0o700 });
      const artifact = join(stage, "artifact");
      await this.#host.download(pin.source, artifact, options?.signal);
      if (digest(await readFile(artifact)) !== pin.integrity) return ok(await this.#receipt(request, "failed", ["Downloaded artifact SHA-256 mismatch"]));
      if (pin.recipe.kind === "npm") {
        const result = await this.#host.run("npm", ["install", "--prefix", stage, "--no-save", "--package-lock=false",
          ...(pin.recipe.allowBuildScripts ? [] : ["--ignore-scripts"]), artifact], { timeoutMs: options?.timeoutMs ?? 180_000,
          ...(options?.signal ? { signal: options.signal } : {}) });
        if (result.exitCode !== 0) return ok(await this.#receipt(request, "failed", [`npm install exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`]));
        const manifest = JSON.parse(await readFile(join(stage, "node_modules", pin.recipe.packageName, "package.json"), "utf8")) as { name?: string; version?: string; license?: string };
        if (manifest.name !== pin.recipe.packageName || manifest.version !== pin.version) return ok(await this.#receipt(request, "failed", ["Installed package identity/version mismatch"]));
        if (manifest.license !== pin.license) return ok(await this.#receipt(request, "failed", ["Installed package license differs from reviewed pin"]));
      } else if (pin.recipe.kind === "rtk_archive") {
        const listing = await this.#host.run("tar", ["-tzf", artifact], { timeoutMs: 15_000 });
        if (listing.exitCode !== 0 || !listing.stdout.split("\n").includes(pin.recipe.archiveMember)) return ok(await this.#receipt(request, "failed", ["RTK archive lacks expected binary"]));
        const extracted = await this.#host.run("tar", ["-xzf", artifact, "-C", stage, pin.recipe.archiveMember], { timeoutMs: 15_000 });
        if (extracted.exitCode !== 0) return ok(await this.#receipt(request, "failed", ["RTK archive extraction failed"]));
        const binary = join(stage, "rtk");
        const info = await lstat(binary);
        if (!info.isFile() || info.isSymbolicLink()) return ok(await this.#receipt(request, "failed", ["RTK archive member is not a regular binary"]));
        await chmod(join(stage, "rtk"), 0o700);
      } else return ok(await this.#receipt(request, "blocked", ["Provider plugin installation is not automated"]));
      const executable = pin.recipe.kind === "rtk_archive" ? "rtk" : join("node_modules", ".bin", pin.recipe.executable);
      await writeFile(join(stage, ".bflow-tool.json"), JSON.stringify({ toolId: pin.toolId, version: pin.version, integrity: pin.integrity, source: pin.source, executable }), { mode: 0o600 });
      // Verify in stage before replacing a known-good installation.
      if (!(await this.#probe(stage, pin))) return ok(await this.#receipt(request, "failed", ["Installed executable did not pass version/function probe"]));
      try { await stat(destination); backup = `${destination}.previous-${randomUUID()}`; await rename(destination, backup); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await rename(stage, destination); }
      catch (error) { if (backup) await rename(backup, destination); throw error; }
      return ok(await this.#receipt(request, "applied", [backup ? `Previous owned install retained at ${backup}` : "Installed and verified"], [destination, ...(backup ? [backup] : [])]));
    } catch (error) {
      return ok(await this.#receipt(request, "unknown", [`Install interrupted or failed: ${String(error)}`], backup ? [backup] : []));
    } finally {
      await rm(stage, { recursive: true, force: true });
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

export function createToolCapability(toolId: ManagedToolPin["toolId"], version: string, repositoryId: string): ToolCapability {
  const definitions = {
    rtk: { kind: "cli_only", operations: ["optimize_output", "gain"], resource: { sharing: "concurrent", maxConcurrency: 64 } },
    "claude-mem": { kind: "existing_shared_worker", operations: ["memory_search"], resource: { sharing: "concurrent", maxConcurrency: 8 } },
    gitnexus: { kind: "stdio_mcp", operations: ["code_query", "code_context", "impact"], resource: { sharing: "exclusive", resourceKey: `gitnexus-${repositoryId}` } },
    "chrome-devtools-mcp": { kind: "stdio_mcp", operations: ["browser_debug", "page_navigate"], resource: { sharing: "exclusive", resourceKey: `chrome-${repositoryId}` } },
    superpowers: { kind: "cli_only", operations: ["skills_instruction"], resource: { sharing: "concurrent", maxConcurrency: 64 } }
  } as const;
  return ToolCapabilitySchema.parse({ schemaVersion: 3, toolId, version, ...definitions[toolId], required: false });
}
