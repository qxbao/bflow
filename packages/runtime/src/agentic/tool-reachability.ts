import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentRoleSchema, MCPEndpointSchema, type AgentRole, type MCPClientRegistration } from "@bflow/contracts";
import type { PreparedRoleLaunch } from "../platform/index.js";
import { tokenEnvironmentName } from "../platform/gateway-registrations.js";
import { digest } from "./journal.js";

/**
 * In-process MCP tool reachability (H1).
 *
 * The host writes `gateway-probes/<launchId>.json` (no tokens) for every launch with registrations. The provider's native SessionStart hook runs as a
 * child of the launched provider, inherits its environment, probes each Gateway registration with the bearer token
 * read from `BFLOW_MCP_TOKEN_*`, and reports only env-var names, registration ids, codes and discovered tool names.
 * Bearer token values never appear in any result, error message or persisted file written by this module.
 */

export const GATEWAY_PROBE_SCHEMA_VERSION = 3;
export const GATEWAY_PROBE_TIMEOUT_MS = 5_000;
const ENV_NAME_PATTERN = /^BFLOW_MCP_TOKEN_[A-Z0-9_]{1,50}$/;

export const GatewayProbeEntrySchema = z.object({
  registrationId: z.string().min(1).max(200),
  envName: z.string().regex(ENV_NAME_PATTERN),
  allowedTools: z.array(z.string().min(1)).min(1)
}).strict();
export type GatewayProbeEntry = z.infer<typeof GatewayProbeEntrySchema>;

/** Private host-written probe plan for one role launch. Contains no token values. */
export const GatewayProbeFileSchema = z.object({
  schemaVersion: z.literal(GATEWAY_PROBE_SCHEMA_VERSION),
  launchId: z.string().min(1),
  endpoint: MCPEndpointSchema,
  entries: z.array(GatewayProbeEntrySchema).min(1)
}).strict();
export type GatewayProbeFile = z.infer<typeof GatewayProbeFileSchema>;

export const TOOL_REACHABILITY_CODES = [
  "token_env_missing", "unauthorized", "http_error", "timeout", "unreachable", "protocol_error", "missing_tools"
] as const;
export type ToolReachabilityCode = (typeof TOOL_REACHABILITY_CODES)[number];
export const ToolReachabilityCodeSchema = z.enum(TOOL_REACHABILITY_CODES);

/** One probe result, as reported by the provider process. `code` is null exactly when `ok` is true. */
export const ToolReachabilityRecordSchema = z.object({
  registrationId: z.string().min(1).max(200),
  envName: z.string().regex(ENV_NAME_PATTERN),
  ok: z.boolean(),
  discoveredTools: z.array(z.string().min(1)).max(1000),
  code: ToolReachabilityCodeSchema.nullable()
}).strict().refine(record => record.ok === (record.code === null), "ok and code are inconsistent");
export type ToolReachabilityRecord = z.infer<typeof ToolReachabilityRecordSchema>;

/** `provider_started` payload. The reachability fields travel together and only for roles with Gateway registrations. */
export const ProviderStartedPayloadSchema = z.object({
  paneId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  launchId: z.string().min(1).optional(),
  toolReachability: z.array(ToolReachabilityRecordSchema).optional()
}).strict().refine(value => (value.launchId === undefined) === (value.toolReachability === undefined),
  "launchId and toolReachability must be sent together");
export type ProviderStartedPayload = z.infer<typeof ProviderStartedPayloadSchema>;

/**
 * Which path reported a reachability fact: the provider's native SessionStart hook (`hook`) or the bootstrap probe that
 * the bflow MCP child runs at provider startup (`mcp_bootstrap`). Both probe from the same provider environment.
 */
export const REACHABILITY_SOURCES = ["hook", "mcp_bootstrap"] as const;
export type ReachabilitySource = (typeof REACHABILITY_SOURCES)[number];
export const ReachabilitySourceSchema = z.enum(REACHABILITY_SOURCES);

