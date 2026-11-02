import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BflowSharedMCPGateway, StreamableHttpGatewayServer, isSupportedJsonSchema, normalizeUpstreamToolList, validateJsonSchema } from "../src/index.js";

// The tools/list result recorded from https://mcp.deepwiki.com/mcp on 2026-10-29, verbatim (ask_wiki_question takes repoName as
// anyOf string | array<string>; the output schemas carry the FastMCP wrap hint; tools carry a _meta block).
const outputSchema = { properties: { result: { type: "string" } }, required: ["result"], type: "object", "x-fastmcp-wrap-result": true };
const repoName = { description: "GitHub repository in owner/repo format (e.g. \"facebook/react\").", type: "string" };
const askInput = {
  properties: {
    repoName: { anyOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }], description: "GitHub repository or list of repositories (max 10) in owner/repo format." },
    question: { description: "The question to ask about the repository.", type: "string" }
  },
  required: ["repoName", "question"], type: "object"
};
const recordedTools = [
  { name: "ask_wiki_question", description: "Ask any question about a GitHub repository's codebase and get an AI-powered answer\ngrounded in its DeepWiki.", inputSchema: askInput, outputSchema, _meta: { _fastmcp: { tags: [] } } },
  { name: "read_wiki_contents", description: "View documentation about a GitHub repository.", inputSchema: { properties: { repoName }, required: ["repoName"], type: "object" }, outputSchema, _meta: { _fastmcp: { tags: [] } } },
  { name: "read_wiki_structure", description: "Get a list of documentation topics for a GitHub repository.", inputSchema: { properties: { repoName }, required: ["repoName"], type: "object" }, outputSchema, _meta: { _fastmcp: { tags: [] } } }
];
const TOOLS = recordedTools.map(tool => tool.name);

interface Fake { endpoint: string; calls: Array<{ name: string; args: any; authorization: string | null }>; requests: number; close(): Promise<void> }
const fakes: Fake[] = [];
const stops: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined); for (const fake of fakes.splice(0)) await fake.close(); });

/** A remote MCP server that answers like the hosted one: SSE replies, structuredContent wrapped in { result }, no authentication. */
async function startFake(tools: unknown[]): Promise<Fake> {
  const calls: Fake["calls"] = [];
  const state = { requests: 0 };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.requests++;
      const reply = (result: unknown) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`); };
      if (body.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "DeepWiki", version: "2.14.3" } });
      if (body.method === "tools/list") return reply({ tools });
      if (body.method === "tools/call") {
        calls.push({ name: body.params.name, args: body.params.arguments, authorization: (req.headers["authorization"] as string | undefined) ?? null });
        const text = `wiki answer from ${body.params.name} for ${JSON.stringify(body.params.arguments)}`;
        return reply({ content: [{ type: "text", text }], structuredContent: { result: text }, isError: false });
      }
      res.writeHead(400).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const fake: Fake = { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, get requests() { return state.requests; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  fakes.push(fake);
  return fake;
}

const scope = { kind: "session" as const, machineId: "m1", repositoryId: "r1", workspaceRoot: "/tmp/ws", sessionId: "s1" };
const operation = { schemaVersion: 3 as const, scope, idempotencyKey: "deepwiki-gateway-op" };
const serviceFor = (serviceId: string, endpoint: string, operations: string[]) => ({ schemaVersion: 3 as const, serviceId, revision: 1, scope: { kind: "machine" as const, machineId: "m1" },
  tool: { schemaVersion: 3 as const, toolId: serviceId, kind: "native_remote_mcp" as const, version: "hosted", operations,
    resource: { sharing: "concurrent" as const, maxConcurrency: 16 }, required: false },
  connection: { kind: "native_remote_mcp" as const, endpoint, ownership: "external" as const }, authentication: { mode: "none" as const },
  healthTimeoutMs: 2000, idleTimeoutMs: 60_000, restartLimit: 2 });

async function startGateway() {
  // The host declares the hosted DeepWiki tools read-only; the fake runs on loopback, so the declaration is made by service id.
  const gateway = new BflowSharedMCPGateway({ policyOverrides: (service: { serviceId: string }) => service.serviceId === "deepwiki" ? { readOnlyTools: [...TOOLS] } : undefined });
  const server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
  const endpoint = `${await server.start()}/mcp`;
  stops.push(() => server.stop());
  let counter = 0;
  const enroll = async (role: string, serviceIds: string[], allowedTools: string[]) => {
    const registrationId = `reg-${role}-${++counter}`;
    const registered = await gateway.register({ schemaVersion: 3, registrationId, provider: "claude", role, scope, environmentId: "env", serviceIds, allowedTools,
      connection: { transport: "streamable_http", endpoint, token: `secret://test/${registrationId}` }, configDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), idempotencyKey: `${registrationId}-k` } as never);
    return { registered, token: registered.ok ? gateway.secretStore.getClientTokenByRegistration(registrationId)! : "" };
  };
  const rpc = async (token: string, method: string, params?: unknown) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
    const text = await response.text();
    // Valid tools/call replies are server-sent events: decode the JSON-RPC payload from the data: line(s).
    const payload = text.trimStart().startsWith("event:") || /^data:/m.test(text)
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
      : text;
    try { return JSON.parse(payload) as any; } catch { return { httpStatus: response.status, raw: text }; }
  };
  return { gateway, enroll, rpc };
}

