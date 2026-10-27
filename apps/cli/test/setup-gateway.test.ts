import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultMachineConfig,
  detectPlatform,
  defaultHostEnvironment,
  SetupStateStore,
  digest,
  NodeCommandRunner,
  MachineSetupService,
  NonInteractiveApprover,
  type ServiceManager,
  type SetupContext
} from "@bflow/machine-setup";
import { wrapSetupComponents, startSetupGatewayRuntime, setupGatewayDiagnostics } from "../src/setup-gateway.js";
import {
  checkRepositoryGitNexus,
  gitNexusServiceId,
  prepareRepositoryGitNexus,
  readGatewayRepositoriesState
} from "../src/gateway-repositories.js";
import { identifyRepository, runCli } from "../src/index.js";
import { GatewayControlClient } from "@bflow/runtime";
import { MCPClientRegistrationSchema, MCPServiceDefinitionSchema, ResolvedToolGrantSchema, ScopedOperationSchema } from "@bflow/contracts";

let root: string;
let runtime: Awaited<ReturnType<typeof startSetupGatewayRuntime>> | undefined;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "bflow-gateway-setup-"))); });
afterEach(async () => {
  await runtime?.stop(); runtime = undefined;
  vi.unstubAllGlobals();
  if (process.env.BFLOW_GATEWAY_KEEP_SMOKE === "1") console.log(`Retained isolated Gateway smoke: ${root}`);
  else await rm(root, { recursive: true, force: true });
});

it("shares approved hosted Context7 across worktrees while keeping the repository GitNexus private", async () => {
  const { input, ctx, platform } = fixture();
  await installFixtureTools(["query", "context", "impact"], { executableName: "gitnexus" });
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  const actualFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (String(url) !== "https://mcp.context7.com/mcp") return actualFetch(url, options);
    const message = JSON.parse(String(options?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "hosted-docs-fixture", version: "1" } }
      : message.method === "tools/list"
        ? { tools: ["resolve-library-id", "query-docs"].map(name => ({ name, inputSchema: { type: "object" } })) }
        : { content: [{ type: "text", text: "documentation from hosted upstream" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "Content-Type": "application/json" } });
  });
  const tools = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
  // An operator service cannot become machine-shared just by claiming the same tool identity.
  const operatorService = { ...tools.createContext7RemoteService({ authenticated: false, operation: { schemaVersion: 3,
    scope: { kind: "machine", machineId: platform.machineId }, idempotencyKey: "operator-docs" } }), serviceId: "operator-context7" };
  const components = wrapSetupComponents([], { ...input, config: { ...input.config, mcpServices: [operatorService] },
    remoteServices: [{ toolId: "context7", authenticated: false, keyFingerprint: null }] });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
  const configPath = join(platform.paths.config, "setup-gateway.json");
  const savedConfig = await readFile(configPath, "utf8");

  // Register repository-scoped GitNexus for `root` via bflow init / prepareRepositoryGitNexus
  const repoReport = await prepareRepositoryGitNexus({ repository: await identifyRepository(root), platform });
  expect(repoReport.status).toBe("ready");

  const loaded = await GatewayControlClient.fromLocator(join(platform.paths.state, "gateway-control.json"));
  if (!loaded.ok) throw new Error(loaded.error.message);
  const otherRoot = join(root, "other-worktree");
  initializeGitRepository(otherRoot);
  const operation = ScopedOperationSchema.parse({ schemaVersion: 3, scope: { kind: "session", machineId: platform.machineId,
    repositoryId: "other-repo", workspaceRoot: otherRoot, sessionId: "other-runtime" }, idempotencyKey: "other-worktree" });
  const catalog = await loaded.value.inspectServices(operation);
  expect(catalog.ok).toBe(true);
  if (!catalog.ok) throw new Error(catalog.error.message);
  expect(catalog.value.map(service => service.serviceId)).toContain("context7");
  expect(catalog.value.map(service => service.serviceId)).not.toContain(repoReport.serviceId);
  const locator = JSON.parse(await readFile(join(platform.paths.state, "gateway-control.json"), "utf8"));
  const client = MCPClientRegistrationSchema.parse({ schemaVersion: 3, registrationId: "other-reviewer", provider: "codex", role: "reviewer",
    scope: operation.scope, environmentId: "other-reviewer-env", serviceIds: ["context7"], allowedTools: ["query-docs"],
    connection: { transport: "streamable_http", endpoint: locator.endpoint, token: "secret://runtime/other-reviewer" },
    configDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "other-reviewer" });
  const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "other-reviewer-context7",
    policyDigest: "b".repeat(64), toolId: "context7", kind: "native_remote_mcp", requiredness: "required",
    role: client.role, scope: operation.scope, serviceId: "context7", operations: ["query-docs"], triggers: ["external_documentation"] });
  const registered = await loaded.value.register(client, undefined, [grant]);
  expect(registered.ok).toBe(true);
  if (!registered.ok) throw new Error(registered.error.message);
  const response = await fetch(locator.endpoint, { method: "POST", headers: { Authorization: `Bearer ${registered.value.bearerToken}`,
    "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "docs", method: "tools/call",
      params: { name: "query-docs", serviceId: "context7", arguments: { query: "example" } } }) });
  expect(await response.json()).toMatchObject({ result: { status: "completed", output: [{ text: "documentation from hosted upstream" }] } });
  expect((await loaded.value.register({ ...client, registrationId: "foreign-gitnexus", idempotencyKey: "foreign-gitnexus",
    serviceIds: [repoReport.serviceId], allowedTools: ["query"] })).ok).toBe(false);
  expect((await loaded.value.register({ ...client, registrationId: "foreign-operator-docs", idempotencyKey: "foreign-operator-docs",
    serviceIds: [operatorService.serviceId] })).ok).toBe(false);
  expect((await loaded.value.revoke(client.registrationId, operation)).ok).toBe(true);
  expect(await readFile(configPath, "utf8")).toBe(savedConfig);
});

