import { connectArtifact } from "../interaction/artifacts.js";
import { openSqliteRunStore } from "@bflow/persistence";
import { WebIssuerCredentialSchema } from "@bflow/contracts/web-host";
import { createExecutionResolutionReader, readPrivateExecutionSources, readResolutionFile, type ExecutionResolutionReader } from "./execution-binding.js";
import { buildExecutionPlan } from "../planning/index.js";
import { OwnerKeySchema } from "../interaction/authority.js";
import { buildWorkflowTelemetry, WorkflowTelemetryReportSchema, type WorkflowTelemetryReport } from "../telemetry/report.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExecutionResolutionSourcesSchema, type ExecutionResolutionSources, AgentRoleSchema, CreateCheckpointCommandSchema, RecoveryCheckpointSchema, RunQuerySchema, SessionManifestSchema, WorkflowRunSnapshotSchema,
  type AgentRole, type CreateCheckpointCommand, type OperationOptions, type OperationResult, type RecoveryCheckpoint,
  StoredRunSchema, type RuntimeService, type SessionManifest
} from "@bflow/contracts";
import { callHost } from "./host-protocol.js";
import { DIRECTOR_LIMITS, type JsonValue } from "@bflow/contracts";
import { findPrivateRuntimeStateDirectory, resolvePrivateRuntimeStateDirectory } from "../private-state.js";
import { AgenticJournal, digest, record, syncFileHandle, textField } from "./journal.js";
import { parseBehavioralCommands, type BehavioralCommand } from "./behavioral-runner.js";
import { parseMutationChecks, type MutationCheck } from "./mutation-check.js";
import { parseAppChecks, type AppCheckSuite } from "./app-check-config.js";
import { AgenticHostPlatformOptionsSchema, HostPrepareResponseSchema, type AgenticHostPlatformOptions, type HostPrepareResponse } from "../platform/host-options.js";
import { HostPlatformStatusSchema, rewritePersistedPlatform, type HostPlatformStatus } from "./host-platform.js";
import { CancellationReconciliationReportSchema, type CancellationReconciliationReport } from "./cancellation-stop.js";
import type { RegressionScope } from "./regression-changes.js";

const HOST_STARTUP_TIMEOUT_MS = 120_000;

/** Inspect only bounded bytes from this boot attempt; never echo arbitrary log text or credentials. */
async function startupSocketPermissionFailure(path: string, offset: number): Promise<string | undefined> {
  try {
    const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= offset) return undefined;
      const start = Math.max(offset, stat.size - 4096);
      const bytes = Buffer.alloc(stat.size - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      const code = /\blisten (EPERM|EACCES):/.exec(bytes.subarray(0, bytesRead).toString("utf8"))?.[1];
      if (code) return `Host Unix socket permission denied (listen ${code})`;
    } finally { await file.close(); }
  } catch { /* Preserve the original startup error when diagnostics are unavailable. */ }
  return undefined;
}

export type { RegressionScope };
export type FastPathMode = "auto" | "off";

export interface AgenticHostOptions {
  executionResolution?: ExecutionResolutionSources;
  repositoryPath: string; sessionId: string; herdrBinary?: string; manifestDirectory?: string; maxDeveloperCapacity?: number;
  behavioralCommands?: readonly BehavioralCommand[];
  /** Owner mutation checks (`.bflow/verification.json`); pinned with the behavioral commands. */
  mutationChecks?: readonly MutationCheck[];
  /** Owner real-app checks (`appChecks` in `.bflow/verification.json`); pinned with the other verification authority. */
  appChecks?: readonly AppCheckSuite[];
  /** P30 platform configuration; absent keeps the legacy Claude-native host behavior. */
  platform?: AgenticHostPlatformOptions;
  /** Session layout (ADR 0009): `director` hosts no Conversation/Coordinator role and needs a v3 manifest. Absent means `legacy_v2`. */
  layout?: "legacy_v2" | "director";
  /** Director layout: argv of the non-LLM progress viewer pane (`bflow progress --follow`). */
  progressCommand?: readonly string[];
  policy?: { sdd: { minimumLevel: "lightweight" | "full"; approvalRequired: boolean };
    tdd: { policy: "conditional" }; verification: { maxIterations: number; onExhausted: "require_human"; regressionScope?: RegressionScope; reviewTimeoutMs?: number };
    issueQueue?: { autoPark: boolean; maxAutoResumesBeforePark: number };
    fastPath?: { mode: FastPathMode };
    concurrency: { maxConcurrency: number } };
  impactIndex?: { executable: string; home: string; storageLockPath: string };
}

