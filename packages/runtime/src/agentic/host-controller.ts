import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateCheckpointCommandSchema, RecoveryCheckpointSchema, RunQuerySchema, SessionManifestSchema, WorkflowRunSnapshotSchema,
  type CreateCheckpointCommand, type OperationOptions, type OperationResult, type RecoveryCheckpoint,
  type RuntimeService, type SessionManifest
} from "@bflow/contracts";
import { callHost } from "./host-protocol.js";
import { record, textField } from "./journal.js";

export interface AgenticHostOptions {
  repositoryPath: string; sessionId: string; herdrBinary?: string; manifestDirectory?: string; maxDeveloperCapacity?: number;
  policy?: { sdd: { minimumLevel: "lightweight" | "full"; approvalRequired: boolean };
    tdd: { policy: "conditional" }; verification: { maxIterations: number; onExhausted: "require_human" };
    concurrency: { maxConcurrency: number } };
}
export interface RoleLaunchDescriptor { systemPrompt: string; mcpConfigFile: string; hooksSettingsFile: string }
export interface AgenticHostController {
  prepare(): Promise<{ roleLaunch: Record<string, RoleLaunchDescriptor> }>;
  activate(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<void>>;
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
  if (value.maxDeveloperCapacity !== undefined && (!Number.isInteger(value.maxDeveloperCapacity) || Number(value.maxDeveloperCapacity) < 1 || Number(value.maxDeveloperCapacity) > 32)) throw new Error("Invalid host Developer capacity");
  if (value.policy !== undefined) {
    const policy = record(value.policy), sdd = record(policy.sdd), tdd = record(policy.tdd), verification = record(policy.verification), concurrency = record(policy.concurrency);
    if (!["lightweight", "full"].includes(String(sdd.minimumLevel)) || typeof sdd.approvalRequired !== "boolean" || tdd.policy !== "conditional" ||
        verification.onExhausted !== "require_human" || !Number.isInteger(verification.maxIterations) || Number(verification.maxIterations) < 1 || Number(verification.maxIterations) > 10 ||
        !Number.isInteger(concurrency.maxConcurrency) || Number(concurrency.maxConcurrency) < 1 || Number(concurrency.maxConcurrency) > 32) throw new Error("Invalid persisted host policy");
  }
  return value as unknown as HostConfiguration;
}
function failure<T>(error: unknown): OperationResult<T> {
  return { ok: false, error: { code: "transport_unavailable", retryable: true, message: String(error) } };
}
/** Idempotently starts a durable host before provider MCP startup. Never steals a stale socket. */
export async function ensureAgenticHost(options: AgenticHostOptions): Promise<AgenticHostController> {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const identity = createHash("sha256").update(repositoryPath + "\0" + options.sessionId).digest("hex").slice(0, 24);
  const directory = resolve(repositoryPath, ".bflow/state/host", options.sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const socketRoot = join(tmpdir(), `bflow-host-${process.getuid?.() ?? "local"}`);
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
  try {
    const file = await open(configPath, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ ...options, repositoryPath, directory, socketPath: join(socketRoot, identity + ".sock"), token: randomBytes(32).toString("hex") })); await file.sync(); }
    finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const configuration = await readHostConfiguration(configPath);
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory) throw new Error("Foreign host configuration");
  if (options.policy && JSON.stringify(configuration.policy) !== JSON.stringify(options.policy)) throw new Error("Persisted host policy differs from project policy; quiesce and reconcile the existing host before changing it");
  const request = (method: string, params: unknown = {}) => callHost(configuration.socketPath, configuration.token, method, params);
  try { await request("ping"); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
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
    try { return { ok: true, value: parse(await request(method, params)) }; } catch (error) { return failure(error); }
  };
  return {
    async prepare() { const value = record(await request("prepare")); const launches = record(value.roleLaunch); const roleLaunch: Record<string, RoleLaunchDescriptor> = {};
      for (const [role, raw] of Object.entries(launches)) { const launch = record(raw); roleLaunch[role] = { systemPrompt: textField(launch.systemPrompt), mcpConfigFile: textField(launch.mcpConfigFile), hooksSettingsFile: textField(launch.hooksSettingsFile) }; }
      return { roleLaunch }; },
    activate: (manifest, op) => result("activate", SessionManifestSchema.parse(manifest), () => undefined, op),
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
    async shutdown() { await request("shutdown"); }
  };
  } finally { await bootLock.close(); }
}