function fixture(mode: SetupContext["mode"] = "apply", options: { initialize?: boolean } = {}) {
  if (options.initialize !== false) initializeGitRepository();
  const platform = { ...detectPlatform(defaultHostEnvironment()),
    paths: { config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), managedBin: join(root, "bin") } };
  const store = new SetupStateStore(platform.paths, { uid: platform.uid, now: () => new Date(), readOnly: mode === "check" || mode === "dry_run" });
  let active = false;
  let installedDigest: string | null = null;
  const serviceManager: ServiceManager = {
    kind: "systemd-user", unitPath: id => join(root, `${id}.service`), render: def => JSON.stringify(def),
    inspect: async () => ({ installed: active, digest: installedDigest, active }),
    install: async def => {
      await runtime?.stop();
      runtime = undefined;
      runtime = await startSetupGatewayRuntime(def.args[2]!);
      installedDigest = digest(JSON.stringify(def));
      active = true;
      return { ownedPaths: [join(root, "mcp-gateway.service")], diagnostics: [], changed: true };
    },
    listInstalled: async () => [], remove: async () => ({ ownedPaths: [], diagnostics: [] })
  };
  const config = defaultMachineConfig();
  config.toolPins = [
    { schemaVersion: 3, toolId: "mempalace", installerId: "fixture", method: "verified_archive", version: "3.11.0",
      source: "https://pypi.org/project/mempalace/3.11.0/", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false },
    { schemaVersion: 3, toolId: "gitnexus", installerId: "fixture", method: "npm", version: "1.6.12",
      source: "https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false }
  ];
  const runner = { run: async () => { throw new Error("Unexpected external command during setup planning"); } };
  const ctx: SetupContext = { platform, runner, mode, now: () => new Date() };
  const input = { platform, store, config, runner, serviceManager,
    launchRequirements: [
      { toolId: "mempalace" as const, executable: join(root, "mempalace-mcp"), args: [], requirements: [] },
      { toolId: "gitnexus" as const, executable: join(root, "gitnexus"), args: ["mcp"], requirements: [] }
    ] };
  const components = wrapSetupComponents([], input);
  return { platform, store, config, components, ctx, input };
}

async function installFixtureTools(tools: string[], options: { initialize?: boolean; executableName?: string } = {}) {
  if (options.initialize !== false) initializeGitRepository();
  const executable = join(root, options.executableName ?? "mempalace-mcp");
  await writeFile(executable, `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('fixture 1.0.0'); process.exit(0); }
if (process.argv[2] === 'analyze') {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(path.join(process.cwd(), '.gitnexus'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.gitnexus', 'meta.json'), JSON.stringify({ repository: process.cwd() }));
  fs.rmSync(path.join(process.cwd(), 'stale-index'), { force: true });
  console.log(JSON.stringify({ status: 'up-to-date', repository: process.cwd() }));
  process.exit(0);
}
if (process.argv[2] === 'status') { console.log(JSON.stringify({schemaVersion:1,repository:process.cwd(),status:require('node:fs').existsSync(require('node:path').join(process.cwd(), 'stale-index')) || require('node:fs').existsSync(${JSON.stringify(join(root, "stale-index"))})?'stale':'up-to-date'})); process.exit(0); }
require('node:fs').appendFileSync(${JSON.stringify(join(root, "launch-count"))}, 'started\\n');
let pending = '';
process.stdin.on('data', chunk => { pending += chunk; while (pending.includes('\\n')) {
  const index = pending.indexOf('\\n'); const line = pending.slice(0,index); pending = pending.slice(index+1);
  if (!line.trim()) continue; const message=JSON.parse(line); if (message.id === undefined) continue;
  if (require('node:fs').existsSync(${JSON.stringify(join(root, "hang"))})) continue;
  const result=message.method==='initialize' ? { protocolVersion:'2025-11-25', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'} }
    : message.method==='tools/list' ? {tools:${JSON.stringify(tools)}.map(name=>({name,inputSchema:{type:'object'}}))} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, result})+'\\n');
}});
`);
  await chmod(executable, 0o700);
}

function initializeGitRepository(directory = root) {
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "-c", "user.name=Gateway Test", "-c", "user.email=gateway@example.test", "commit", "--quiet", "--allow-empty", "-m", "Gateway fixture"]);
}

it("plans gateway and managed MCP setup without installing tools or creating state", async () => {
  const { components, ctx } = fixture("dry_run");
  expect(components.map(item => item.componentId)).toEqual(["mcp-config", "services"]);
  for (const component of components) {
    expect((await component.desired(ctx)).targets.length).toBeGreaterThan(0);
    expect((await component.observe(ctx)).stateDigest).toBeNull();
    expect((await component.apply(ctx)).ownedPaths).toEqual([]);
  }
  expect((await readdir(root)).filter(entry => entry !== ".git")).toEqual([]);
});