/** Layout options are owner configuration: a malformed value or a platform that disagrees with the layout is refused. */
export function assertHostLayoutOptions(value: { layout?: unknown; progressCommand?: unknown; platform?: unknown }): void {
  if (value.layout !== undefined && value.layout !== "legacy_v2" && value.layout !== "director") throw new Error("Invalid host layout");
  if (value.progressCommand !== undefined && (!Array.isArray(value.progressCommand) || value.progressCommand.length < 1 || value.progressCommand.length > 16 ||
      value.progressCommand.some(item => typeof item !== "string" || item.length === 0 || item.length > 4096 || item.includes("\0"))))
    throw new Error("Invalid host progress command");
  const layout = value.layout ?? "legacy_v2";
  const platform = value.platform as { layout?: unknown } | undefined;
  if (platform !== undefined && (platform.layout ?? "legacy_v2") !== layout) throw new Error("Host platform layout does not match host layout");
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
    ...((persisted.issueQueue ?? requested.issueQueue) ? { issueQueue: persisted.issueQueue ?? requested.issueQueue! } : {}),
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
export interface HostConfiguration extends AgenticHostOptions { executionSourceDigests?: Record<string, string>; directory: string; socketPath: string; token: string }
export async function readHostConfiguration(path: string): Promise<HostConfiguration> {
  const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 256 * 1024) {
      throw new Error("Host configuration must be a private regular file within size bounds");
    }
    raw = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  const value = record(JSON.parse(raw));
  for (const key of ["repositoryPath", "sessionId", "directory", "socketPath", "token"]) textField(value[key]);
  parseMutationChecks(value.mutationChecks, parseBehavioralCommands(value.behavioralCommands));
  parseAppChecks(value.appChecks);
  if (value.platform !== undefined) value.platform = AgenticHostPlatformOptionsSchema.parse(value.platform);
  assertHostLayoutOptions(value);
  if (value.executionResolution !== undefined) value.executionResolution = ExecutionResolutionSourcesSchema.parse(value.executionResolution);
  if (value.executionSourceDigests !== undefined) {
    const sources = record(value.executionSourceDigests);
    if (Object.values(sources).some(digest => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) throw new Error("Invalid execution source binding");
  }
  if (value.maxDeveloperCapacity !== undefined && (!Number.isInteger(value.maxDeveloperCapacity) || Number(value.maxDeveloperCapacity) < 1 || Number(value.maxDeveloperCapacity) > 32)) throw new Error("Invalid host Developer capacity");
  if (value.policy !== undefined) {
    const policy = record(value.policy), sdd = record(policy.sdd), tdd = record(policy.tdd), verification = record(policy.verification), concurrency = record(policy.concurrency);
    if (!["lightweight", "full"].includes(String(sdd.minimumLevel)) || typeof sdd.approvalRequired !== "boolean" || tdd.policy !== "conditional" ||
        verification.onExhausted !== "require_human" || !Number.isInteger(verification.maxIterations) || Number(verification.maxIterations) < 1 || Number(verification.maxIterations) > 10 ||
        (verification.regressionScope !== undefined && !["affected", "full", "mapped_only"].includes(String(verification.regressionScope))) ||
        (verification.reviewTimeoutMs !== undefined && (!Number.isSafeInteger(verification.reviewTimeoutMs) || Number(verification.reviewTimeoutMs) < 60_000 || Number(verification.reviewTimeoutMs) > 3_600_000)) ||
        !Number.isInteger(concurrency.maxConcurrency) || Number(concurrency.maxConcurrency) < 1 || Number(concurrency.maxConcurrency) > 32) throw new Error("Invalid persisted host policy");
    if (policy.issueQueue !== undefined) {
      const queue = record(policy.issueQueue);
      if (Object.keys(queue).some(key => !["autoPark", "maxAutoResumesBeforePark"].includes(key)) || typeof queue.autoPark !== "boolean" ||
          !Number.isInteger(queue.maxAutoResumesBeforePark) || Number(queue.maxAutoResumesBeforePark) < 0 || Number(queue.maxAutoResumesBeforePark) > 3)
        throw new Error("issueQueue.maxAutoResumesBeforePark phải trong khoảng 0–3");
    }
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
  return ensureHost({ repositoryPath, sessionId: options.sessionId,
    ...(persisted.herdrBinary !== undefined ? { herdrBinary: persisted.herdrBinary } : {}),
    ...(persisted.manifestDirectory !== undefined ? { manifestDirectory: persisted.manifestDirectory } : {}),
    ...(persisted.maxDeveloperCapacity !== undefined ? { maxDeveloperCapacity: persisted.maxDeveloperCapacity } : {}),
    ...(persisted.behavioralCommands !== undefined ? { behavioralCommands: persisted.behavioralCommands } : {}),
    ...(persisted.mutationChecks !== undefined ? { mutationChecks: persisted.mutationChecks } : {}),
    ...(persisted.appChecks !== undefined ? { appChecks: persisted.appChecks } : {}),
    ...(persisted.policy !== undefined ? { policy: persisted.policy } : {}),
    ...(persisted.platform !== undefined ? { platform: persisted.platform } : {}),
    ...(persisted.layout !== undefined ? { layout: persisted.layout } : {}),
    ...(persisted.progressCommand !== undefined ? { progressCommand: persisted.progressCommand } : {}),
    ...(persisted.impactIndex !== undefined ? { impactIndex: persisted.impactIndex } : {}),
    ...(persisted.executionResolution !== undefined ? { executionResolution: persisted.executionResolution } : {}) }, true);
}
/** Connect only to an existing endpoint. This seam cannot prepare, activate or restart a host. */
export async function queryAgenticHostInteraction(options: { repositoryPath: string; sessionId: string }, input: unknown, method: "interaction_query" | "interaction_events" = "interaction_query"): Promise<unknown> {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const root = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!root) throw new Error("Host unavailable");
  const directory = resolve(root, "host", options.sessionId);
  const configuration = await readHostConfiguration(join(directory, "host.json"));
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
    throw new Error("Foreign host configuration");
  return callHost(configuration.socketPath, configuration.token, method, input, 5000);
}
async function locateDirectorHost(options: { repositoryPath: string; sessionId: string }) {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const root = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!root) throw new Error("Host unavailable");
  const directory = resolve(root, "host", options.sessionId);
  const configuration = await readHostConfiguration(join(directory, "host.json")).catch(() => { throw new Error("Host unavailable"); });
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
    throw new Error("Foreign host configuration");
  return configuration;
}
/** Owner-token Director methods on an already running host; never starts a host. */
export async function callDirectorOwnerHost(options: { repositoryPath: string; sessionId: string },
  method: "director_register" | "director_revoke" | "director_progress" | "director_hook_note" | "director_issues" | "director_issue" | "director_issue_status" | "director_mailbox",
  input: unknown, timeoutMs = 10_000): Promise<unknown> {
  const configuration = await locateDirectorHost(options);
  return callHost(configuration.socketPath, configuration.token, method, input, timeoutMs);
}
/** D-DIR-02: owner-token `bflow approve <#n>` on an already running host; never starts a host. */
export async function callHumanDecisionHost(options: { repositoryPath: string; sessionId: string }, input: unknown, timeoutMs = 30_000): Promise<unknown> {
  const configuration = await locateDirectorHost(options);
  return callHost(configuration.socketPath, configuration.token, "human_decision_cli", input, timeoutMs);
}
/** Director-token tool call; the long `director_wait` gets its maximum wait plus slack. */
export async function callDirectorTool(options: { repositoryPath: string; sessionId: string }, token: string, name: string,
  args: Record<string, JsonValue>): Promise<unknown> {
  const configuration = await locateDirectorHost(options);
  return callHost(configuration.socketPath, token, "director_call", { name, arguments: args },
    name === "director_wait" ? DIRECTOR_LIMITS.waitMaxMs + 30_000 : 600_000);
}
/** Read a scoped artifact from an already existing host; never opens stores or starts a host locally. */
export async function readHostInteractionArtifact(options: { repositoryPath: string; sessionId: string }, input: unknown) {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const root = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!root) throw new Error("Host unavailable");
  const directory = resolve(root, "host", options.sessionId), configuration = await readHostConfiguration(join(directory, "host.json"));
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory) throw new Error("Foreign host configuration");
  return connectArtifact(configuration.socketPath, configuration.token, input);
}
/** Owner-only registration. The returned credential has user-interaction scope
 * only and stays inside trusted Local Server composition, never browser DTOs. */