/**
 * `provider_bootstrap` payload, sent by the bflow MCP child (`host.js mcp <role.json>`) once per process at startup.
 * It carries reachability only: the native session comes from Herdr's own observation, never from this message.
 */
export const ProviderBootstrapPayloadSchema = z.object({
  launchId: z.string().min(1),
  paneId: z.string().min(1).optional(),
  toolReachability: z.array(ToolReachabilityRecordSchema).min(1),
  source: z.literal("mcp_bootstrap")
}).strict();
export type ProviderBootstrapPayload = z.infer<typeof ProviderBootstrapPayloadSchema>;

/** Reachability fields persisted in a launch receipt; other receipt fields are ignored here. */
const ReachabilityReceiptSchema = z.object({
  launchId: z.string().min(1).optional(),
  toolReachability: z.array(ToolReachabilityRecordSchema).optional()
});

/** Per-role summary for `platform_status`. Carries no tokens. */
export const RoleToolReachabilitySchema = z.object({
  role: AgentRoleSchema,
  launchId: z.string().min(1),
  state: z.enum(["ready", "pending", "failed"]),
  reason: z.string().nullable(),
  registrations: z.array(ToolReachabilityRecordSchema)
}).strict();
export type RoleToolReachability = z.infer<typeof RoleToolReachabilitySchema>;

/** What the host expects for one prepared launch: every registration must be reachable from inside the provider. */
export interface ReachabilityExpectation {
  readonly launchId: string;
  readonly entries: readonly GatewayProbeEntry[];
}

export interface ReportedReachability {
  readonly launchId: string;
  readonly toolReachability: readonly ToolReachabilityRecord[];
}

export type ReachabilityVerdict =
  | { readonly state: "ready" }
  | { readonly state: "pending"; readonly reason: string }
  | { readonly state: "failed"; readonly registrationId: string; readonly envName: string; readonly code: ToolReachabilityCode; readonly reason: string };

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GatewayProbeTarget extends GatewayProbeEntry {
  readonly endpoint: string;
}

/** Internal failure carrying only a code; never a message from the network stack. */
class ProbeFailure extends Error {
  constructor(readonly code: ToolReachabilityCode) {
    super(code);
  }
}

const InitializeResultSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.object({}).passthrough(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).passthrough()
}).passthrough();
const ToolsResultSchema = z.object({ tools: z.array(z.object({ name: z.string().min(1) }).passthrough()) }).passthrough();
const RpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().nullable(),
  result: z.unknown().optional(),
  error: z.unknown().optional()
}).passthrough();

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

interface RpcReply {
  readonly result: unknown;
  readonly sessionId: string | undefined;
}

async function rpc(fetchImpl: ProbeFetch, target: GatewayProbeTarget, token: string, id: number, method: string,
  params: Record<string, unknown>, sessionId: string | undefined, timeoutMs: number): Promise<RpcReply> {
  let response: Response;
  try {
    response = await fetchImpl(target.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId })
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });
  } catch (error) {
    throw new ProbeFailure(isAbort(error) ? "timeout" : "unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    throw new ProbeFailure("unauthorized");
  }
  if (!response.ok) {
    await discardBody(response);
    throw new ProbeFailure("http_error");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ProbeFailure(isAbort(error) ? "timeout" : "protocol_error");
  }
  const envelope = RpcEnvelopeSchema.safeParse(body);
  if (!envelope.success || envelope.data.id !== id || envelope.data.error !== undefined || envelope.data.result === undefined) {
    throw new ProbeFailure("protocol_error");
  }
  return { result: envelope.data.result, sessionId: response.headers.get("mcp-session-id") ?? undefined };
}

function failure(target: GatewayProbeEntry, code: ToolReachabilityCode, discoveredTools: readonly string[]): ToolReachabilityRecord {
  return { registrationId: target.registrationId, envName: target.envName, ok: false, discoveredTools: [...discoveredTools], code };
}

