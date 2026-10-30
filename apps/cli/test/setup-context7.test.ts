import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, describe } from "vitest";
import { defaultMachineConfig, detectPlatform, defaultHostEnvironment, SetupStateStore, digest,
  type ServiceManager, type SetupContext } from "@bflow/machine-setup";
import { wrapSetupComponents, startSetupGatewayRuntime } from "../src/setup-gateway.js";

// File name kept from the Context7 era: this suite carries the legacy hosted-service setup coverage over to DeepWiki, and keeps the
// guarantee that a leftover Context7 key or registration is never read, forwarded, logged or rewritten.
const LEGACY_KEY = "ctx7sk-0123456789abcdef-test";
const TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
let root: string;
let runtime: Awaited<ReturnType<typeof startSetupGatewayRuntime>> | undefined;
let restore: (() => void) | undefined;
// A short root keeps the control socket inside the state directory. Beyond 100 bytes the Gateway falls back to one
// shared /tmp socket, which concurrent test files (and macOS's long temporary paths) would otherwise contend for.
beforeEach(async () => { root = await realpath(await mkdtemp(join("/tmp", "bflow-dw-"))); });
afterEach(async () => { await runtime?.stop(); runtime = undefined; restore?.(); restore = undefined; await rm(root, { recursive: true, force: true }); });

const recordedTools = [
  { name: "ask_wiki_question", inputSchema: { properties: { repoName: { anyOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }], description: "GitHub repository or list of repositories (max 10) in owner/repo format." },
    question: { description: "The question to ask about the repository.", type: "string" } }, required: ["repoName", "question"], type: "object" }, annotations: { readOnlyHint: true } },
  { name: "read_wiki_contents", inputSchema: { properties: { repoName: { type: "string" } }, required: ["repoName"], type: "object" }, annotations: { readOnlyHint: true } },
  { name: "read_wiki_structure", inputSchema: { properties: { repoName: { type: "string" } }, required: ["repoName"], type: "object" }, annotations: { readOnlyHint: true } }
];

/** Stands in for the hosted endpoint: only requests to mcp.deepwiki.com are answered; everything else reaches the real fetch. */
function stubDeepWiki() {
  const seen: Array<{ method: string; authorization: string | null; accept: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://mcp.deepwiki.com/")) return original(input, init);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ method: body.method, authorization: headers.get("authorization"), accept: headers.get("accept") });
    const reply = (result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "DeepWiki", version: "2.14.3" } });
    if (body.method === "tools/list") return reply({ tools: recordedTools });
    return reply({ content: [{ type: "text", text: "ok" }] });
  }) as typeof fetch;
  restore = () => { globalThis.fetch = original; };
  return { seen };
}

function fixture(options: { mode?: SetupContext["mode"] } = {}) {
  const mode = options.mode ?? "apply";
  const platform = { ...detectPlatform(defaultHostEnvironment()),
    paths: { config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), managedBin: join(root, "bin") } };
  const store = new SetupStateStore(platform.paths, { uid: platform.uid, now: () => new Date(), readOnly: mode === "check" || mode === "dry_run" });
  let active = false;
  let installedDigest: string | null = null;
  const serviceManager: ServiceManager = {
    kind: "systemd-user", unitPath: id => join(root, `${id}.service`), render: def => JSON.stringify(def),
    inspect: async () => ({ installed: active, digest: installedDigest, active }),
    install: async def => { runtime = await startSetupGatewayRuntime(def.args[2]!); installedDigest = digest(JSON.stringify(def)); active = true;
      return { ownedPaths: [join(root, "mcp-gateway.service")], diagnostics: [], changed: true }; },
    listInstalled: async () => [], remove: async () => ({ ownedPaths: [], diagnostics: [] })
  };
  const input = { platform, store, config: defaultMachineConfig(), runner: { run: async () => { throw new Error("no external command expected"); } }, serviceManager,
    launchRequirements: [], remoteServices: [{ toolId: "deepwiki" as const }] };
  const components = wrapSetupComponents([], input);
  const ctx: SetupContext = { platform, runner: input.runner, mode, now: () => new Date() };
  return { platform, components, ctx, input };
}

