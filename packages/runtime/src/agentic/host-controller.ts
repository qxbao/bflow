import { buildWorkflowTelemetry, WorkflowTelemetryReportSchema, type WorkflowTelemetryReport } from "../telemetry/report.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRoleSchema, CreateCheckpointCommandSchema, RecoveryCheckpointSchema, RunQuerySchema, SessionManifestSchema, WorkflowRunSnapshotSchema,
  type AgentRole, type CreateCheckpointCommand, type OperationOptions, type OperationResult, type RecoveryCheckpoint,
  type RuntimeService, type SessionManifest
} from "@bflow/contracts";
import { callHost } from "./host-protocol.js";
import { findPrivateRuntimeStateDirectory, resolvePrivateRuntimeStateDirectory } from "../private-state.js";
import { digest, record, textField } from "./journal.js";
import { parseBehavioralCommands, type BehavioralCommand } from "./behavioral-runner.js";
import { parseMutationChecks, type MutationCheck } from "./mutation-check.js";
import { AgenticHostPlatformOptionsSchema, HostPrepareResponseSchema, type AgenticHostPlatformOptions, type HostPrepareResponse } from "../platform/host-options.js";
import { HostPlatformStatusSchema, rewritePersistedPlatform, type HostPlatformStatus } from "./host-platform.js";
import type { RegressionScope } from "./regression-changes.js";

export type { RegressionScope };
export type FastPathMode = "auto" | "off";

export interface AgenticHostOptions {
  repositoryPath: string; sessionId: string; herdrBinary?: string; manifestDirectory?: string; maxDeveloperCapacity?: number;
  behavioralCommands?: readonly BehavioralCommand[];
  /** Owner mutation checks (`.bflow/verification.json`); pinned with the behavioral commands. */
  mutationChecks?: readonly MutationCheck[];
  /** P30 platform configuration; absent keeps the legacy Claude-native host behavior. */
  platform?: AgenticHostPlatformOptions;
  policy?: { sdd: { minimumLevel: "lightweight" | "full"; approvalRequired: boolean };
    tdd: { policy: "conditional" }; verification: { maxIterations: number; onExhausted: "require_human"; regressionScope?: RegressionScope; reviewTimeoutMs?: number };
    fastPath?: { mode: FastPathMode };
    concurrency: { maxConcurrency: number } };
  impactIndex?: { executable: string; home: string; storageLockPath: string };
}

export function effectiveRegressionScope(policy: AgenticHostOptions["policy"] | undefined, persisted: boolean): RegressionScope {
  if (!policy) return "mapped_only";
  return policy.verification.regressionScope ?? (persisted ? "mapped_only" : "affected");
}

export function effectiveFastPathMode(policy: AgenticHostOptions["policy"] | undefined, persisted: boolean): FastPathMode {
  if (!policy) return "off";
  return policy.fastPath?.mode ?? (persisted ? "off" : "auto");
}

