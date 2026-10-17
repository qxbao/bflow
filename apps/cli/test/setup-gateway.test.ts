import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultMachineConfig, detectPlatform, defaultHostEnvironment, SetupStateStore, digest, NodeCommandRunner, MachineSetupService, NonInteractiveApprover,
  type ServiceManager, type SetupContext } from "@bflow/machine-setup";
import { wrapSetupComponents, startSetupGatewayRuntime, setupGatewayDiagnostics } from "../src/setup-gateway.js";

let root: string;
let runtime: Awaited<ReturnType<typeof startSetupGatewayRuntime>> | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bflow-gateway-setup-")); });
afterEach(async () => {
  await runtime?.stop(); runtime = undefined;
  if (process.env.BFLOW_GATEWAY_KEEP_SMOKE === "1") console.log(`Retained isolated Gateway smoke: ${root}`);
  else await rm(root, { recursive: true, force: true });
});

function fixture(mode: SetupContext["mode"] = "apply") {
  const platform = { ...detectPlatform(defaultHostEnvironment()),
    paths: { config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), managedBin: join(root, "bin") } };
  const store = new SetupStateStore(platform.paths, { uid: platform.uid, now: () => new Date(), readOnly: mode === "check" || mode === "dry_run" });
  let active = false;
  let installedDigest: string | null = null;
  const serviceManager: ServiceManager = {
    kind: "systemd-user", unitPath: id => join(root, `${id}.service`), render: def => JSON.stringify(def),
    inspect: async () => ({ installed: active, digest: installedDigest, active }),
    install: async def => {
      runtime = await startSetupGatewayRuntime(def.args[2]!);
      installedDigest = digest(JSON.stringify(def));
      active = true;
      return { ownedPaths: [join(root, "mcp-gateway.service")], diagnostics: [], changed: true };
    },
    listInstalled: async () => [], remove: async () => ({ ownedPaths: [], diagnostics: [] })
  };
  const config = defaultMachineConfig();
  config.toolPins = [{ schemaVersion: 3, toolId: "gitnexus", installerId: "fixture", method: "npm", version: "1.6.12",
    source: "https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false }];
  const runner = { run: async () => { throw new Error("Unexpected external command during setup planning"); } };
  const ctx: SetupContext = { platform, runner, mode, now: () => new Date() };
  const input = { platform, store, config, runner, serviceManager, repositoryRoot: root,
    launchRequirements: [{ toolId: "gitnexus" as const, executable: join(root, "gitnexus"), args: ["mcp"], requirements: [] }] };
  const components = wrapSetupComponents([], input);
  return { platform, store, config, components, ctx, input };
}

async function installFixtureTools(tools: string[]) {
  initializeGitRepository();
  await writeFile(join(root, "gitnexus"), `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('fixture 1.0.0'); process.exit(0); }
if (process.argv[2] === 'status') { console.log(JSON.stringify({schemaVersion:1,repository:process.cwd(),status:require('node:fs').existsSync(${JSON.stringify(join(root, "stale-index"))})?'stale':'up-to-date'})); process.exit(0); }
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
  await chmod(join(root, "gitnexus"), 0o700);
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
  expect(await readdir(root)).toEqual([]);
});

it("configures after installation and verifies actual MCP negotiation and tools through the gateway", async () => {
  const { components, ctx, platform, input } = fixture();
  await installFixtureTools(["query", "context", "impact"]);
  for (const component of components) {
    expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect(await component.observe(ctx)).toMatchObject({ valid: true, stateDigest: (await component.desired(ctx)).digest });
  }
  const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  expect(machine.mcpServices[0].tool.operations).toEqual(["query", "context", "impact"]);
  expect(JSON.stringify(machine)).not.toContain('"token"');
  expect(runtime?.observations[0]).toMatchObject({ status: "ready", protocolVersion: "2025-11-25", discoveredTools: ["query", "context", "impact"] });
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
  await installFixtureTools(["query"]);
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  const applied = await components[1]!.apply(ctx);
  expect(applied.diagnostics.join(" ")).toMatch(/required|ready|tools/i);
  expect((await components[1]!.observe(ctx)).valid).toBe(false);
});

it("does not configure a missing managed executable or record it as ready", async () => {
  const { components, ctx, platform } = fixture();
  expect((await components[0]!.apply(ctx)).diagnostics.length).toBeGreaterThan(0);
  await expect(readFile(join(platform.paths.config, "machine.json"))).rejects.toThrow();
});

it("starts the machine Gateway outside a repository and explicitly defers repository-scoped GitNexus activation", async () => {
  const { input, ctx } = fixture();
  const outsideRepository = { ...input, repositoryRoot: undefined };
  const components = wrapSetupComponents([], outsideRepository);
  for (const component of components) {
    expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect((await component.observe(ctx)).valid).toBe(true);
  }
  expect(runtime?.observations).toEqual([]);
  expect(setupGatewayDiagnostics(outsideRepository).join(" ")).toMatch(/GitNexus.*deferred/);
});

it("preserves an unowned existing gateway user service", async () => {
  const { input, ctx } = fixture();
  const components = wrapSetupComponents([], { ...input, repositoryRoot: undefined });
  const unitPath = input.serviceManager.unitPath("mcp-gateway");
  await writeFile(unitPath, "[Service]\nExecStart=/operator-owned/worker\n");
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  expect((await components[1]!.apply(ctx)).diagnostics.join(" ")).toMatch(/unowned/i);
  expect(runtime).toBeUndefined();
  expect(await readFile(unitPath, "utf8")).toContain("/operator-owned/worker");
});

it.each(["argv", "environment", "cwd", "lockPath", "owner", "profile"])("rejects a self-checksummed Chrome spec with changed %s", async field => {
  const { input, ctx, platform } = fixture();
  await installFixtureTools(["list_pages", "new_page", "navigate_page"]);
  await mkdir(join(root, "bin"));
  const browser = join(root, "bin", "google-chrome");
  await writeFile(browser, `#!${process.execPath}\nconsole.log('Google Chrome 152.0.0.0');\n`);
  await chmod(browser, 0o700);
  const chromeInput = { ...input, platform: { ...platform, pathEntries: [join(root, "bin")] },
    config: { ...input.config, toolPins: [{ ...input.config.toolPins[0]!, toolId: "chrome-devtools-mcp", version: "1.11.0" }] },
    runner: new NodeCommandRunner(), launchRequirements: [{ toolId: "chrome-devtools-mcp" as const,
      executable: join(root, "gitnexus"), args: ["--no-usage-statistics", "--no-performance-crux"], requirements: [] }] };
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
  await installFixtureTools(["query", "context", "impact"]);
  for (const component of components) expect((await component.apply(ctx)).diagnostics).toEqual([]);
  await writeFile(join(root, "hang"), "hang");
  await vi.waitFor(async () => expect((await components[1]!.observe(ctx)).valid).toBe(false), { timeout: 18_000, interval: 500 });
  expect((await readFile(join(root, "launch-count"), "utf8")).trim().split("\n")).toHaveLength(1);
}, 25_000);

it("does not carry a prior generated repository backend into another repository session", async () => {
  const { components, ctx, input, platform } = fixture();
  await installFixtureTools(["query", "context", "impact"]);
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  const machine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  const previousId = machine.mcpServices[0].serviceId;
  const other = join(root, "other"); await mkdir(other); initializeGitRepository(other);
  const next = wrapSetupComponents([], { ...input, config: machine, repositoryRoot: other });
  for (const component of next) expect((await component.apply(ctx)).diagnostics).toEqual([]);
  const finalMachine = JSON.parse(await readFile(join(platform.paths.config, "machine.json"), "utf8"));
  const finalMcp = JSON.parse(await readFile(join(platform.paths.config, "mcp.json"), "utf8"));
  expect(finalMachine.mcpServices).toHaveLength(1);
  expect(finalMcp.services).not.toHaveProperty(previousId);
  expect(runtime?.observations.map(item => item.serviceId)).not.toContain(previousId);
});

it("observes stale repository indexes without rerunning analysis or rewriting state", async () => {
  const { components, ctx, platform } = fixture();
  await installFixtureTools(["query", "context", "impact"]);
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  const file = join(platform.paths.config, "setup-gateway.json"); const before = await readFile(file, "utf8");
  await writeFile(join(root, "stale-index"), "stale");
  expect((await components[0]!.observe({ ...ctx, mode: "check" })).valid).toBe(false);
  expect(await readFile(file, "utf8")).toBe(before);
});

it("uses canonical repository identity for symlinked setup paths", async () => {
  const { input, ctx, platform } = fixture();
  await installFixtureTools(["query", "context", "impact"]);
  const alias = join(root, "repo-alias"); await symlink(root, alias);
  const components = wrapSetupComponents([], { ...input, repositoryRoot: alias });
  expect((await components[0]!.apply(ctx)).diagnostics).toEqual([]);
  const saved = JSON.parse(await readFile(join(platform.paths.config, "setup-gateway.json"), "utf8"));
  expect(saved.operation.scope.workspaceRoot).toBe(root);
});

it("keeps required services ready when an optional external backend is offline", async () => {
  const { input, ctx } = fixture();
  await installFixtureTools(["query", "context", "impact"]);
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
    const components = wrapSetupComponents([], { ...input, repositoryRoot: undefined, config: { ...input.config, mcpServices: [required] } });
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
  const components = wrapSetupComponents([], { ...input, repositoryRoot, platform, store, config, runner: new NodeCommandRunner(), launchRequirements: [
    { toolId: "gitnexus", executable: join(toolRoot, "gitnexus/node_modules/.bin/gitnexus"), args: ["mcp"], requirements: [] },
    { toolId: "chrome-devtools-mcp", executable: join(toolRoot, "chrome-devtools-mcp/node_modules/.bin/chrome-devtools-mcp"),
      args: ["--no-usage-statistics", "--no-performance-crux"], requirements: [] }
  ] });
  for (const component of components) {
    expect((await component.apply(ctx)).diagnostics).toEqual([]);
    expect((await component.observe(ctx)).valid).toBe(true);
  }
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
  const manifest = JSON.parse(await readFile(join(account.paths.state, "environment.json"), "utf8"));
  expect(manifest.serviceIds).toContain("mcp-gateway");
  expect(manifest.lastPlan.planId).toBe(result.plan?.planId);
  expect((await setup.run({ mode: "apply", assumeYes: true })).outcome).toBe("healthy");
});
