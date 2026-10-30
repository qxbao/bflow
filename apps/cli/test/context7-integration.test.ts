import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsClient, FileDocsCache, MemoryDocsCache, DEFAULT_CACHE_POLICY } from "@bflow/docs-retrieval";
import { GatewayDocsCaller } from "../src/docs-gateway.js";
import { DEEPWIKI_ID, DEEPWIKI_TOOL_NAMES, startGateway, startUpstream, type Upstream } from "./helpers/context7-fixtures.js";
import { evaluateDeepWikiHealth } from "../src/docs-health.js";

// File name kept from the Context7 era: this suite carries the legacy shared-Gateway regression coverage over to DeepWiki.
let upstream: Upstream;
let stack: Awaited<ReturnType<typeof startGateway>> | undefined;
let temporary: string;
beforeEach(async () => {
  upstream = await startUpstream();
  temporary = await mkdtemp(join("/tmp", "bflow-dwi-"));
});
afterEach(async () => { await stack?.stop(); stack = undefined; await upstream.close(); await rm(temporary, { recursive: true, force: true }); });

const ask = (agent: ConstructorParameters<typeof GatewayDocsCaller>[0], question: string, repoName = "a/b", options: { timeoutMs?: number } = {}) =>
  new DocsClient({ caller: new GatewayDocsCaller(agent), ...options }).ask({ repoName, visibility: "public", question });