/**
 * Probes one Gateway registration from the calling process: initialize, then tools/list with the same session.
 * The bearer token is read from `env[target.envName]`; it is sent only in the Authorization header.
 * Never throws for probe outcomes; every failure maps to a code. Timeouts are enforced per request.
 */
export async function probeGatewayTools(target: GatewayProbeTarget, env: Readonly<Record<string, string | undefined>>,
  fetchImpl: ProbeFetch, timeoutMs: number): Promise<ToolReachabilityRecord> {
  const token = env[target.envName];
  if (token === undefined || token.length === 0) return failure(target, "token_env_missing", []);
  let sessionId: string | undefined;
  try {
    const initialized = await rpc(fetchImpl, target, token, 1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bflow-platform-probe", version: "0.1.0" }
    }, undefined, timeoutMs);
    if (!InitializeResultSchema.safeParse(initialized.result).success) throw new ProbeFailure("protocol_error");
    sessionId = initialized.sessionId;
    const listed = await rpc(fetchImpl, target, token, 2, "tools/list", {}, sessionId, timeoutMs);
    const parsed = ToolsResultSchema.safeParse(listed.result);
    if (!parsed.success) throw new ProbeFailure("protocol_error");
    const discovered = [...new Set(parsed.data.tools.map(tool => tool.name))].sort();
    if (target.allowedTools.some(tool => !discovered.includes(tool))) return failure(target, "missing_tools", discovered);
    return { registrationId: target.registrationId, envName: target.envName, ok: true, discoveredTools: discovered, code: null };
  } catch (error) {
    return failure(target, error instanceof ProbeFailure ? error.code : "unreachable", []);
  } finally {
    if (sessionId !== undefined) {
      // Best effort: release the probe's Gateway session. The result above is already decided.
      await fetchImpl(target.endpoint, {
        method: "DELETE", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId }
      }).then(response => discardBody(response), () => undefined);
    }
  }
}

const HINTS: Readonly<Record<ToolReachabilityCode, string>> = {
  token_env_missing: "the provider process did not receive the launch token environment variable; Herdr or the provider did not forward the launch environment",
  unauthorized: "the Gateway rejected the registration token; it is expired, revoked or replaced",
  http_error: "the Gateway answered with an HTTP error",
  timeout: "the Gateway did not answer within the probe timeout",
  unreachable: "the Gateway endpoint could not be reached from the provider process",
  protocol_error: "the Gateway answered with a malformed or mismatched MCP response",
  missing_tools: "the Gateway does not expose every allowed tool to this registration"
};

function failed(entry: GatewayProbeEntry, code: ToolReachabilityCode, reason: string): ReachabilityVerdict {
  return { state: "failed", registrationId: entry.registrationId, envName: entry.envName, code, reason };
}

/** Compares the provider's reported probe results with the host's expectation for one launch. Fails closed. */
export function evaluateToolReachability(expectation: ReachabilityExpectation,
  reported: ReportedReachability | undefined): ReachabilityVerdict {
  if (reported === undefined) return { state: "pending", reason: "no in-process tool reachability record has been published yet" };
  if (reported.launchId !== expectation.launchId) {
    return { state: "pending", reason: "the published tool reachability record belongs to another launch" };
  }
  for (const entry of expectation.entries) {
    const record = reported.toolReachability.find(candidate => candidate.registrationId === entry.registrationId);
    if (record === undefined) return failed(entry, "protocol_error", "the provider probe reported no result for this registration");
    if (record.envName !== entry.envName) return failed(entry, "protocol_error", "the provider probe reported a different token variable");
    if (!record.ok || record.code !== null) {
      const code = record.code ?? "protocol_error";
      return failed(entry, code, HINTS[code]);
    }
    if (entry.allowedTools.some(tool => !record.discoveredTools.includes(tool))) {
      return failed(entry, "missing_tools", HINTS.missing_tools);
    }
  }
  return { state: "ready" };
}