it("configures machine services after installation and verifies actual MCP negotiation and tools through the gateway", async () => {
  const { components, ctx, platform, input } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) {
    expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect(await component.observe(ctx)).toMatchObject({ valid: true, stateDigest: (await component.desired(ctx)).digest });
  }
  const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  expect(machine.mcpServices[0].tool.operations).toEqual(["mempalace_search"]);
  expect(JSON.stringify(machine)).not.toContain('"token"');
  expect(runtime?.observations[0]).toMatchObject({ status: "ready", protocolVersion: "2025-11-25", discoveredTools: ["mempalace_status", "mempalace_search"] });
  const repeated = wrapSetupComponents([], { ...input, config: machine });
  expect((await repeated[0]!.desired(ctx)).digest).toBe((await components[0]!.desired(ctx)).digest);
  expect((await repeated[0]!.observe(ctx)).valid).toBe(true);
  const privateConfig = join(platform.paths.config, "setup-gateway.json");
  const saved = JSON.parse(await readFile(privateConfig, "utf8"));
  saved.services[0].connection.argv.push("tampered");
  await writeFile(privateConfig, JSON.stringify(saved));
  expect((await components[0]!.observe(ctx)).valid).toBe(false);
});

it("fails the service postcheck when a real upstream omits required tools", async () => {
  const { components, ctx } = fixture();
  await installFixtureTools(["mempalace_status"]);
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  const applied = await components[1]!.apply(ctx);
  expect(applied.diagnostics.join(" ")).toMatch(/required|ready|tools/i);
  expect((await components[1]!.observe(ctx)).valid).toBe(false);
});

