import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsClient } from "@bflow/docs-retrieval";
import { GatewayDocsCaller } from "../src/docs-gateway.js";
import { evaluateDeepWikiHealth } from "../src/docs-health.js";
import { DEEPWIKI_ID, DEEPWIKI_TOOL_NAMES, startGateway } from "./helpers/context7-fixtures.js";

/**
 * REAL DeepWiki integration tests (file name kept from the Context7 era). They call https://mcp.deepwiki.com/mcp through a real Gateway
 * and the real upstream driver. Off by default (network, third-party service, results drift over time):
 *   BFLOW_TEST_LIVE_DEEPWIKI=1 pnpm exec vitest run apps/cli/test/context7-live.test.ts
 * They assert structure and error classification, never specific wording. They send only public repository names and short questions.
 * Fake-server coverage of the same behavior is in context7-integration.test.ts; passing there is not evidence about the live service.
 * Skipped runs are never presented as live evidence.
 */
const live = process.env.BFLOW_TEST_LIVE_DEEPWIKI === "1";
const LIVE_ENDPOINT = "https://mcp.deepwiki.com/mcp";
let stack: Awaited<ReturnType<typeof startGateway>> | undefined;
let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(join("/tmp", "bflow-dwlive-")); });
afterEach(async () => { await stack?.stop(); stack = undefined; await rm(temporary, { recursive: true, force: true }); });

describe.skipIf(!live)("live DeepWiki through the shared Gateway", () => {
  it("discovers the three documented tools, including the anyOf schema, with no local backend process", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    expect(stack.ensured.ok).toBe(true);
    if (stack.ensured.ok) {
      expect(stack.ensured.value.status).toBe("ready");
      expect(stack.ensured.value.discoveredTools).toEqual(expect.arrayContaining(DEEPWIKI_TOOL_NAMES));
      expect(stack.ensured.value.ownership).toBe("external");
    }
    expect(stack.metrics().activeProcessCount).toBe(0);
  }, 60_000);

  it("reads the wiki structure and answers a question about a public repository", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agent = await stack.enroll("developer", "claude");
    const client = new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 });
    const structure = await client.structure({ repoName: "facebook/react", visibility: "public" });
    expect(structure.ok, JSON.stringify(structure)).toBe(true);
    if (structure.ok) expect(structure.content.length).toBeGreaterThan(50);
    const answer = await client.ask({ repoName: "facebook/react", visibility: "public", question: "What does useEffect cleanup do?" });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    if (answer.ok) expect(answer.content.length).toBeGreaterThan(100);
  }, 120_000);

  it("serves three agents at once and does not multiply upstream sessions", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agents = await Promise.all([["developer", "claude"], ["reviewer", "codex"], ["architect", "agy"]].map(([role, provider]) => stack!.enroll(role!, provider!)));
    const results = await Promise.all(agents.map(agent => new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 }).structure({ repoName: "facebook/react", visibility: "public" })));
    for (const result of results) expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(stack.metrics().activeProcessCount).toBe(0);
    expect(stack.metrics().perService[DEEPWIKI_ID]?.activeInstances).toBeLessThanOrEqual(1);
  }, 90_000);

  it("classifies an unknown library name and an unindexed repository", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agent = await stack.enroll("developer", "claude");
    const client = () => new DocsClient({ caller: new GatewayDocsCaller(agent), timeoutMs: 45_000 });
    expect(await client().ask({ library: "zzzz-no-such-lib-qq-xyzzy", question: "x" })).toMatchObject({ ok: false, stage: "validate", failure: { kind: "library_not_found" } });
    const missing = await client().structure({ repoName: "nobody-bflow-test/nothing-xyz-0000", visibility: "public" });
    expect(missing.ok).toBe(false);
  }, 120_000);

  it("is healthy end to end, with each check passing on a real call", async () => {
    stack = await startGateway(LIVE_ENDPOINT);
    const agent = await stack.enroll("developer", "claude");
    await writeFile(join(temporary, "setup-gateway-ready.json"), JSON.stringify({ schemaVersion: 3, definitionDigest: "d", pid: process.pid, endpoint: stack.endpoint,
      observedAt: new Date().toISOString(), observations: [{ serviceId: DEEPWIKI_ID, status: "ready", discoveredTools: DEEPWIKI_TOOL_NAMES }] }), { mode: 0o600 });
    await mkdir(join(temporary, "secrets"), { recursive: true });
    const health = await evaluateDeepWikiHealth({ deepwiki: { enabled: true, required: true }, roles: [{ role: "developer", cli: "claude" }], grantedRoles: ["developer"],
      stateDirectory: temporary, machineId: "m1", repository: undefined, env: {}, timeoutMs: 45_000, deps: { access: async () => ({ mode: "agent", target: agent }) } });
    expect(health.checks.filter(check => check.status === "fail"), JSON.stringify(health.checks)).toEqual([]);
    expect(health.state).toBe("healthy");
  }, 120_000);
});