/** Throws `[bflow:native-startup-pending]` while unproven and a clear error once a probe has failed. */
export function assertRoleToolReachability(role: AgentRole, expectation: ReachabilityExpectation,
  reported: ReportedReachability | undefined): void {
  const verdict = evaluateToolReachability(expectation, reported);
  if (verdict.state === "pending") {
    throw new Error(`[bflow:native-startup-pending] ${role} has not proven Gateway tool reachability from its provider process: ${verdict.reason}`);
  }
  if (verdict.state === "failed") {
    throw new Error(`Required role ${role} cannot reach Gateway registration ${verdict.registrationId} from its provider process ` +
      `(${verdict.envName}: ${verdict.code}; ${verdict.reason})`);
  }
}

/** Extracts the reachability fields of a launch receipt; undefined when the hook did not report them. */
export function reportedReachabilityOf(receipt: Record<string, unknown>): ReportedReachability | undefined {
  const parsed = ReachabilityReceiptSchema.parse(receipt);
  if (parsed.launchId === undefined || parsed.toolReachability === undefined) return undefined;
  return { launchId: parsed.launchId, toolReachability: parsed.toolReachability };
}

export function summarizeToolReachability(role: AgentRole, expectation: ReachabilityExpectation,
  reported: ReportedReachability | undefined): RoleToolReachability {
  const verdict = evaluateToolReachability(expectation, reported);
  return RoleToolReachabilitySchema.parse({
    role,
    launchId: expectation.launchId,
    state: verdict.state === "ready" ? "ready" : verdict.state === "pending" ? "pending" : "failed",
    reason: verdict.state === "ready" ? null : verdict.reason,
    registrations: reported?.toolReachability ?? []
  });
}

// ------------------------------------------------------------------ host files

/** Non-secret environment variable naming the launch whose probe plan the provider hook must use. */
export const BFLOW_LAUNCH_ID_ENV = "BFLOW_LAUNCH_ID";
/** Launch-keyed token-free probe plans: `<host dir>/gateway-probes/<launchId>.json`. */
export const GATEWAY_PROBE_DIRECTORY = "gateway-probes";
/** Launch-keyed reachability records reported by the provider hook: `<host dir>/launch-reachability/<digest>.json`. */
export const LAUNCH_REACHABILITY_DIRECTORY = "launch-reachability";
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** A launch id becomes a file name, so only identifier characters are admissible (no separators, no dots). */
export function assertLaunchIdentifier(launchId: string): string {
  if (!LAUNCH_ID_PATTERN.test(launchId)) throw new Error("Launch id is not a safe identifier for a Gateway probe plan");
  return launchId;
}

export function launchProbePath(probeDirectory: string, launchId: string): string {
  return join(probeDirectory, `${assertLaunchIdentifier(launchId)}.json`);
}

/** Legacy per-role plan written by daemons that predate launch-keyed plans. Read only as a hook fallback. */
export function legacyRoleProbePath(directory: string, role: AgentRole): string {
  return join(directory, `${role}.gateway.json`);
}

export function launchReachabilityPath(reachabilityDirectory: string, launchId: string): string {
  return join(reachabilityDirectory, `${digest([launchId])}.json`);
}

