import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { DEEPWIKI_PROBE_REPO, DocsClient } from "@bflow/docs-retrieval";
import { GatewayDocsCaller } from "./docs-gateway.js";
import { DEEPWIKI_ENDPOINT, DEEPWIKI_SERVICE_ID, DEEPWIKI_TOOLS } from "./deepwiki-constants.js";

/**
 * Evidence from one owner-run probe of DeepWiki through Bflow's own Gateway.
 *  - `live`: the fixed hosted endpoint was contacted for real (`ok` says whether it answered).
 *  - `fixture`: a stand-in server answered. It proves the code path only and is never live evidence.
 *  - `skipped`: nothing was contacted.
 */
export interface DeepWikiProbeResult {
  readonly mode: "live" | "fixture" | "skipped";
  readonly ok: boolean;
  readonly timestamp: string;
  readonly revision: string;
  readonly endpoint: string;
  readonly toolsListed: readonly string[];
  readonly readCall: { readonly tool: string; readonly ok: boolean; readonly characters?: number } | null;
  readonly reason?: string;
}

export interface DeepWikiProbeOptions {
  /** Really contact the service. Without it the probe is skipped. */
  readonly live?: boolean;
  /** Test seam: a different server. Anything other than the hosted endpoint is labeled `fixture`, never `live`. */
  readonly upstreamEndpoint?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** The checkout revision to record; read from Git when omitted. */
  readonly revision?: string;
}

function checkoutRevision(): Promise<string> {
  return new Promise(done => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: new URL(".", import.meta.url).pathname, timeout: 5000 }, (error, stdout) => done(error ? "unknown" : stdout.trim() || "unknown"));
  });
}

/** The platform fetch as it was when this module loaded, before anything in the process could replace it. */
const startupFetch = globalThis.fetch;