describe("DeepWiki through the shared Gateway", () => {
  it("serves Claude, Codex and Agy agents concurrently from one upstream with no local backend process", async () => {
    stack = await startGateway(upstream.endpoint);
    expect(stack.ensured.ok && stack.ensured.value.ownership).toBe("external");
    const agents = await Promise.all([["developer", "claude"], ["reviewer", "codex"], ["architect", "agy"]].map(([role, provider]) => stack!.enroll(role!, provider!)));
    const results = await Promise.all(agents.flatMap(agent => Array.from({ length: 4 }, (_, index) => ask(agent, `question ${index}`, "facebook/react"))));
    expect(results.every(result => result.ok)).toBe(true);
    const first = results[0]!;
    expect(first.ok && first.repoName).toBe("facebook/react");
    expect(upstream.seen.filter(item => item.method === "initialize")).toHaveLength(1);
    expect(upstream.seen.filter(item => item.tool === "ask_wiki_question")).toHaveLength(12);
    const snapshot = stack.metrics();
    expect(snapshot.activeProcessCount).toBe(0);
    expect(snapshot.perService[DEEPWIKI_ID]?.activeProcesses ?? 0).toBe(0);
    expect(snapshot.perService[DEEPWIKI_ID]?.upstreamHttp?.request).toBeGreaterThan(12);
  });

  it("discovers the real ask_wiki_question anyOf schema through tools/list and never sends a credential", async () => {
    stack = await startGateway(upstream.endpoint);
    expect(stack.ensured.ok && stack.ensured.value.discoveredTools).toEqual(expect.arrayContaining(DEEPWIKI_TOOL_NAMES));
    await ask(await stack.enroll("developer", "claude"), "anything");
    expect(upstream.seen.every(item => item.authorization === null)).toBe(true);
  });

  it("grants DeepWiki only to registrations that hold both the service and the tools", async () => {
    stack = await startGateway(upstream.endpoint);
    const noTools = await stack.enroll("developer", "claude", { allowedTools: ["read_wiki_structure"] });
    const denied = await ask(noTools, "x");
    expect(denied).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
    expect(upstream.seen.filter(item => item.tool === "ask_wiki_question")).toHaveLength(0);
    const revoked = await stack.enroll("developer", "codex");
    await stack.gateway.revoke(revoked.registrationId, stack.operation);
    expect(await ask(revoked, "x")).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
    const wrongToken = await ask({ ...revoked, token: "0".repeat(64) }, "x");
    expect(wrongToken).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
  });

  it("returns the repository's answer and cache behavior end to end", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude");
    const cache = new MemoryDocsCache();
    const client = new DocsClient({ caller: new GatewayDocsCaller(agent), cache, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    const input = { repoName: "facebook/react", visibility: "public", question: "useEffect cleanup" };
    const first = await client.ask(input);
    const second = await client.ask(input);
    expect(first).toMatchObject({ ok: true, repoName: "facebook/react", cache: { hit: false, stored: true } });
    expect(first.ok && first.content).toBe("wiki answer for facebook/react: useEffect cleanup");
    expect(second).toMatchObject({ ok: true, cache: { hit: true } });
    expect(upstream.seen.filter(item => item.tool === "ask_wiki_question")).toHaveLength(1);
    expect(upstream.seen.find(item => item.tool === "ask_wiki_question")?.args).toEqual({ repoName: "facebook/react", question: "useEffect cleanup" });
  });

  describe("failure modes", () => {
    it("absorbs a transient 429 and reports a persistent one with its retry delay", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ faults: [{ status: 429, headers: { "retry-after": "0" } }] });
      expect(await ask(agent, "x")).toMatchObject({ ok: true });
      upstream.behave({ faults: Array.from({ length: 6 }, () => ({ status: 429, headers: { "retry-after": "120" } })) });
      const limited = await ask(agent, "y");
      expect(limited).toMatchObject({ ok: false, failure: { kind: "rate_limited", retryable: true, retryAfterMs: 120_000 } });
      expect(stack.metrics().perService[DEEPWIKI_ID]?.upstreamHttp?.rate_limited).toBeGreaterThanOrEqual(2);
    });

    it("classifies an unindexed repository and a documentation gap without inventing content", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ answerText: args => args.repoName === "nobody/lib" ? { text: "Repository not found. Visit https://deepwiki.com/nobody/lib to index it.", isError: true } : { text: "   " } });
      expect(await ask(agent, "x", "nobody/lib")).toMatchObject({ ok: false, failure: { kind: "library_not_found" } });
      expect(await ask(agent, "x", "react/react")).toMatchObject({ ok: false, failure: { kind: "no_documentation" } });
      const unknown = await new DocsClient({ caller: new GatewayDocsCaller(agent) }).ask({ library: "zzzz-no-such-lib-qq", question: "x" });
      expect(unknown).toMatchObject({ ok: false, stage: "validate", failure: { kind: "library_not_found" } });
    });

    it("reports a timeout and an unreachable DeepWiki as different kinds, and recovers when it returns", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ faults: ["hang", "hang", "hang"] });
      const slow = await ask(agent, "x", "a/b", { timeoutMs: 1500 });
      expect(slow).toMatchObject({ ok: false, failure: { kind: "timeout" } });
      upstream.behave({ faults: [] });
      const port = Number(new URL(upstream.endpoint).port);
      await upstream.close();
      const down = await ask(agent, "x", "a/b", { timeoutMs: 6000 });
      expect(down.ok).toBe(false);
      if (!down.ok) {
        expect(["network", "unavailable"]).toContain(down.failure.kind);
        expect(down.failure.retryable).toBe(true);
      }
      upstream = await startUpstream(undefined, port);
      const again = await ask(agent, "back", "a/b", { timeoutMs: 6000 });
      expect(again).toMatchObject({ ok: true });
    });

    it("keeps the Gateway's cautious default when nothing declares the tools read-only: a failure is reported as unknown", async () => {
      stack = await startGateway(upstream.endpoint, { declareReadOnly: false });
      const agent = await stack.enroll("developer", "claude");
      upstream.behave({ faults: Array.from({ length: 6 }, () => ({ status: 503 })) });
      const result = await ask(agent, "x");
      expect(result).toMatchObject({ ok: false, failure: { kind: "upstream_error", message: "The outcome of the lookup could not be confirmed." } });
      expect(upstream.seen.filter(item => item.tool === "ask_wiki_question")).toHaveLength(1);
    });

    it("recovers when the upstream drops its session, without agents noticing", async () => {
      upstream.behave({ stateful: true });
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      expect((await ask(agent, "one")).ok).toBe(true);
      upstream.sessions.clear();
      expect((await ask(agent, "two")).ok).toBe(true);
      expect(upstream.seen.filter(item => item.method === "initialize")).toHaveLength(2);
      expect(stack.metrics().perService[DEEPWIKI_ID]?.upstreamHttp?.session_reinitialized).toBe(1);
    });

    it("rejects an earlier registration after the Gateway restarts and serves a fresh one", async () => {
      stack = await startGateway(upstream.endpoint);
      const before = await stack.enroll("developer", "claude");
      expect((await ask(before, "x")).ok).toBe(true);
      await stack.stop();
      stack = await startGateway(upstream.endpoint);
      const stale = await ask({ ...before, endpoint: stack.endpoint }, "x");
      expect(stale).toMatchObject({ ok: false, failure: { kind: "permission_denied" } });
      const fresh = await stack.enroll("developer", "claude");
      expect((await ask(fresh, "x")).ok).toBe(true);
    });

    it("never writes a credential into the cache, metrics or results", async () => {
      stack = await startGateway(upstream.endpoint);
      const agent = await stack.enroll("developer", "claude");
      const cache = new FileDocsCache({ directory: join(temporary, "cache") });
      const client = new DocsClient({ caller: new GatewayDocsCaller(agent), cache, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
      const result = await client.ask({ repoName: "a/b", visibility: "public", question: "x" });
      expect(JSON.stringify(result)).not.toMatch(/ctx7sk|Bearer|secret:\/\//);
      expect(JSON.stringify(stack.metrics())).not.toMatch(/ctx7sk|Bearer /);
      expect(upstream.seen.every(item => item.authorization === null)).toBe(true);
    });
  });
});

