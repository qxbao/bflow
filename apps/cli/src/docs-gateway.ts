import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { GatewayControlClient, resolvePrivateRuntimeStateDirectory } from "@bflow/runtime";
import type { MCPClientRegistration, ResolvedToolGrant } from "@bflow/contracts";
import type { DocsTool, DocsToolCaller, ToolCallOutcome } from "@bflow/docs-retrieval";
import { GATEWAY_CONTROL_LOCATOR_FILE } from "./gateway-control.js";
import { readGatewayReadiness } from "./gateway-readiness.js";
import type { RepositoryIdentity } from "./repository.js";

import { CONTEXT7_SERVICE_ID, CONTEXT7_TOOLS } from "./context7-constants.js";

export const CONTEXT7_SERVICE = CONTEXT7_SERVICE_ID;
const CONTEXT7_TOOL_NAMES = CONTEXT7_TOOLS;
const LAUNCH_ID_ENV = "BFLOW_LAUNCH_ID";
const TOKEN_ENV = /^BFLOW_MCP_TOKEN_[A-Z0-9_]{1,50}$/;
const LAUNCH_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The repository the Bflow host was started from. A Developer pane works in a task worktree whose top level differs, but the
 * host's private state (probe plans, Gateway registrations) belongs to the main working tree, which is the parent of the shared
 * git directory. Returns undefined outside git.
 */
export async function resolveHostRepositoryRoot(cwd: string): Promise<string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const query = (flag: string) => new Promise<string | undefined>(done => {
    execFile("git", ["rev-parse", flag], { cwd, env, timeout: 5000 }, (error, stdout) => done(error ? undefined : stdout.trim() || undefined));
  });
  const common = await query("--git-common-dir");
  if (common) {
    const absolute = isAbsolute(common) ? common : resolve(cwd, common);
    if (basename(absolute) === ".git") return dirname(absolute);
  }
  return query("--show-toplevel");
}

export interface GatewayTarget {
  readonly endpoint: string;
  readonly token: string;
  readonly registrationId: string;
}

export type DocsAccess =
  | { readonly mode: "agent"; readonly target: GatewayTarget; readonly release?: undefined }
  | { readonly mode: "operator"; readonly target: GatewayTarget; readonly release: () => Promise<void> }
  | { readonly mode: "none"; readonly reason: string; readonly kind: "no_gateway" | "not_granted" | "disabled" | "failed" };

const isLoopback = (endpoint: string): boolean => {
  try { const url = new URL(endpoint); return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password; }
  catch { return false; }
};

/**
 * An agent's own Gateway access: the host exports `BFLOW_LAUNCH_ID` and one `BFLOW_MCP_TOKEN_*` per registration into the
 * provider process, and writes a token-free plan naming the Gateway endpoint for that launch. The token never leaves the
 * environment of the process that runs this command, and the Gateway authorizes the call against that registration.
 */
export async function discoverAgentAccess(env: Readonly<Record<string, string | undefined>>, repositoryRoot: string): Promise<GatewayTarget | undefined> {
  const launchId = env[LAUNCH_ID_ENV];
  if (!launchId || !LAUNCH_ID.test(launchId)) return undefined;
  // Resolving private state creates `.bflow/`; never do that as a side effect of a lookup in a directory Bflow does not own.
  if (!existsSync(join(repositoryRoot, ".bflow"))) return undefined;
  const hostRoot = join(resolvePrivateRuntimeStateDirectory(repositoryRoot), "host");
  let sessions: string[];
  try { sessions = await readdir(hostRoot); } catch { return undefined; }
  for (const session of sessions) {
    const path = join(hostRoot, session, "gateway-probes", `${launchId}.json`);
    let plan: unknown;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) continue;
      plan = JSON.parse(await readFile(path, "utf8"));
    } catch { continue; }
    if (typeof plan !== "object" || plan === null) continue;
    const record = plan as { launchId?: unknown; endpoint?: unknown; entries?: unknown };
    if (record.launchId !== launchId || typeof record.endpoint !== "string" || !isLoopback(record.endpoint) || !Array.isArray(record.entries)) continue;
    for (const entry of record.entries as Array<{ registrationId?: unknown; envName?: unknown; allowedTools?: unknown }>) {
      if (typeof entry.envName !== "string" || !TOKEN_ENV.test(entry.envName) || typeof entry.registrationId !== "string") continue;
      const tools = Array.isArray(entry.allowedTools) ? entry.allowedTools : [];
      const token = env[entry.envName];
      if (token && CONTEXT7_TOOL_NAMES.every(name => tools.includes(name))) return { endpoint: record.endpoint, token, registrationId: entry.registrationId };
    }
  }
  return undefined;
}