it("produces the exact same valid setup check across different directories and emits init guidance when --dir is passed", async () => {
  const { components, ctx, input, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
  const configPath = join(platform.paths.config, "setup-gateway.json");
  const savedBytes = await readFile(configPath, "utf8");
  const savedJson = JSON.parse(savedBytes);
  expect(savedJson.operation.scope).toEqual({ kind: "machine", machineId: platform.machineId });
  expect(savedJson.operation.scope.workspaceRoot).toBeUndefined();

  const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  const otherRepository = join(root, "other-repository");
  await mkdir(otherRepository);
  initializeGitRepository(otherRepository);

  const checkInRepoA = wrapSetupComponents([], { ...input, config: machine });
  const checkInRepoB = wrapSetupComponents([], { ...input, config: machine, repositoryRoot: otherRepository });

  for (let i = 0; i < checkInRepoA.length; i++) {
    const obsA = await checkInRepoA[i]!.observe({ ...ctx, mode: "check" });
    const obsB = await checkInRepoB[i]!.observe({ ...ctx, mode: "check" });
    expect(obsA.valid).toBe(true);
    expect(obsB.valid).toBe(true);
    expect(obsA.stateDigest).toBe(obsB.stateDigest);
    expect((await checkInRepoA[i]!.desired(ctx)).digest).toBe((await checkInRepoB[i]!.desired(ctx)).digest);
  }
  expect(setupGatewayDiagnostics({ ...input, repositoryRoot: otherRepository }).join(" ")).toContain("bflow init");
  expect(await readFile(configPath, "utf8")).toBe(savedBytes);
});

it("identifies newly selected MCP services as a setup plan change", async () => {
  const { input, ctx, platform } = fixture();
  const baseInput = { ...input, launchRequirements: [] };
  const components = wrapSetupComponents([], baseInput);
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  const configPath = join(platform.paths.config, "setup-gateway.json");
  const savedBytes = await readFile(configPath, "utf8");
  const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  const changed = wrapSetupComponents([], { ...input, config: machine,
    remoteServices: [{ toolId: "context7", authenticated: false, keyFingerprint: null }] });

  const observed = await changed[0]!.observe({ ...ctx, mode: "check" });
  expect(observed.valid).toBe(false);
  expect(observed.diagnostics.join(" ")).toContain("managed MCP services changed (added: context7, mempalace; removed: none)");
  expect(observed.diagnostics.join(" ")).toContain("bflow setup");
  expect(await readFile(configPath, "utf8")).toBe(savedBytes);
  expect(runtime).toBeUndefined();
});

it("retains registered repository GitNexus services and reader locks across Gateway restarts and setup updates", async () => {
  const { input, ctx, platform } = fixture();
  await installFixtureTools(["query", "context", "impact"], { executableName: "gitnexus" });
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  const withoutMempalace = wrapSetupComponents([], { ...input, launchRequirements: input.launchRequirements.filter(item => item.toolId === "gitnexus") });
  for (const component of withoutMempalace) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  const repoReport = await prepareRepositoryGitNexus({ repository: await identifyRepository(root), platform });
  expect(repoReport.status).toBe("ready");
  const lock = join(platform.paths.state, "gitnexus", `gitnexus-storage-${createHash("sha256").update(root).digest("hex")}.lock`);
  const reader = JSON.parse(await readFile(lock, "utf8")) as { pid: number };
  expect(reader.pid).toBeGreaterThan(0);

  const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  const updated = wrapSetupComponents([], { ...input, config: machine });
  expect((await updated[0]!.apply(ctx)).diagnostics).toEqual([]);
  expect((await updated[0]!.observe(ctx)).valid).toBe(true);
  expect((await updated[1]!.apply(ctx)).diagnostics).toEqual([]);
  expect((await updated[1]!.observe(ctx)).valid).toBe(true);
  const reloadedReader = JSON.parse(await readFile(lock, "utf8")) as { pid: number };
  expect(reloadedReader.pid).toBeGreaterThan(0);
  expect(runtime?.observations.map(item => item.serviceId)).toContain(repoReport.serviceId);
  expect(runtime?.observations.some(item => item.serviceId.startsWith("mempalace-"))).toBe(true);
});

it("does not configure a missing managed executable or record it as ready", async () => {
  const { components, ctx, platform } = fixture();
  expect((await components[0]!.apply(ctx)).diagnostics.length).toBeGreaterThan(0);
  await expect(readFile(join(platform.paths.config, "machine.json"))).rejects.toThrow();
});

it("starts the machine Gateway outside a repository and explicitly defers repository-scoped GitNexus activation to bflow init", async () => {
  const { input, ctx } = fixture();
  const outsideRepository = {
    ...input,
    launchRequirements: [{ toolId: "gitnexus" as const, executable: join(root, "gitnexus"), args: ["mcp"], requirements: [] }]
  };
  const components = wrapSetupComponents([], outsideRepository);
  for (const component of components) {
    expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect((await component.observe(ctx)).valid).toBe(true);
  }
  expect(runtime?.observations).toEqual([]);
  expect(setupGatewayDiagnostics(outsideRepository).join(" ")).toMatch(/GitNexus.*deferred.*bflow init/);
});

it("preserves an unowned existing gateway user service", async () => {
  const { input, ctx } = fixture();
  const components = wrapSetupComponents([], { ...input, launchRequirements: [] });
  const unitPath = input.serviceManager.unitPath("mcp-gateway");
  await writeFile(unitPath, "[Service]\nExecStart=/operator-owned/worker\n");
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  expect((await components[1]!.apply(ctx)).diagnostics.join(" ")).toMatch(/unowned/i);
  expect(runtime).toBeUndefined();
  expect(await readFile(unitPath, "utf8")).toContain("/operator-owned/worker");
});

it.each(["argv", "environment", "cwd", "lockPath", "owner", "profile"])("rejects a self-checksummed Chrome spec with changed %s", async field => {
  const { input, ctx, platform } = fixture();
  await installFixtureTools(["list_pages", "new_page", "navigate_page"], { executableName: "chrome-mcp" });
  await mkdir(join(root, "bin"));
  const browser = join(root, "bin", "google-chrome");
  await writeFile(browser, `#!${process.execPath}\nconsole.log('Google Chrome 152.0.0.0');\n`);
  await chmod(browser, 0o700);
  const chromeInput = { ...input, platform: { ...platform, pathEntries: [join(root, "bin")] },
    config: { ...input.config, toolPins: [{ ...input.config.toolPins[0]!, toolId: "chrome-devtools-mcp", version: "1.11.0" }] },
    runner: new NodeCommandRunner(), launchRequirements: [{ toolId: "chrome-devtools-mcp" as const,
      executable: join(root, "chrome-mcp"), args: ["--no-usage-statistics", "--no-performance-crux"], requirements: [] }] };
  const [component] = wrapSetupComponents([], chromeInput);
  expect((await component!.apply(ctx)).diagnostics).toEqual([]);
  const file = join(platform.paths.config, "setup-gateway.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const definition = saved.services[0];
  const specFile = definition.connection.argv[1];
  const spec = JSON.parse(await readFile(specFile, "utf8"));
  if (field === "argv") spec.argv.push("--no-sandbox");
  if (field === "environment") spec.environment.NODE_OPTIONS = "--trace-warnings";
  if (field === "cwd") spec.cwd = root;
  if (field === "lockPath") spec.lockPath = join(root, "unapproved.lock");
  if (field === "owner") spec.browserOwner.taskId = "another-task";
  if (field === "profile") spec.argv[spec.argv.indexOf("--userDataDir") + 1] = join(root, "personal-chrome");
  await writeFile(specFile, JSON.stringify(spec));
  definition.connection.argv[2] = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
  saved.definitionDigest = digest(saved.services);
  await writeFile(file, JSON.stringify(saved));
  const machineFile = join(platform.paths.config, "machine.json");
  const machine = JSON.parse(await readFile(machineFile, "utf8")); machine.mcpServices = saved.services;
  await writeFile(machineFile, JSON.stringify(machine));
  const mcpFile = join(platform.paths.config, "mcp.json");
  const mcp = JSON.parse(await readFile(mcpFile, "utf8")); mcp.services[definition.serviceId] = definition;
  await writeFile(mcpFile, JSON.stringify(mcp));
  expect((await component!.observe(ctx)).valid).toBe(false);
  await expect(startSetupGatewayRuntime(file, saved.desiredDigest).then(value => { runtime = value; return value; }))
    .rejects.toThrow(/canonical|approved/);
});

it("invalidates readiness when the current backend stops answering after startup", async () => {
  const { components, ctx } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
  await writeFile(join(root, "hang"), "hang");
  await vi.waitFor(async () => expect((await components[1]!.observe(ctx)).valid).toBe(false), { timeout: 18_000, interval: 500 });
  expect((await readFile(join(root, "launch-count"), "utf8")).trim().split("\n")).toHaveLength(1);
}, 25_000);

it("registers multiple repositories concurrently via bflow init, reloads them on Gateway restart, skips deleted repos, and supports bflow init --remove", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await mkdir(repoA); await mkdir(repoB);
  initializeGitRepository(repoA);
  initializeGitRepository(repoB);

  const initA = await runCli(["init", "--yes", "--json"], { cwd: repoA, setup: { platform } });
  const initB = await runCli(["init", "--yes", "--json"], { cwd: repoB, setup: { platform } });
  expect(initA.exitCode).toBe(0);
  expect(initB.exitCode).toBe(0);

  const dataA = JSON.parse(initA.stdout).data;
  const dataB = JSON.parse(initB.stdout).data;
  expect(dataA.gitnexus).toMatchObject({ status: "ready", serviceId: gitNexusServiceId(repoA), indexed: true, registered: true, gatewayReady: true });
  expect(dataB.gitnexus).toMatchObject({ status: "ready", serviceId: gitNexusServiceId(repoB), indexed: true, registered: true, gatewayReady: true });

  // Both services are simultaneously active in gateway-repositories.json and on the running Gateway
  const persisted = await readGatewayRepositoriesState(platform.paths.state, platform.machineId);
  expect(persisted.status).toBe("valid");
  expect(persisted.state?.repositories.map(item => item.service.serviceId).sort()).toEqual(
    [gitNexusServiceId(repoA), gitNexusServiceId(repoB)].sort()
  );
  expect(runtime?.observations.map(item => item.serviceId)).toEqual(
    expect.arrayContaining([gitNexusServiceId(repoA), gitNexusServiceId(repoB)])
  );

  // bflow init --check succeeds for both repositories
  const checkA = await runCli(["init", "--check", "--json"], { cwd: repoA, setup: { platform } });
  const checkB = await runCli(["init", "--check", "--json"], { cwd: repoB, setup: { platform } });
  expect(checkA.exitCode).toBe(0);
  expect(checkB.exitCode).toBe(0);

  // Restart Gateway -> reloads both repoA and repoB
  const gatewayConfigPath = join(platform.paths.config, "setup-gateway.json");
  await runtime?.stop();
  runtime = await startSetupGatewayRuntime(gatewayConfigPath);
  expect(runtime.observations.map(item => item.serviceId)).toEqual(
    expect.arrayContaining([gitNexusServiceId(repoA), gitNexusServiceId(repoB)])
  );

  // Remove repoA via `bflow init --remove` -> repoA is removed while repoB stays active
  const removeA = await runCli(["init", "--remove", "--json"], { cwd: repoA, setup: { platform } });
  expect(removeA.exitCode).toBe(0);
  expect(JSON.parse(removeA.stdout).data.gitnexus.status).toBe("removed");
  expect(runtime.observations.map(item => item.serviceId)).not.toContain(gitNexusServiceId(repoA));
  expect(runtime.observations.map(item => item.serviceId)).toContain(gitNexusServiceId(repoB));

  // Re-init repoA, then delete repoB directory from disk and restart Gateway -> Gateway skips deleted repoB without failing
  expect((await runCli(["init", "--yes", "--json"], { cwd: repoA, setup: { platform } })).exitCode).toBe(0);
  await rm(repoB, { recursive: true, force: true });
  await runtime.stop();
  runtime = await startSetupGatewayRuntime(gatewayConfigPath);
  expect(runtime.observations.map(item => item.serviceId)).toContain(gitNexusServiceId(repoA));
  expect(runtime.observations.map(item => item.serviceId)).not.toContain(gitNexusServiceId(repoB));
  // A deleted repository is pruned from persisted state instead of being retried on every restart.
  const pruned = await readGatewayRepositoriesState(platform.paths.state, platform.machineId);
  expect(pruned.state?.repositories.map(item => item.service.serviceId)).toEqual([gitNexusServiceId(repoA)]);

  // A repository deleted while the Gateway runs can still be unregistered by its former path.
  const repoC = join(root, "repo-c");
  await mkdir(repoC);
  initializeGitRepository(repoC);
  expect(JSON.parse((await runCli(["init", "--yes", "--json"], { cwd: repoC, setup: { platform } })).stdout).data.gitnexus.status).toBe("ready");
  await rm(repoC, { recursive: true, force: true });
  const removeC = await runCli(["init", "--remove", "--dir", repoC, "--json"], { cwd: root, setup: { platform } });
  expect(removeC.exitCode).toBe(0);
  expect(JSON.parse(removeC.stdout).data.gitnexus.status).toBe("removed");
  expect(runtime.observations.map(item => item.serviceId)).not.toContain(gitNexusServiceId(repoC));
  expect((await readGatewayRepositoriesState(platform.paths.state, platform.machineId)).state?.repositories
    .map(item => item.service.serviceId)).toEqual([gitNexusServiceId(repoA)]);
});

it("asks before the first GitNexus index, skips unapproved indexing and does not ask again for a registered repository", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  const declined = await runCli(["init", "--json"], { cwd: root, setup: { platform } });
  expect(declined.exitCode).toBe(0);
  const declinedData = JSON.parse(declined.stdout).data;
  expect(declinedData.gitnexus.status).toBe("skipped");
  expect(declinedData.diagnostics.join(" ")).toContain("--accept-gitnexus-license");
  expect(await readdir(root)).not.toContain(".gitnexus");
  expect(await readFile(join(root, ".bflow", "config.yml"), "utf8")).toContain("schemaVersion");

  const prompts: string[] = [];
  const approved = await runCli(["init", "--json"], { cwd: root, setup: { platform, confirm: async prompt => { prompts.push(prompt); return true; } } });
  expect(JSON.parse(approved.stdout).data.gitnexus.status).toBe("ready");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("PolyForm-Noncommercial");

  const repeated = await runCli(["init", "--json"], { cwd: root, setup: { platform, confirm: async prompt => { prompts.push(prompt); return false; } } });
  expect(JSON.parse(repeated.stdout).data.gitnexus.status).toBe("ready");
  expect(prompts).toHaveLength(1);
});

