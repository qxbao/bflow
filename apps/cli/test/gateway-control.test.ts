import { createConnection } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MCPClientRegistrationSchema, MCPServiceDefinitionSchema } from "@bflow/contracts";
import { startGatewayControl } from "../src/gateway-control.js";

let root: string;
let control: Awaited<ReturnType<typeof startGatewayControl>> | undefined;
let gateway: any;
let data: any;
let operation: any;
let service: any;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bflow-control-test-"));
  const module = await import(new URL("../../../packages/mcp-gateway/dist/index.js", import.meta.url).href);
  gateway = new module.BflowSharedMCPGateway();
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
    endpoint: `${await data.start()}/mcp`, workspaceRoot: root, services: [service] });
});
afterEach(async () => {
  await control?.stop(); await data?.stop();
  if (service) await gateway.serviceManager.stop(service.serviceId, operation);
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
