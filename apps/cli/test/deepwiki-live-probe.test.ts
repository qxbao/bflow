import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeDocsCommand } from "../src/docs-command.js";
import { parseCliArgs } from "../src/index.js";

const TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
const OFFICIAL = "https://mcp.deepwiki.com/mcp";
const now = () => new Date("2026-10-30T08:09:10.000Z");
const revision = "8d20906f65a7824e373e6fe4ed5aaf3a2448f273";

const servers: Server[] = [];
let restoreFetch: (() => void) | undefined;
afterEach(async () => {
  restoreFetch?.(); restoreFetch = undefined;
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); })));
});

/** A local stand-in for DeepWiki. Whatever it answers is fixture evidence by construction. */
async function startFixture() {
  const seen: Array<{ method: string; authorization: string | undefined; tool?: string; args?: unknown }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ method: body.method, authorization: req.headers["authorization"] as string | undefined,
        ...(body.method === "tools/call" ? { tool: body.params.name, args: body.params.arguments } : {}) });
      const sse = (result: unknown) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`); };
      if (body.method === "initialize") sse({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "DeepWiki fixture", version: "0" } });
      else if (body.method === "notifications/initialized") res.writeHead(202).end();
      else if (body.method === "tools/list") sse({ tools: TOOLS.map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) });
      else if (body.method === "tools/call") sse({ content: [{ type: "text", text: "- 1 Overview\n- 2 Reconciler" }] });
      else res.writeHead(400).end();
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

describe("DeepWiki integration", () => {
  it("live probe labels live fixture and skipped evidence", async () => {
    // Command line: the probe is its own owner-run subcommand and a live run is requested explicitly.
    const live1 = parseCliArgs(["docs", "probe", "--live", "--json"]);
    expect(live1.ok).toBe(true);
    expect((live1 as any).value).toMatchObject({ command: "docs", action: "probe", live: true, json: true });
    expect((parseCliArgs(["docs", "probe"]) as any).value).toMatchObject({ action: "probe", live: false });
    expect(parseCliArgs(["docs", "probe", "--repo", "facebook/react"]).ok).toBe(false);

    const probe = await import("../src/docs-probe.js").catch(() => ({})) as Record<string, any>;
    expect(typeof probe.runDeepWikiProbe).toBe("function");
    expect(typeof probe.formatDeepWikiProbe).toBe("function");

    // Skipped: without --live nothing is sent anywhere, and the result cannot be mistaken for evidence.
    const original = globalThis.fetch;
    let attempted = 0;
    globalThis.fetch = (async () => { attempted++; throw new Error("the network must not be touched by a skipped probe"); }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = original; };
    const skipped = await probe.runDeepWikiProbe({ now, revision });
    expect(skipped).toMatchObject({ mode: "skipped", ok: false, timestamp: "2026-10-30T08:09:10.000Z", revision, endpoint: OFFICIAL, toolsListed: [], readCall: null });
    expect(skipped.reason).toMatch(/--live/);
    expect(attempted).toBe(0);
    const skippedText = probe.formatDeepWikiProbe(skipped);
    expect(skippedText).toMatch(/mode=skipped/);
    expect(skippedText).toMatch(/not live evidence/i);
    expect(skippedText).not.toMatch(/mode=live/);
    const viaCommand = await executeDocsCommand({ command: "docs", action: "probe", live: false, json: true, help: false } as never, { cwd: process.cwd(), docs: { stateDirectory: "/nonexistent", machineId: "m1" } } as never);
    expect(viaCommand).toMatchObject({ docs: true, action: "probe", ok: false, probe: { mode: "skipped" } });

    // Fixture: the full path through the Gateway succeeds against a local server, and is labeled so. It never reads as live.
    const fixture = await startFixture();
    const fake = await probe.runDeepWikiProbe({ live: true, upstreamEndpoint: fixture.endpoint, now, revision, timeoutMs: 15_000 });
    expect(fake).toMatchObject({ mode: "fixture", ok: true, timestamp: "2026-10-30T08:09:10.000Z", revision, endpoint: fixture.endpoint,
      readCall: { tool: "read_wiki_structure", ok: true } });
    expect([...fake.toolsListed].sort()).toEqual(TOOLS);
    expect(fixture.seen.some(item => item.method === "tools/list")).toBe(true);
    expect(fixture.seen.find(item => item.method === "tools/call")).toMatchObject({ tool: "read_wiki_structure", args: { repoName: expect.stringMatching(/^[\w.-]+\/[\w.-]+$/) } });
    expect(fixture.seen.every(item => item.authorization === undefined)).toBe(true);
    const fixtureText = probe.formatDeepWikiProbe(fake);
    expect(fixtureText).toMatch(/mode=fixture/);
    expect(fixtureText).toMatch(/not live evidence/i);
    expect(fixtureText).not.toMatch(/mode=live/);

    // Live: only the fixed hosted endpoint counts. With the network refused the attempt is recorded as a failed live run, never a success.
    let refused = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://mcp.deepwiki.com/")) { refused++; throw new TypeError("fetch failed"); }
      return original(input, init);
    }) as typeof fetch;
    const live = await probe.runDeepWikiProbe({ live: true, now, revision, timeoutMs: 3000 });
    expect(refused).toBeGreaterThan(0);
    expect(live).toMatchObject({ mode: "live", ok: false, endpoint: OFFICIAL, revision, timestamp: "2026-10-30T08:09:10.000Z", readCall: null });
    expect(live.reason).toBeTruthy();
    expect(probe.formatDeepWikiProbe(live)).toMatch(/mode=live/);
    expect(probe.formatDeepWikiProbe(live)).toMatch(/failed/i);
  }, 120_000);
});
