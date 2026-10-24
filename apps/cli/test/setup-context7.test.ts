import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, describe } from "vitest";
import { defaultMachineConfig, detectPlatform, defaultHostEnvironment, SetupStateStore, digest,
  type ServiceManager, type SetupContext } from "@bflow/machine-setup";
import { wrapSetupComponents, startSetupGatewayRuntime } from "../src/setup-gateway.js";
import { context7KeyFingerprint, context7KeyPath, readKeyFromStream, readStoredContext7Key, validateContext7ApiKey, writeStoredContext7Key } from "../src/context7-secret.js";
import { describeExistingContext7, detectAgyContext7, detectClaudeContext7, detectCodexContext7 } from "../src/context7-detect.js";

const KEY = "ctx7sk-0123456789abcdef-test";
let root: string;
let runtime: Awaited<ReturnType<typeof startSetupGatewayRuntime>> | undefined;
let restore: (() => void) | undefined;
// A short root keeps the control socket inside the state directory. Beyond 100 bytes the Gateway falls back to one
// shared /tmp socket, which concurrent test files (and macOS's long temporary paths) would otherwise contend for.
beforeEach(async () => { root = await realpath(await mkdtemp(join("/tmp", "bflow-c7-"))); });
afterEach(async () => { await runtime?.stop(); runtime = undefined; restore?.(); restore = undefined; await rm(root, { recursive: true, force: true }); });

/** Stands in for the hosted endpoint: only requests to mcp.context7.com are answered; everything else reaches the real fetch. */
function stubContext7(options: { requireToken?: string } = {}) {
  const seen: Array<{ method: string; authorization: string | null; accept: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://mcp.context7.com/")) return original(input, init);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ method: body.method, authorization: headers.get("authorization"), accept: headers.get("accept") });
    if (options.requireToken && headers.get("authorization") !== `Bearer ${options.requireToken}`) return new Response("denied", { status: 401 });
    const reply = (result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Context7", version: "4.4.3" } });
    if (body.method === "tools/list") return reply({ tools: ["resolve-library-id", "query-docs"].map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) });
    return reply({ content: [{ type: "text", text: "ok" }] });
  }) as typeof fetch;
  restore = () => { globalThis.fetch = original; };
  return { seen };
}

function fixture(options: { authenticated?: boolean; apiKey?: string; mode?: SetupContext["mode"]; keyFingerprint?: string | null } = {}) {
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
  const authenticated = options.authenticated ?? false;
  const input = { platform, store, config: defaultMachineConfig(), runner: { run: async () => { throw new Error("no external command expected"); } }, serviceManager,
    launchRequirements: [], remoteServices: [{ toolId: "context7" as const, authenticated,
      keyFingerprint: options.keyFingerprint !== undefined ? options.keyFingerprint : authenticated ? context7KeyFingerprint(options.apiKey ?? KEY) : null }],
    ...(options.apiKey !== undefined ? { context7ApiKey: options.apiKey } : {}) };
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
      if (!entry.isFile() || entry.parentPath.endsWith("secrets")) continue;
      texts.push(await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => ""));
    }
  }
  return texts.join("\n");
}