it("accepts the GitNexus license with --accept-gitnexus-license without overwriting customized configuration", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  const created = await runCli(["init", "--no-gitnexus", "--provider", "claude", "--json"], { cwd: root, setup: { platform } });
  expect(created.exitCode).toBe(0);
  const configPath = join(root, ".bflow", "config.yml");
  const customized = `${await readFile(configPath, "utf8")}# customized by operator\n`;
  await writeFile(configPath, customized, "utf8");

  const accepted = await runCli(["init", "--accept-gitnexus-license", "--json"], { cwd: root, setup: { platform } });
  expect(accepted.exitCode).toBe(0);
  expect(JSON.parse(accepted.stdout).data.gitnexus.status).toBe("ready");
  expect(await readFile(configPath, "utf8")).toBe(customized);
});

it("keeps the written repository configuration and reports GitNexus as blocked when registration fails", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
  await writeFile(join(platform.paths.state, "gateway-repositories.json"), "{}\n", { mode: 0o600 });

  const result = await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.gitnexus).toMatchObject({ status: "blocked", registered: false, gatewayReady: false });
  expect(data.diagnostics.join(" ")).toContain("GitNexus repository preparation failed");
  expect(await readFile(join(root, ".bflow", "config.yml"), "utf8")).toContain("schemaVersion");
});

