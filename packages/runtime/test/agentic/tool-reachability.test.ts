import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MCPClientRegistrationSchema, MCPServiceDefinitionSchema, type AgentRole, type MCPClientRegistration } from "@bflow/contracts";
import type { PreparedRoleLaunch } from "../../src/platform/index.js";
import { tokenEnvironmentName } from "../../src/platform/gateway-registrations.js";
import {
  assertRoleToolReachability, BFLOW_LAUNCH_ID_ENV, evaluateToolReachability, GATEWAY_PROBE_DIRECTORY, GatewayProbeFileSchema,
  launchProbePath, launchReachabilityPath, legacyRoleProbePath, probeGatewayTools, ProviderBootstrapPayloadSchema, ProviderStartedPayloadSchema,
  publishLaunchProbe, readLaunchReachability, readLaunchReachabilityFact, removeLaunchProbe, removeLegacyRoleProbes, reportedReachabilityOf, resolveProbePlan, selectReachabilityFact,
  summarizeToolReachability, writeLaunchReachability, type GatewayProbeTarget, type ProbeFetch, type ReachabilityExpectation,
  type ReachabilityFact, type ToolReachabilityCode, type ToolReachabilityRecord
} from "../../src/agentic/tool-reachability.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

const TOKEN = "unit-bearer-value-0123456789abcdef";
const REGISTRATION_ID = "reg-h1probe0001";
const ENV_NAME = tokenEnvironmentName(REGISTRATION_ID);
const target: GatewayProbeTarget = { endpoint: "http://127.0.0.1:9/mcp", registrationId: REGISTRATION_ID, envName: ENV_NAME, allowedTools: ["query"] };
const env = { [ENV_NAME]: TOKEN };
const expectation: ReachabilityExpectation = { launchId: "launch-h1", entries: [target] };

function rpcResponse(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

interface Seen { readonly method: string; readonly headers: Record<string, string>; readonly body: Record<string, unknown> | undefined }

/** Fake Gateway: accepts TOKEN, issues session `sess-1`, lists the given tools. */
function fakeGateway(tools: readonly string[] = ["query"]): { fetch: ProbeFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: ProbeFetch = async (_url, init) => {
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    seen.push({ method: String(init.method), headers, body });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (headers.Authorization !== `Bearer ${TOKEN}`) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id, error: { code: -32000, message: "bad token" } }), { status: 401 });
    }
    if (body?.method === "initialize") {
      return rpcResponse(body.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "bflow-mcp-gateway", version: "0.1.0" } }, { "mcp-session-id": "sess-1" });
    }
    if (body?.method === "tools/list") return rpcResponse(body.id, { tools: tools.map(name => ({ name, serviceId: "svc-1" })) });
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, seen };
}

