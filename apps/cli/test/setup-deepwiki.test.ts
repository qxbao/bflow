import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsClient } from "@bflow/docs-retrieval";
import { defaultMachineConfig, detectPlatform, defaultHostEnvironment, SetupStateStore, digest,
  type ServiceManager, type SetupContext } from "@bflow/machine-setup";
import { wrapSetupComponents, startSetupGatewayRuntime } from "../src/setup-gateway.js";
import { defaultEnvironmentConfig, identifyRepository, parseCliArgs, readEnvironmentConfig, runCli } from "../src/index.js";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "../dist/bin.js");
const LEGACY_KEY = "ctx7sk-0123456789abcdef-legacy";
const TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
let root: string;
let runtime: Awaited<ReturnType<typeof startSetupGatewayRuntime>> | undefined;
let restoreFetch: (() => void) | undefined;
let restoreEnv: (() => void) | undefined;
// A short root keeps the Gateway control socket inside the state directory.
beforeEach(async () => { root = await realpath(await mkdtemp(join("/tmp", "bflow-dw-"))); });
afterEach(async () => {
  await runtime?.stop(); runtime = undefined; restoreFetch?.(); restoreFetch = undefined; restoreEnv?.(); restoreEnv = undefined;
  await rm(root, { recursive: true, force: true });
});

/** Stands in for the hosted endpoint: only requests to mcp.deepwiki.com are answered; everything else reaches the real fetch. */
function stubDeepWiki() {
  const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://mcp.deepwiki.com/")) return original(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url, method: body.method, headers });
    const reply = (result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "DeepWiki", version: "fixture" } });
    if (body.method === "tools/list") return reply({ tools: TOOLS.map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) });
    return reply({ content: [{ type: "text", text: "ok" }] });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  return { seen };
}

function fixture() {
  const platform = { ...detectPlatform(defaultHostEnvironment()),
    paths: { config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), managedBin: join(root, "bin") } };
  const store = new SetupStateStore(platform.paths, { uid: platform.uid, now: () => new Date(), readOnly: false });
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
  const components = wrapSetupComponents([], input as never);
  const ctx: SetupContext = { platform, runner: input.runner, mode: "apply", now: () => new Date() };
  return { platform, components, ctx };
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

async function newRepository() {
  const repo = await realpath(await mkdtemp(join("/tmp", "bflow-dwrepo-")));
  execFileSync("git", ["init", "--quiet", repo]);
  return repo;
}

/** A configuration as an earlier release wrote it: a context7 block and no deepwiki block. */
async function writeLegacyConfig(repo: string, context7: Record<string, unknown>) {
  const repository = await identifyRepository(repo);
  const config = JSON.parse(JSON.stringify(defaultEnvironmentConfig(repository, "legacy", new Date("2026-10-17T00:00:00.000Z"), "claude")));
  delete config.environment.deepwiki;
  config.environment.context7 = context7;
  await mkdir(join(repo, ".bflow"), { recursive: true });
  const text = stringify(config);
  await writeFile(join(repo, ".bflow/config.yml"), text, { mode: 0o600 });
  return { repository, text, config };
}

const backups = async (repo: string) => (await readdir(join(repo, ".bflow"))).filter(name => /context7.*\.bak$/.test(name));

