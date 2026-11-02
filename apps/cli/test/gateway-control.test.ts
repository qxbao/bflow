import { createConnection } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MCPClientRegistrationSchema, MCPServiceDefinitionSchema, ResolvedToolGrantSchema } from "@bflow/contracts";
import { startGatewayControl } from "../src/gateway-control.js";

let root: string;
let control: Awaited<ReturnType<typeof startGatewayControl>> | undefined;
let gateway: any;
let data: any;
let operation: any;
let service: any;
let sharedService: any;
let upstream: Server | undefined;
let grantMap: Map<string, any>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-control-test-")));
  const module = await import(new URL("../../../packages/mcp-gateway/dist/index.js", import.meta.url).href);
  gateway = new module.BflowSharedMCPGateway();
  grantMap = new Map();
  data = new module.StreamableHttpGatewayServer({ gateway });
  const source = `let input='';process.stdin.on('data',chunk=>{input+=chunk;while(input.includes('\\n')){let n=input.indexOf('\\n');let m=JSON.parse(input.slice(0,n));input=input.slice(n+1);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'control-fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'query',inputSchema:{type:'object'}},{name:'context',inputSchema:{type:'object'}},{name:'impact',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify(m.params)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}});`;
  const script = join(root, "worker.cjs"); await writeFile(script, source, { mode: 0o600 });
  operation = { schemaVersion: 3, scope: { kind: "session", machineId: "machine", repositoryId: "repo", workspaceRoot: root, sessionId: "runtime" }, idempotencyKey: "fixture" };
  service = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: "gitnexus-fixture", revision: 1,
    scope: { kind: "machine", machineId: "machine" },
    tool: { schemaVersion: 3, toolId: "gitnexus", kind: "stdio_mcp", version: "1", operations: ["query", "context", "impact"], required: true,
      resource: { sharing: "exclusive", resourceKey: "gitnexus-fixture" } },
    connection: { kind: "stdio_mcp", executable: process.execPath, argv: [script], environmentBindings: {},
      executableDigest: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), ownership: "bflow", bridgeRequired: true },
    authentication: { mode: "none" }, healthTimeoutMs: 1000, idleTimeoutMs: 1000, restartLimit: 0 });
  const ensured = await gateway.serviceManager.ensure(service, operation); expect(ensured.ok).toBe(true);
  control = await startGatewayControl({ gateway, stateRoot: join(root, "state"), machineId: "machine", configDigest: "a".repeat(64),
    endpoint: `${await data.start()}/mcp`, workspaceRoot: root, services: [service], grantMap });
});
afterEach(async () => {
  await control?.stop(); await data?.stop();
  if (service) await gateway.serviceManager.stop(service.serviceId, operation);
  if (sharedService) await gateway.serviceManager.stop(sharedService.serviceId, operation);
  sharedService = undefined;
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream!.close(error => error ? reject(error) : resolve()));
    upstream = undefined;
  }
  await rm(root, { recursive: true, force: true });
});
function rpc(method: string, params: unknown, overrides: Record<string, unknown> = {}) {
  const locator = control!.locator;
  return new Promise<any>((resolve, reject) => {
    const socket = createConnection(locator.socketPath); let buffer = "";
    socket.on("error", reject); socket.on("data", chunk => {
      buffer += chunk; if (buffer.includes("\n")) { socket.end(); resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ schemaVersion: 3, id: "request", token: locator.token,
      generation: locator.generation, method, params, ...overrides }) + "\n"));
  });
}
function client(overrides: Record<string, unknown> = {}) {
  return MCPClientRegistrationSchema.parse({ schemaVersion: 3, registrationId: "reviewer-pane-1", provider: "codex", role: "reviewer",
    scope: operation.scope, environmentId: "host-epoch-pane-1", serviceIds: [service.serviceId], allowedTools: ["query"],
    connection: { transport: "streamable_http", endpoint: control!.locator.endpoint, token: "secret://runtime/reviewer-pane-1" },
    configDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "register-reviewer", ...overrides });
}

it("publishes a private short Unix control locator and rejects wrong auth/generation", async () => {
  const saved = JSON.parse(await readFile(join(root, "state", "gateway-control.json"), "utf8"));
  expect(saved).toEqual(control!.locator);
  expect(saved.socketPath.length).toBeLessThan(100);
  expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "state", "gateway-control.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(saved.socketPath)).mode & 0o777).toBe(0o600);
  expect((await rpc("catalog", { operation }, { token: "wrong" })).ok).toBe(false);
  expect((await rpc("catalog", { operation }, { generation: "old-daemon" })).ok).toBe(false);
  expect((await rpc("catalog", { operation })).value.observations[0].status).toBe("ready");
});

