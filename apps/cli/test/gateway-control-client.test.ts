import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MCPServiceDefinitionSchema } from "@bflow/contracts";
import { startGatewayControl } from "../src/gateway-control.js";

let root: string;
let control: Awaited<ReturnType<typeof startGatewayControl>> | undefined;
let gateway: any;
let data: any;
let operation: any;
let service: any;
let fakeServers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bflow-control-client-"));
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
  for (const server of fakeServers) await new Promise<void>(resolve => server.close(() => resolve()));
  fakeServers = [];
  await control?.stop(); await data?.stop();
  if (service) await gateway.serviceManager.stop(service.serviceId, operation);
  await rm(root, { recursive: true, force: true });
});

async function loadRuntimeModules() {
  const client = await import(new URL("../../../packages/runtime/dist/platform/gateway-control-client.js", import.meta.url).href);
  const registrations = await import(new URL("../../../packages/runtime/dist/platform/gateway-registrations.js", import.meta.url).href);
  return { GatewayControlClient: client.GatewayControlClient, GatewayRegistrationManager: registrations.GatewayRegistrationManager };
}

function identity() {
  return { machineId: "machine", repositoryId: "repo", workspaceRoot: root, sessionId: "runtime", generation: 1,
    stateDirectory: join(root, "runtime-state") };
}

const reviewer = { role: "reviewer", provider: "codex", environmentId: "env-reviewer", serviceIds: [] as string[],
  allowedTools: ["query"], configDigest: "a".repeat(64) };

it("registers, lists, revokes and re-registers a role through the real control endpoint", async () => {
  const { GatewayControlClient, GatewayRegistrationManager } = await loadRuntimeModules();
  const opened = await GatewayControlClient.fromLocator(join(root, "state", "gateway-control.json"));
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const client = opened.value;
  const manager = new GatewayRegistrationManager({ control: client, endpoint: control!.locator.endpoint });
  const request = { ...reviewer, serviceIds: [service.serviceId] };

  const first = await manager.ensureForRole(identity(), request);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const registrationId = first.value.registrations[0]?.registrationId ?? "";
  const [firstName] = Object.keys(first.value.tokenEnvironment);
  const firstToken = first.value.tokenEnvironment[firstName ?? ""] ?? "";
  expect(firstToken).toMatch(/^[a-f0-9]{64}$/);
  expect(gateway.authenticateToken(firstToken).ok).toBe(true);
  expect(JSON.stringify(first.value)).not.toContain(control!.locator.token);

  const listed = await client.list(operation.scope);
  expect(listed.ok).toBe(true);
  if (listed.ok) expect(listed.value.map((registration: any) => registration.registrationId)).toEqual([registrationId]);

  const observed = await client.inspectServices(operation);
  expect(observed.ok).toBe(true);
  if (observed.ok) expect(observed.value[0]?.status).toBe("ready");

  expect(await manager.revokeRole(identity(), "reviewer")).toEqual({ ok: true, value: undefined });
  expect(gateway.authenticateToken(firstToken).ok).toBe(false);
  const afterRevoke = await client.list(operation.scope);
  expect(afterRevoke.ok && afterRevoke.value).toEqual([]);

  const second = await manager.ensureForRole(identity(), request);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value.registrations[0]?.registrationId).toBe(registrationId);
  const [secondName] = Object.keys(second.value.tokenEnvironment);
  const secondToken = second.value.tokenEnvironment[secondName ?? ""] ?? "";
  expect(secondToken).not.toBe(firstToken);
  expect(gateway.authenticateToken(secondToken).ok).toBe(true);
});

it("refuses a locator that is group/world readable, symlinked or owned by another user", async () => {
  const { GatewayControlClient } = await loadRuntimeModules();
  const locatorPath = join(root, "state", "gateway-control.json");

  await chmod(locatorPath, 0o644);
  const readable = await GatewayControlClient.fromLocator(locatorPath);
  expect(readable.ok).toBe(false);
  if (!readable.ok) expect(readable.error.code).toBe("validation");
  await chmod(locatorPath, 0o600);

  const link = join(root, "linked-locator.json");
  await symlink(locatorPath, link);
  const linked = await GatewayControlClient.fromLocator(link);
  expect(linked.ok).toBe(false);
  if (!linked.ok) expect(linked.error.code).toBe("validation");

  const missing = await GatewayControlClient.fromLocator(join(root, "absent.json"));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("transport_unavailable");

  const accepted = await GatewayControlClient.fromLocator(locatorPath);
  expect(accepted.ok).toBe(true);
});

