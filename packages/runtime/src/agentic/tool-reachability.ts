import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentRoleSchema, MCPEndpointSchema, type AgentRole, type MCPClientRegistration } from "@bflow/contracts";
import type { PreparedRoleLaunch } from "../platform/index.js";
import { tokenEnvironmentName } from "../platform/gateway-registrations.js";
import { digest } from "./journal.js";

/**
 * In-process MCP tool reachability (H1).
 *
 * The host writes `<role>.gateway.json` (no tokens) at prepare. The provider's native SessionStart hook runs as a
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

export function gatewayProbePath(directory: string, role: AgentRole): string {
  return join(directory, `${role}.gateway.json`);
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

/** Removes stale probe plans so a role without registrations cannot inherit an earlier generation's probe. */
export async function removeGatewayProbes(directory: string, roles: readonly AgentRole[]): Promise<void> {
  await Promise.all(roles.map(role => rm(gatewayProbePath(directory, role), { force: true })));
}

/**
 * Writes `<role>.gateway.json` for every prepared launch with Gateway registrations and returns the host's expectations.
 * Token values are never read here: only registration ids, derived env names, allowed tool names and the endpoint.
 */
export async function publishGatewayProbes(directory: string, roles: readonly AgentRole[],
  launches: ReadonlyMap<AgentRole, PreparedRoleLaunch>): Promise<Map<AgentRole, ReachabilityExpectation>> {
  const expectations = new Map<AgentRole, ReachabilityExpectation>();
  for (const role of roles) {
    const prepared = launches.get(role);
    const registrations: readonly MCPClientRegistration[] = prepared?.gateway.registrations ?? [];
    if (prepared === undefined || registrations.length === 0) {
      await rm(gatewayProbePath(directory, role), { force: true });
      continue;
    }
    const endpoints = new Set<string>();
    for (const registration of registrations) {
      if (registration.connection.transport !== "streamable_http") {
        throw new Error(`Gateway registration for role ${role} uses an unsupported transport for in-process probing`);
      }
      endpoints.add(registration.connection.endpoint);
    }
    if (endpoints.size !== 1) throw new Error(`Gateway registrations for role ${role} disagree on the endpoint`);
    const entries = registrations.map(registration => GatewayProbeEntrySchema.parse({
      registrationId: registration.registrationId,
      envName: tokenEnvironmentName(registration.registrationId),
      allowedTools: [...registration.allowedTools]
    }));
    const launchId = prepared.launch.launchId;
    const file = GatewayProbeFileSchema.parse({ schemaVersion: GATEWAY_PROBE_SCHEMA_VERSION, launchId,
      endpoint: [...endpoints][0], entries });
    await writePrivateFileAtomic(gatewayProbePath(directory, role), `${JSON.stringify(file)}\n`);
    expectations.set(role, { launchId, entries });
  }
  return expectations;
}

/** Reads a role's probe plan; undefined when the role has none. A present but invalid plan is an error. */
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

/** Probes every entry of a plan in parallel, from the calling (provider) process environment. */
export async function probeAllGateways(plan: GatewayProbeFile, env: Readonly<Record<string, string | undefined>>,
  fetchImpl: ProbeFetch, timeoutMs = GATEWAY_PROBE_TIMEOUT_MS): Promise<ToolReachabilityRecord[]> {
  return Promise.all(plan.entries.map(entry => probeGatewayTools({ endpoint: plan.endpoint, ...entry }, env, fetchImpl, timeoutMs)));
}

/** Digest key of a role's launch receipt file (matches the host's receipt naming). */
export function launchReceiptName(role: AgentRole, paneId: string): string {
  return digest([role, paneId]) + ".json";
}
