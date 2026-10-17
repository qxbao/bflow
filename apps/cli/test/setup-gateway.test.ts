import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
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
if (process.argv[2] === 'status') { console.log(JSON.stringify({schemaVersion:1,repository:process.cwd(),status:'up-to-date'})); process.exit(0); }
let pending = '';
process.stdin.on('data', chunk => { pending += chunk; while (pending.includes('\\n')) {
  const index = pending.indexOf('\\n'); const line = pending.slice(0,index); pending = pending.slice(index+1);
  if (!line.trim()) continue; const message=JSON.parse(line); if (message.id === undefined) continue;
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