it("enrolls a scoped role through control and calls real stdio through authenticated HTTP with an exclusive lease", async () => {
  const registered = await rpc("register", { client: client() }); expect(registered.ok).toBe(true);
  expect(registered.value.token).not.toBe(control!.locator.token);
  const lease = await rpc("acquire", { ...operation, registrationId: "reviewer-pane-1", serviceId: service.serviceId,
    resourceKey: "gitnexus-fixture", ttlMs: 10_000 }); expect(lease.ok).toBe(true);
  const call = { schemaVersion: 3, callId: "call-1", registrationId: "reviewer-pane-1", serviceId: service.serviceId,
    tool: "query", input: { query: "find" }, resourceLease: lease.value, idempotencyKey: "call-1" };
  const response = await fetch(control!.locator.endpoint, { method: "POST", headers: { Authorization: `Bearer ${registered.value.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "data-call", method: "tools/call", params: { name: "query", serviceId: service.serviceId,
      arguments: call.input, callId: call.callId, idempotencyKey: call.idempotencyKey, resourceLease: lease.value } }) });
  const body = await response.json() as any;
  expect(response.ok).toBe(true); expect(body.error).toBeUndefined(); expect(body.result).toBeDefined();
  expect((await rpc("renew", { schemaVersion: 3, lease: lease.value, ttlMs: 10_000, idempotencyKey: "renew" })).ok).toBe(true);
  expect((await rpc("reconcile", { call })).ok).toBe(true);
  expect((await rpc("release", { lease: lease.value, operation })).ok).toBe(true);
  expect((await rpc("revoke", { registrationId: "reviewer-pane-1", operation })).ok).toBe(true);
  expect(gateway.authenticateToken(registered.value.token).ok).toBe(false);
});

it("validates Runtime grants at registration and invokes only an exact granted operation through control", async () => {
  const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "gitnexus-reviewer-grant", policyDigest: "b".repeat(64),
    toolId: "gitnexus", kind: "stdio_mcp", requiredness: "required", role: "reviewer", scope: operation.scope,
    serviceId: service.serviceId, operations: ["query"], triggers: ["code_relationships"] });
  const wrongPrincipal = { ...grant, grantId: "gitnexus-qa-grant", role: "qa" };
  expect((await rpc("register", { client: client(), toolGrants: [wrongPrincipal] })).ok).toBe(false);
  const originalRegister = gateway.register.bind(gateway);
  let grantAvailableDuringRegistration = false;
  vi.spyOn(gateway, "register").mockImplementation(async (registeredClient: any) => {
    grantAvailableDuringRegistration = grantMap.has(registeredClient.registrationId);
    return originalRegister(registeredClient);
  });
  const registered = await rpc("register", { client: client({ allowedTools: ["query", "context"] }), toolGrants: [grant] });
  expect(registered.ok).toBe(true);
  expect(grantAvailableDuringRegistration).toBe(true);
  expect(grantMap.get("reviewer-pane-1")).toEqual([grant]);
  const lease = await rpc("acquire", { ...operation, registrationId: "reviewer-pane-1", serviceId: service.serviceId,
    resourceKey: "gitnexus-fixture", ttlMs: 10_000 });
  expect(lease.ok).toBe(true);
  const call = { schemaVersion: 3, callId: "granted-call", registrationId: "reviewer-pane-1", serviceId: service.serviceId,
    tool: "query", input: { query: "find" }, resourceLease: lease.value, idempotencyKey: "granted-call" };
  const result = await rpc("invoke_tool", { call });
  expect(result.ok).toBe(true);
  expect(result.value.status).toBe("completed");
  expect((await rpc("reconcile_tool_call", { call })).value.status).toBe("completed");
  expect((await rpc("invoke_tool", { call: { ...call, callId: "wrong-op", tool: "context", idempotencyKey: "wrong-op" } })).ok).toBe(false);
});

it("treats an explicit empty Runtime grant set as deny-all and removes grants on revoke", async () => {
  const registered = await rpc("register", { client: client(), toolGrants: [] });
  expect(registered.ok).toBe(true);
  expect(grantMap.has("reviewer-pane-1")).toBe(true);
  const call = { schemaVersion: 3, callId: "denied-call", registrationId: "reviewer-pane-1", serviceId: service.serviceId,
    tool: "query", input: {}, idempotencyKey: "denied-call" };
  expect((await rpc("invoke_tool", { call })).ok).toBe(false);
  expect((await rpc("revoke", { registrationId: "reviewer-pane-1", operation })).ok).toBe(true);
  expect(grantMap.has("reviewer-pane-1")).toBe(false);
});

it("denies foreign repositories, widened roles, endpoint replacement, expired clients and unconfigured services", async () => {
  const foreign = { ...operation, scope: { ...operation.scope, workspaceRoot: tmpdir(), repositoryId: "foreign" } };
  expect((await rpc("catalog", { operation: foreign })).ok).toBe(false);
  expect((await rpc("register", { client: client({ scope: foreign.scope }) })).ok).toBe(false);
  expect((await rpc("register", { client: client({ role: "conversation" }) })).ok).toBe(false);
  expect((await rpc("register", { client: client({ allowedTools: ["arbitrary_tool"] }) })).ok).toBe(false);
  expect((await rpc("register", { client: client({ connection: { transport: "streamable_http", endpoint: "http://127.0.0.1:1/mcp", token: "secret://runtime/x" } }) })).ok).toBe(false);
  expect((await rpc("register", { client: client({ expiresAt: new Date(Date.now() - 1).toISOString() }) })).ok).toBe(false);
  expect((await rpc("register", { client: client({ serviceIds: ["unconfigured"] }) })).ok).toBe(false);
});

it("rejects principal replacement, cross-session leases and old control credentials after restart", async () => {
  expect((await rpc("register", { client: client() })).ok).toBe(true);
  expect((await rpc("register", { client: client({ role: "qa", idempotencyKey: "replace" }) })).ok).toBe(false);
  const other = { ...operation, scope: { ...operation.scope, sessionId: "another-session" } };
  expect((await rpc("acquire", { ...other, registrationId: "reviewer-pane-1", serviceId: service.serviceId, resourceKey: "gitnexus-fixture", ttlMs: 1000 })).ok).toBe(false);
  const old = control!.locator; await control!.stop();
  control = await startGatewayControl({ gateway, stateRoot: join(root, "state"), machineId: "machine", configDigest: "a".repeat(64),
    endpoint: old.endpoint, workspaceRoot: root, services: [service] });
  expect(control.locator.generation).not.toBe(old.generation); expect(control.locator.token).not.toBe(old.token);
  expect((await rpc("catalog", { operation }, { generation: old.generation, token: old.token })).ok).toBe(false);
});


async function enableSharedService() {
  upstream = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "shared-docs", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "read_wiki_contents", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "shared documentation" }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>(resolve => upstream!.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing shared service address");
  sharedService = MCPServiceDefinitionSchema.parse({ ...service, serviceId: "shared-docs",
    tool: { ...service.tool, toolId: "deepwiki", kind: "native_remote_mcp", operations: ["read_wiki_contents"],
      resource: { sharing: "concurrent", maxConcurrency: 16 } },
    connection: { kind: "native_remote_mcp", endpoint: `http://127.0.0.1:${address.port}/mcp`, ownership: "external" } });
  expect((await gateway.serviceManager.ensure(sharedService, operation)).ok).toBe(true);
  await control!.stop();
  control = await startGatewayControl({ gateway, stateRoot: join(root, "state"), machineId: "machine", configDigest: "a".repeat(64),
    endpoint: `${await data.start()}/mcp`, workspaceRoot: root, services: [service, sharedService], machineSharedServiceIds: [sharedService.serviceId] });
  const foreignRoot = join(root, "other-worktree");
  await mkdir(foreignRoot);
  const foreignOperation = { ...operation, scope: { ...operation.scope, repositoryId: "other-repository", workspaceRoot: foreignRoot } };
  const foreignClient = client({ registrationId: "foreign-reviewer", idempotencyKey: "foreign-register", scope: foreignOperation.scope,
    serviceIds: [sharedService.serviceId], allowedTools: ["read_wiki_contents"] });
  return { foreignRoot, foreignOperation, foreignClient };
}

it("shares only host-approved machine services across worktrees while preserving repository tool isolation", async () => {
  const { foreignOperation, foreignClient } = await enableSharedService();
  const catalog = await rpc("catalog", { operation: foreignOperation });
  expect(catalog.ok).toBe(true);
  expect(catalog.value.observations.map((item: any) => item.serviceId)).toEqual([sharedService.serviceId]);
  expect((await rpc("catalog", { operation })).value.observations).toHaveLength(2);
  const registered = await rpc("register", { client: foreignClient });
  expect(registered.ok).toBe(true);
  const response = await fetch(control!.locator.endpoint, { method: "POST",
    headers: { Authorization: `Bearer ${registered.value.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "docs-call", method: "tools/call",
      params: { name: "read_wiki_contents", serviceId: sharedService.serviceId, arguments: {}, callId: "docs-call", idempotencyKey: "docs-call" } }) });
  const result = await response.json() as any;
  expect(response.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.result.status).toBe("completed");
  expect(result.result.output).toEqual([{ type: "text", text: "shared documentation" }]);
  expect((await rpc("register", { client: client({ scope: foreignOperation.scope }) })).ok).toBe(false);
  expect((await rpc("register", { client: { ...foreignClient, serviceIds: [sharedService.serviceId, service.serviceId] } })).ok).toBe(false);
  expect((await rpc("register", { client: { ...foreignClient, allowedTools: ["query"] } })).ok).toBe(false);
});

it("keeps shared-service registrations, replacement and revocation scoped to each repository and session", async () => {
  const { foreignOperation, foreignClient } = await enableSharedService();
  const local = await rpc("register", { client: client() });
  const foreign = await rpc("register", { client: foreignClient });
  expect(local.ok).toBe(true); expect(foreign.ok).toBe(true);
  expect((await rpc("list", { scope: operation.scope })).value.registrations.map((item: any) => item.registrationId)).toEqual(["reviewer-pane-1"]);
  expect((await rpc("list", { scope: foreignOperation.scope })).value.registrations.map((item: any) => item.registrationId)).toEqual(["foreign-reviewer"]);
  const anotherSession = { ...foreignOperation, scope: { ...foreignOperation.scope, sessionId: "other-session" } };
  expect((await rpc("list", { scope: anotherSession.scope })).value.registrations).toEqual([]);
  expect((await rpc("register", { client: { ...foreignClient, registrationId: "reviewer-pane-1" } })).ok).toBe(false);
  expect((await rpc("acquire", { ...foreignOperation, registrationId: "reviewer-pane-1", serviceId: service.serviceId,
    resourceKey: "gitnexus-fixture", ttlMs: 1000 })).ok).toBe(false);
  expect((await rpc("acquire", { ...foreignOperation, registrationId: "foreign-reviewer", serviceId: service.serviceId,
    resourceKey: "gitnexus-fixture", ttlMs: 1000 })).ok).toBe(false);
  expect((await rpc("revoke", { registrationId: "foreign-reviewer", operation })).ok).toBe(false);
  expect((await rpc("revoke", { registrationId: "foreign-reviewer", operation: anotherSession })).ok).toBe(false);
  expect((await rpc("revoke", { registrationId: "foreign-reviewer", operation: foreignOperation })).ok).toBe(true);
  expect(gateway.authenticateToken(foreign.value.token).ok).toBe(false);
  expect(gateway.authenticateToken(local.value.token).ok).toBe(true);
});

it("rejects noncanonical and foreign-machine workspaces even when a service is shared", async () => {
  const { foreignRoot, foreignOperation, foreignClient } = await enableSharedService();
  const alias = join(root, "worktree-alias");
  await symlink(foreignRoot, alias);
  for (const scope of [
    { ...foreignOperation.scope, workspaceRoot: alias },
    { ...foreignOperation.scope, workspaceRoot: join(root, "missing") },
    { ...foreignOperation.scope, machineId: "other-machine" }
  ]) {
    expect((await rpc("catalog", { operation: { ...foreignOperation, scope } })).ok).toBe(false);
    expect((await rpc("register", { client: { ...foreignClient, scope } })).ok).toBe(false);
  }
});

it("rejects unknown and repository-scoped services in the host machine-sharing grant", async () => {
  await control!.stop();
  const options = { gateway, stateRoot: join(root, "state"), machineId: "machine", configDigest: "a".repeat(64),
    endpoint: control!.locator.endpoint, workspaceRoot: root, services: [service] };
  await expect(startGatewayControl({ ...options, machineSharedServiceIds: ["missing"] })).rejects.toThrow(/machine|configured|service/i);
  const repositoryService = { ...service, scope: { kind: "repository", machineId: "machine", repositoryId: "repo", workspaceRoot: root } };
  await expect(startGatewayControl({ ...options, services: [repositoryService], machineSharedServiceIds: [service.serviceId] })).rejects.toThrow(/machine/i);
  const otherMachineService = { ...service, scope: { kind: "machine", machineId: "other-machine" } };
  await expect(startGatewayControl({ ...options, services: [otherMachineService], machineSharedServiceIds: [service.serviceId] })).rejects.toThrow(/machine/i);
});

it("never starts a caller-supplied repository service without the trusted host's validating handler", async () => {
  const repositoryScope = { kind: "repository", machineId: "machine", repositoryId: "repo", workspaceRoot: root };
  const repositoryService = MCPServiceDefinitionSchema.parse({ ...service, serviceId: "gitnexus-unvalidated", scope: repositoryScope,
    tool: { ...service.tool, resource: { sharing: "exclusive", resourceKey: "gitnexus-unvalidated" } } });
  const repositoryOperation = { schemaVersion: 3, scope: repositoryScope, idempotencyKey: "register-unvalidated" };
  const registered = await rpc("register_repository_service", { service: repositoryService, operation: repositoryOperation });
  expect(registered).toMatchObject({ ok: false, error: { code: "validation" } });
  expect(gateway.registry.getService("gitnexus-unvalidated")).toBeUndefined();
  const removed = await rpc("remove_repository_service", { serviceId: "gitnexus-unvalidated", operation: repositoryOperation });
  expect(removed).toMatchObject({ ok: false, error: { code: "validation" } });
});