export interface OperatorAccessOptions {
  readonly stateDirectory: string;
  readonly machineId: string;
  readonly repository: RepositoryIdentity;
  readonly role: string;
  readonly now?: () => Date;
}

/**
 * Operator use outside an agent pane: the account owner enrolls one short-lived Gateway client through the private control
 * endpoint, acts under the chosen role's grant, and revokes it afterwards. The enrollment is the same one a role launch
 * makes, so the Gateway applies the same service and tool limits.
 */
export async function enrollOperatorAccess(options: OperatorAccessOptions): Promise<DocsAccess> {
  const locator = join(options.stateDirectory, GATEWAY_CONTROL_LOCATOR_FILE);
  const client = await GatewayControlClient.fromLocator(locator);
  if (!client.ok) return { mode: "none", kind: "no_gateway", reason: client.error.message };
  const readiness = await readGatewayReadiness(options.stateDirectory, CONTEXT7_SERVICE);
  if (!readiness.endpoint) return { mode: "none", kind: "no_gateway", reason: "The Gateway has not published its endpoint; run 'bflow setup'." };
  const now = (options.now ?? (() => new Date()))();
  const sessionId = `docs-${randomUUID().slice(0, 12)}`;
  const registrationId = `docs-cli-${randomUUID().slice(0, 16)}`;
  const scope = { kind: "session" as const, machineId: options.machineId, repositoryId: options.repository.id, workspaceRoot: options.repository.root, sessionId };
  const registration = {
    schemaVersion: 3 as const, registrationId, provider: "claude" as const, role: options.role as MCPClientRegistration["role"], scope,
    environmentId: "docs-cli", serviceIds: [CONTEXT7_SERVICE], allowedTools: [...CONTEXT7_TOOL_NAMES],
    connection: { transport: "streamable_http" as const, endpoint: readiness.endpoint, token: `secret://bflow/docs-cli/${registrationId}` },
    configDigest: "0".repeat(64), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(), idempotencyKey: `${registrationId}:${randomUUID()}`
  };
  const grant: ResolvedToolGrant = {
    schemaVersion: 3,
    grantId: `grant-${registrationId}`,
    policyDigest: "0".repeat(64),
    toolId: "context7",
    kind: "native_remote_mcp",
    requiredness: "optional",
    role: options.role as ResolvedToolGrant["role"],
    scope,
    serviceId: CONTEXT7_SERVICE,
    operations: [...CONTEXT7_TOOL_NAMES],
    triggers: ["external_documentation"]
  };
  const granted = await client.value.register(registration as MCPClientRegistration, undefined, [grant]);
  if (!granted.ok) return { mode: "none", kind: "not_granted", reason: granted.error.message };
  const operation = { schemaVersion: 3 as const, scope, idempotencyKey: `${registrationId}:revoke` };
  return { mode: "operator", target: { endpoint: readiness.endpoint, token: granted.value.bearerToken, registrationId },
    release: async () => { await client.value.revoke(registrationId, operation).catch(() => undefined); } };
}

/**
 * Reads the JSON-RPC message with the given id from an SSE body. Every complete event in the buffer is considered, comments and
 * events without data are skipped, other messages (notifications) are ignored, and a final event without its closing blank line
 * is still read when the stream ends.
 */