it("observes stale repository indexes in bflow init --check without rerunning analysis or rewriting state", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  expect((await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } })).exitCode).toBe(0);
  const reposFile = join(platform.paths.state, "gateway-repositories.json");
  const before = await readFile(reposFile, "utf8");
  await writeFile(join(root, "stale-index"), "stale");

  const checkRes = await runCli(["init", "--check", "--json"], { cwd: root, setup: { platform } });
  expect(checkRes.exitCode).toBe(1);
  expect(JSON.parse(checkRes.stdout).data.gitnexus.status).toBe("stale");
  // Machine setup check remains valid even when a repository index is stale
  expect((await components[0]!.observe({ ...ctx, mode: "check" })).valid).toBe(true);
  expect(await readFile(reposFile, "utf8")).toBe(before);

  const refreshRes = await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(refreshRes.exitCode).toBe(0);
  expect(JSON.parse(refreshRes.stdout).data.gitnexus.status).toBe("ready");
});

it("uses canonical repository identity for symlinked init paths", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  const alias = join(root, "repo-alias");
  await symlink(root, alias);
  const initRes = await runCli(["init", "--dir", alias, "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(initRes.exitCode).toBe(0);
  const persisted = await readGatewayRepositoriesState(platform.paths.state, platform.machineId);
  expect(persisted.state?.repositories[0]?.workspaceRoot).toBe(root);
});

it("migrates a legacy session-scoped setup-gateway.json to machine scope on bflow setup while backing up the old file", async () => {
  const { input, ctx, platform } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });

  // Simulate legacy session-scoped setup-gateway.json + machine.json + mcp.json bound to `root`
  await mkdir(platform.paths.config, { recursive: true });
  await mkdir(platform.paths.state, { recursive: true });
  const legacyGitnexusId = gitNexusServiceId(root);
  const legacyGitnexusService = MCPServiceDefinitionSchema.parse({
    schemaVersion: 3,
    serviceId: legacyGitnexusId,
    revision: 1,
    scope: { kind: "session", machineId: platform.machineId, repositoryId: "legacy-repo", workspaceRoot: root, sessionId: "setup-gateway-probe" },
    tool: {
      schemaVersion: 3,
      toolId: "gitnexus",
      kind: "stdio_mcp",
      version: "1.6.12",
      required: true,
      operations: ["query", "context", "impact"],
      resource: { sharing: "exclusive", resourceKey: legacyGitnexusId }
    },
    connection: {
      kind: "stdio_mcp",
      executable: process.execPath,
      executableDigest: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
      argv: ["mcp"],
      environmentBindings: {},
      ownership: "bflow",
      bridgeRequired: true
    },
    authentication: { mode: "none" },
    healthTimeoutMs: 15_000,
    idleTimeoutMs: 60_000,
    restartLimit: 2
  });
  const legacyConfig = {
    schemaVersion: 3,
    desiredDigest: "c".repeat(64),
    definitionDigest: digest([legacyGitnexusService]),
    operation: {
      schemaVersion: 3,
      scope: { kind: "session", machineId: platform.machineId, repositoryId: "legacy-repo", workspaceRoot: root, sessionId: "setup-gateway-probe" },
      idempotencyKey: "legacy-setup"
    },
    paths: platform.paths,
    receiptPath: join(platform.paths.state, "setup-gateway-ready.json"),
    generatedIds: [legacyGitnexusId],
    services: [legacyGitnexusService]
  };
  const gatewayConfigPath = join(platform.paths.config, "setup-gateway.json");
  await writeFile(gatewayConfigPath, JSON.stringify(legacyConfig, null, 2), { mode: 0o600 });
  const machineWithLegacy = { ...input.config, mcpServices: [legacyGitnexusService] };
  await writeFile(join(platform.paths.config, "machine.json"), JSON.stringify(machineWithLegacy, null, 2), { mode: 0o600 });

  const components = wrapSetupComponents([], { ...input, config: machineWithLegacy });
  // 1. `setup --check` clearly reports that `bflow setup` is needed to migrate to machine scope
  const checkObs = await components[0]!.observe({ ...ctx, mode: "check" });
  expect(checkObs.valid).toBe(false);
  expect(checkObs.diagnostics.join(" ")).toContain("legacy session scope");
  expect(checkObs.diagnostics.join(" ")).toContain("bflow setup");
  expect(checkObs.diagnostics.join(" ")).toContain("bflow init");
  expect(setupGatewayDiagnostics({ ...input, config: machineWithLegacy }).join(" ")).toContain("Legacy session-scoped Gateway configuration detected");

  // 2. `setup --apply` migrates to machine scope, backs up old file, preserves mempalace, and removes legacy gitnexus from machine.json/mcp.json
  const mcpApplied = await components[0]!.apply(ctx);
  expect(mcpApplied.diagnostics.join(" ")).toContain("Migrated legacy session-scoped Gateway configuration");
  expect(mcpApplied.diagnostics.join(" ")).toContain("bflow init");
  expect((await components[1]!.apply(ctx)).diagnostics).toEqual([]);
  const migratedGateway = JSON.parse(await readFile(gatewayConfigPath, "utf8"));
  expect(migratedGateway.operation.scope).toEqual({ kind: "machine", machineId: platform.machineId });
  expect(migratedGateway.services.some((s: { tool: { toolId: string } }) => s.tool.toolId === "mempalace")).toBe(true);
  expect(migratedGateway.services.some((s: { tool: { toolId: string } }) => s.tool.toolId === "gitnexus")).toBe(false);

  const migratedMachine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  expect(migratedMachine.mcpServices.some((s: { tool: { toolId: string } }) => s.tool.toolId === "gitnexus")).toBe(false);
  expect(migratedMachine.mcpServices.some((s: { tool: { toolId: string } }) => s.tool.toolId === "mempalace")).toBe(true);

  const backupIndex = await readFile(join(platform.paths.state, "backups", "index.jsonl"), "utf8");
  expect(backupIndex).toContain("setup-gateway.json");
});

