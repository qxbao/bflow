import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { GatewayTarget } from "../../src/docs-gateway.js";

// The Gateway is loaded the way the daemon loads it. Everything here is fake: the hosted service is a local HTTP server
// that behaves like the one observed on 2026-10-19. Real-service tests live in context7-live.test.ts and are opt-in.
export const gatewayModule = () => import(new URL("../../../../packages/mcp-gateway/dist/index.js", import.meta.url).href);
export const SECRET_REF = "secret://bflow/context7/api-key";
export const KEY = "ctx7sk-0123456789abcdef-test";
export const fixtureDirectory = join(import.meta.dirname, "../../../../packages/docs-retrieval/test/fixtures");

export interface Upstream { endpoint: string; seen: Array<{ method: string; authorization: string | null; tool?: string; args?: any }>; close(): Promise<void>;
  behave(next: Partial<Behavior>): void; sessions: Set<string> }
export interface Behavior {
  /** Responses for tools/call consumed in order before normal handling: an HTTP status or "hang". */
  faults: Array<{ status: number; headers?: Record<string, string> } | "hang">;
  requireKey?: string;
  stateful: boolean;
  queryText: (args: any) => { text: string; isError?: boolean };
  resolveText: string;
}

export async function startUpstream(resolveText: string, port = 0): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const sessions = new Set<string>();
  const behavior: Behavior = { faults: [], stateful: false, resolveText, queryText: args => ({ text: `docs for ${args.libraryId}: ${args.query}` }) };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "DELETE") { sessions.delete(String(req.headers["mcp-session-id"])); res.writeHead(200).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const authorization = (req.headers["authorization"] as string | undefined) ?? null;
      seen.push({ method: body.method, authorization, ...(body.method === "tools/call" ? { tool: body.params.name, args: body.params.arguments } : {}) });
      const sse = (payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(payload as object) })}\n\n`);
      };
      if (!String(req.headers["accept"] ?? "").includes("text/event-stream")) { res.writeHead(406).end(); return; }
      if (body.method === "tools/call" && behavior.faults.length > 0) {
        const fault = behavior.faults.shift()!;
        if (fault === "hang") return;
        res.writeHead(fault.status, fault.headers ?? {}).end("busy");
        return;
      }
      if (behavior.stateful && body.method !== "initialize" && !sessions.has(String(req.headers["mcp-session-id"] ?? ""))) { res.writeHead(404).end(); return; }
      if (body.method === "initialize") {
        const headers: Record<string, string> = {};
        if (behavior.stateful) { const id = `up-${Math.random().toString(16).slice(2, 10)}`; sessions.add(id); headers["Mcp-Session-Id"] = id; }
        sse({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Context7", version: "4.4.3" } } }, headers);
      } else if (body.method === "notifications/initialized") res.writeHead(202).end();
      else if (body.method === "tools/list") sse({ result: { tools: ["resolve-library-id", "query-docs"].map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true, idempotentHint: true } })) } });
      else if (body.method === "tools/call") {
        if (behavior.requireKey && authorization !== `Bearer ${behavior.requireKey}`) { sse({ result: { content: [{ type: "text", text: "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix." }], isError: true } }); return; }
        const args = body.params.arguments;
        if (body.params.name === "resolve-library-id") sse({ result: { content: [{ type: "text", text: behavior.resolveText }] } });
        else { const answer = behavior.queryText(args); sse({ result: { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) } }); }
      } else res.writeHead(400).end();
    });
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { endpoint, seen, sessions, behave: next => Object.assign(behavior, next),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export async function startGateway(upstream: string, options: { apiKey?: string; authenticated?: boolean; declareReadOnly?: boolean } = {}) {
  const module = await gatewayModule();
  // The daemon declares the hosted Context7 tools read-only (trustedGatewayPolicy); the fake upstream runs on loopback, so the same
  // declaration is made here by service id.
  const gateway = new module.BflowSharedMCPGateway({ policyOverrides: (service: { serviceId: string }) => service.serviceId === "context7" && options.declareReadOnly !== false ? { readOnlyTools: ["resolve-library-id", "query-docs"] } : undefined });
  if (options.apiKey) gateway.secretStore.setSecret(SECRET_REF, options.apiKey);
  const server = new module.StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
  const endpoint = `${await server.start()}/mcp`;
  const scope = { kind: "session" as const, machineId: "m1", repositoryId: "r1", workspaceRoot: "/tmp/ws", sessionId: "s1" };
  const operation = { schemaVersion: 3 as const, scope, idempotencyKey: "gateway-op" };
  const service = { schemaVersion: 3 as const, serviceId: "context7", revision: 1, scope: { kind: "machine" as const, machineId: "m1" },
    tool: { schemaVersion: 3 as const, toolId: "context7", kind: "native_remote_mcp" as const, version: "hosted", operations: ["resolve-library-id", "query-docs"],
      resource: { sharing: "concurrent" as const, maxConcurrency: 16 }, required: false },
    connection: { kind: "native_remote_mcp" as const, endpoint: upstream, ownership: "external" as const },
    authentication: options.authenticated ? { mode: "bearer" as const, credential: SECRET_REF } : { mode: "none" as const },
    healthTimeoutMs: 2000, idleTimeoutMs: 60_000, restartLimit: 2 };
  const ensured = await gateway.serviceManager.ensure(service, operation);
  let counter = 0;
  const enroll = async (role: string, provider: string, grant: { serviceIds?: string[]; allowedTools?: string[] } = {}): Promise<GatewayTarget> => {
    const registrationId = `reg-${role}-${provider}-${++counter}`;
    const registered = await gateway.register({ schemaVersion: 3, registrationId, provider, role, scope, environmentId: "env", serviceIds: grant.serviceIds ?? ["context7"],
      allowedTools: grant.allowedTools ?? ["resolve-library-id", "query-docs"],
      connection: { transport: "streamable_http", endpoint, token: `secret://test/${registrationId}` }, configDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), idempotencyKey: `${registrationId}-k` });
    if (!registered.ok) throw new Error(registered.error.message);
    return { endpoint, token: gateway.secretStore.getClientTokenByRegistration(registrationId)!, registrationId };
  };
  return { gateway, server, endpoint, ensured, operation, enroll, metrics: () => gateway.metrics.snapshot(),
    stop: async () => { await server.stop(); await gateway.serviceManager.stop("context7", operation).catch(() => undefined); } };
}

