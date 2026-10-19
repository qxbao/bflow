import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsClient, FileDocsCache, MemoryDocsCache, DEFAULT_CACHE_POLICY } from "@bflow/docs-retrieval";
import { GatewayDocsCaller } from "../src/docs-gateway.js";
import { KEY, SECRET_REF, fixtureDirectory, startGateway, startUpstream, type Upstream } from "./helpers/context7-fixtures.js";
import { evaluateContext7Health } from "../src/docs-health.js";

let upstream: Upstream;
let stack: Awaited<ReturnType<typeof startGateway>> | undefined;
let temporary: string;
let resolveReact: string;
beforeEach(async () => {
  resolveReact = await readFile(join(fixtureDirectory, "resolve-react.txt"), "utf8");
  upstream = await startUpstream(resolveReact);
  temporary = await mkdtemp(join("/tmp", "bflow-c7i-"));
});
afterEach(async () => { await stack?.stop(); stack = undefined; await upstream.close(); await rm(temporary, { recursive: true, force: true }); });

describe("Context7 through the shared Gateway", () => {
  it("serves Claude, Codex and Agy agents concurrently from one upstream with no local backend process", async () => {
    stack = await startGateway(upstream.endpoint);
    expect(stack.ensured.ok && stack.ensured.value.ownership).toBe("external");
    const agents = await Promise.all([["developer", "claude"], ["reviewer", "codex"], ["architect", "agy"]].map(([role, provider]) => stack!.enroll(role!, provider!)));
    const results = await Promise.all(agents.flatMap(agent => Array.from({ length: 4 }, (_, index) =>
      new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ library: "react", version: "18.2.0", query: `question ${index}` }))));
    expect(results.every(result => result.ok)).toBe(true);
    const first = results[0]!;
    expect(first.ok && first.libraryId).toBe("/react/react/v18.2.0");
    expect(upstream.seen.filter(item => item.method === "initialize")).toHaveLength(1);
    expect(upstream.seen.filter(item => item.tool === "query-docs")).toHaveLength(12);
    const snapshot = stack.metrics();
    expect(snapshot.activeProcessCount).toBe(0);
    expect(snapshot.perService["context7"]?.activeProcesses ?? 0).toBe(0);
    expect(snapshot.perService["context7"]?.upstreamHttp?.request).toBeGreaterThan(12);
  });

  it("grants Context7 only to registrations that hold both the service and the tools", async () => {
    stack = await startGateway(upstream.endpoint);
    const noTools = await stack.enroll("developer", "claude", { allowedTools: ["resolve-library-id"] });
    const denied = await new DocsClient({ caller: new GatewayDocsCaller(noTools) }).lookup({ libraryId: "/a/b", query: "x" });
    expect(denied).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
    expect(upstream.seen.filter(item => item.tool === "query-docs")).toHaveLength(0);
    const revoked = await stack.enroll("developer", "codex");
    await stack.gateway.revoke(revoked.registrationId, stack.operation);
    expect(await new DocsClient({ caller: new GatewayDocsCaller(revoked) }).lookup({ libraryId: "/a/b", query: "x" })).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
    const wrongToken = await new DocsClient({ caller: new GatewayDocsCaller({ ...revoked, token: "0".repeat(64) }) }).lookup({ libraryId: "/a/b", query: "x" });
    expect(wrongToken).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
  });

  it("returns the library's documentation, the version used and cache behavior end to end", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude");
    const cache = new MemoryDocsCache();
    const client = new DocsClient({ caller: new GatewayDocsCaller(agent), cache, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    const first = await client.lookup({ library: "react", version: "18.2.0", query: "useEffect cleanup", language: "javascript" });
    const second = await client.lookup({ library: "react", version: "18.2.0", query: "useEffect cleanup", language: "javascript" });
    expect(first).toMatchObject({ ok: true, versionUsed: "v18.2.0", versionMatch: "exact", cache: { hit: false, stored: true } });
    expect(first.ok && first.content).toBe("docs for /react/react/v18.2.0: useEffect cleanup");
    expect(second).toMatchObject({ ok: true, cache: { hit: true } });
    expect(upstream.seen.filter(item => item.tool === "query-docs")).toHaveLength(1);
    expect(upstream.seen.find(item => item.tool === "query-docs")?.args).toEqual({ libraryId: "/react/react/v18.2.0", query: "useEffect cleanup", language: "javascript" });
  });

  describe("failure modes", () => {
    it("reports a missing key, an invalid key and a valid key as different outcomes", async () => {
      upstream.behave({ requireKey: KEY });
      stack = await startGateway(upstream.endpoint, { authenticated: true });
      const agent = await stack.enroll("developer", "claude");
      expect(await new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ libraryId: "/a/b", query: "x" }))
        .toMatchObject({ ok: false, failure: { kind: "auth_missing" } });
      await stack.stop(); stack = undefined;
      stack = await startGateway(upstream.endpoint, { authenticated: true, apiKey: "ctx7sk-wrong-key-0123456789" });
      const wrong = await stack.enroll("developer", "claude");
      expect(await new DocsClient({ caller: new GatewayDocsCaller(wrong) }).lookup({ libraryId: "/a/b", query: "x" }))
        .toMatchObject({ ok: false, stage: "query", failure: { kind: "auth_invalid", retryable: false } });
      await stack.stop(); stack = undefined;
      stack = await startGateway(upstream.endpoint, { authenticated: true, apiKey: KEY });
      const good = await stack.enroll("developer", "claude");
      expect(await new DocsClient({ caller: new GatewayDocsCaller(good) }).lookup({ libraryId: "/a/b", query: "x" })).toMatchObject({ ok: true });
      expect(upstream.seen.some(item => item.authorization === `Bearer ${KEY}`)).toBe(true);
    });

    it("absorbs a transient 429 and reports a persistent one with its retry delay", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ faults: [{ status: 429, headers: { "retry-after": "0" } }] });
      expect(await new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ libraryId: "/a/b", query: "x" })).toMatchObject({ ok: true });
      upstream.behave({ faults: Array.from({ length: 6 }, () => ({ status: 429, headers: { "retry-after": "120" } })) });
      const limited = await new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ libraryId: "/a/b", query: "y" });
      expect(limited).toMatchObject({ ok: false, failure: { kind: "rate_limited", retryable: true, retryAfterMs: 120_000 } });
      expect(stack.metrics().perService["context7"]?.upstreamHttp?.rate_limited).toBeGreaterThanOrEqual(2);
    });

    it("classifies library-not-found, version-not-found and documentation gaps without inventing content", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ queryText: args => args.libraryId === "/nobody/lib" ? { text: 'Library "/nobody/lib" not found. Please check the library ID or your access permissions.', isError: true }
        : args.libraryId.endsWith("/v1.0.0") ? { text: `Version "v1.0.0" not found for library "/react/react". Available versions: v19.2.7, v18.2.0`, isError: true } : { text: "   " } });
      const client = () => new DocsClient({ caller: new GatewayDocsCaller(agent) });
      expect(await client().lookup({ libraryId: "/nobody/lib", query: "x" })).toMatchObject({ ok: false, failure: { kind: "library_not_found" } });
      expect(await client().lookup({ libraryId: "/react/react", version: "v1.0.0", query: "x" })).toMatchObject({ ok: false, failure: { kind: "version_not_found", availableVersions: ["v19.2.7", "v18.2.0"] } });
      expect(await client().lookup({ libraryId: "/react/react", query: "x" })).toMatchObject({ ok: false, failure: { kind: "no_documentation" } });
      const unknown = await client().lookup({ library: "zzzz-no-such-lib-qq", query: "x" });
      expect(unknown).toMatchObject({ ok: false, stage: "resolve", failure: { kind: "library_not_found" } });
    });

    it("reports a timeout and an unreachable Context7 as different kinds, and recovers when it returns", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ faults: ["hang", "hang", "hang"] });
      const slow = await new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 1500 }).lookup({ libraryId: "/a/b", query: "x" });
      expect(slow).toMatchObject({ ok: false, failure: { kind: "timeout" } });
      upstream.behave({ faults: [] });
      const port = Number(new URL(upstream.endpoint).port);
      await upstream.close();
      const down = await new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 6000 }).lookup({ libraryId: "/a/b", query: "x" });
      expect(down.ok).toBe(false);
      if (!down.ok) {
        expect(["network", "unavailable"]).toContain(down.failure.kind);
        expect(down.failure.retryable).toBe(true);
      }
      upstream = await startUpstream(resolveReact, port);
      const again = await new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 6000 }).lookup({ libraryId: "/a/b", query: "back" });
      expect(again).toMatchObject({ ok: true });
    });

    it("keeps the Gateway's cautious default when nothing declares the tools read-only: a failure is reported as unknown", async () => {
      stack = await startGateway(upstream.endpoint, { declareReadOnly: false });
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ faults: Array.from({ length: 6 }, () => ({ status: 503 })) });
      const result = await new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ libraryId: "/a/b", query: "x" });
      expect(result).toMatchObject({ ok: false, failure: { kind: "upstream_error", message: "The outcome of the lookup could not be confirmed." } });
      expect(upstream.seen.filter(item => item.tool === "query-docs")).toHaveLength(1);
    });

    it("recovers when the upstream drops its session, without agents noticing", async () => {
      upstream.behave({ stateful: true });
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      expect((await new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ libraryId: "/a/b", query: "one" })).ok).toBe(true);
      upstream.sessions.clear();
      expect((await new DocsClient({ caller: new GatewayDocsCaller(agent) }).lookup({ libraryId: "/a/b", query: "two" })).ok).toBe(true);
      expect(upstream.seen.filter(item => item.method === "initialize")).toHaveLength(2);
      expect(stack.metrics().perService["context7"]?.upstreamHttp?.session_reinitialized).toBe(1);
    });

    it("rejects an earlier registration after the Gateway restarts and serves a fresh one", async () => {
      stack = await startGateway(upstream.endpoint);
      const before = await stack.enroll("developer", "claude");
      expect((await new DocsClient({ caller: new GatewayDocsCaller(before) }).lookup({ libraryId: "/a/b", query: "x" })).ok).toBe(true);
      await stack.stop();
      stack = await startGateway(upstream.endpoint);
      const stale = await new DocsClient({ caller: new GatewayDocsCaller({ ...before, endpoint: stack.endpoint }) }).lookup({ libraryId: "/a/b", query: "x" });
      expect(stale).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
      const fresh = await stack.enroll("developer", "claude");
      expect((await new DocsClient({ caller: new GatewayDocsCaller(fresh) }).lookup({ libraryId: "/a/b", query: "x" })).ok).toBe(true);
    });

    it("never writes the API key into the cache, logs or results", async () => {
      upstream.behave({ requireKey: KEY });
      stack = await startGateway(upstream.endpoint, { authenticated: true, apiKey: KEY });
      const agent = await stack.enroll("developer", "claude");
      const directory = join(temporary, "cache");
      const cache = new FileDocsCache({ directory });
      const client = new DocsClient({ caller: new GatewayDocsCaller(agent), cache, authenticated: true, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
      const result = await client.lookup({ libraryId: "/a/b", query: "x" });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(stack.metrics())).not.toContain(KEY);
      expect(cache.stats().writes).toBe(0);
    });
  });
});