describe("DeepWiki integration", () => {
  it("gateway tools/list readiness and role grants allow and deny", async () => {
    const upstream = await startFake(recordedTools);
    const { gateway, enroll, rpc } = await startGateway();
    const ensured = await gateway.serviceManager.ensure(serviceFor("deepwiki", upstream.endpoint, TOOLS), operation);
    stops.push(() => gateway.serviceManager.stop("deepwiki", operation));
    // Readiness: the real tools/list (with the anyOf schema) is accepted and all three tools are discovered.
    expect(ensured.ok).toBe(true);
    expect(ensured.ok && ensured.value).toMatchObject({ status: "ready", ownership: "external", discoveredTools: TOOLS });

    const developer = await enroll("developer", ["deepwiki"], TOOLS);
    expect(developer.registered.ok).toBe(true);
    const listed = await rpc(developer.token, "tools/list");
    expect(listed.result?.tools?.map((tool: { name: string }) => tool.name)).toEqual(TOOLS);
    const ask = listed.result?.tools?.find((tool: { name: string }) => tool.name === "ask_wiki_question");
    expect(ask).toMatchObject({ serviceId: "deepwiki", inputSchema: askInput, outputSchema });
    expect(ask).not.toHaveProperty("_meta");

    // Allow: a single repository and a list of repositories are both forwarded unchanged.
    const single = await rpc(developer.token, "tools/call", { name: "ask_wiki_question", serviceId: "deepwiki", arguments: { repoName: "facebook/react", question: "How do hooks work?" } });
    expect(single.result).toMatchObject({ status: "completed" });
    const many = await rpc(developer.token, "tools/call", { name: "ask_wiki_question", serviceId: "deepwiki", arguments: { repoName: ["facebook/react", "vercel/next.js"], question: "Compare them" } });
    expect(many.result).toMatchObject({ status: "completed" });
    expect(upstream.calls.map(call => call.args.repoName)).toEqual(["facebook/react", ["facebook/react", "vercel/next.js"]]);

    // Deny: a role granted only one tool neither sees nor can call the others, and the upstream never receives the attempt.
    const reviewer = await enroll("reviewer", ["deepwiki"], ["read_wiki_structure"]);
    expect(reviewer.registered.ok).toBe(true);
    const reviewerList = await rpc(reviewer.token, "tools/list");
    expect(reviewerList.result?.tools?.map((tool: { name: string }) => tool.name)).toEqual(["read_wiki_structure"]);
    const before = upstream.calls.length;
    const denied = await rpc(reviewer.token, "tools/call", { name: "ask_wiki_question", serviceId: "deepwiki", arguments: { repoName: "facebook/react", question: "x" } });
    expect(denied.error).toBeDefined();
    expect(JSON.stringify(denied)).not.toContain("wiki answer");
    expect(upstream.calls.length).toBe(before);
    // A wrong or invalid-token caller gets nothing either, and DeepWiki is reached without any credential.
    const stranger = await rpc("0".repeat(64), "tools/list");
    expect(stranger.result?.tools).toBeUndefined();
    expect(upstream.calls.every(call => call.authorization === null)).toBe(true);
  });

  it("gateway accepts the live ask_wiki_question anyOf schema", () => {
    const normalized = normalizeUpstreamToolList({ tools: recordedTools });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const [ask, contents, structure] = normalized.value.definitions;
    expect(normalized.value.definitions.map(definition => definition.name)).toEqual(TOOLS);
    // Constraints are kept exactly: nothing is stripped to make the schema pass.
    expect(ask!.inputSchema).toEqual(askInput);
    expect(ask!.outputSchema).toEqual(outputSchema);
    expect(contents!.inputSchema).toEqual({ properties: { repoName }, required: ["repoName"], type: "object" });
    expect(structure!.inputSchema).toEqual(contents!.inputSchema);
    expect(normalized.value.defaultedInputSchemaTools).toEqual([]);
    expect(ask).not.toHaveProperty("_meta");
    expect(isSupportedJsonSchema(askInput)).toBe(true);
    expect(isSupportedJsonSchema(outputSchema)).toBe(true);
    // Both branches of the anyOf are satisfiable.
    expect(validateJsonSchema({ repoName: "facebook/react", question: "q" }, askInput as never)).toBe(true);
    expect(validateJsonSchema({ repoName: ["facebook/react", "vercel/next.js"], question: "q" }, askInput as never)).toBe(true);
    expect(validateJsonSchema({ repoName: [], question: "q" }, askInput as never)).toBe(true);
    expect(validateJsonSchema({ result: "text" }, outputSchema as never)).toBe(true);
  });

  it("gateway rejects wrong anyOf values and unsupported nested keywords", async () => {
    // Wrong values never satisfy any branch.
    for (const value of [{ repoName: 5, question: "q" }, { repoName: [1], question: "q" }, { repoName: ["a/b", 2], question: "q" }, { repoName: { owner: "a" }, question: "q" },
      { repoName: null, question: "q" }, { repoName: true, question: "q" }, { question: "q" }, { repoName: "a/b" }, { repoName: "a/b", question: 3 }, "a/b", null])
      expect(validateJsonSchema(value, askInput as never), JSON.stringify(value)).toBe(false);

    // The base constraints and at least one branch must both hold.
    const constrained = { type: "string", minLength: 2, anyOf: [{ maxLength: 3 }, { enum: ["abcdefgh"] }] };
    expect(isSupportedJsonSchema(constrained)).toBe(true);
    for (const [value, expected] of [["a", false], ["ab", true], ["abc", true], ["abcd", false], ["abcdefgh", true], [7, false]] as const)
      expect(validateJsonSchema(value, constrained as never), String(value)).toBe(expected);

    // Anything the validator cannot enforce is rejected, wherever it is nested, and never silently dropped.
    const unsupported: unknown[] = [
      { anyOf: [{ type: "string", pattern: "^a" }, { type: "array" }] },
      { anyOf: [{ type: "string" }, { $ref: "#/definitions/x" }] },
      { anyOf: [{ type: "string" }, { patternProperties: { "^x": { type: "string" } } }] },
      { anyOf: [{ type: "string" }, { format: "uri" }] },
      { anyOf: [{ anyOf: [{ type: "string", uniqueItems: true }] }, { type: "number" }] },
      { type: "string", anyOf: [{ type: "string" }], oneOf: [{ type: "string" }] },
      { type: "string", allOf: [{ type: "string" }] },
      { type: "string", not: { type: "number" } },
      { anyOf: [] }, { anyOf: "string" }, { anyOf: [null] }, { anyOf: [["string"]] }, { anyOf: [{ type: "bogus" }] },
      { anyOf: Array.from({ length: 65 }, () => ({ type: "string" })) },
      Array.from({ length: 40 }).reduce<Record<string, unknown>>(schema => ({ anyOf: [schema, { type: "null" }] }), { type: "string" })
    ];
    for (const schema of unsupported) {
      expect(isSupportedJsonSchema(schema), JSON.stringify(schema).slice(0, 80)).toBe(false);
      expect(validateJsonSchema("abc", schema as never), JSON.stringify(schema).slice(0, 80)).toBe(false);
      for (const key of ["inputSchema", "outputSchema"] as const)
        expect(normalizeUpstreamToolList({ tools: [{ name: "t", inputSchema: { type: "object" }, [key]: { type: "object", properties: { v: schema } } }] }).ok).toBe(false);
    }
    // An unknown keyword next to the vendor annotation is still rejected.
    expect(isSupportedJsonSchema({ type: "object", "x-fastmcp-wrap-result": true, "x-other": 1 })).toBe(false);
    expect(isSupportedJsonSchema({ type: "object", "x-fastmcp-wrap-result": "yes" })).toBe(false);

    // A service whose real tools/list carries an unsupported nested keyword never becomes ready.
    const bad = structuredClone(recordedTools) as any[];
    bad[0].inputSchema.properties.repoName.anyOf[1].items = { type: "string", pattern: "^[a-z]+/[a-z]+$" };
    const upstream = await startFake(bad);
    const { gateway } = await startGateway();
    const ensured = await gateway.serviceManager.ensure(serviceFor("deepwiki", upstream.endpoint, TOOLS), operation);
    stops.push(() => gateway.serviceManager.stop("deepwiki", operation));
    expect(ensured.ok && ensured.value.status === "ready").toBe(false);
  });

  it("gateway denies DeepWiki to a role granted only another registered service", async () => {
    const deepwiki = await startFake(recordedTools);
    const notesTools = [{ name: "lookup_note", description: "Look up a note.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, outputSchema }];
    const notes = await startFake(notesTools);
    const { gateway, enroll, rpc } = await startGateway();
    // Both services are real, registered and ready; only the grants differ.
    const first = await gateway.serviceManager.ensure(serviceFor("deepwiki", deepwiki.endpoint, TOOLS), operation);
    const second = await gateway.serviceManager.ensure(serviceFor("other-notes", notes.endpoint, ["lookup_note"]), operation);
    stops.push(() => gateway.serviceManager.stop("deepwiki", operation), () => gateway.serviceManager.stop("other-notes", operation));
    expect(first.ok && first.value.status).toBe("ready");
    expect(second.ok && second.value.status).toBe("ready");

    // The Gateway keeps rejecting a service it does not know.
    const unknown = await enroll("reviewer", ["not-a-registered-service"], ["lookup_note"]);
    expect(unknown.registered.ok).toBe(false);

    const reviewer = await enroll("reviewer", ["other-notes"], ["lookup_note"]);
    expect(reviewer.registered.ok).toBe(true);
    const listed = await rpc(reviewer.token, "tools/list");
    const names = listed.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    expect(names).toEqual(["lookup_note"]);
    for (const tool of TOOLS) expect(names).not.toContain(tool);

    const attempts = [
      { name: "ask_wiki_question", serviceId: "deepwiki", arguments: { repoName: "facebook/react", question: "x" } },
      { name: "read_wiki_structure", serviceId: "deepwiki", arguments: { repoName: "facebook/react" } },
      { name: "lookup_note", serviceId: "deepwiki", arguments: { id: "1" } },
      { name: "ask_wiki_question", serviceId: "other-notes", arguments: { repoName: "facebook/react", question: "x" } }
    ];
    for (const attempt of attempts) {
      const answer = await rpc(reviewer.token, "tools/call", attempt);
      expect(answer.error ?? answer.result?.status, JSON.stringify(attempt)).toBeDefined();
      expect(answer.result?.status === "completed", JSON.stringify(attempt)).toBe(false);
      expect(JSON.stringify(answer)).not.toContain("wiki answer");
    }
    expect(deepwiki.calls).toEqual([]);

    // The granted service still works for that role, and a DeepWiki grant still works for another role.
    const note = await rpc(reviewer.token, "tools/call", { name: "lookup_note", serviceId: "other-notes", arguments: { id: "1" } });
    expect(note.result).toMatchObject({ status: "completed" });
    const developer = await enroll("developer", ["deepwiki"], TOOLS);
    const allowed = await rpc(developer.token, "tools/call", { name: "read_wiki_structure", serviceId: "deepwiki", arguments: { repoName: "facebook/react" } });
    expect(allowed.result).toMatchObject({ status: "completed" });
    expect(deepwiki.calls.map(call => call.name)).toEqual(["read_wiki_structure"]);
  });
});