export async function registerUserInteractionIssuer(options: { repositoryPath: string; sessionId: string }, input: unknown) {
  const registration = OwnerKeySchema.parse(input), repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const root = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!root) throw new Error("Host unavailable");
  const directory = resolve(root, "host", options.sessionId), configuration = await readHostConfiguration(join(directory, "host.json"));
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
    throw new Error("Foreign host configuration");
  const result = WebIssuerCredentialSchema.omit({socketPath:true}).parse(
    await callHost(configuration.socketPath, configuration.token, "interaction_register", registration, 5000));
  return WebIssuerCredentialSchema.parse({ ...result, socketPath: configuration.socketPath });
}
/** Dedicated web credential can never call owner lifecycle or role methods. */
export async function callUserInteractionHost(options: { repositoryPath: string; sessionId: string }, credential: string,
  method: "interaction_execute" | "interaction_operation" | "interaction_notice_displayed" | "interaction_chat_send" | "interaction_chat_history"
    | "interaction_director_send" | "interaction_director_history", input: unknown): Promise<unknown> {
  const repositoryPath = await realpath(options.repositoryPath);
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const root = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!root) throw new Error("Host unavailable");
  const directory = resolve(root, "host", options.sessionId), configuration = await readHostConfiguration(join(directory, "host.json"));
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
    throw new Error("Foreign host configuration");
  return callHost(configuration.socketPath, credential, method, input, 30000);
}
function failure<T>(error: unknown): OperationResult<T> {
  if (String(error).includes("[bflow:native-startup-pending]")) return { ok: false, error: { code: "conflict", retryable: true,
    message: String(error), details: { stage: "native_startup" } } };
  return { ok: false, error: { code: "transport_unavailable", retryable: true, message: String(error) } };
}
/** Idempotently starts a durable host before provider MCP startup. Never steals a stale socket. */
export async function ensureAgenticHost(options: AgenticHostOptions): Promise<AgenticHostController> {
  return ensureHost(options, false);
}