/** Atomic private write (0600): temp file, then rename. */
export async function writePrivateFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Builds the token-free probe plan and expectation for one prepared launch; undefined when it has no registrations. */
function probePlanOf(prepared: PreparedRoleLaunch): { readonly file: GatewayProbeFile; readonly expectation: ReachabilityExpectation } | undefined {
  const registrations: readonly MCPClientRegistration[] = prepared.gateway.registrations.filter(
    registration => prepared.launch.env[tokenEnvironmentName(registration.registrationId)] !== undefined
  );
  if (registrations.length === 0) return undefined;
  const endpoints = new Set<string>();
  for (const registration of registrations) {
    if (registration.connection.transport !== "streamable_http") {
      throw new Error(`Gateway registration for role ${prepared.role} uses an unsupported transport for in-process probing`);
    }
    endpoints.add(registration.connection.endpoint);
  }
  if (endpoints.size !== 1) throw new Error(`Gateway registrations for role ${prepared.role} disagree on the endpoint`);
  const entries = registrations.map(registration => GatewayProbeEntrySchema.parse({
    registrationId: registration.registrationId,
    envName: tokenEnvironmentName(registration.registrationId),
    allowedTools: [...registration.allowedTools]
  }));
  const launchId = prepared.launch.launchId;
  const file = GatewayProbeFileSchema.parse({ schemaVersion: GATEWAY_PROBE_SCHEMA_VERSION, launchId, endpoint: [...endpoints][0], entries });
  return { file, expectation: { launchId, entries } };
}

/**
 * Publishes the plan of one launch (permanent role at prepare, or a Developer at allocation) as `<launchId>.json`.
 * Returns the expectation the host must see satisfied; undefined when the launch has no Gateway registrations.
 * Token values are never read here: only registration ids, derived env names, allowed tool names and the endpoint.
 */
export async function publishLaunchProbe(probeDirectory: string, prepared: PreparedRoleLaunch): Promise<ReachabilityExpectation | undefined> {
  const planned = probePlanOf(prepared);
  if (planned === undefined) return undefined;
  await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(launchProbePath(probeDirectory, planned.file.launchId), `${JSON.stringify(planned.file)}\n`);
  return planned.expectation;
}

export async function removeLaunchProbe(probeDirectory: string, launchId: string): Promise<void> {
  await rm(launchProbePath(probeDirectory, launchId), { force: true });
}

/** Removes legacy per-role plans so a new generation never inherits an earlier generation's probe. */
export async function removeLegacyRoleProbes(directory: string, roles: readonly AgentRole[]): Promise<void> {
  await Promise.all(roles.map(role => rm(legacyRoleProbePath(directory, role), { force: true })));
}

/** Reads a probe plan file; undefined when absent. A present but invalid plan is an error. */
export async function readGatewayProbeFile(path: string): Promise<GatewayProbeFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return GatewayProbeFileSchema.parse(JSON.parse(text));
}

/**
 * The provider hook's plan. A launch id in the environment selects `gateway-probes/<launchId>.json` (its validated
 * identifier and the file's own launch id must agree). Only when the id is absent does the hook fall back to the
 * legacy `<role>.gateway.json` written by an older daemon.
 */
export async function resolveProbePlan(directory: string, role: AgentRole,
  env: Readonly<Record<string, string | undefined>>): Promise<GatewayProbeFile | undefined> {
  const launchId = env[BFLOW_LAUNCH_ID_ENV];
  if (launchId === undefined) return readGatewayProbeFile(legacyRoleProbePath(directory, role));
  const plan = await readGatewayProbeFile(launchProbePath(join(directory, GATEWAY_PROBE_DIRECTORY), launchId));
  if (plan !== undefined && plan.launchId !== launchId) throw new Error("Gateway probe plan names another launch");
  return plan;
}

/** Reachability reported by the hook for one launch, keyed by launch id and bound to the pane it ran in. */
export const LaunchReachabilityRecordSchema = z.object({
  launchId: z.string().min(1),
  paneId: z.string().min(1),
  toolReachability: z.array(ToolReachabilityRecordSchema),
  /** Absent in records written before the bootstrap path existed; those were all hook proofs. */
  source: ReachabilitySourceSchema.optional()
}).strict();
export type LaunchReachabilityRecord = z.infer<typeof LaunchReachabilityRecordSchema>;