async function applyAll(components: ReturnType<typeof fixture>["components"], ctx: SetupContext) {
  const diagnostics: string[] = [];
  for (const component of components) diagnostics.push(...(await component.apply(ctx)).diagnostics);
  return diagnostics;
}

async function persistedText(platform: ReturnType<typeof fixture>["platform"]): Promise<string> {
  const texts: string[] = [];
  for (const directory of [platform.paths.config, platform.paths.state]) {
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      texts.push(await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => ""));
    }
  }
  return texts.join("\n");
}

describe("hosted DeepWiki in the setup Gateway", () => {
  it("configures the remote service without credentials or a local process, and verifies discovery through the Gateway", async () => {
    const fake = stubDeepWiki();
    const { components, ctx, platform } = fixture();
    expect(await applyAll(components, ctx)).toEqual([]);
    for (const component of components) expect(await component.observe(ctx)).toMatchObject({ valid: true });
    const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
    const service = machine.mcpServices.find((item: { serviceId: string }) => item.serviceId === "deepwiki");
    expect(service).toMatchObject({ connection: { kind: "native_remote_mcp", endpoint: "https://mcp.deepwiki.com/mcp", ownership: "external" },
      authentication: { mode: "none" }, tool: { operations: TOOLS, resource: { sharing: "concurrent" }, required: false } });
    expect(machine.mcpServices.some((item: { serviceId: string }) => item.serviceId === "context7")).toBe(false);
    expect(runtime?.observations[0]).toMatchObject({ serviceId: "deepwiki", status: "ready", ownership: "external", discoveredTools: TOOLS });
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(fake.seen.every(item => item.authorization === null)).toBe(true);
    expect(fake.seen.every(item => item.accept?.includes("text/event-stream"))).toBe(true);
    await expect(stat(join(platform.paths.state, "secrets"))).rejects.toThrow();
  });

  it("never forwards, stores or logs a leftover Context7 key from the environment or state", async () => {
    const fake = stubDeepWiki();
    const previous = process.env.CONTEXT7_API_KEY;
    process.env.CONTEXT7_API_KEY = LEGACY_KEY;
    try {
      const { components, ctx, platform } = fixture();
      const legacyFile = join(platform.paths.state, "secrets", "context7-api-key");
      await mkdir(join(platform.paths.state, "secrets"), { recursive: true, mode: 0o700 });
      await writeFile(legacyFile, `${LEGACY_KEY}\n`, { mode: 0o600 });
      const diagnostics = await applyAll(components, ctx);
      expect(diagnostics.join(" ")).not.toContain(LEGACY_KEY);
      expect(runtime?.observations[0]).toMatchObject({ serviceId: "deepwiki", status: "ready" });
      expect(fake.seen.every(item => item.authorization === null)).toBe(true);
      expect(JSON.stringify(runtime?.observations)).not.toContain(LEGACY_KEY);
      const text = (await persistedText(platform)).split(LEGACY_KEY).length - 1;
      expect(text).toBe(1); // only the owner's own untouched legacy file still holds it
      expect((await readFile(legacyFile, "utf8")).trim()).toBe(LEGACY_KEY);
    } finally { if (previous === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = previous; }
  });

  it("keeps the approved plan stable between runs and rejects a plan for the retired service", async () => {
    const digestOf = async () => { const { components, ctx } = fixture(); return (await components[0]!.desired(ctx)).digest; };
    const first = await digestOf();
    expect(await digestOf()).toBe(first);
    const { components, ctx } = fixture();
    const legacy = wrapSetupComponents([], { ...fixture().input, remoteServices: [{ toolId: "context7", authenticated: false, keyFingerprint: null }] as never });
    expect((await legacy[0]!.desired(ctx)).digest).not.toBe((await components[0]!.desired(ctx)).digest);
  });

  it("keeps a Gateway installed before remote services existed valid, with the digest it was approved under", async () => {
    stubDeepWiki();
    const { components, ctx, platform, input } = fixture();
    const legacy = wrapSetupComponents([], { ...input, remoteServices: [] });
    expect(await applyAll(legacy, ctx)).toEqual([]);
    await runtime?.stop(); runtime = undefined;
    const privateConfig = join(platform.paths.config, "setup-gateway.json");
    const saved = JSON.parse(await readFile(privateConfig, "utf8"));
    expect(saved.approval.remoteServices).toEqual([]);
    delete saved.approval.remoteServices; // the shape written before this key existed
    await writeFile(privateConfig, JSON.stringify(saved));
    expect((await legacy[0]!.observe(ctx)).valid).toBe(true);
    runtime = await startSetupGatewayRuntime(privateConfig, saved.desiredDigest);
    expect(runtime.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(components.length).toBe(2);
  });

  it("refuses to treat a tampered remote definition as approved", async () => {
    stubDeepWiki();
    const { components, ctx, platform } = fixture();
    await applyAll(components, ctx);
    const privateConfig = join(platform.paths.config, "setup-gateway.json");
    const saved = JSON.parse(await readFile(privateConfig, "utf8"));
    saved.services.find((item: { serviceId: string }) => item.serviceId === "deepwiki").connection.endpoint = "https://evil.example.com/mcp";
    await writeFile(privateConfig, JSON.stringify(saved));
    expect((await components[0]!.observe(ctx)).valid).toBe(false);
  });

  it("treats a Gateway approved for the retired Context7 service as stale and rewrites it to DeepWiki without a key", async () => {
    stubDeepWiki();
    const { components, ctx, platform } = fixture();
    await applyAll(components, ctx);
    await runtime?.stop(); runtime = undefined;
    const privateConfig = join(platform.paths.config, "setup-gateway.json");
    const saved = JSON.parse(await readFile(privateConfig, "utf8"));
    saved.approval.remoteServices = [{ toolId: "context7", authenticated: true, keyFingerprint: "f".repeat(64) }];
    await writeFile(privateConfig, JSON.stringify(saved));
    expect((await components[0]!.observe(ctx)).valid).toBe(false);
    expect(await applyAll(components, ctx)).toEqual([]);
    const rewritten = JSON.parse(await readFile(privateConfig, "utf8"));
    expect(rewritten.approval.remoteServices).toEqual([{ toolId: "deepwiki" }]);
    expect(JSON.stringify(rewritten)).not.toMatch(/context7|keyFingerprint|f{64}/);
    for (const component of components) expect(await component.observe(ctx)).toMatchObject({ valid: true });
  });
});

describe("existing Context7 registrations", () => {
  it("leaves Context7 entries in Claude, Codex and Agy configuration untouched and says nothing about keys", async () => {
    stubDeepWiki();
    const home = join(root, "home");
    await mkdir(join(home, ".codex"), { recursive: true });
    const claude = JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: LEGACY_KEY } } } });
    const codex = '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n';
    await writeFile(join(home, ".claude.json"), claude);
    await writeFile(join(home, ".codex", "config.toml"), codex);
    const { components, ctx } = fixture();
    const diagnostics = await applyAll(components, ctx);
    expect(diagnostics.join(" ")).not.toContain(LEGACY_KEY);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(claude);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(codex);
  });

  it("tolerates missing or broken provider files while setting up DeepWiki", async () => {
    stubDeepWiki();
    const home = join(root, "empty");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".claude.json"), "{broken");
    const { components, ctx } = fixture();
    expect(await applyAll(components, ctx)).toEqual([]);
    expect(runtime?.observations[0]).toMatchObject({ serviceId: "deepwiki", status: "ready" });
  });
});