function compatiblePersistedPolicy(
  persisted: AgenticHostOptions["policy"] | undefined,
  requested: NonNullable<AgenticHostOptions["policy"]>
): boolean {
  if (!persisted) return false;
  const normalizedPersisted: NonNullable<AgenticHostOptions["policy"]> = {
    sdd: persisted.sdd,
    tdd: persisted.tdd,
    verification: {
      ...persisted.verification,
      ...(persisted.verification.regressionScope === undefined && requested.verification.regressionScope === "affected"
        ? { regressionScope: "affected" }
        : {})
    },
    ...(persisted.fastPath !== undefined
      ? { fastPath: persisted.fastPath }
      : requested.fastPath?.mode === "auto"
        ? { fastPath: { mode: "auto" } }
        : {}),
    concurrency: persisted.concurrency
  };
  return digest(normalizedPersisted) === digest(requested);
}
export interface RoleLaunchDescriptor { systemPrompt: string; mcpConfigFile: string; hooksSettingsFile: string }
export interface AgenticHostController {
  prepare(options?: OperationOptions): Promise<HostPrepareResponse>;
  /** Readiness report and launch-index status. Never includes launch env, tokens or argv. */
  platformStatus(): Promise<HostPlatformStatus>;
  activate(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<void>>;
  /** Private preparatory health; never starts the workspace or scheduler. */
  verifyRoleStartup?(manifest: SessionManifest, role: AgentRole, options?: OperationOptions): Promise<OperationResult<void>>;
  /** Wait for daemon-side startup work even after a role RPC disconnects. */
  drainRoleStartup?(): Promise<OperationResult<void>>;
  runtime: Pick<RuntimeService, "findRuns" | "getRun">;
  quiesce(options?: OperationOptions): Promise<OperationResult<void>>;
  checkpoint(command: CreateCheckpointCommand, options?: OperationOptions): Promise<OperationResult<RecoveryCheckpoint>>;
  /** Disconnect the client. The host intentionally survives CLI process exit. */
  close(): Promise<void>;
  /** Call only after Herdr has stopped and lifecycle receipts have been saved. */
  shutdown(): Promise<void>;
}
export interface HostConfiguration extends AgenticHostOptions { directory: string; socketPath: string; token: string }
export async function readHostConfiguration(path: string): Promise<HostConfiguration> {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Host configuration must be a private regular file");
  const value = record(JSON.parse(await readFile(path, "utf8")));
  for (const key of ["repositoryPath", "sessionId", "directory", "socketPath", "token"]) textField(value[key]);
  parseMutationChecks(value.mutationChecks, parseBehavioralCommands(value.behavioralCommands));
  if (value.platform !== undefined) value.platform = AgenticHostPlatformOptionsSchema.parse(value.platform);
  if (value.maxDeveloperCapacity !== undefined && (!Number.isInteger(value.maxDeveloperCapacity) || Number(value.maxDeveloperCapacity) < 1 || Number(value.maxDeveloperCapacity) > 32)) throw new Error("Invalid host Developer capacity");
  if (value.policy !== undefined) {
    const policy = record(value.policy), sdd = record(policy.sdd), tdd = record(policy.tdd), verification = record(policy.verification), concurrency = record(policy.concurrency);
    if (!["lightweight", "full"].includes(String(sdd.minimumLevel)) || typeof sdd.approvalRequired !== "boolean" || tdd.policy !== "conditional" ||
        verification.onExhausted !== "require_human" || !Number.isInteger(verification.maxIterations) || Number(verification.maxIterations) < 1 || Number(verification.maxIterations) > 10 ||
        (verification.regressionScope !== undefined && !["affected", "full", "mapped_only"].includes(String(verification.regressionScope))) ||
        (verification.reviewTimeoutMs !== undefined && (!Number.isSafeInteger(verification.reviewTimeoutMs) || Number(verification.reviewTimeoutMs) < 60_000 || Number(verification.reviewTimeoutMs) > 3_600_000)) ||
        !Number.isInteger(concurrency.maxConcurrency) || Number(concurrency.maxConcurrency) < 1 || Number(concurrency.maxConcurrency) > 32) throw new Error("Invalid persisted host policy");
    if (policy.fastPath !== undefined) {
      if (policy.fastPath === null || typeof policy.fastPath !== "object" || Array.isArray(policy.fastPath)) throw new Error("Invalid persisted host policy");
      const fastPath = policy.fastPath as Record<string, unknown>;
      if (Object.keys(fastPath).some(key => key !== "mode") || (fastPath.mode !== "auto" && fastPath.mode !== "off")) throw new Error("Invalid persisted host policy");
    }
  }
  if (value.impactIndex !== undefined) {
    if (value.impactIndex === null || typeof value.impactIndex !== "object" || Array.isArray(value.impactIndex)) {
      throw new Error("Invalid persisted host impactIndex");
    }
    const impact = value.impactIndex as Record<string, unknown>;
    const keys = Object.keys(impact);
    if (
      keys.length !== 3 ||
      !["executable", "home", "storageLockPath"].every(
        key =>
          typeof impact[key] === "string" &&
          (impact[key] as string).length > 0 &&
          isAbsolute(impact[key] as string) &&
          !(impact[key] as string).includes("\0")
      )
    ) {
      throw new Error("Invalid persisted host impactIndex");
    }
  }
  return value as unknown as HostConfiguration;
}

/** Reopen the owned host for recovery using its persisted authority, without requesting a platform change. */
export async function openPersistedAgenticHost(options: Pick<AgenticHostOptions, "repositoryPath" | "sessionId">): Promise<AgenticHostController> {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const directory = resolve(resolvePrivateRuntimeStateDirectory(repositoryPath), "host", options.sessionId);
  const persisted = await readHostConfiguration(join(directory, "host.json"));
  if (persisted.repositoryPath !== repositoryPath || persisted.sessionId !== options.sessionId || persisted.directory !== directory)
    throw new Error("Foreign host configuration");
  return ensureAgenticHost({ repositoryPath, sessionId: options.sessionId,
    ...(persisted.herdrBinary !== undefined ? { herdrBinary: persisted.herdrBinary } : {}),
    ...(persisted.manifestDirectory !== undefined ? { manifestDirectory: persisted.manifestDirectory } : {}),
    ...(persisted.maxDeveloperCapacity !== undefined ? { maxDeveloperCapacity: persisted.maxDeveloperCapacity } : {}),
    ...(persisted.behavioralCommands !== undefined ? { behavioralCommands: persisted.behavioralCommands } : {}),
    ...(persisted.mutationChecks !== undefined ? { mutationChecks: persisted.mutationChecks } : {}),
    ...(persisted.policy !== undefined ? { policy: persisted.policy } : {}),
    ...(persisted.platform !== undefined ? { platform: persisted.platform } : {}),
    ...(persisted.impactIndex !== undefined ? { impactIndex: persisted.impactIndex } : {}) });
}
function failure<T>(error: unknown): OperationResult<T> {
  if (String(error).includes("[bflow:native-startup-pending]")) return { ok: false, error: { code: "conflict", retryable: true,
    message: String(error), details: { stage: "native_startup" } } };
  return { ok: false, error: { code: "transport_unavailable", retryable: true, message: String(error) } };
}
/** Idempotently starts a durable host before provider MCP startup. Never steals a stale socket. */
export async function ensureAgenticHost(options: AgenticHostOptions): Promise<AgenticHostController> {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const identity = createHash("sha256").update(repositoryPath + "\0" + options.sessionId).digest("hex").slice(0, 24);
  const directory = resolve(resolvePrivateRuntimeStateDirectory(repositoryPath), "host", options.sessionId);
  const stateRoot = resolve(directory, "../..");
  for (const parent of [stateRoot,resolve(stateRoot,"host"),directory]) {
    try { await mkdir(parent,{mode:0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const observed = await lstat(parent);
    if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error("Host state directories must not be symlinks or special files");
  }
  await chmod(directory, 0o700);
  // Unix socket paths have a byte limit independent of filesystem path limits.
  // Long profile-provided TMPDIRs must not break the default CLI on Linux.
  const socketDirectoryName = `bflow-host-${process.getuid?.() ?? "local"}`;
  const temporaryRoot = Buffer.byteLength(join(tmpdir(), socketDirectoryName, identity + ".native.sock")) <= 103 ? tmpdir() : "/tmp";
  const socketRoot = join(temporaryRoot, socketDirectoryName);
  await mkdir(socketRoot, { recursive: true, mode: 0o700 });
  const stat = await lstat(socketRoot);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe host socket directory");
  const bootLock = await open(join(directory, "boot.lock"), "a+", 0o600);
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      const acquired = await new Promise<boolean>((accept, reject) => {
        const child = spawn("flock", ["--nonblock", "3"], {stdio:["ignore","ignore","ignore",bootLock.fd]});
        child.once("error",reject); child.once("exit",code=>accept(code===0));
      });
      if (acquired) break;
      if (Date.now() >= deadline) throw new Error("Agentic host startup is busy; reconcile before retry");
      await new Promise(accept=>setTimeout(accept,50));
    }
  const configPath = join(directory, "host.json");
  let hasConfiguration = true;
  try { await lstat(configPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") hasConfiguration = false; else throw error; }
  if (!hasConfiguration) {
    const temporaryConfig = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const file = await open(temporaryConfig, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ ...options, repositoryPath, directory, socketPath: join(socketRoot, identity + ".sock"), token: randomBytes(32).toString("hex") })); await file.sync(); }
      finally { await file.close(); }
      // Location/recovery readers may inspect the config before acquiring boot.lock.
      // Publish complete bytes exclusively; retain an existing host's exact token.
      try { await link(temporaryConfig, configPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await unlink(temporaryConfig).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  let configuration = await readHostConfiguration(configPath);
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory) throw new Error("Foreign host configuration");
  if (digest(parseBehavioralCommands(configuration.behavioralCommands)) !== digest(parseBehavioralCommands(options.behavioralCommands)))
    throw new Error("Persisted behavioral commands differ from owner configuration; quiesce and reconcile before changing verification authority");
  if (digest(parseMutationChecks(configuration.mutationChecks, parseBehavioralCommands(configuration.behavioralCommands))) !==
      digest(parseMutationChecks(options.mutationChecks, parseBehavioralCommands(options.behavioralCommands))))
    throw new Error("Persisted mutation checks differ from owner configuration; quiesce and reconcile before changing verification authority");
  // Platform, policy and impactIndex changes are only admissible while no host process owns the endpoint.
  const requestedPlatform = options.platform === undefined ? undefined : AgenticHostPlatformOptionsSchema.parse(options.platform);
  const platformChanged = digest(configuration.platform ?? null) !== digest(requestedPlatform ?? null);
  const policyChanged = options.policy !== undefined && digest(configuration.policy ?? null) !== digest(options.policy);
  const impactIndexChanged = options.impactIndex !== undefined && digest(configuration.impactIndex ?? null) !== digest(options.impactIndex);
  const request = (method: string, params: unknown = {}, op?: OperationOptions) => {
    const timeoutMs = Math.min(op?.timeoutMs ?? (method === "prepare" ? 600_000 : 30_000),
      op?.deadline === undefined ? Infinity : Math.max(1, Date.parse(op.deadline) - Date.now()));
    return callHost(configuration.socketPath, configuration.token, method, params, timeoutMs, op?.signal);
  };
  let alive = true;
  try { await request("ping"); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    alive = false;
  }
  if (alive && options.policy && !compatiblePersistedPolicy(configuration.policy, options.policy))
    throw new Error("Persisted host policy differs from project policy; quiesce and reconcile the existing host before changing it");
  if (alive && platformChanged) throw new Error("Persisted host platform differs; run bflow down before changing providers/roles");
  if (!alive) {
    try {
      await lstat(configuration.socketPath);
      const owner = record(JSON.parse(await readFile(join(directory,"owner.json"),"utf8")));
      if (!Number.isInteger(owner.pid) || Number(owner.pid) < 1) throw new Error("Host endpoint has no valid process owner; reconcile before restarting");
      try { process.kill(Number(owner.pid),0); throw new Error("Host owner is still alive but unreachable; preserve the endpoint and reconcile"); }
      catch (ownerError) { if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") throw ownerError; }
      // A refused connection plus a dead recorded owner proves this process endpoint stale.
      // Durable dispatch intents remain unchanged and unknown deliveries are never resent.
      await unlink(configuration.socketPath);
      try { await unlink(configuration.socketPath.replace(/\.sock$/, ".native.sock")); }
      catch (nativeError) { if ((nativeError as NodeJS.ErrnoException).code !== "ENOENT") throw nativeError; }
    } catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
    if (platformChanged || policyChanged || impactIndexChanged) {
      await rewritePersistedPlatform(configPath, requestedPlatform, {
        ...(options.policy !== undefined ? { policy: options.policy } : {}),
        ...(options.impactIndex !== undefined ? { impactIndex: options.impactIndex } : {})
      });
      configuration = await readHostConfiguration(configPath);
    }
    const log = await open(join(directory, "host.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./host.js", import.meta.url)), "daemon", configPath],
        { detached: true, cwd: repositoryPath, stdio: ["ignore", log.fd, log.fd], env: { ...process.env } });
      child.unref();
    } finally { await log.close(); }
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await request("ping"); break; }
      catch (startupError) { if (Date.now() >= deadline) throw new Error(`Agentic host failed to start: ${String(startupError)}; see ${join(directory, "host.log")}`); }
      await new Promise(accept => setTimeout(accept, 50));
    }
  }
  const result = async <T>(method: string, params: unknown, parse: (value: unknown) => T, op?: OperationOptions): Promise<OperationResult<T>> => {
    if (op?.signal?.aborted) return { ok: false, error: { code: "cancelled", retryable: false, message: "Operation aborted" } };
    try { return { ok: true, value: parse(await request(method, params, op)) }; } catch (error) { return failure(error); }
  };
  return {
    async prepare(op) {
      const deadline = new Date(Math.min(Date.now() + (op?.timeoutMs ?? 600_000),
        op?.deadline === undefined ? Infinity : Date.parse(op.deadline))).toISOString();
      return HostPrepareResponseSchema.parse(await request("prepare", { deadline }, op));
    },
    async platformStatus() { return HostPlatformStatusSchema.parse(await request("platform_status")); },
    activate: (manifest, op) => result("activate", SessionManifestSchema.parse(manifest), () => undefined, op),
    verifyRoleStartup: (manifest, role, op) => result("verify_role_startup", { manifest: SessionManifestSchema.parse(manifest), role: AgentRoleSchema.parse(role) }, () => undefined, op),
    drainRoleStartup: () => result("drain_role_startup", {}, () => undefined, { timeoutMs: 600_000 }),
    runtime: {
      getRun: (runId, op) => result("get_run", { runId }, value => value === null ? null : WorkflowRunSnapshotSchema.parse(value), op),
      findRuns: (query, op) => result("find_runs", RunQuerySchema.parse(query), value => {
        const page = record(value); if (!Array.isArray(page.items)) throw new Error("Malformed host run page");
        return { items: page.items.map(item => WorkflowRunSnapshotSchema.parse(item)), ...(page.nextCursor ? { nextCursor: textField(page.nextCursor) } : {}) };
      }, op)
    },
    quiesce: op => result("quiesce", {}, () => undefined, op),
    checkpoint: (command, op) => result("checkpoint", CreateCheckpointCommandSchema.parse(command), value => RecoveryCheckpointSchema.parse(value), op),
    async close() {},
    async shutdown() {
      await request("shutdown");
      const deadline = Date.now() + 10_000;
      while (true) {
        try { await lstat(configuration.socketPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        if (Date.now() >= deadline) throw new Error("Host stop acknowledgement received but endpoint is still present; reconcile its owner");
        await new Promise(accept=>setTimeout(accept,25));
      }
    }
  };
  } finally { await bootLock.close(); }
}

/** Connect-only observation. Never ensures/starts a host, changes config, or repairs sockets. */
export async function readExistingAgenticTelemetry(options: { repositoryPath: string; sessionId: string; runId: string; asOf?: string }): Promise<WorkflowTelemetryReport> {
  const asOf = options.asOf ?? new Date().toISOString();
  try {
    if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Invalid session");
    const repositoryPath = await realpath(options.repositoryPath);
    const stateDirectory = findPrivateRuntimeStateDirectory(repositoryPath);
    if (!stateDirectory) throw new Error("No existing state");
    const directory = resolve(stateDirectory, "host", options.sessionId);
    const configuration = await readHostConfiguration(join(directory, "host.json"));
    if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
      throw new Error("Foreign host");
    const report = WorkflowTelemetryReportSchema.parse(await callHost(configuration.socketPath, configuration.token,
      "telemetry_report", { runId: options.runId, asOf }, 10_000));
    if (report.runId !== options.runId || report.source !== "agentic" || report.asOf !== asOf) throw new Error("Foreign report");
    return report;
  } catch {
    return buildWorkflowTelemetry({ runId: options.runId, asOf, source: "agentic", events: [], taskIds: [],
      complete: false, diagnostics: ["host_unavailable"] });
  }
}

const RECONCILE_CANCELLATION_TIMEOUT_MS = 600_000;
/** Explicit operator mutation, connect-only. Never bootstraps a daemon, changes platform configuration or resumes work. */
export async function reconcileExistingAgenticCancellation(options: { repositoryPath: string; sessionId: string; runId: string }): Promise<import("./cancellation-stop.js").CancellationReconciliationReport> {
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Invalid host session ID");
  const repositoryPath = await realpath(options.repositoryPath);
  const stateDirectory = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!stateDirectory) throw new Error("No existing Bflow host; preserve state and reconcile the session before retrying");
  const directory = resolve(stateDirectory, "host", options.sessionId);
  const configuration = await readHostConfiguration(join(directory, "host.json"));
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
    throw new Error("Foreign host configuration");
  const { CancellationReconciliationReportSchema } = await import("./cancellation-stop.js");
  const report = CancellationReconciliationReportSchema.parse(await callHost(configuration.socketPath, configuration.token,
    // Bounded per-execution stops run under the journal lock; a client timeout does not mean the host stopped applying them.
    "reconcile_cancellation", { runId: textField(options.runId) }, RECONCILE_CANCELLATION_TIMEOUT_MS));
  if (report.runId !== options.runId) throw new Error("Foreign cancellation report");
  return report;
}