it("writes .bflow/config.yml and emits clear diagnostics when bflow init runs before bflow setup or when Gateway is not running", async () => {
  const { platform, input, ctx } = fixture();
  // Case A: before bflow setup (no machine.json / gitnexus binary)
  const beforeSetup = await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(beforeSetup.exitCode).toBe(0);
  const beforeData = JSON.parse(beforeSetup.stdout).data;
  expect(beforeData.gitnexus.status).toBe("missing");
  expect(beforeData.diagnostics.join(" ")).toContain("bflow setup");

  // Case B: machine.json and gitnexus binary exist, but Gateway is not running
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  const mcpOnly = wrapSetupComponents([], { ...input, launchRequirements: input.launchRequirements.filter(item => item.toolId === "gitnexus") });
  expect((await mcpOnly[0]!.apply(ctx)).diagnostics).toEqual([]);
  const gatewayStopped = await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(gatewayStopped.exitCode).toBe(0);
  const stoppedData = JSON.parse(gatewayStopped.stdout).data;
  expect(stoppedData.gitnexus.indexed).toBe(true);
  expect(stoppedData.gitnexus.registered).toBe(true);
  expect(stoppedData.gitnexus.gatewayReady).toBe(false);
  expect(stoppedData.diagnostics.join(" ")).toContain("bflow setup");
});

it("keeps required services ready when an optional external backend is offline", async () => {
  const { input, ctx } = fixture();
  await installFixtureTools(["mempalace_status", "mempalace_search"]);
  const external = createServer((_request, response) => { response.writeHead(503); response.end("offline"); });
  await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
  const address = external.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  try {
    const optional = { schemaVersion: 3 as const, serviceId: "optional-external", revision: 1,
      scope: { kind: "machine" as const, machineId: input.platform.machineId },
      tool: { schemaVersion: 3 as const, toolId: "optional", kind: "native_remote_mcp" as const, version: "1", required: false,
        operations: ["optional_tool"], resource: { sharing: "concurrent" as const, maxConcurrency: 1 } },
      connection: { kind: "native_remote_mcp" as const, endpoint: `http://127.0.0.1:${address.port}/mcp`, ownership: "external" as const },
      authentication: { mode: "none" as const }, healthTimeoutMs: 100, idleTimeoutMs: 1000, restartLimit: 0 };
    const components = wrapSetupComponents([], { ...input, config: { ...input.config, mcpServices: [optional] } });
    for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect((await components[1]!.observe(ctx)).valid).toBe(true);
    expect(runtime?.observations.find(item => item.serviceId === optional.serviceId)?.status).toBe("blocked");
  } finally { await new Promise<void>((resolve, reject) => external.close(error => error ? reject(error) : resolve())); }
});

it("invalidates a required HTTP backend when it stops answering protocol requests", async () => {
  const { input, ctx } = fixture();
  let hanging = false;
  let initializations = 0;
  const external = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const rpc = JSON.parse(body);
      if (rpc.method === "initialize") initializations++;
      if (hanging) return;
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "http-health", version: "1" } }
        : { tools: [{ name: "health_tool", inputSchema: { type: "object" } }] };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });
  await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
  const address = external.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  try {
    const required = { schemaVersion: 3 as const, serviceId: "required-http", revision: 1,
      scope: { kind: "machine" as const, machineId: input.platform.machineId },
      tool: { schemaVersion: 3 as const, toolId: "required-http", kind: "native_remote_mcp" as const, version: "1", required: true,
        operations: ["health_tool"], resource: { sharing: "concurrent" as const, maxConcurrency: 1 } },
      connection: { kind: "native_remote_mcp" as const, endpoint: `http://127.0.0.1:${address.port}/mcp`, ownership: "external" as const },
      authentication: { mode: "none" as const }, healthTimeoutMs: 500, idleTimeoutMs: 1000, restartLimit: 0 };
    const components = wrapSetupComponents([], { ...input, launchRequirements: [], config: { ...input.config, mcpServices: [required] } });
    for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
    hanging = true;
    await vi.waitFor(async () => expect((await components[1]!.observe(ctx)).valid).toBe(false), { timeout: 13_000, interval: 200 });
    expect(initializations).toBe(1);
  } finally {
    external.closeAllConnections();
    await new Promise<void>((resolve, reject) => external.close(error => error ? reject(error) : resolve()));
  }
}, 20_000);