describe("Context7 health", () => {
  async function receipt(directory: string, status: string, ageMs = 1000) {
    await writeFile(join(directory, "setup-gateway-ready.json"), JSON.stringify({ schemaVersion: 3, definitionDigest: "d", pid: process.pid, endpoint: "http://127.0.0.1:1/mcp",
      observedAt: new Date(Date.now() - ageMs).toISOString(),
      observations: status === "missing" ? [] : [{ serviceId: "context7", status, discoveredTools: status === "ready" ? ["resolve-library-id", "query-docs"] : [], diagnosticCode: status === "ready" ? undefined : "optional_backend_unavailable" }] }), { mode: 0o600 });
  }
  const base = (stateDirectory: string, required = false) => ({ context7: { enabled: true, required }, stateDirectory, machineId: "m1", repository: undefined, env: {},
    roles: [{ role: "developer", cli: "claude" }, { role: "reviewer", cli: "codex" }, { role: "architect", cli: "agy" }, { role: "conversation", cli: "claude" }],
    grantedRoles: ["developer", "reviewer", "architect", "specifier", "planner", "qa"] });

  it("is healthy only when the Gateway lists the service ready and both tools answer", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude");
    await receipt(temporary, "ready");
    const health = await evaluateContext7Health({ ...base(temporary), deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.state).toBe("healthy");
    expect(health.checks.filter(check => check.status === "fail")).toEqual([]);
    expect(health.checks.find(check => check.id === "query-docs")).toMatchObject({ status: "pass" });
    expect(health.providers).toEqual([{ provider: "claude", granted: true, roles: ["developer"] }, { provider: "codex", granted: true, roles: ["reviewer"] }, { provider: "agy", granted: true, roles: ["architect"] }]);
    expect(health.probe.mode).toBe("agent");
  });

  it("does not call a service healthy because an HTTP endpoint answered: an invalid key fails the tool checks", async () => {
    upstream.behave({ requireKey: KEY });
    stack = await startGateway(upstream.endpoint, { authenticated: true, apiKey: "ctx7sk-wrong-0123456789ab" });
    const agent = await stack.enroll("developer", "claude");
    await receipt(temporary, "ready");
    const health = await evaluateContext7Health({ ...base(temporary, true), deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.state).toBe("unavailable");
    expect(health.checks.find(check => check.id === "resolve-library-id")).toMatchObject({ status: "fail", failureKind: "auth_invalid" });
    expect(health.checks.find(check => check.id === "service")?.status).toBe("pass");
  });

  it("is degraded, not unavailable, when an optional service cannot be reached, and tells the causes apart", async () => {
    await receipt(temporary, "blocked");
    const optional = await evaluateContext7Health(base(temporary, false));
    expect(optional.state).toBe("degraded");
    expect(optional.checks.find(check => check.id === "service")).toMatchObject({ status: "fail", failureKind: "unavailable" });
    expect(optional.checks.filter(check => check.status === "skipped").map(check => check.id)).toContain("query-docs");
    const required = await evaluateContext7Health(base(temporary, true));
    expect(required.state).toBe("unavailable");
    await rm(join(temporary, "setup-gateway-ready.json"));
    expect((await evaluateContext7Health(base(temporary))).checks.find(check => check.id === "gateway")).toMatchObject({ status: "fail" });
    await receipt(temporary, "ready", 5 * 60_000);
    expect((await evaluateContext7Health(base(temporary))).checks.find(check => check.id === "gateway")?.message).toMatch(/stale/);
    await receipt(temporary, "missing");
    expect((await evaluateContext7Health(base(temporary))).checks.find(check => check.id === "service")?.message).toMatch(/does not list/);
  });

  it("reports a rate limit as a warning with a distinct cause", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude");
    await receipt(temporary, "ready");
    upstream.behave({ faults: Array.from({ length: 8 }, () => ({ status: 429, headers: { "retry-after": "90" } })) });
    const health = await evaluateContext7Health({ ...base(temporary), deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.checks.find(check => check.id === "quota")).toMatchObject({ status: "warn", failureKind: "rate_limited" });
  });

  it("is disabled, and makes no call, when the repository has not enabled Context7", async () => {
    const health = await evaluateContext7Health({ ...base(temporary), context7: undefined });
    expect(health.state).toBe("disabled");
    expect(health.probe.mode).toBe("none");
    expect(upstream.seen).toHaveLength(0);
  });
});