export async function readEvent(body: ReadableStream<Uint8Array>, id: number): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (event: string): unknown => {
    const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return undefined;
    try {
      const message = JSON.parse(data) as { id?: unknown; result?: unknown; error?: unknown };
      return message && message.id === id && (message.result !== undefined || message.error !== undefined) ? message : undefined;
    } catch { return undefined; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Response exceeded the size limit");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const found = parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (found !== undefined) return found;
      }
      if (done) return parse(buffer.trim() === "" ? "" : buffer);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

type RpcOutcome = { readonly ok: true; readonly result: any } | { readonly ok: false; readonly error: { code: string; message: string; retryable?: boolean; details?: unknown } };

/**
 * Calls Context7 through the shared Gateway with one registration's bearer token. One upstream session serves every agent;
 * this client only holds its own Gateway session and never starts a documentation process.
 */
export class GatewayDocsCaller implements DocsToolCaller {
  private session: string | undefined;
  private nextId = 1;
  constructor(private readonly target: GatewayTarget, private readonly fetchImpl: typeof fetch = fetch) {}

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<RpcOutcome> {
    const id = this.nextId++;
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.target.endpoint, { method: "POST", redirect: "error", signal: abort,
        headers: { Authorization: `Bearer ${this.target.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          ...(this.session ? { "Mcp-Session-Id": this.session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return timedOut
        ? { ok: false, error: { code: "timeout", retryable: true, message: "The Gateway did not answer in time.", details: { kind: "timeout" } } }
        : { ok: false, error: { code: "transport_unavailable", retryable: true, message: "The Gateway is not reachable.", details: { kind: "network" } } };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: { code: "validation", message: "The Gateway rejected this registration's bearer token.", details: { kind: "gateway_auth" } } };
    }
    const issued = response.headers.get("mcp-session-id");
    if (issued) this.session = issued;
    let message: any;
    try {
      message = (response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body ? await readEvent(response.body, id) : await response.json();
    } catch { return { ok: false, error: { code: "corruption", message: "The Gateway sent an unreadable response." } }; }
    if (!response.ok || !message) return { ok: false, error: { code: "transport_unavailable", retryable: true, message: `The Gateway answered HTTP ${response.status}.`, details: { kind: "upstream_http", status: response.status } } };
    if (message.error) {
      const data = message.error.data;
      if (data && typeof data === "object" && typeof data.code === "string") return { ok: false, error: { code: data.code, message: String(data.message ?? message.error.message), retryable: data.retryable === true, details: data.details } };
      return { ok: false, error: { code: "transport_unavailable", retryable: true, message: String(message.error.message ?? "Gateway error") } };
    }
    return { ok: true, result: message.result };
  }

  private async ensureSession(timeoutMs: number, signal?: AbortSignal): Promise<RpcOutcome | undefined> {
    if (this.session) return undefined;
    const opened = await this.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bflow-docs", version: "0.1.0" } }, timeoutMs, signal);
    return opened.ok && this.session ? undefined : opened.ok ? { ok: false, error: { code: "corruption", message: "The Gateway did not open a session." } } : opened;
  }

  async callTool(tool: DocsTool, args: Readonly<Record<string, unknown>>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolCallOutcome> {
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const failed = await this.ensureSession(timeoutMs, options?.signal);
    if (failed && !failed.ok) return { ok: false, error: failed.error };
    const reply = await this.rpc("tools/call", { name: tool, arguments: args, serviceId: CONTEXT7_SERVICE, timeoutMs }, timeoutMs, options?.signal);
    if (!reply.ok) return { ok: false, error: reply.error };
    const result = reply.result as { status?: string; output?: unknown } | undefined;
    const output = result?.output;
    const text = Array.isArray(output)
      ? output.map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("")
      : typeof output === "string" ? output : "";
    if (result?.status === "unknown") return { ok: false, error: { code: "unknown_delivery", message: "The outcome of the lookup could not be confirmed.", retryable: false } };
    return { ok: true, isError: result?.status === "failed", text };
  }

  async listTools(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: true; tools: readonly string[] } | { ok: false; error: { code: string; message: string; details?: unknown } }> {
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const failed = await this.ensureSession(timeoutMs, options?.signal);
    if (failed && !failed.ok) return { ok: false, error: failed.error };
    const reply = await this.rpc("tools/list", {}, timeoutMs, options?.signal);
    if (!reply.ok) return { ok: false, error: reply.error };
    const tools = Array.isArray(reply.result?.tools) ? reply.result.tools as Array<{ name?: unknown; serviceId?: unknown }> : [];
    return { ok: true, tools: tools.filter(tool => tool.serviceId === CONTEXT7_SERVICE && typeof tool.name === "string").map(tool => tool.name as string) };
  }
}