it("reports a stopped control endpoint as transport_unavailable and never leaks the token", async () => {
  const { GatewayControlClient } = await loadRuntimeModules();
  const opened = await GatewayControlClient.fromLocator(join(root, "state", "gateway-control.json"));
  if (!opened.ok) throw new Error("locator must open");
  await control!.stop();

  const result = await opened.value.list(operation.scope);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("transport_unavailable");
  expect(JSON.stringify(result)).not.toContain(control!.locator.token);
});

/** A control stand-in that answers every connection with `reply` (or never answers when undefined). */
async function fakeControl(name: string, reply: string | undefined): Promise<{ locatorPath: string }> {
  const socketPath = join(root, `${name}.sock`);
  const server = createServer(socket => {
    socket.on("data", () => { if (reply !== undefined) socket.end(reply); });
  });
  fakeServers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
  const locatorPath = join(root, `${name}-locator.json`);
  await writeFile(locatorPath, JSON.stringify({ socketPath, token: "b".repeat(64), generation: "g".repeat(16),
    endpoint: "http://127.0.0.1:1/mcp" }), { mode: 0o600 });
  return { locatorPath };
}

it("maps a silent control after the request is written to timeout with observation_only retry safety", async () => {
  const { GatewayControlClient } = await loadRuntimeModules();
  const { locatorPath } = await fakeControl("silent", undefined);
  const opened = await GatewayControlClient.fromLocator(locatorPath);
  if (!opened.ok) throw new Error("locator must open");

  const result = await opened.value.list(operation.scope, { timeoutMs: 200 });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({ code: "timeout", retryable: true, retrySafety: "observation_only" });
});

it("treats a malformed or schema-invalid control reply as corruption", async () => {
  const { GatewayControlClient } = await loadRuntimeModules();
  const notJson = await fakeControl("garbled", "not json\n");
  const notJsonClient = await GatewayControlClient.fromLocator(notJson.locatorPath);
  if (!notJsonClient.ok) throw new Error("locator must open");
  const garbled = await notJsonClient.value.list(operation.scope, { timeoutMs: 1000 });
  expect(garbled.ok).toBe(false);
  if (!garbled.ok) expect(garbled.error.code).toBe("corruption");

  const wrongShape = await fakeControl("wrong-shape", `${JSON.stringify({ ok: true, value: { registrations: [{ bogus: true }] } })}\n`);
  const wrongShapeClient = await GatewayControlClient.fromLocator(wrongShape.locatorPath);
  if (!wrongShapeClient.ok) throw new Error("locator must open");
  const invalid = await wrongShapeClient.value.list(operation.scope, { timeoutMs: 1000 });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("corruption");
});

it("refuses a locator with unknown fields", async () => {
  const { GatewayControlClient } = await loadRuntimeModules();
  const locatorPath = join(root, "extra-locator.json");
  await writeFile(locatorPath, JSON.stringify({ socketPath: join(root, "state", "gateway-control.sock"), token: "c".repeat(64),
    generation: "g".repeat(16), endpoint: "http://127.0.0.1:1/mcp", extra: true }), { mode: 0o600 });

  const result = await GatewayControlClient.fromLocator(locatorPath);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("corruption");
});

it("acquires, uses and releases exclusive resource leases across roles via GatewayRegistrationManager", async () => {
  const { GatewayControlClient, GatewayRegistrationManager } = await loadRuntimeModules();
  const opened = await GatewayControlClient.fromLocator(join(root, "state", "gateway-control.json"));
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const client = opened.value;
  const manager = new GatewayRegistrationManager({ control: client, endpoint: control!.locator.endpoint });

  const reviewerEnroll = await manager.ensureForRole(identity(), { ...reviewer, serviceIds: [service.serviceId] });
  const architectEnroll = await manager.ensureForRole(identity(), {
    role: "architect", provider: "codex", environmentId: "env-architect",
    serviceIds: [service.serviceId], allowedTools: ["query", "context"], configDigest: "a".repeat(64)
  });
  expect(reviewerEnroll.ok).toBe(true);
  expect(architectEnroll.ok).toBe(true);

  const firstCall = await manager.invokeTool(identity(), "reviewer", undefined, service.serviceId, "query",
    { query: "auth flow" }, "call-reviewer-1");
  expect(firstCall.ok).toBe(true);
  if (firstCall.ok) expect(firstCall.value.status).toBe("completed");

  // Because the lease was released after firstCall completed, architect can immediately acquire and invoke.
  const secondCall = await manager.invokeTool(identity(), "architect", undefined, service.serviceId, "context",
    { name: "AuthService" }, "call-architect-1");
  expect(secondCall.ok).toBe(true);
  if (secondCall.ok) expect(secondCall.value.status).toBe("completed");
});