/** A fresh owner resolution may repair an interrupted bootstrap, never an existing workflow binding. */
async function refreshEmptyStartupSources(configuration: HostConfiguration, configPath: string,
  sources: ExecutionResolutionSources, reader: ExecutionResolutionReader): Promise<void> {
  const owner = record(JSON.parse((await readResolutionFile(join(configuration.directory, "owner.json"))).toString("utf8")));
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) throw new Error("Startup refresh requires a valid stopped host owner");
  try { process.kill(Number(owner.pid), 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    const storage = resolve(configuration.directory, "../../agentic");
    await new AgenticJournal(join(storage, "journal"), configuration.repositoryPath).exclusive(async state => {
      if ([state.runs, state.outbound, state.inbox, state.pendingCore, state.pendingVerifications].some(items => items.length))
        throw new Error("Startup source refresh is forbidden when workflow state exists");
      // A missing journal is legitimate before intake only when the authoritative RunStore is also empty.
      const database = join(storage, "runs.db");
      try {
        const info = await lstat(database);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(database) !== database)
          throw new Error("Startup refresh requires a safe existing RunStore");
        const opened = openSqliteRunStore({ filename: database });
        if (!opened.ok) throw new Error("Startup refresh cannot verify the existing RunStore");
        try {
          const found = await opened.value.find(RunQuerySchema.parse({ limit: 1 }));
          if (!found.ok) throw new Error("Startup refresh cannot verify the existing RunStore");
          if (found.value.items.map(item => StoredRunSchema.parse(item)).length || found.value.nextCursor)
            throw new Error("Startup source refresh is forbidden when workflow state exists");
        } finally { opened.value.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const executionSourceDigests = await readPrivateExecutionSources(reader);
      await reader();
      await rewritePersistedPlatform(configPath, configuration.platform, { executionResolution: sources, executionSourceDigests });
      const parent = await open(configuration.directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    });
    return;
  }
  throw new Error("Startup source refresh requires the recorded host owner to be stopped");
}

async function ensureHost(options: AgenticHostOptions, reopening: boolean): Promise<AgenticHostController> {
  if (options.executionResolution !== undefined)
    options = { ...options, executionResolution: ExecutionResolutionSourcesSchema.parse(options.executionResolution) };
  const repositoryPath = await realpath(options.repositoryPath);
  let startupReader = !reopening && options.executionResolution !== undefined ? await createExecutionResolutionReader(options.executionResolution) : undefined;
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
    const deadline = Date.now() + HOST_STARTUP_TIMEOUT_MS;
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
    const executionSourceDigests = await startupReader?.readPrivateSources?.();
    await startupReader?.();
    const temporaryConfig = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const file = await open(temporaryConfig, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ ...options, ...(executionSourceDigests ? { executionSourceDigests } : {}), repositoryPath, directory, socketPath: join(socketRoot, identity + ".sock"), token: randomBytes(32).toString("hex") })); await syncFileHandle(file); }
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
  if (digest(parseAppChecks(configuration.appChecks)) !== digest(parseAppChecks(options.appChecks)))
    throw new Error("Persisted real-app checks differ from owner configuration; quiesce and reconcile before changing verification authority");
  // Platform, policy and impactIndex changes are only admissible while no host process owns the endpoint.
  const requestedPlatform = options.platform === undefined ? undefined : AgenticHostPlatformOptionsSchema.parse(options.platform);
  assertHostLayoutOptions({ ...options, ...(requestedPlatform ? { platform: requestedPlatform } : {}) });
  const layoutChanged = (configuration.layout ?? "legacy_v2") !== (options.layout ?? "legacy_v2") ||
    digest(configuration.progressCommand ?? null) !== digest(options.progressCommand ?? null);
  const platformChanged = digest(configuration.platform ?? null) !== digest(requestedPlatform ?? null);
  const policyChanged = options.policy !== undefined && digest(configuration.policy ?? null) !== digest(options.policy);
  const impactIndexChanged = options.impactIndex !== undefined && digest(configuration.impactIndex ?? null) !== digest(options.impactIndex);
  // Live readiness observations are deliberately absent from the planner's authority fingerprint.
  const resolutionAuthority = (sources: ExecutionResolutionSources | undefined) => sources === undefined ? null
    : { ...sources, plan: buildExecutionPlan(sources.plan).fingerprint };
  const resolutionChanged = options.executionResolution !== undefined &&
    digest(resolutionAuthority(configuration.executionResolution)) !== digest(resolutionAuthority(options.executionResolution));
  const resolveDeadlineMs = (deadlineValue: OperationOptions["deadline"]): number => {
    if (deadlineValue === undefined) return Infinity;
    return Date.parse(deadlineValue);
  };
  const request = (method: string, params: unknown = {}, op?: OperationOptions) => {
    const deadlineRemainingMs = op?.deadline === undefined ? Infinity : resolveDeadlineMs(op.deadline) - Date.now();
    const timeoutMs = Math.min(op?.timeoutMs ?? (method === "prepare" ? 600_000 : 30_000), deadlineRemainingMs);
    return callHost(configuration.socketPath, configuration.token, method, params, timeoutMs, op?.signal);
  };
  let alive = true;
  try { await request("ping"); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    alive = false;
  }
  // Reopening may connect to a live owner without granting fresh execution. A replacement daemon still validates sources.
  if (!alive && reopening && options.executionResolution !== undefined)
    startupReader = await createExecutionResolutionReader(options.executionResolution);
  const executionSourceDigests = await startupReader?.readPrivateSources?.();
  await startupReader?.();
  const sourceSnapshotChanged = resolutionChanged || startupReader !== undefined &&
    digest(configuration.executionSourceDigests ?? null) !== digest(executionSourceDigests ?? null);
  if (alive && options.policy && !compatiblePersistedPolicy(configuration.policy, options.policy))
    throw new Error("Persisted host policy differs from project policy; quiesce and reconcile the existing host before changing it");
  if (alive && platformChanged) throw new Error("Persisted host platform differs; run bflow down before changing providers/roles");
  if (alive && sourceSnapshotChanged) throw new Error("Persisted host execution sources differ; quiesce the existing host before re-resolution");
  if (alive && layoutChanged) throw new Error("Persisted host layout differs; run bflow down before changing the session layout");
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
    if (sourceSnapshotChanged) {
      if (reopening || !startupReader || !options.executionResolution)
        throw new Error("Persisted recovery cannot refresh execution sources");
      await refreshEmptyStartupSources(configuration, configPath, options.executionResolution, startupReader);
      configuration = await readHostConfiguration(configPath);
    }
    if (platformChanged || policyChanged || impactIndexChanged || layoutChanged) {
      await rewritePersistedPlatform(configPath, requestedPlatform, {
        ...(options.policy !== undefined ? { policy: options.policy } : {}),
        ...(options.impactIndex !== undefined ? { impactIndex: options.impactIndex } : {}),
        ...(layoutChanged ? { layout: options.layout, progressCommand: options.progressCommand } : {})
      });
      configuration = await readHostConfiguration(configPath);
    }

    const log = await open(join(directory, "host.log"), "a", 0o600);
    let exited: string | undefined;
    let startupLogOffset = 0;
    try {
      startupLogOffset = (await log.stat()).size;
      const child = spawn(process.execPath, [fileURLToPath(new URL("./host.js", import.meta.url)), "daemon", configPath],
        { detached: true, cwd: repositoryPath, stdio: ["ignore", log.fd, log.fd], env: { ...process.env } });
      child.once("exit", (code, signal) => { exited = signal ? `signal ${signal}` : `exit code ${code}`; });
      child.once("error", error => { exited = String(error); });
      child.unref();
    } finally { await log.close(); }
    // Daemon boot composes platform readiness before binding the socket and can exceed
    // a few seconds; keep waiting while the child lives and fail fast once it exits.
    const deadline = Date.now() + HOST_STARTUP_TIMEOUT_MS;
    while (true) {
      try { await request("ping"); break; }
      catch (startupError) {
        if (exited !== undefined) {
          const cause = await startupSocketPermissionFailure(join(directory, "host.log"), startupLogOffset) ?? String(startupError);
          throw new Error(`Agentic host exited during startup (${exited}): ${cause}; see ${join(directory, "host.log")}`);
        }
        if (Date.now() >= deadline) throw new Error(`Agentic host failed to start within ${HOST_STARTUP_TIMEOUT_MS / 1000}s: ${String(startupError)}; the daemon may still be starting, retry shortly or see ${join(directory, "host.log")}`);
      }
      await new Promise(accept => setTimeout(accept, 50));
    }
  }
  const result = async <T>(method: string, params: unknown, parse: (value: unknown) => T, op?: OperationOptions): Promise<OperationResult<T>> => {
    if (op?.signal?.aborted) return { ok: false, error: { code: "cancelled", retryable: false, message: "Operation aborted" } };
    try { return { ok: true, value: parse(await request(method, params, op)) }; } catch (error) { return failure(error); }
  };
  return {
    async prepare(op) {
      const deadline = new Date(Math.min(Date.now() + (op?.timeoutMs ?? 600_000), resolveDeadlineMs(op?.deadline))).toISOString();
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
export async function reconcileExistingAgenticCancellation(options: { repositoryPath: string; sessionId: string; runId: string }): Promise<CancellationReconciliationReport> {
  if (!/^[A-Za-z0-9._-]+$/.test(options.sessionId) || options.sessionId.includes("..")) throw new Error("Invalid host session ID");
  const repositoryPath = await realpath(options.repositoryPath);
  const stateDirectory = findPrivateRuntimeStateDirectory(repositoryPath);
  if (!stateDirectory) throw new Error("No existing Bflow host; preserve state and reconcile the session before retrying");
  const directory = resolve(stateDirectory, "host", options.sessionId);
  const configuration = await readHostConfiguration(join(directory, "host.json"));
  if (configuration.repositoryPath !== repositoryPath || configuration.sessionId !== options.sessionId || configuration.directory !== directory)
    throw new Error("Foreign host configuration");
  const report = CancellationReconciliationReportSchema.parse(await callHost(configuration.socketPath, configuration.token,
    // Bounded per-execution stops run under the journal lock; a client timeout does not mean the host stopped applying them.
    "reconcile_cancellation", { runId: textField(options.runId) }, RECONCILE_CANCELLATION_TIMEOUT_MS));
  if (report.runId !== options.runId) throw new Error("Foreign cancellation report");
  return report;
}