it.runIf(Boolean(process.env.BFLOW_GATEWAY_LIVE_TOOL_ROOT))("verifies installed real GitNexus and Chrome MCP through an isolated Gateway", async () => {
  const toolRoot = process.env.BFLOW_GATEWAY_LIVE_TOOL_ROOT!;
  const { input, ctx } = fixture();
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot);
  initializeGitRepository(repositoryRoot);
  await writeFile(join(repositoryRoot, "example.ts"), "export function greeting(name: string) { return `Hello ${name}`; }\n");
  execFileSync("git", ["-C", repositoryRoot, "add", "example.ts"]);
  execFileSync("git", ["-C", repositoryRoot, "-c", "user.name=Gateway Test", "-c", "user.email=gateway@example.test", "commit", "--quiet", "-m", "Sample code for the actual index probe"]);
  const platform = process.env.BFLOW_GATEWAY_LIVE_DATA_ROOT
    ? { ...input.platform, paths: { ...input.platform.paths, data: join(process.env.BFLOW_GATEWAY_LIVE_DATA_ROOT, root.split("/").at(-1)!) } }
    : input.platform;
  const store = new SetupStateStore(platform.paths, { uid: platform.uid, now: () => new Date() });
  const config = { ...input.config, toolPins: [...input.config.toolPins, { schemaVersion: 3 as const, toolId: "chrome-devtools-mcp",
    installerId: "fixture", method: "npm" as const, version: "1.11.0", source: "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.11.0.tgz",
    integrity: "a".repeat(64), platforms: ["linux" as const], requiresElevation: false }] };
  const components = wrapSetupComponents([], { ...input, platform, store, config, runner: new NodeCommandRunner(), launchRequirements: [
    { toolId: "gitnexus", executable: join(toolRoot, "gitnexus/node_modules/.bin/gitnexus"), args: ["mcp"], requirements: [] },
    { toolId: "chrome-devtools-mcp", executable: join(toolRoot, "chrome-devtools-mcp/node_modules/.bin/chrome-devtools-mcp"),
      args: ["--no-usage-statistics", "--no-performance-crux"], requirements: [] }
  ] });
  for (const component of components) {
    expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect((await component.observe(ctx)).valid).toBe(true);
  }
  const repoReport = await prepareRepositoryGitNexus({ repository: await identifyRepository(repositoryRoot), platform });
  expect(repoReport.status).toBe("ready");
  expect(runtime?.observations).toHaveLength(2);
  console.log(JSON.stringify({ gateway: runtime?.endpoint, observations: runtime?.observations }, null, 2));
}, 150_000);

it("composes the full setup service without overwriting generated gateway config", async () => {
  const { input, platform } = fixture();
  const account = { ...platform, homeDir: root, shell: "bash" as const, pathEntries: [join(root, "fixtures")] };
  await mkdir(account.pathEntries[0]!);
  for (const name of ["node", "pnpm", "git", "herdr"]) {
    const file = join(account.pathEntries[0]!, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o700);
  }
  const runner = { run: async (argv: readonly string[]) => ({ exitCode: 0, timedOut: false, stderr: "", stdout:
    argv[0]!.endsWith("/pnpm") ? "12.5.1" : argv[0]!.endsWith("/git") ? "git version 2.45.0" : argv[0]!.endsWith("/herdr") ? "herdr 0.9.5" : "v24.16.0" }) };
  const setup = new MachineSetupService({ platform: account, runner, config: defaultMachineConfig(),
    approver: new NonInteractiveApprover(), persistMachineConfig: false,
    decorateComponents: (components, factory) => wrapSetupComponents(components, { ...input, ...factory, launchRequirements: [], repositoryRoot: undefined }) });
  const result = await setup.run({ mode: "apply", assumeYes: true });
  expect(result.outcome).toBe("applied");
  const machine = JSON.parse(await readFile(join(account.paths.config, "machine.json"), "utf8"));
  expect(machine.services.map((service: { serviceId: string }) => service.serviceId)).toContain("mcp-gateway");
  // OS service managers do not inherit the shell PATH: the unit must find the exact Node running setup.
  const gatewayService = machine.services.find((service: { serviceId: string }) => service.serviceId === "mcp-gateway");
  expect(gatewayService.env.PATH.split(delimiter)[0]).toBe(dirname(process.execPath));
  expect(gatewayService.env.PATH.split(delimiter)).toContain(account.paths.managedBin);
  const manifest = JSON.parse(await readFile(join(account.paths.state, "environment.json"), "utf8"));
  expect(manifest.serviceIds).toContain("mcp-gateway");
  expect(manifest.lastPlan.planId).toBe(result.plan?.planId);
  expect((await setup.run({ mode: "apply", assumeYes: true })).outcome).toBe("healthy");
});

it("defers GitNexus in a repository without commits during bflow init, writes .bflow/config.yml, and activates it after the first commit", async () => {
  const { components, ctx, platform } = fixture("apply", { initialize: false });
  execFileSync("git", ["init", "--quiet", root]);
  await installFixtureTools(["mempalace_status", "mempalace_search"], { initialize: false });
  await installFixtureTools(["query", "context", "impact"], { initialize: false, executableName: "gitnexus" });
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);

  const unbornInit = await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(unbornInit.exitCode).toBe(0);
  const unbornData = JSON.parse(unbornInit.stdout).data;
  expect(unbornData.gitnexus.status).toBe("deferred");
  expect(unbornData.diagnostics.join(" ")).toContain("no commits yet");
  expect(await readFile(join(root, ".bflow", "config.yml"), "utf8")).toContain("schemaVersion:");

  execFileSync("git", ["-C", root, "-c", "user.name=Gateway Test", "-c", "user.email=gateway@example.test", "commit", "--quiet", "--allow-empty", "-m", "First commit"]);
  const committedInit = await runCli(["init", "--yes", "--json"], { cwd: root, setup: { platform } });
  expect(committedInit.exitCode).toBe(0);
  const committedData = JSON.parse(committedInit.stdout).data;
  expect(committedData.gitnexus.status).toBe("ready");
  expect(committedData.gitnexus.gatewayReady).toBe(true);
  expect(committedData.diagnostics.join(" ")).toContain("PolyForm-Noncommercial-1.0.0");

  const checkReport = await checkRepositoryGitNexus({ repository: await identifyRepository(root), platform });
  expect(checkReport.status).toBe("ready");
});