describe("H1 in-process tool reachability probe (unit)", () => {
  it("reports token_env_missing without any network call when the launch environment lacks the token", async () => {
    const { fetch, seen } = fakeGateway();
    const result = await probeGatewayTools(target, {}, fetch, 1000);
    expect(result).toEqual({ registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: false, discoveredTools: [], code: "token_env_missing" });
    expect(seen).toHaveLength(0);
  });

  it("maps an HTTP 401 from the Gateway to unauthorized", async () => {
    const result = await probeGatewayTools(target, { [ENV_NAME]: "wrong-token-value" }, fakeGateway().fetch, 1000);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
  });

  it("fails when an allowed tool is not discovered", async () => {
    const withMissing = { ...target, allowedTools: ["query", "context"] };
    const result = await probeGatewayTools(withMissing, env, fakeGateway(["query"]).fetch, 1000);
    expect(result).toEqual({ registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: false, discoveredTools: ["query"], code: "missing_tools" });
  });

  it("succeeds with discovered tools, propagates the session id and closes the probe session", async () => {
    const fake = fakeGateway(["query", "impact"]);
    const result = await probeGatewayTools(target, env, fake.fetch, 1000);
    expect(result).toEqual({ registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: true, discoveredTools: ["impact", "query"], code: null });
    expect(fake.seen.map(call => call.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(fake.seen[0]!.body).toMatchObject({ method: "initialize" });
    expect(fake.seen[0]!.headers["Mcp-Session-Id"]).toBeUndefined();
    expect(fake.seen[1]!.body).toMatchObject({ method: "tools/list" });
    expect(fake.seen[1]!.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(fake.seen[2]!.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(fake.seen.every(call => call.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("classifies a timed-out request as timeout and a network refusal as unreachable", async () => {
    const timeout = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
    const refused = async () => { throw new TypeError("fetch failed"); };
    expect((await probeGatewayTools(target, env, timeout as ProbeFetch, 1000)).code).toBe("timeout");
    expect((await probeGatewayTools(target, env, refused as ProbeFetch, 1000)).code).toBe("unreachable");
  });

  it("rejects an MCP response with a mismatched id as protocol_error", async () => {
    const mismatched: ProbeFetch = async () => rpcResponse(999, { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "v" } });
    expect((await probeGatewayTools(target, env, mismatched, 1000)).code).toBe("protocol_error");
  });

  it("never places the token value in the result, a thrown-error path or any serialized output", async () => {
    const leaky: ProbeFetch = async () => { throw new Error(`socket error while sending ${TOKEN}`); };
    const result = await probeGatewayTools(target, env, leaky, 1000);
    expect(result.code).toBe("unreachable");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const bodyLeak: ProbeFetch = async () => new Response(`{"error":"${TOKEN}"}`, { status: 500 });
    expect(JSON.stringify(await probeGatewayTools(target, env, bodyLeak, 1000))).not.toContain(TOKEN);
  });

  it("evaluates pending, failed and ready verdicts and refuses a stale launch", () => {
    expect(evaluateToolReachability(expectation, undefined).state).toBe("pending");
    expect(evaluateToolReachability(expectation, { launchId: "other", toolReachability: [] }).state).toBe("pending");
    const failedRecord = { registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: false, discoveredTools: [], code: "token_env_missing" as const };
    const failed = evaluateToolReachability(expectation, { launchId: "launch-h1", toolReachability: [failedRecord] });
    expect(failed).toMatchObject({ state: "failed", code: "token_env_missing", envName: ENV_NAME });
    const okRecord = { registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: true, discoveredTools: ["query"], code: null };
    expect(evaluateToolReachability(expectation, { launchId: "launch-h1", toolReachability: [okRecord] })).toEqual({ state: "ready" });
    const silentlyMissingTool = { ...okRecord, discoveredTools: ["impact"] };
    expect(evaluateToolReachability(expectation, { launchId: "launch-h1", toolReachability: [silentlyMissingTool] })).toMatchObject({ state: "failed", code: "missing_tools" });
  });

  it("throws the pending marker while unproven and a named error on failure, never the token", () => {
    expect(() => assertRoleToolReachability("reviewer" as AgentRole, expectation, undefined))
      .toThrow("[bflow:native-startup-pending] reviewer has not proven Gateway tool reachability");
    const failedRecord = { registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: false, discoveredTools: [], code: "token_env_missing" as const };
    let message = "";
    try { assertRoleToolReachability("reviewer" as AgentRole, expectation, { launchId: "launch-h1", toolReachability: [failedRecord] }); }
    catch (error) { message = String(error); }
    expect(message).toContain("reviewer");
    expect(message).toContain(REGISTRATION_ID);
    expect(message).toContain(ENV_NAME);
    expect(message).toContain("token_env_missing");
    expect(message).not.toContain("native-startup-pending");
    expect(message).not.toContain(TOKEN);
    expect(() => assertRoleToolReachability("reviewer" as AgentRole, expectation, { launchId: "launch-h1", toolReachability: [{ ...failedRecord, ok: true, code: null, discoveredTools: ["query"] }] })).not.toThrow();
  });

  it("summarizes reachability for platform_status without tokens", () => {
    const summary = summarizeToolReachability("reviewer" as AgentRole, expectation, undefined);
    expect(summary).toEqual({ role: "reviewer", launchId: "launch-h1", state: "pending", reason: expect.any(String), registrations: [] });
    const reported = reportedReachabilityOf({ role: "reviewer", paneId: "p1", launchId: "launch-h1", toolReachability: [] });
    expect(reported).toEqual({ launchId: "launch-h1", toolReachability: [] });
    expect(reportedReachabilityOf({ role: "reviewer" })).toBeUndefined();
  });

  it("validates the provider_started payload strictly and requires launchId and reachability together", () => {
    const base = { paneId: "p1", nativeSessionId: "n1" };
    expect(ProviderStartedPayloadSchema.parse(base)).toEqual(base);
    expect(() => ProviderStartedPayloadSchema.parse({ ...base, launchId: "launch-h1" })).toThrow();
    expect(() => ProviderStartedPayloadSchema.parse({ ...base, toolReachability: [] })).toThrow();
    expect(() => ProviderStartedPayloadSchema.parse({ ...base, toolReachability: [{ registrationId: "r", envName: ENV_NAME, ok: true, discoveredTools: [], code: "timeout" }] })).toThrow();
    expect(() => ProviderStartedPayloadSchema.parse({ ...base, extra: true })).toThrow();
  });
});

// ------------------------------------------------------------ host-written files

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bflow-h1-probe-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function preparedWithRegistration(role: AgentRole, launchId: string, registrationId: string): PreparedRoleLaunch {
  const registration = {
    schemaVersion: 3, registrationId, provider: "codex", role, scope: { kind: "session" }, environmentId: "env-1", serviceIds: ["svc-1"],
    allowedTools: ["query"], connection: { transport: "streamable_http", endpoint: "http://127.0.0.1:9/mcp", token: `secret://runtime/${registrationId}` },
    configDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "key-1"
  } as unknown as MCPClientRegistration;
  return {
    role, provider: "codex", required: true,
    gateway: { registrations: [registration], observations: [], tokenEnvironment: { [tokenEnvironmentName(registrationId)]: TOKEN } },
    launch: { argv: [], env: { [tokenEnvironmentName(registrationId)]: TOKEN }, launchId, launchFingerprint: "b".repeat(64) }
  } as unknown as PreparedRoleLaunch;
}

describe("H1 launch-keyed probe plans", () => {
  it("writes a private token-free plan per launch and removes it when the launch is released", async () => {
    const root = await tempDirectory();
    const probes = join(root, GATEWAY_PROBE_DIRECTORY);
    const expectation = await publishLaunchProbe(probes, preparedWithRegistration("reviewer" as AgentRole, "launch-h1", REGISTRATION_ID));
    expect(expectation).toEqual({ launchId: "launch-h1", entries: [{ registrationId: REGISTRATION_ID, envName: ENV_NAME, allowedTools: ["query"] }] });

    const path = launchProbePath(probes, "launch-h1");
    expect((await stat(probes)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("secret://");
    expect(GatewayProbeFileSchema.parse(JSON.parse(text))).toEqual({ schemaVersion: 3, launchId: "launch-h1", endpoint: "http://127.0.0.1:9/mcp",
      entries: [{ registrationId: REGISTRATION_ID, envName: ENV_NAME, allowedTools: ["query"] }] });
    expect((await readdir(probes)).filter(name => name.endsWith(".tmp"))).toEqual([]);

    await removeLaunchProbe(probes, "launch-h1");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes no plan and creates no directory for a launch without Gateway registrations", async () => {
    const root = await tempDirectory();
    const plain = { ...preparedWithRegistration("developer" as AgentRole, "launch-plain", REGISTRATION_ID),
      gateway: { registrations: [], observations: [], tokenEnvironment: {} } } as unknown as PreparedRoleLaunch;
    expect(await publishLaunchProbe(join(root, GATEWAY_PROBE_DIRECTORY), plain)).toBeUndefined();
    await expect(stat(join(root, GATEWAY_PROBE_DIRECTORY))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps concurrent launches of one role in distinct plan files", async () => {
    const root = await tempDirectory();
    const probes = join(root, GATEWAY_PROBE_DIRECTORY);
    await publishLaunchProbe(probes, preparedWithRegistration("developer" as AgentRole, "launch-dev-1", "reg-dev1aaaa0001"));
    await publishLaunchProbe(probes, preparedWithRegistration("developer" as AgentRole, "launch-dev-2", "reg-dev2aaaa0001"));
    expect((await readdir(probes)).sort()).toEqual(["launch-dev-1.json", "launch-dev-2.json"]);
    const first = GatewayProbeFileSchema.parse(JSON.parse(await readFile(launchProbePath(probes, "launch-dev-1"), "utf8")));
    const second = GatewayProbeFileSchema.parse(JSON.parse(await readFile(launchProbePath(probes, "launch-dev-2"), "utf8")));
    expect(first.entries.map(entry => entry.registrationId)).toEqual(["reg-dev1aaaa0001"]);
    expect(second.entries.map(entry => entry.registrationId)).toEqual(["reg-dev2aaaa0001"]);
  });

  it("accepts only identifier launch ids as plan file names", () => {
    expect(() => launchProbePath("/host/gateway-probes", "../reviewer")).toThrow("not a safe identifier");
    expect(() => launchProbePath("/host/gateway-probes", "a/b")).toThrow("not a safe identifier");
    expect(() => launchProbePath("/host/gateway-probes", "")).toThrow("not a safe identifier");
    expect(launchProbePath("/host/gateway-probes", "launch-claude-developer-0a1b2c")).toBe("/host/gateway-probes/launch-claude-developer-0a1b2c.json");
  });

  it("resolves the hook plan from BFLOW_LAUNCH_ID, returns nothing for an unknown launch and rejects a traversal value", async () => {
    const root = await tempDirectory();
    await publishLaunchProbe(join(root, GATEWAY_PROBE_DIRECTORY), preparedWithRegistration("developer" as AgentRole, "launch-dev-1", REGISTRATION_ID));
    expect((await resolveProbePlan(root, "developer" as AgentRole, { [BFLOW_LAUNCH_ID_ENV]: "launch-dev-1" }))?.launchId).toBe("launch-dev-1");
    expect(await resolveProbePlan(root, "developer" as AgentRole, { [BFLOW_LAUNCH_ID_ENV]: "launch-other" })).toBeUndefined();
    await expect(resolveProbePlan(root, "developer" as AgentRole, { [BFLOW_LAUNCH_ID_ENV]: "../../etc/passwd" })).rejects.toThrow("not a safe identifier");
    await expect(resolveProbePlan(root, "developer" as AgentRole, { [BFLOW_LAUNCH_ID_ENV]: "" })).rejects.toThrow("not a safe identifier");
  });

  it("refuses a plan file whose content names another launch than its file name", async () => {
    const root = await tempDirectory();
    const probes = join(root, GATEWAY_PROBE_DIRECTORY);
    await mkdir(probes, { recursive: true });
    const misfiled = { schemaVersion: 3, launchId: "launch-b", endpoint: "http://127.0.0.1:9/mcp", entries: [{ registrationId: REGISTRATION_ID, envName: ENV_NAME, allowedTools: ["query"] }] };
    await writeFile(launchProbePath(probes, "launch-a"), JSON.stringify(misfiled));
    await expect(resolveProbePlan(root, "developer" as AgentRole, { [BFLOW_LAUNCH_ID_ENV]: "launch-a" })).rejects.toThrow("another launch");
  });

  it("falls back to the legacy role plan only when no launch id is in the environment, and removes it on prepare", async () => {
    const root = await tempDirectory();
    const legacy = { schemaVersion: 3, launchId: "launch-old", endpoint: "http://127.0.0.1:9/mcp", entries: [{ registrationId: REGISTRATION_ID, envName: ENV_NAME, allowedTools: ["query"] }] };
    await writeFile(legacyRoleProbePath(root, "reviewer" as AgentRole), JSON.stringify(legacy));
    expect((await resolveProbePlan(root, "reviewer" as AgentRole, {}))?.launchId).toBe("launch-old");
    expect(await resolveProbePlan(root, "reviewer" as AgentRole, { [BFLOW_LAUNCH_ID_ENV]: "launch-new" })).toBeUndefined();
    await removeLegacyRoleProbes(root, ["reviewer" as AgentRole]);
    expect(await resolveProbePlan(root, "reviewer" as AgentRole, {})).toBeUndefined();
  });

  it("stores reachability per launch with its pane, so concurrent Developers of one role never overwrite each other", async () => {
    const root = await tempDirectory();
    const okRecord: ToolReachabilityRecord = { registrationId: "reg-a", envName: ENV_NAME, ok: true, discoveredTools: ["query"], code: null };
    const failedRecord: ToolReachabilityRecord = { registrationId: "reg-b", envName: ENV_NAME, ok: false, discoveredTools: [], code: "unauthorized" };
    await writeLaunchReachability(root, "launch-a", "pane-a", [okRecord]);
    await writeLaunchReachability(root, "launch-b", "pane-b", [failedRecord]);
    expect(await readLaunchReachability(root, "launch-a")).toEqual({ paneId: "pane-a", reported: { launchId: "launch-a", toolReachability: [okRecord] } });
    expect(await readLaunchReachability(root, "launch-b")).toEqual({ paneId: "pane-b", reported: { launchId: "launch-b", toolReachability: [failedRecord] } });
    expect(await readLaunchReachability(root, "launch-c")).toBeUndefined();
    expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});

// ---------------------------------------------------------- real Gateway

const WORKER_SOURCE = `let input='';process.stdin.on('data',chunk=>{input+=chunk;while(input.includes('\\n')){let n=input.indexOf('\\n');let m=JSON.parse(input.slice(0,n));input=input.slice(n+1);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'control-fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'query',inputSchema:{type:'object'}},{name:'context',inputSchema:{type:'object'}},{name:'impact',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify(m.params)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}});`;

async function startRealGateway() {
  const root = await tempDirectory();
  const module = await import(new URL("../../../mcp-gateway/dist/index.js", import.meta.url).href);
  const gateway = new module.BflowSharedMCPGateway();
  const server = new module.StreamableHttpGatewayServer({ gateway });
  const endpoint = `${await server.start()}/mcp`;
  const script = join(root, "worker.cjs");
  await writeFile(script, WORKER_SOURCE, { mode: 0o600 });
  const operation = { schemaVersion: 3, scope: { kind: "session", machineId: "machine", repositoryId: "repo", workspaceRoot: root, sessionId: "runtime" }, idempotencyKey: "fixture" };
  const service = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: "gitnexus-h1", revision: 1,
    scope: { kind: "machine", machineId: "machine" },
    tool: { schemaVersion: 3, toolId: "gitnexus", kind: "stdio_mcp", version: "1", operations: ["query", "context", "impact"], required: true,
      resource: { sharing: "exclusive", resourceKey: "gitnexus-h1" } },
    connection: { kind: "stdio_mcp", executable: process.execPath, argv: [script], environmentBindings: {},
      executableDigest: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), ownership: "bflow", bridgeRequired: true },
    authentication: { mode: "none" }, healthTimeoutMs: 1000, idleTimeoutMs: 1000, restartLimit: 0 });
  const ensured = await gateway.serviceManager.ensure(service, operation);
  if (!ensured.ok) throw new Error("fixture service did not start");
  cleanup.push(async () => { await gateway.serviceManager.stop(service.serviceId, operation); await server.stop(); });

  const registrationId = "reg-h1gateway0001";
  const registration = MCPClientRegistrationSchema.parse({ schemaVersion: 3, registrationId, provider: "codex", role: "reviewer",
    scope: operation.scope, environmentId: "host-epoch-h1", serviceIds: [service.serviceId], allowedTools: ["query"],
    connection: { transport: "streamable_http", endpoint, token: `secret://runtime/${registrationId}` },
    configDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: `register-${registrationId}` });
  const sent = await gateway.register(registration);
  if (!sent.ok) throw new Error("fixture registration was refused");
  const token: string = gateway.secretStore.getClientTokenByRegistration(registrationId);
  const revoke = () => gateway.revoke(registrationId, operation);
  return { endpoint, token, registration: sent.value as MCPClientRegistration, registrationId, revoke };
}

describe("H1 probe against a real Gateway", () => {
  it("proves reachability from the registration token and then reports unauthorized after revocation", async () => {
    const real = await startRealGateway();
    const envName = tokenEnvironmentName(real.registrationId);
    const probeTarget: GatewayProbeTarget = { endpoint: real.endpoint, registrationId: real.registrationId, envName, allowedTools: ["query"] };
    const ok = await probeGatewayTools(probeTarget, { [envName]: real.token }, (url, init) => fetch(url, init), 5000);
    expect(ok).toEqual({ registrationId: real.registrationId, envName, ok: true, discoveredTools: ["query"], code: null });
    expect(JSON.stringify(ok)).not.toContain(real.token);

    const widened = await probeGatewayTools({ ...probeTarget, allowedTools: ["query", "context"] }, { [envName]: real.token }, (url, init) => fetch(url, init), 5000);
    expect(widened).toMatchObject({ ok: false, code: "missing_tools" });

    await real.revoke();
    const revoked = await probeGatewayTools(probeTarget, { [envName]: real.token }, (url, init) => fetch(url, init), 5000);
    expect(revoked).toMatchObject({ ok: false, code: "unauthorized" });
    expect(JSON.stringify(revoked)).not.toContain(real.token);
  });
});

// ------------------------------------------- provider hook process (spawned host build)

describe("H1 SessionStart hook in a separate provider-like process", () => {
  it("reports in-process reachability via provider_started and never the token", async () => {
    const real = await startRealGateway();
    const envName = tokenEnvironmentName(real.registrationId);
    const root = await tempDirectory();
    const hostSocket = join(root, "h.sock"), herdrSocket = join(root, "x.sock");
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const hostServer = await listen(hostSocket, (socket, line) => {
      const request = JSON.parse(line) as { method: string; params: Record<string, unknown>; token: string };
      if (request.token !== "host-role-token") { socket.end(JSON.stringify({ ok: false, error: "auth" }) + "\n"); return; }
      requests.push({ method: request.method, params: request.params });
      socket.end(JSON.stringify({ ok: true, value: null }) + "\n");
    });
    const herdrServer = await listen(herdrSocket, socket => socket.end(JSON.stringify({ id: "n", result: {} }) + "\n"));
    cleanup.push(() => closeServer(hostServer), () => closeServer(herdrServer));

    const rolePath = join(root, "reviewer.json");
    await writeFile(rolePath, JSON.stringify({ socketPath: hostSocket, token: "host-role-token", role: "reviewer", provider: "codex", herdrBinary: "herdr", sessionId: "s1" }), { mode: 0o600 });
    await chmod(rolePath, 0o600);
    await publishLaunchProbe(join(root, GATEWAY_PROBE_DIRECTORY), preparedGateway("reviewer", "launch-hook", real));

    const hostBuild = fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url));
    const runHook = (token: string | undefined, launchId: string | undefined = "launch-hook") => new Promise<number>((accept, reject) => {
      const child = spawn(process.execPath, [hostBuild, "hook", rolePath, "SessionStart"], {
        env: { PATH: process.env.PATH ?? "", HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: herdrSocket,
          ...(launchId === undefined ? {} : { [BFLOW_LAUNCH_ID_ENV]: launchId }), ...(token === undefined ? {} : { [envName]: token }) },
        stdio: ["pipe", "ignore", "pipe"]
      });
      let errors = "";
      child.stderr.on("data", chunk => { errors += String(chunk); });
      child.once("error", reject);
      child.once("exit", code => { if (code !== 0) reject(new Error(`hook exited ${code}: ${errors.replace(real.token, "[token]")}`)); else accept(code); });
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "native-session-1", source: "startup" }));
    });

    await runHook(real.token);
    const started = requests.find(request => request.method === "provider_started");
    expect(started).toBeDefined();
    expect(started!.params).toMatchObject({ paneId: "pane-1", nativeSessionId: "native-session-1", launchId: "launch-hook",
      toolReachability: [{ registrationId: real.registrationId, envName, ok: true, discoveredTools: ["query"], code: null }] });
    expect(JSON.stringify(requests)).not.toContain(real.token);
    expect(requests.some(request => request.method === "native_session")).toBe(true);

    requests.length = 0;
    await runHook(undefined);
    const missing = requests.find(request => request.method === "provider_started")!;
    expect(missing.params.toolReachability).toEqual([{ registrationId: real.registrationId, envName, ok: false, discoveredTools: [], code: "token_env_missing" }]);

    requests.length = 0;
    await real.revoke();
    await runHook(real.token);
    const revoked = requests.find(request => request.method === "provider_started")!;
    expect(revoked.params.toolReachability).toEqual([expect.objectContaining({ ok: false, code: "unauthorized" })]);
    expect(JSON.stringify(requests)).not.toContain(real.token);

    // A traversal launch id is refused before any probe or report: the hook fails and nothing reaches the host.
    requests.length = 0;
    await expect(runHook(real.token, "../reviewer")).rejects.toThrow("not a safe identifier");
    expect(requests.some(request => request.method === "provider_started")).toBe(false);
  });

  it("falls back to the legacy per-role plan only when the launch id is absent from the environment", async () => {
    const real = await startRealGateway();
    const envName = tokenEnvironmentName(real.registrationId);
    const root = await tempDirectory();
    const hostSocket = join(root, "h.sock"), herdrSocket = join(root, "x.sock");
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const hostServer = await listen(hostSocket, (socket, line) => {
      const request = JSON.parse(line) as { method: string; params: Record<string, unknown>; token: string };
      if (request.token !== "host-role-token") { socket.end(JSON.stringify({ ok: false, error: "auth" }) + "\n"); return; }
      requests.push({ method: request.method, params: request.params });
      socket.end(JSON.stringify({ ok: true, value: null }) + "\n");
    });
    const herdrServer = await listen(herdrSocket, socket => socket.end(JSON.stringify({ id: "n", result: {} }) + "\n"));
    cleanup.push(() => closeServer(hostServer), () => closeServer(herdrServer));
    const rolePath = join(root, "reviewer.json");
    await writeFile(rolePath, JSON.stringify({ socketPath: hostSocket, token: "host-role-token", role: "reviewer", provider: "codex", herdrBinary: "herdr", sessionId: "s1" }), { mode: 0o600 });
    await chmod(rolePath, 0o600);
    await writeFile(legacyRoleProbePath(root, "reviewer" as AgentRole), JSON.stringify({ schemaVersion: 3, launchId: "launch-legacy", endpoint: real.endpoint,
      entries: [{ registrationId: real.registrationId, envName, allowedTools: ["query"] }] }));

    const hostBuild = fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url));
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, [hostBuild, "hook", rolePath, "SessionStart"], {
        env: { PATH: process.env.PATH ?? "", HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: herdrSocket, [envName]: real.token },
        stdio: ["pipe", "ignore", "pipe"]
      });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? accept() : reject(new Error(`hook exited ${code}`)));
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "native-session-2", source: "startup" }));
    });
    const started = requests.find(request => request.method === "provider_started")!;
    expect(started.params).toMatchObject({ launchId: "launch-legacy", toolReachability: [expect.objectContaining({ ok: true, code: null })] });
    expect(JSON.stringify(requests)).not.toContain(real.token);
  });
});

