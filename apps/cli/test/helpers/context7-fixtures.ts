import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewayTarget } from "../../src/docs-gateway.js";

// File name kept from the Context7 era so every legacy suite keeps its import. The Gateway is loaded the way the daemon loads it.
// Everything here is fake: the hosted service is a local HTTP server that advertises the three DeepWiki tools with the input
// schemas recorded from https://mcp.deepwiki.com/mcp on 2026-10-29 (ask_wiki_question takes repoName as anyOf string | array<string>).
// Real-service tests live in context7-live.test.ts and are opt-in.
export const gatewayModule = () => import(new URL("../../../../packages/mcp-gateway/dist/index.js", import.meta.url).href);
export const DEEPWIKI_ID = "deepwiki";
export const DEEPWIKI_TOOL_NAMES = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
export const STRUCTURE_TEXT = "Available pages for facebook/react:\n\n- 1 React Overview\n  - 1.1 Repository Structure\n- 2 Reconciler\n  - 2.1 Fiber Architecture\n- 3 Glossary";

const repoProperty = { description: "GitHub repository in owner/repo format (e.g. \"facebook/react\").", type: "string" };
const recordedTools = [
  { name: "ask_wiki_question", description: "Ask any question about a GitHub repository's codebase and get an AI-powered answer grounded in its DeepWiki.",
    inputSchema: { properties: { repoName: { anyOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }],
      description: "GitHub repository or list of repositories (max 10) in owner/repo format." }, question: { description: "The question to ask about the repository.", type: "string" } },
      required: ["repoName", "question"], type: "object" }, annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: "read_wiki_contents", description: "View documentation about a GitHub repository.",
    inputSchema: { properties: { repoName: repoProperty }, required: ["repoName"], type: "object" }, annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: "read_wiki_structure", description: "Get a list of documentation topics for a GitHub repository.",
    inputSchema: { properties: { repoName: repoProperty }, required: ["repoName"], type: "object" }, annotations: { readOnlyHint: true, idempotentHint: true } }
];

export interface Upstream { endpoint: string; seen: Array<{ method: string; authorization: string | null; tool?: string; args?: any }>; close(): Promise<void>;
  behave(next: Partial<Behavior>): void; sessions: Set<string> }
export interface Behavior {
  /** Responses for tools/call consumed in order before normal handling: an HTTP status or "hang". */
  faults: Array<{ status: number; headers?: Record<string, string> } | "hang">;
  stateful: boolean;
  /** Answer to ask_wiki_question and read_wiki_contents. */
  answerText: (args: any, tool: string) => { text: string; isError?: boolean };
  structureText: string;
}

export async function startUpstream(structureText: string = STRUCTURE_TEXT, port = 0): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const sessions = new Set<string>();
  const behavior: Behavior = { faults: [], stateful: false, structureText, answerText: args => ({ text: `wiki answer for ${String(args.repoName)}: ${String(args.question ?? "")}` }) };
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
        sse({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "DeepWiki", version: "2.14.3" } } }, headers);
      } else if (body.method === "notifications/initialized") res.writeHead(202).end();
      else if (body.method === "tools/list") sse({ result: { tools: recordedTools } });
      else if (body.method === "tools/call") {
        const args = body.params.arguments;
        if (body.params.name === "read_wiki_structure") sse({ result: { content: [{ type: "text", text: behavior.structureText }] } });
        else { const answer = behavior.answerText(args, body.params.name); sse({ result: { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) } }); }
      } else res.writeHead(400).end();
    });
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { endpoint, seen, sessions, behave: next => Object.assign(behavior, next),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export async function startGateway(upstream: string, options: { declareReadOnly?: boolean } = {}) {
  const module = await gatewayModule();
  // The daemon declares the hosted DeepWiki tools read-only (trustedGatewayPolicy); the fake upstream runs on loopback, so the same
  // declaration is made here by service id.
  const gateway = new module.BflowSharedMCPGateway({ policyOverrides: (service: { serviceId: string }) => service.serviceId === DEEPWIKI_ID && options.declareReadOnly !== false ? { readOnlyTools: [...DEEPWIKI_TOOL_NAMES] } : undefined });
  const server = new module.StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
  const endpoint = `${await server.start()}/mcp`;
  const scope = { kind: "session" as const, machineId: "m1", repositoryId: "r1", workspaceRoot: "/tmp/ws", sessionId: "s1" };
  const operation = { schemaVersion: 3 as const, scope, idempotencyKey: "gateway-op" };
  const service = { schemaVersion: 3 as const, serviceId: DEEPWIKI_ID, revision: 1, scope: { kind: "machine" as const, machineId: "m1" },
    tool: { schemaVersion: 3 as const, toolId: DEEPWIKI_ID, kind: "native_remote_mcp" as const, version: "hosted", operations: [...DEEPWIKI_TOOL_NAMES],
      resource: { sharing: "concurrent" as const, maxConcurrency: 16 }, required: false },
    connection: { kind: "native_remote_mcp" as const, endpoint: upstream, ownership: "external" as const },
    authentication: { mode: "none" as const },
    healthTimeoutMs: 2000, idleTimeoutMs: 60_000, restartLimit: 2 };
  const ensured = await gateway.serviceManager.ensure(service, operation);
  let counter = 0;
  const enroll = async (role: string, provider: string, grant: { serviceIds?: string[]; allowedTools?: string[] } = {}): Promise<GatewayTarget> => {
    const registrationId = `reg-${role}-${provider}-${++counter}`;
    const registered = await gateway.register({ schemaVersion: 3, registrationId, provider, role, scope, environmentId: "env", serviceIds: grant.serviceIds ?? [DEEPWIKI_ID],
      allowedTools: grant.allowedTools ?? [...DEEPWIKI_TOOL_NAMES],
      connection: { transport: "streamable_http", endpoint, token: `secret://test/${registrationId}` }, configDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), idempotencyKey: `${registrationId}-k` });
    if (!registered.ok) throw new Error(registered.error.message);
    return { endpoint, token: gateway.secretStore.getClientTokenByRegistration(registrationId)!, registrationId };
  };
  return { gateway, server, endpoint, ensured, operation, enroll, metrics: () => gateway.metrics.snapshot(),
    stop: async () => { await server.stop(); await gateway.serviceManager.stop(DEEPWIKI_ID, operation).catch(() => undefined); } };
}