/** One launch's reachability proof: which launch and pane, the probe records and the path that reported them. */
export interface ReachabilityFact {
  readonly launchId: string;
  readonly paneId: string;
  readonly toolReachability: readonly ToolReachabilityRecord[];
  readonly source: ReachabilitySource;
}

const allProbesOk = (records: readonly ToolReachabilityRecord[]): boolean => records.every(record => record.ok);

/**
 * Precedence between a stored and an incoming reachability fact for the same launch (hook and bootstrap both report it):
 * - a different launch or pane replaces the stored fact (the launch was bound to another pane);
 * - the first all-ok fact of a launch and pane is kept; a later all-ok fact does not replace it;
 * - an incoming fact never downgrades a stored all-ok fact, except one failing with `unauthorized`: the Gateway
 *   rejecting a token it accepted earlier is a newer, real revocation;
 * - a stored fact with any failure is replaced by the incoming one (latest diagnostics, or recovery to ok).
 * Pure: callers serialize the read-select-write sequence.
 */
export function selectReachabilityFact(stored: ReachabilityFact | undefined, incoming: ReachabilityFact): ReachabilityFact {
  if (stored === undefined || stored.launchId !== incoming.launchId || stored.paneId !== incoming.paneId) return incoming;
  if (!allProbesOk(stored.toolReachability)) return incoming;
  if (allProbesOk(incoming.toolReachability)) return stored;
  return incoming.toolReachability.some(record => record.code === "unauthorized") ? incoming : stored;
}

export async function writeLaunchReachability(reachabilityDirectory: string, launchId: string, paneId: string,
  toolReachability: readonly ToolReachabilityRecord[], source: ReachabilitySource = "hook"): Promise<void> {
  const record = LaunchReachabilityRecordSchema.parse({ launchId, paneId, toolReachability, source });
  await mkdir(reachabilityDirectory, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(launchReachabilityPath(reachabilityDirectory, launchId), `${JSON.stringify(record)}\n`);
}

/** Reads the reachability record of one launch; undefined when none has been reported yet. */
export async function readLaunchReachability(reachabilityDirectory: string, launchId: string):
  Promise<{ readonly paneId: string; readonly reported: ReportedReachability } | undefined> {
  const fact = await readLaunchReachabilityFact(reachabilityDirectory, launchId);
  return fact === undefined ? undefined : { paneId: fact.paneId, reported: { launchId: fact.launchId, toolReachability: [...fact.toolReachability] } };
}

/** Reads one launch's reachability proof together with the path that reported it; undefined when none has been reported. */
export async function readLaunchReachabilityFact(reachabilityDirectory: string, launchId: string): Promise<ReachabilityFact | undefined> {
  let text: string;
  try {
    text = await readFile(launchReachabilityPath(reachabilityDirectory, launchId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const record = LaunchReachabilityRecordSchema.parse(JSON.parse(text));
  if (record.launchId !== launchId) throw new Error("Launch reachability record names another launch");
  return { launchId: record.launchId, paneId: record.paneId, toolReachability: record.toolReachability, source: record.source ?? "hook" };
}

export async function removeLaunchReachability(reachabilityDirectory: string, launchId: string): Promise<void> {
  await rm(launchReachabilityPath(reachabilityDirectory, launchId), { force: true });
}

/** Probes every entry of a plan in parallel, from the calling (provider) process environment. */
export async function probeAllGateways(plan: GatewayProbeFile, env: Readonly<Record<string, string | undefined>>,
  fetchImpl: ProbeFetch, timeoutMs = GATEWAY_PROBE_TIMEOUT_MS): Promise<ToolReachabilityRecord[]> {
  return Promise.all(plan.entries.map(entry => probeGatewayTools({ endpoint: plan.endpoint, ...entry }, env, fetchImpl, timeoutMs)));
}

/** Digest key of a role's launch receipt file (matches the host's receipt naming). */
export function launchReceiptName(role: AgentRole, paneId: string): string {
  return digest([role, paneId]) + ".json";
}