describe("DeepWiki integration", () => {
  it("setup replaces Context7 in setup init config and flags", async () => {
    // Flags
    const parsed = parseCliArgs(["setup", "--no-deepwiki"]);
    expect(parsed.ok && parsed.value).toMatchObject({ command: "setup", noDeepWiki: true });
    for (const retired of [["setup", "--no-context7"], ["setup", "--apply", "--context7-api-key-stdin"]]) expect(parseCliArgs(retired).ok, retired.join(" ")).toBe(false);
    const help = await runCli(["setup", "--help"]);
    expect(help.stdout).toContain("--no-deepwiki");
    expect(help.stdout).not.toMatch(/context7/i);
    expect((await runCli(["--help"])).stdout).not.toMatch(/context7/i);

    // Init and config
    const repo = await newRepository();
    try {
      expect((await runCli(["init"], { cwd: repo })).ok).toBe(true);
      const yaml = await readFile(join(repo, ".bflow/config.yml"), "utf8");
      expect(yaml).toMatch(/^ {2}deepwiki:/m);
      expect(yaml).not.toMatch(/context7/i);
      const config = await readEnvironmentConfig(await identifyRepository(repo));
      expect(config.environment).toMatchObject({ deepwiki: { enabled: true, required: false } });
      expect(config.environment).not.toHaveProperty("context7");
    } finally { await rm(repo, { recursive: true, force: true }); }

    // Setup: the Gateway is configured with the hosted service, no process, no credential, and discovers the three tools.
    const fake = stubDeepWiki();
    const { components, ctx, platform } = fixture();
    expect(await applyAll(components, ctx)).toEqual([]);
    for (const component of components) expect(await component.observe(ctx)).toMatchObject({ valid: true });
    const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
    expect(machine.mcpServices.some((item: { serviceId: string }) => item.serviceId === "context7")).toBe(false);
    expect(machine.mcpServices.find((item: { serviceId: string }) => item.serviceId === "deepwiki")).toMatchObject({
      connection: { kind: "native_remote_mcp", endpoint: "https://mcp.deepwiki.com/mcp", ownership: "external" }, authentication: { mode: "none" },
      tool: { toolId: "deepwiki", operations: TOOLS, resource: { sharing: "concurrent" }, required: false } });
    expect(runtime?.observations[0]).toMatchObject({ serviceId: "deepwiki", status: "ready", ownership: "external", discoveredTools: TOOLS });
    expect(fake.seen.length).toBeGreaterThan(0);
    await expect(stat(join(platform.paths.state, "secrets"))).rejects.toThrow();
  });

  it("migration backs up and is idempotent preserving enabled and required", async () => {
    const repo = await newRepository();
    try {
      const { repository, text } = await writeLegacyConfig(repo, { enabled: false, required: true, cache: { enabled: true, ttlSeconds: 600, allowAuthenticated: false } });
      // A legacy file stays readable before it is rewritten.
      expect((await readEnvironmentConfig(repository, text)).environment).toMatchObject({ deepwiki: { enabled: false, required: true } });

      const migration = await import("../src/deepwiki-migration.js").catch(() => ({})) as Record<string, any>;
      expect(typeof migration.migrateLegacyContext7Config).toBe("function");
      const first = await migration.migrateLegacyContext7Config(repo, { now: () => new Date("2026-10-30T01:02:03.000Z") });
      expect(first).toMatchObject({ migrated: true });
      expect(first.backupPath).toContain(".bflow/");
      expect(await readFile(first.backupPath, "utf8")).toBe(text);
      expect((await stat(first.backupPath)).mode & 0o077).toBe(0);

      const migrated = await readFile(join(repo, ".bflow/config.yml"), "utf8");
      expect(migrated).not.toMatch(/context7/i);
      expect((await readEnvironmentConfig(repository)).environment).toMatchObject({ deepwiki: { enabled: false, required: true } });
      expect(await backups(repo)).toHaveLength(1);

      // Repeating changes nothing and writes no further backup.
      const second = await migration.migrateLegacyContext7Config(repo, { now: () => new Date("2026-10-30T05:06:07.000Z") });
      expect(second).toMatchObject({ migrated: false });
      expect(await readFile(join(repo, ".bflow/config.yml"), "utf8")).toBe(migrated);
      expect(await backups(repo)).toHaveLength(1);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("setup never forwards a Context7 key or logs secrets", async () => {
    // The DeepWiki opt-out exists and the Context7 key flag does not, before any setup code runs.
    expect(parseCliArgs(["setup", "--no-deepwiki"]).ok).toBe(true);
    expect(parseCliArgs(["setup", "--apply", "--context7-api-key-stdin"]).ok).toBe(false);
    const previous = process.env.CONTEXT7_API_KEY;
    process.env.CONTEXT7_API_KEY = LEGACY_KEY;
    restoreEnv = () => { if (previous === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = previous; };

    const fake = stubDeepWiki();
    const { components, ctx, platform } = fixture();
    // A key stored by an earlier release is still on disk; it must stay unread.
    await mkdir(join(platform.paths.state, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(join(platform.paths.state, "secrets", "context7-api-key"), `${LEGACY_KEY}\n`, { mode: 0o600 });
    // Setup must accept the DeepWiki requirement; a rejected or thrown apply is a failed expectation, not a crash.
    let applyError: unknown;
    const diagnostics = await applyAll(components, ctx).catch(error => { applyError = error; return [] as string[]; });
    expect(applyError).toBeUndefined();

    expect(runtime?.observations[0]).toMatchObject({ serviceId: "deepwiki", status: "ready" });
    expect(fake.seen.length).toBeGreaterThan(0);
    for (const request of fake.seen) {
      expect(request.headers["authorization"], request.method).toBeUndefined();
      expect(JSON.stringify(request.headers)).not.toContain(LEGACY_KEY);
    }
    const everything = [diagnostics.join("\n"), await persistedText(platform), JSON.stringify(runtime?.observations)].join("\n");
    expect(everything).not.toContain(LEGACY_KEY);
    expect(everything).not.toMatch(/secret:\/\/bflow\/context7/);

    // The command line reports DeepWiki, ignores the legacy variable, and never prints a key.
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const checked = await run(process.execPath, [bin, "setup", "--check", "--json"], { env: { ...process.env, BFLOW_HOME: home, CONTEXT7_API_KEY: LEGACY_KEY }, timeout: 60_000 })
      .catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
    const notes = (JSON.parse(checked.stdout || "{}").data?.diagnostics ?? []) as string[];
    expect(notes.some(note => note.includes("https://mcp.deepwiki.com/mcp"))).toBe(true);
    expect(`${checked.stdout}${checked.stderr}`).not.toContain(LEGACY_KEY);
    expect(`${checked.stdout}${checked.stderr}`).not.toContain("mcp.context7.com");
  }, 90_000);

  it("regression covers invalid input timeout failure and repeated migration", async () => {
    // Invalid input is refused before anything leaves the machine.
    const refused = (...args: string[]) => { const result = parseCliArgs(args); expect(result.ok, args.join(" ")).toBe(false); return result.ok ? "" : result.error.message; };
    expect(refused("docs", "ask", "--repo", "not-a-repo", "--public", "--question", "x")).toMatch(/owner\/repo/);
    expect(refused("docs", "ask", "--repo", "https://github.com/acme/private", "--public", "--question", "x")).toMatch(/owner\/repo/);
    expect(refused("docs", "ask", "--repo", "facebook/react", "--question", "x")).toMatch(/--public/);
    expect(refused("docs", "ask", "--repo", "facebook/react", "--public")).toMatch(/--question/);
    expect(refused("docs", "ask", "--repo", "facebook/react", "--public", "--question", "x".repeat(2001))).toMatch(/1-2000/);

    // Timeouts and failures keep distinct, typed causes and stay retryable only when retrying can help.
    const failing = (outcome: unknown) => new DocsClient({ caller: { callTool: async () => outcome as never } });
    const input = { repoName: "facebook/react", question: "How are hooks scheduled?", visibility: "public" as const };
    expect(await failing({ ok: false, error: { code: "timeout", message: "slow", details: { kind: "timeout" } } }).ask(input))
      .toMatchObject({ ok: false, stage: "query", failure: { kind: "timeout", retryable: true } });
    expect(await failing({ ok: false, error: { code: "transport_unavailable", message: "down", details: { kind: "network" } } }).ask(input))
      .toMatchObject({ ok: false, failure: { kind: "network", retryable: true } });
    expect(await failing({ ok: true, isError: true, text: "Repository not found: facebook/react" }).ask(input))
      .toMatchObject({ ok: false, failure: { kind: "library_not_found", retryable: false } });
    expect(await failing({ ok: true, isError: false, text: "   " }).ask(input)).toMatchObject({ ok: false, failure: { kind: "no_documentation" } });

    // Repeated migration is stable, including when a stale block reappears next to an explicit deepwiki block.
    const repo = await newRepository();
    try {
      const { repository } = await writeLegacyConfig(repo, { enabled: true, required: false });
      const migrationModule = await import("../src/deepwiki-migration.js").catch(() => ({})) as Record<string, any>;
      expect(typeof migrationModule.migrateLegacyContext7Config).toBe("function");
      const { migrateLegacyContext7Config } = migrationModule;
      const at = (minute: number) => ({ now: () => new Date(Date.UTC(2026, 9, 30, 1, minute, 0)) });
      expect((await migrateLegacyContext7Config(repo, at(1))).migrated).toBe(true);
      const settled = await readFile(join(repo, ".bflow/config.yml"), "utf8");
      for (const minute of [2, 3]) expect((await migrateLegacyContext7Config(repo, at(minute))).migrated).toBe(false);
      expect(await readFile(join(repo, ".bflow/config.yml"), "utf8")).toBe(settled);
      expect(await backups(repo)).toHaveLength(1);

      const explicit = (await readEnvironmentConfig(repository)).environment as Record<string, any>;
      expect(explicit.deepwiki).toMatchObject({ enabled: true, required: false });
      const config = JSON.parse(JSON.stringify(defaultEnvironmentConfig(repository, "legacy", new Date("2026-10-17T00:00:00.000Z"), "claude")));
      config.environment.deepwiki = { enabled: false, required: true };
      config.environment.context7 = { enabled: true, required: false };
      await writeFile(join(repo, ".bflow/config.yml"), stringify(config), { mode: 0o600 });
      expect((await migrateLegacyContext7Config(repo, at(4))).migrated).toBe(true);
      expect((await readEnvironmentConfig(repository)).environment).toMatchObject({ deepwiki: { enabled: false, required: true } });
      expect((await migrateLegacyContext7Config(repo, at(5))).migrated).toBe(false);
      expect(await backups(repo)).toHaveLength(2);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
