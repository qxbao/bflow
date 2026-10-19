import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsClient } from "@bflow/docs-retrieval";
import { GatewayDocsCaller } from "../src/docs-gateway.js";
import { evaluateContext7Health } from "../src/docs-health.js";
import { startGateway } from "./helpers/context7-fixtures.js";

/**
 * REAL Context7 integration tests. They call https://mcp.context7.com/mcp through a real Gateway and the real upstream driver.
 * Off by default (network, third-party service, results drift over time):  BFLOW_TEST_LIVE_CONTEXT7=1 pnpm exec vitest run apps/cli/test/context7-live.test.ts
 * They assert structure and error classification, never a specific library ranking. They send only public library names and questions.
 * Fake-server coverage of the same behavior is in context7-integration.test.ts; passing there is not evidence about the live service.
 */
const live = process.env.BFLOW_TEST_LIVE_CONTEXT7 === "1";
const LIVE_ENDPOINT = "https://mcp.context7.com/mcp";
let stack: Awaited<ReturnType<typeof startGateway>> | undefined;
let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(join("/tmp", "bflow-c7live-")); });
afterEach(async () => { await stack?.stop(); stack = undefined; await rm(temporary, { recursive: true, force: true }); });

describe.skipIf(!live)("live Context7 through the shared Gateway", () => {
  it("discovers exactly the two documented tools, with no local backend process", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    expect(stack.ensured.ok).toBe(true);
    if (stack.ensured.ok) {
      expect(stack.ensured.value.status).toBe("ready");
      expect([...stack.ensured.value.discoveredTools].sort()).toEqual(["query-docs", "resolve-library-id"]);
      expect(stack.ensured.value.ownership).toBe("external");
    }
    expect(stack.metrics().activeProcessCount).toBe(0);
  }, 60_000);

  it("resolves a library and returns documentation for the version a project pins", async () => {
    await writeFile(join(temporary, "package.json"), JSON.stringify({ dependencies: { react: "18.2.0" } }));
    await writeFile(join(temporary, "package-lock.json"), JSON.stringify({ packages: { "node_modules/react": { version: "18.2.0" } } }));
    stack = await startGateway(LIVE_ENDPOINT);
    const agent = await stack.enroll("developer", "claude");
    const result = await new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 }).lookup({ library: "react", query: "useEffect cleanup function", projectRoot: temporary });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.requestedVersion).toBe("18.2.0");
    expect(result.versionSource).toBe("installed");
    expect(["exact", "minor", "major", "none"]).toContain(result.versionMatch);
    if (result.versionUsed) expect(result.libraryId.endsWith(`/${result.versionUsed}`)).toBe(true);
    expect(result.content.length).toBeGreaterThan(200);
    expect(result.content.toLowerCase()).toContain("effect");
  }, 90_000);

  it("serves three agents at once and does not multiply upstream sessions", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agents = await Promise.all([["developer", "claude"], ["reviewer", "codex"], ["architect", "agy"]].map(([role, provider]) => stack!.enroll(role!, provider!)));
    const results = await Promise.all(agents.map(agent => new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 }).search({ library: "react" })));
    for (const result of results) { expect(result.ok, JSON.stringify(result)).toBe(true); if (result.ok) expect(result.candidates.length).toBeGreaterThan(0); }
    expect(stack.metrics().activeProcessCount).toBe(0);
    expect(stack.metrics().perService["context7"]?.activeInstances).toBeLessThanOrEqual(1);
  }, 90_000);

  it("classifies an unknown library, an unknown library id and an undocumented version", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agent = await stack.enroll("developer", "claude");
    const client = () => new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 });
    expect(await client().lookup({ library: "zzzz-no-such-lib-qq-xyzzy", query: "x" })).toMatchObject({ ok: false, stage: "resolve", failure: { kind: "library_not_found" } });
    expect(await client().lookup({ libraryId: "/nobody/nothing-xyz", query: "x" })).toMatchObject({ ok: false, failure: { kind: "library_not_found" } });
    const version = await client().lookup({ libraryId: "/react/react", version: "v1.0.0", query: "useEffect" });
    expect(version).toMatchObject({ ok: false, failure: { kind: "version_not_found" } });
    if (!version.ok) expect(version.failure.availableVersions?.length).toBeGreaterThan(0);
  }, 120_000);

  it("reports an invalid API key as an authentication failure, not as success or as a network fault", async () => {
    stack = await startGateway(LIVE_ENDPOINT, { authenticated: true, apiKey: "ctx7sk-invalid-key-for-bflow-test-0000" });
    const agent = await stack.enroll("developer", "claude");
    const result = await new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 }).lookup({ libraryId: "/reactjs/react.dev", query: "useState" });
    expect(result).toMatchObject({ ok: false, failure: { kind: "auth_invalid", retryable: false } });
  }, 60_000);

  it("is healthy end to end, with each check passing on a real call", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agent = await stack.enroll("developer", "claude");
    await writeFile(join(temporary, "setup-gateway-ready.json"), JSON.stringify({ schemaVersion: 3, definitionDigest: "d", pid: process.pid, endpoint: stack.endpoint,
      observedAt: new Date().toISOString(), observations: [{ serviceId: "context7", status: "ready", discoveredTools: ["resolve-library-id", "query-docs"] }] }), { mode: 0o600 });
    await mkdir(join(temporary, "secrets"), { recursive: true });
    const health = await evaluateContext7Health({ context7: { enabled: true, required: true }, roles: [{ role: "developer", cli: "claude" }], grantedRoles: ["developer"],
      stateDirectory: temporary, machineId: "m1", repository: undefined, env: {}, timeoutMs: 45_000, deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.checks.filter(check => check.status === "fail"), JSON.stringify(health.checks)).toEqual([]);
    expect(health.state).toBe("healthy");
  }, 120_000);
});