function preparedGateway(role: AgentRole, launchId: string, real: { endpoint: string; token: string; registration: MCPClientRegistration; registrationId: string }): PreparedRoleLaunch {
  const envName = tokenEnvironmentName(real.registrationId);
  return {
    role, provider: "codex", required: true,
    gateway: { registrations: [{ ...real.registration, connection: { transport: "streamable_http", endpoint: real.endpoint, token: `secret://runtime/${real.registrationId}` } }],
      observations: [], tokenEnvironment: { [envName]: real.token } },
    launch: { argv: [], env: { [envName]: real.token }, launchId, launchFingerprint: "c".repeat(64) }
  } as unknown as PreparedRoleLaunch;
}

function listen(path: string, onLine: (socket: Socket, line: string) => void): Promise<Server> {
  return new Promise((accept, reject) => {
    const server = createServer(socket => {
      let input = "";
      socket.on("error", () => undefined);
      socket.on("data", chunk => { input += String(chunk); if (input.includes("\n")) onLine(socket, input.split("\n")[0]!); });
    });
    server.once("error", reject);
    server.listen(path, () => accept(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(accept => server.close(() => accept()));
}

describe("H1 reachability precedence and source (unit)", () => {
  const okRecord: ToolReachabilityRecord = { registrationId: REGISTRATION_ID, envName: ENV_NAME, ok: true, discoveredTools: ["query"], code: null };
  const failing = (code: ToolReachabilityCode): ToolReachabilityRecord => ({ ...okRecord, ok: false, discoveredTools: [], code });
  const fact = (toolReachability: ToolReachabilityRecord[], source: "hook" | "mcp_bootstrap", paneId = "pane-1", launchId = "launch-p"): ReachabilityFact =>
    ({ launchId, paneId, toolReachability, source });

  it("keeps the first all-ok proof of a launch against later failures, except an unauthorized rejection", () => {
    const stored = fact([okRecord], "hook");
    expect(selectReachabilityFact(stored, fact([okRecord], "mcp_bootstrap"))).toBe(stored);
    expect(selectReachabilityFact(stored, fact([failing("token_env_missing")], "mcp_bootstrap"))).toBe(stored);
    expect(selectReachabilityFact(stored, fact([failing("timeout")], "mcp_bootstrap"))).toBe(stored);
    const revoked = fact([failing("unauthorized")], "mcp_bootstrap");
    expect(selectReachabilityFact(stored, revoked)).toBe(revoked);
  });

  it("lets any incoming fact replace a partially failing one, and a different launch or pane replace everything", () => {
    const failed = fact([failing("token_env_missing")], "hook");
    expect(selectReachabilityFact(failed, fact([okRecord], "mcp_bootstrap"))).toEqual(fact([okRecord], "mcp_bootstrap"));
    expect(selectReachabilityFact(failed, fact([failing("timeout")], "mcp_bootstrap")).toolReachability).toEqual([failing("timeout")]);
    const allOk = fact([okRecord], "hook");
    const other = fact([failing("unauthorized")], "mcp_bootstrap", "pane-2");
    expect(selectReachabilityFact(allOk, other)).toBe(other);
    expect(selectReachabilityFact(undefined, other)).toBe(other);
  });

  it("persists the reporting path with the launch record and treats older records as hook proofs", async () => {
    const directory = await tempDirectory();
    await writeLaunchReachability(directory, "launch-src", "pane-1", [okRecord], "mcp_bootstrap");
    expect(await readLaunchReachabilityFact(directory, "launch-src")).toEqual({ launchId: "launch-src", paneId: "pane-1",
      toolReachability: [okRecord], source: "mcp_bootstrap" });
    expect(await readLaunchReachability(directory, "launch-src")).toEqual({ paneId: "pane-1", reported: { launchId: "launch-src", toolReachability: [okRecord] } });
    // A record written before the source field existed is a hook proof.
    await writeFile(launchReachabilityPath(directory, "launch-old"), JSON.stringify({ launchId: "launch-old", paneId: "pane-1", toolReachability: [okRecord] }));
    expect((await readLaunchReachabilityFact(directory, "launch-old"))?.source).toBe("hook");
  });

  it("rejects a bootstrap payload that is not the strict launch-bound shape", () => {
    expect(ProviderBootstrapPayloadSchema.safeParse({ launchId: "l", paneId: "p", toolReachability: [okRecord], source: "mcp_bootstrap" }).success).toBe(true);
    expect(ProviderBootstrapPayloadSchema.safeParse({ launchId: "l", toolReachability: [okRecord], source: "hook" }).success).toBe(false);
    expect(ProviderBootstrapPayloadSchema.safeParse({ launchId: "l", toolReachability: [], source: "mcp_bootstrap" }).success).toBe(false);
    expect(ProviderBootstrapPayloadSchema.safeParse({ launchId: "l", toolReachability: [okRecord], source: "mcp_bootstrap", token: "x" }).success).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("H1 MCP bootstrap probe (spawned role MCP child)", () => {
  const hostBuild = fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url));

  /** Fake host socket that records every request and acknowledges it; returns the role file path. */
  async function bootstrapHost(root: string) {
    const hostSocket = join(root, "h.sock"), herdrSocket = join(root, "x.sock");
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const hostServer = await listen(hostSocket, (socket, line) => {
      const request = JSON.parse(line) as { method: string; params: Record<string, unknown>; token: string };
      if (request.token !== "host-role-token") { socket.end(JSON.stringify({ ok: false, error: "auth" }) + "\n"); return; }
      requests.push({ method: request.method, params: request.params });
      socket.end(JSON.stringify({ ok: true, value: null }) + "\n");
    });
    const herdrServer = await listen(herdrSocket, socket => socket.end(JSON.stringify({ id: "n", result: {} }) + "\n"));
    cleanup.push(() => closeServer(hostServer), () => closeServer(herdrServer));
    const rolePath = join(root, "reviewer.json");
    await writeFile(rolePath, JSON.stringify({ socketPath: hostSocket, token: "host-role-token", role: "reviewer", provider: "codex", herdrBinary: "herdr", sessionId: "s1" }), { mode: 0o600 });
    await chmod(rolePath, 0o600);
    return { rolePath, requests };
  }

  /** Runs the role MCP child with one initialize request; resolves when the child (and its bootstrap) has exited. */
  function runMcpChild(rolePath: string, env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
      const child = spawn(process.execPath, [hostBuild, "mcp", rolePath], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", code => accept({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    });
  }

  it("sends one authenticated provider_bootstrap with the probe records, from the provider environment, and never a token", async () => {
    const real = await startRealGateway();
    const envName = tokenEnvironmentName(real.registrationId);
    const root = await tempDirectory();
    const { rolePath, requests } = await bootstrapHost(root);
    await publishLaunchProbe(join(root, GATEWAY_PROBE_DIRECTORY), preparedGateway("reviewer", "launch-mcp", real));

    const child = await runMcpChild(rolePath, { HERDR_PANE_ID: "pane-mcp", BFLOW_LAUNCH_ID: "launch-mcp", [envName]: real.token });
    expect(child.code).toBe(0);
    expect(child.stdout).toContain('"protocolVersion"');
    const bootstrap = requests.filter(request => request.method === "provider_bootstrap");
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]!.params).toEqual({ launchId: "launch-mcp", paneId: "pane-mcp", source: "mcp_bootstrap",
      toolReachability: [{ registrationId: real.registrationId, envName, ok: true, discoveredTools: ["query"], code: null }] });
    expect(requests.some(request => request.method === "provider_started" || request.method === "native_session")).toBe(false);
    expect(JSON.stringify(requests) + child.stdout + child.stderr).not.toContain(real.token);
  });

  it("reports token_env_missing when the provider environment lacks the launch token, without any network call", async () => {
    const real = await startRealGateway();
    const envName = tokenEnvironmentName(real.registrationId);
    const root = await tempDirectory();
    const { rolePath, requests } = await bootstrapHost(root);
    await publishLaunchProbe(join(root, GATEWAY_PROBE_DIRECTORY), preparedGateway("reviewer", "launch-mcp", real));

    const child = await runMcpChild(rolePath, { HERDR_PANE_ID: "pane-mcp", BFLOW_LAUNCH_ID: "launch-mcp" });
    expect(child.code).toBe(0);
    expect(requests).toEqual([{ method: "provider_bootstrap", params: { launchId: "launch-mcp", paneId: "pane-mcp", source: "mcp_bootstrap",
      toolReachability: [{ registrationId: real.registrationId, envName, ok: false, discoveredTools: [], code: "token_env_missing" }] } }]);
  });

  it("sends nothing when the launch has no probe plan or the launch id is absent", async () => {
    const real = await startRealGateway();
    const envName = tokenEnvironmentName(real.registrationId);
    const root = await tempDirectory();
    const { rolePath, requests } = await bootstrapHost(root);

    const noPlan = await runMcpChild(rolePath, { HERDR_PANE_ID: "pane-mcp", BFLOW_LAUNCH_ID: "launch-missing", [envName]: real.token });
    expect(noPlan.code).toBe(0);
    await publishLaunchProbe(join(root, GATEWAY_PROBE_DIRECTORY), preparedGateway("reviewer", "launch-mcp", real));
    const noLaunchId = await runMcpChild(rolePath, { HERDR_PANE_ID: "pane-mcp", [envName]: real.token });
    expect(noLaunchId.code).toBe(0);
    expect(requests).toEqual([]);
  });
});