export async function runDeepWikiProbe(options: DeepWikiProbeOptions = {}): Promise<DeepWikiProbeResult> {
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const revision = options.revision ?? await checkoutRevision();
  if (options.live !== true)
    return { mode: "skipped", ok: false, timestamp, revision, endpoint: DEEPWIKI_ENDPOINT, toolsListed: [], readCall: null,
      reason: "Not run: pass --live to contact the hosted DeepWiki service. A skipped probe is not live evidence." };

  const endpoint = options.upstreamEndpoint ?? DEEPWIKI_ENDPOINT;
  const mode = endpoint === DEEPWIKI_ENDPOINT ? "live" : "fixture";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = { mode, timestamp, revision, endpoint } as const;
  let stop: (() => Promise<void>) | undefined;
  // A fixture run talks only to its own loopback stand-in, so an override of the ambient fetch must not decide its outcome. A live run
  // uses whatever fetch the process has, because that is exactly what reaches the hosted service.
  const ambientFetch = globalThis.fetch;
  if (mode === "fixture") globalThis.fetch = startupFetch;
  try {
    const gateway = await import("@bflow/mcp-gateway");
    const tools: any = await import("@bflow/tool-installer");
    const scope = { kind: "session" as const, machineId: "deepwiki-probe", repositoryId: "deepwiki-probe", workspaceRoot: tmpdir(), sessionId: "deepwiki-probe" };
    const operation = { schemaVersion: 3 as const, scope, idempotencyKey: `deepwiki-probe-${timestamp}` };
    const hub = new gateway.BflowSharedMCPGateway({ policyOverrides: (service: { serviceId: string }) => service.serviceId === DEEPWIKI_SERVICE_ID ? { readOnlyTools: [...DEEPWIKI_TOOLS] } : undefined });
    const server = new gateway.StreamableHttpGatewayServer({ gateway: hub, host: "127.0.0.1", port: 0 });
    const gatewayEndpoint = `${await server.start()}/mcp`;
    stop = async () => { await server.stop().catch(() => undefined); await hub.serviceManager.stop(DEEPWIKI_SERVICE_ID, operation).catch(() => undefined); };

    const defined = tools.createDeepWikiRemoteService({ operation: { schemaVersion: 3, scope: { kind: "machine", machineId: "deepwiki-probe" }, idempotencyKey: operation.idempotencyKey } });
    const service = { ...defined, connection: { ...defined.connection, endpoint }, healthTimeoutMs: Math.max(1000, timeoutMs) };
    const ensured = await hub.serviceManager.ensure(service, operation);
    if (!ensured.ok) return { ...base, ok: false, toolsListed: [], readCall: null, reason: `The Gateway could not reach DeepWiki: ${ensured.error.message}` };

    const registrationId = "deepwiki-probe-client";
    const registered = await hub.register({ schemaVersion: 3, registrationId, provider: "claude", role: "developer", scope, environmentId: "deepwiki-probe",
      serviceIds: [DEEPWIKI_SERVICE_ID], allowedTools: [...DEEPWIKI_TOOLS],
      connection: { transport: "streamable_http", endpoint: gatewayEndpoint, token: `secret://bflow/deepwiki-probe/${registrationId}` },
      configDigest: "0".repeat(64), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), idempotencyKey: `${registrationId}:${timestamp}` } as never);
    if (!registered.ok) return { ...base, ok: false, toolsListed: [], readCall: null, reason: `The Gateway refused the probe registration: ${registered.error.message}` };
    const token = hub.secretStore.getClientTokenByRegistration(registrationId);
    if (!token) return { ...base, ok: false, toolsListed: [], readCall: null, reason: "The Gateway issued no probe token." };

    const caller = new GatewayDocsCaller({ endpoint: gatewayEndpoint, token, registrationId });
    const listed = await caller.listTools({ timeoutMs });
    if (!listed.ok) return { ...base, ok: false, toolsListed: [], readCall: null, reason: `tools/list failed: ${listed.error.message}` };
    const toolsListed = [...listed.tools];
    const missing = DEEPWIKI_TOOLS.filter(tool => !toolsListed.includes(tool));
    if (missing.length > 0) return { ...base, ok: false, toolsListed, readCall: null, reason: `The service does not offer: ${missing.join(", ")}.` };

    const read = await new DocsClient({ caller, timeoutMs }).structure({ repoName: DEEPWIKI_PROBE_REPO, visibility: "public" });
    if (!read.ok) return { ...base, ok: false, toolsListed, readCall: { tool: "read_wiki_structure", ok: false }, reason: `read_wiki_structure failed (${read.failure.kind}): ${read.failure.message}` };
    return { ...base, ok: true, toolsListed, readCall: { tool: "read_wiki_structure", ok: true, characters: read.content.length } };
  } catch (error) {
    return { ...base, ok: false, toolsListed: [], readCall: null, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await stop?.();
    if (mode === "fixture") globalThis.fetch = ambientFetch;
  }
}

/** One line a person can paste into a record. The mode comes first and is never inferred from the outcome. */
export function formatDeepWikiProbe(result: DeepWikiProbeResult): string {
  const lines = [`DeepWiki probe: mode=${result.mode} ok=${result.ok} timestamp=${result.timestamp} revision=${result.revision}`,
    `  endpoint: ${result.endpoint}`,
    `  tools/list: ${result.toolsListed.length > 0 ? result.toolsListed.join(", ") : "none"}`,
    `  read call: ${result.readCall ? `${result.readCall.tool} ${result.readCall.ok ? `ok (${result.readCall.characters ?? 0} characters)` : "failed"}` : "none"}`];
  if (result.reason) lines.push(`  ${result.ok ? "note" : "failed"}: ${result.reason}`);
  if (result.mode === "fixture") lines.push("  This used a stand-in server: fixture output is not live evidence.");
  if (result.mode === "skipped") lines.push("  Nothing was contacted: a skipped probe is not live evidence.");
  if (result.mode === "live" && !result.ok) lines.push("  The hosted service was contacted and the probe failed; this is not a success.");
  return lines.join("\n");
}