describe("DeepWiki health", () => {
  async function receipt(directory: string, status: string, ageMs = 1000) {
    await writeFile(join(directory, "setup-gateway-ready.json"), JSON.stringify({ schemaVersion: 3, definitionDigest: "d", pid: process.pid, endpoint: "http://127.0.0.1:1/mcp",
      observedAt: new Date(Date.now() - ageMs).toISOString(),
      observations: status === "missing" ? [] : [{ serviceId: DEEPWIKI_ID, status, discoveredTools: status === "ready" ? DEEPWIKI_TOOL_NAMES : [], diagnosticCode: status === "ready" ? undefined : "optional_backend_unavailable" }] }), { mode: 0o600 });
  }
  const base = (stateDirectory: string, required = false) => ({ deepwiki: { enabled: true, required }, stateDirectory, machineId: "m1", repository: undefined, env: {},
    roles: [{ role: "developer", cli: "claude" }, { role: "reviewer", cli: "codex" }, { role: "architect", cli: "agy" }, { role: "conversation", cli: "claude" }],
    grantedRoles: ["developer", "reviewer", "architect", "specifier", "planner", "qa"] });

  it("is healthy only when the Gateway lists the service ready and the read call answers", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude");
    await receipt(temporary, "ready");
    const health = await evaluateDeepWikiHealth({ ...base(temporary), deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.state).toBe("healthy");
    expect(health.checks.filter(check => check.status === "fail")).toEqual([]);
    expect(health.checks.find(check => check.id === "read_wiki_structure")).toMatchObject({ status: "pass" });
    expect(health.providers).toEqual([{ provider: "claude", granted: true, roles: ["developer"] }, { provider: "codex", granted: true, roles: ["reviewer"] }, { provider: "agy", granted: true, roles: ["architect"] }]);
    expect(health.probe.mode).toBe("agent");
  });

  it("does not call a service healthy because an HTTP endpoint answered: a registration missing a tool fails discovery", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude", { allowedTools: ["ask_wiki_question"] });
    await receipt(temporary, "ready");
    const health = await evaluateDeepWikiHealth({ ...base(temporary, true), deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.state).toBe("unavailable");
    expect(health.checks.find(check => check.id === "discovery")).toMatchObject({ status: "fail", failureKind: "protocol" });
    expect(health.checks.find(check => check.id === "service")?.status).toBe("pass");
  });

  it("is degraded, not unavailable, when an optional service cannot be reached, and tells the causes apart", async () => {
    await receipt(temporary, "blocked");
    const optional = await evaluateDeepWikiHealth(base(temporary, false));
    expect(optional.state).toBe("degraded");
    expect(optional.checks.find(check => check.id === "service")).toMatchObject({ status: "fail", failureKind: "unavailable" });
    expect(optional.checks.filter(check => check.status === "skipped").map(check => check.id)).toContain("read_wiki_structure");
    const required = await evaluateDeepWikiHealth(base(temporary, true));
    expect(required.state).toBe("unavailable");
    await rm(join(temporary, "setup-gateway-ready.json"));
    expect((await evaluateDeepWikiHealth(base(temporary))).checks.find(check => check.id === "gateway")).toMatchObject({ status: "fail" });
    await receipt(temporary, "ready", 5 * 60_000);
    expect((await evaluateDeepWikiHealth(base(temporary))).checks.find(check => check.id === "gateway")?.message).toMatch(/stale/);
    await receipt(temporary, "missing");
    expect((await evaluateDeepWikiHealth(base(temporary))).checks.find(check => check.id === "service")?.message).toMatch(/does not list/);
  });

  it("reports a rate limit as a warning with a distinct cause", async () => {
    stack = await startGateway(upstream.endpoint);
    const agent = await stack.enroll("developer", "claude");
    await receipt(temporary, "ready");
    upstream.behave({ faults: Array.from({ length: 8 }, () => ({ status: 429, headers: { "retry-after": "90" } })) });
    const health = await evaluateDeepWikiHealth({ ...base(temporary), deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.checks.find(check => check.id === "quota")).toMatchObject({ status: "warn", failureKind: "rate_limited" });
  });

  it("is disabled, and makes no call, when the repository has not enabled DeepWiki", async () => {
    const health = await evaluateDeepWikiHealth({ ...base(temporary), deepwiki: undefined });
    expect(health.state).toBe("disabled");
    expect(health.probe.mode).toBe("none");
    expect(upstream.seen).toHaveLength(0);
  });
});