describe("hosted Context7 in the setup Gateway", () => {
  it("configures the remote service anonymously, with no local process, and verifies discovery through the Gateway", async () => {
    const fake = stubContext7();
    const { components, ctx, platform } = fixture();
    expect(await applyAll(components, ctx)).toEqual([]);
    for (const component of components) expect(await component.observe(ctx)).toMatchObject({ valid: true });
    const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
    const service = machine.mcpServices.find((item: { serviceId: string }) => item.serviceId === "context7");
    expect(service).toMatchObject({ connection: { kind: "native_remote_mcp", endpoint: "https://mcp.context7.com/mcp", ownership: "external" },
      authentication: { mode: "none" }, tool: { operations: ["resolve-library-id", "query-docs"], resource: { sharing: "concurrent" }, required: false } });
    expect(runtime?.observations[0]).toMatchObject({ serviceId: "context7", status: "ready", ownership: "external", discoveredTools: ["resolve-library-id", "query-docs"] });
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(fake.seen.every(item => item.authorization === null)).toBe(true);
    expect(fake.seen.every(item => item.accept?.includes("text/event-stream"))).toBe(true);
    await expect(stat(join(platform.paths.state, "secrets"))).rejects.toThrow();
  });

  it("sends the stored key to Context7 and never writes it to configuration, state or receipts", async () => {
    const fake = stubContext7({ requireToken: KEY });
    const { components, ctx, platform } = fixture({ authenticated: true, apiKey: KEY });
    expect(await applyAll(components, ctx)).toEqual([]);
    expect(runtime?.observations[0]).toMatchObject({ serviceId: "context7", status: "ready" });
    expect(fake.seen.some(item => item.authorization === `Bearer ${KEY}`)).toBe(true);
    const keyFile = context7KeyPath(platform.paths);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(platform.paths.state, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await readFile(keyFile, "utf8")).trim()).toBe(KEY);
    const text = await persistedText(platform);
    expect(text).not.toContain(KEY);
    expect(JSON.stringify(runtime?.observations)).not.toContain(KEY);
    expect(text).toContain("secret://bflow/context7/api-key");
    expect(text).toContain(context7KeyFingerprint(KEY));
  });

  it("changes the approved plan when the credential mode or the key changes", async () => {
    const digestOf = async (options: Parameters<typeof fixture>[0]) => {
      const { components, ctx } = fixture(options);
      return (await components[0]!.desired(ctx)).digest;
    };
    const anonymous = await digestOf({});
    const first = await digestOf({ authenticated: true, apiKey: KEY });
    const rotated = await digestOf({ authenticated: true, apiKey: "ctx7sk-another-key-0123456789" });
    expect(new Set([anonymous, first, rotated]).size).toBe(3);
    expect(await digestOf({ authenticated: true, apiKey: KEY })).toBe(first);
  });

  it("keeps the Gateway running and reports Context7 unavailable when the approved key is missing", async () => {
    stubContext7();
    const { components, ctx } = fixture({ authenticated: true, keyFingerprint: context7KeyFingerprint(KEY) });
    const diagnostics = await applyAll(components, ctx);
    expect(diagnostics.join(" ")).not.toContain(KEY);
    expect(runtime?.observations[0]).toMatchObject({ serviceId: "context7", status: "blocked", diagnosticCode: "optional_backend_unavailable" });
  });

  it("rotates the stored key atomically and keeps owner-only permissions", async () => {
    stubContext7();
    const { components, ctx, platform } = fixture({ authenticated: true, apiKey: KEY });
    await applyAll(components, ctx);
    await runtime?.stop(); runtime = undefined;
    const next = "ctx7sk-rotated-key-0123456789";
    const rotated = fixture({ authenticated: true, apiKey: next });
    await applyAll(rotated.components, rotated.ctx);
    expect((await readFile(context7KeyPath(platform.paths), "utf8")).trim()).toBe(next);
    expect((await stat(context7KeyPath(platform.paths))).mode & 0o777).toBe(0o600);
    expect((await readdir(join(platform.paths.state, "secrets"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps a Gateway installed before remote services existed valid, with the digest it was approved under", async () => {
    stubContext7();
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
    stubContext7();
    const { components, ctx, platform } = fixture();
    await applyAll(components, ctx);
    const privateConfig = join(platform.paths.config, "setup-gateway.json");
    const saved = JSON.parse(await readFile(privateConfig, "utf8"));
    saved.services.find((item: { serviceId: string }) => item.serviceId === "context7").connection.endpoint = "https://evil.example.com/mcp";
    await writeFile(privateConfig, JSON.stringify(saved));
    expect((await components[0]!.observe(ctx)).valid).toBe(false);
  });
});

describe("Context7 API key storage", () => {
  it("accepts only well-formed keys and never echoes a rejected one", () => {
    expect(validateContext7ApiKey(`${KEY}\n`)).toEqual({ ok: true, key: KEY });
    for (const bad of ["", "   ", "not-a-key", "ctx7sk bad space", "https://context7.com/dashboard", `ctx7sk-${"x".repeat(300)}`]) {
      const result = validateContext7ApiKey(bad);
      expect(result.ok).toBe(false);
      if (!result.ok && bad.length > 3) expect(result.reason).not.toContain(bad.trim());
    }
  });

  it("refuses a key file that is a symlink, group-readable or malformed, and reads a private one", async () => {
    const paths = { state: join(root, "state") };
    expect(await readStoredContext7Key(paths)).toEqual({ status: "absent" });
    await writeStoredContext7Key(paths, KEY);
    expect(await readStoredContext7Key(paths)).toEqual({ status: "ok", key: KEY });
    const { chmod } = await import("node:fs/promises");
    await chmod(context7KeyPath(paths), 0o640);
    expect(await readStoredContext7Key(paths)).toMatchObject({ status: "unsafe" });
    await chmod(context7KeyPath(paths), 0o600);
    await writeFile(context7KeyPath(paths), "garbage\n", { mode: 0o600 });
    expect(await readStoredContext7Key(paths)).toMatchObject({ status: "invalid" });
    const linked = { state: join(root, "linked") };
    await mkdir(join(linked.state, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "elsewhere"), `${KEY}\n`, { mode: 0o600 });
    await symlink(join(root, "elsewhere"), context7KeyPath(linked));
    expect(await readStoredContext7Key(linked)).toMatchObject({ status: "unsafe" });
  });

  it("reads a key from a stream within a size bound", async () => {
    async function* chunks(...parts: string[]) { for (const part of parts) yield Buffer.from(part); }
    expect(await readKeyFromStream(chunks("ctx7sk-", "abc"))).toBe("ctx7sk-abc");
    await expect(readKeyFromStream(chunks("x".repeat(5000)))).rejects.toThrow(/too long/);
  });
});

describe("existing Context7 registrations", () => {
  it("finds a Context7 entry in Claude, Codex and Agy configuration without modifying anything", async () => {
    const home = join(root, "home");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" }, other: { command: "x" } },
      projects: { "/p": { mcpServers: { docs: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } } } } }));
    await writeFile(join(home, ".codex", "config.toml"), '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n\n[mcp_servers.git]\ncommand = "git-mcp"\n');
    const claude = await detectClaudeContext7(home);
    expect(claude.map(item => item.name).sort()).toEqual(["context7", "docs"]);
    expect(await detectCodexContext7(join(home, ".codex"))).toEqual([{ provider: "codex", source: join(home, ".codex", "config.toml"), name: "context7" }]);
    const agy = await detectAgyContext7({ run: async () => ({ exitCode: 0, stderr: "",
      stdout: "NAME        TYPE   STATUS   COMMAND/URL\ncontext7    http   enabled  https://mcp.context7.com/mcp\ngitnexus    stdio  enabled  /bin/gitnexus mcp\n" }) });
    expect(agy).toEqual([{ provider: "agy", source: "agy mcp list", name: "context7" }]);
    const note = describeExistingContext7([...claude, ...(await detectCodexContext7(join(home, ".codex"))), ...agy]);
    expect(note).toHaveLength(1);
    expect(note[0]).toMatch(/claude \(context7, docs\).*codex \(context7\).*agy \(context7\).*untouched.*Gateway/s);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toContain("mcp.context7.com");
  });

  it("reports nothing when no provider has it, and tolerates missing or broken files and commands", async () => {
    const home = join(root, "empty");
    expect(await detectClaudeContext7(home)).toEqual([]);
    expect(await detectCodexContext7(join(home, ".codex"))).toEqual([]);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".claude.json"), "{broken");
    expect(await detectClaudeContext7(home)).toEqual([]);
    expect(await detectAgyContext7({ run: async () => { throw new Error("agy not installed"); } })).toEqual([]);
    expect(await detectAgyContext7({ run: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) })).toEqual([]);
    expect(describeExistingContext7([])).toEqual([]);
  });
});
