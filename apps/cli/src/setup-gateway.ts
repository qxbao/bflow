import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { MCPClientRegistrationSchema, MCPServiceDefinitionSchema, MCPServiceObservationSchema, ScopedOperationSchema,
  type MCPServiceDefinition, type MCPServiceObservation } from "@bflow/contracts";
import { MachineConfigSchema, McpConfigComponent, ServicesComponent, SetupStateStore, EnvironmentManifestComponent,
  loadMachineConfig, MACHINE_CONFIG_FILE, digest, McpConfigFileSchema, SERVICE_MARKER, ToolInstallDescriptorSchema,
  type MachineConfig, type PlatformProfile, type SetupComponent, type SetupContext, type CommandRunner,
  type ServiceDefinition, type ServiceManager } from "@bflow/machine-setup";

export interface SetupGatewayLaunchRequirement {
  toolId: "gitnexus" | "chrome-devtools-mcp";
  executable: string;
  args: string[];
  requirements: string[];
}
export interface SetupGatewayInput {
  platform: PlatformProfile;
  store: SetupStateStore;
  config: MachineConfig;
  launchRequirements: readonly SetupGatewayLaunchRequirement[];
  runner: CommandRunner;
  serviceManager: ServiceManager;
  repositoryRoot?: string;
}

export function setupGatewayDiagnostics(input: Pick<SetupGatewayInput, "repositoryRoot" | "launchRequirements">): string[] {
  return [
    ...(!input.repositoryRoot && input.launchRequirements.some(item => item.toolId === "gitnexus")
      ? ["GitNexus installs globally; repository indexing and its MCP activation are deferred until bflow setup --dir <repository>."] : []),
    "The background Gateway verifies installed backends. Connecting actual agent roles to this daemon still requires a Runtime registration control endpoint; machine setup does not establish those connections."
  ];
}

const requiredOperations = {
  gitnexus: ["query", "context", "impact"],
  "chrome-devtools-mcp": ["list_pages", "new_page", "navigate_page"]
};
const ApprovalSchema = z.object({ policyVersion: z.literal(2), repositorySelected: z.boolean(), browserExecutable: z.string().nullable(),
  requirements: z.array(z.object({ toolId: z.enum(["gitnexus", "chrome-devtools-mcp"]), executable: z.string(),
    args: z.array(z.string()), requirements: z.array(z.string()), version: z.string().min(1), pin: ToolInstallDescriptorSchema }).strict()) }).strict();
const GatewayConfigSchema = z.object({
  schemaVersion: z.literal(3), desiredDigest: z.string().regex(/^[a-f0-9]{64}$/),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: ScopedOperationSchema,
  services: z.array(MCPServiceDefinitionSchema), generatedIds: z.array(z.string()),
  receiptPath: z.string().min(1), paths: z.object({ config: z.string(), data: z.string(), state: z.string(), managedBin: z.string() }).strict(),
  approval: ApprovalSchema.optional()
}).strict();
const ReadySchema = z.object({ schemaVersion: z.literal(3), definitionDigest: z.string(), pid: z.number().int().positive(),
  endpoint: z.string().url(), observedAt: z.string().datetime(), observations: z.array(MCPServiceObservationSchema) }).strict();
const RpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough();
const InitializeSchema = z.object({ protocolVersion: z.string().min(1), capabilities: z.object({}).passthrough(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).passthrough() }).passthrough();
const ToolsSchema = z.object({ tools: z.array(z.object({ serviceId: z.string(), name: z.string() }).passthrough()) }).passthrough();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const leaf = (name: string) => import(new URL(`../../../packages/${name}/dist/index.js`, import.meta.url).href);
const why = (error: unknown) => error instanceof Error ? error.message : String(error);
const readonly = (ctx: SetupContext) => ctx.mode === "check" || ctx.mode === "dry_run";
async function readJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error(`Not a bounded regular setup file: ${file}`);
  return JSON.parse(await readFile(file, "utf8"));
}
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function approvedBrowser(platform: PlatformProfile): string | null {
  const candidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .flatMap(name => platform.pathEntries.filter(directory => isAbsolute(directory)).map(directory => resolve(directory, name)));
  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } }
    catch { /* No browser at this approved PATH location. */ }
  }
  return null;
}

function ownedConfiguration(file: string): z.infer<typeof GatewayConfigSchema> | undefined {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error("Invalid owned Gateway configuration file");
    const saved = GatewayConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (saved.definitionDigest !== digest(saved.services)) throw new Error("Invalid owned Gateway configuration checksum");
    return saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function configurationDigest(saved: z.infer<typeof GatewayConfigSchema>): string {
  if (!saved.approval) throw new Error("Gateway configuration needs a canonical approved launch specification; rerun setup");
  return digest({ setupPolicyVersion: saved.approval.policyVersion, machineId: saved.operation.scope.machineId,
    repositoryRoot: saved.operation.scope.kind === "machine" ? "" : saved.operation.scope.workspaceRoot,
    paths: saved.paths,
    repositorySelected: saved.approval.repositorySelected, browserExecutable: saved.approval.browserExecutable,
    requirements: saved.approval.requirements, services: saved.services.filter(item => !saved.generatedIds.includes(item.serviceId)) });
}

/** Reconstruct boundaries from the unit-bound approval, never from a spec's self-checksums alone. */
async function validateLaunches(saved: z.infer<typeof GatewayConfigSchema>) {
  if (!saved.approval || configurationDigest(saved) !== saved.desiredDigest || saved.operation.scope.kind !== "session")
    throw new Error("Gateway launch configuration differs from its approved specification");
  const root = saved.operation.scope.workspaceRoot;
  const repositoryId = `setup-${sha(root).slice(0, 24)}`;
  const expectedOperation = ScopedOperationSchema.parse({ schemaVersion: 3, scope: { kind: "session", machineId: saved.operation.scope.machineId,
    repositoryId, workspaceRoot: root, sessionId: "setup-gateway" }, idempotencyKey: "setup-gateway" });
  if (digest(saved.operation) !== digest(expectedOperation) || saved.receiptPath !== join(saved.paths.state, "setup-gateway-ready.json"))
    throw new Error("Gateway session identity or readiness path differs from the approved boundary");
  const active = saved.approval.requirements.filter(item => item.toolId !== "gitnexus" || saved.approval!.repositorySelected);
  if (new Set(saved.generatedIds).size !== active.length) throw new Error("Managed MCP service inventory does not match setup");
  const tools = await leaf("tool-installer");
  for (const item of active) {
    const definition = saved.services.find(candidate => saved.generatedIds.includes(candidate.serviceId) && candidate.tool.toolId === item.toolId);
    if (!definition || definition.connection.kind !== "stdio_mcp" || definition.connection.argv.length !== 4)
      throw new Error(`Managed ${item.toolId} service changed since configuration`);
    const [launcher, specPath, specDigest, launcherDigest] = definition.connection.argv;
    const spec = tools.ToolLaunchSpecSchema.parse(await readJson(specPath!));
    const expectedLauncher = fileURLToPath(new URL("../../../packages/tool-installer/dist/service-launcher.js", import.meta.url));
    if (await realpath(launcher!) !== await realpath(expectedLauncher) || sha(await readFile(launcher!)) !== launcherDigest ||
      sha(JSON.stringify(spec)) !== specDigest || spec.executable !== item.executable || !isAbsolute(item.executable) ||
      sha(await readFile(item.executable)) !== spec.executableDigest || !specPath!.startsWith(`${await realpath(join(saved.paths.config, "tool-launches"))}${sep}`))
      throw new Error(`Managed ${item.toolId} executable or launch specification changed`);
    let expectedSpec: unknown;
    let serviceId: string;
    if (item.toolId === "gitnexus") {
      const canonicalRoot = await realpath(root), state = await realpath(join(saved.paths.state, "gitnexus"));
      serviceId = `gitnexus-${sha(canonicalRoot).slice(0, 24)}`;
      expectedSpec = { schemaVersion: 3, executable: item.executable, executableDigest: spec.executableDigest, argv: ["mcp"], cwd: canonicalRoot,
        environment: { GITNEXUS_HOME: join(state, "gitnexus-home"), GITNEXUS_MCP_ALLOWED_REPOS: canonicalRoot,
          GITNEXUS_MCP_READ_ONLY: "1", GITNEXUS_SHARED_STORE: "off" }, lockPath: join(state, `gitnexus-storage-${sha(canonicalRoot)}.lock`) };
    } else {
      const profileRoot = await realpath(join(saved.paths.data, "browser-profiles"));
      const profile = join(profileRoot, "chrome", repositoryId, "setup-browser-probe");
      if (await realpath(profile) !== profile || !saved.approval.browserExecutable ||
        await realpath(saved.approval.browserExecutable) !== saved.approval.browserExecutable)
        throw new Error("Chrome profile or approved executable is not canonical");
      const argv = ["--userDataDir", profile, "--executablePath", saved.approval.browserExecutable, "--headless", "--no-usage-statistics"];
      for (const argument of item.args) {
        if (!["--no-usage-statistics", "--no-performance-crux"].includes(argument)) throw new Error("Unapproved Chrome launch argument");
        if (!argv.includes(argument)) argv.push(argument);
      }
      serviceId = `chrome-${sha(profile).slice(0, 24)}`;
      expectedSpec = { schemaVersion: 3, executable: item.executable, executableDigest: spec.executableDigest, argv,
        cwd: dirname(profile), environment: {}, lockPath: join(profile, ".bflow-profile.lock"),
        browserOwner: { taskId: "setup-browser-probe", repositoryId, profileDir: profile } };
    }
    if (digest(spec) !== digest(expectedSpec)) throw new Error(`Managed ${item.toolId} canonical launch boundaries changed`);
    const expectedDefinition = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId, revision: 1,
      scope: { kind: "machine", machineId: saved.operation.scope.machineId },
      tool: { ...tools.createToolCapability(item.toolId, item.version, saved.operation.scope.machineId), required: true,
        operations: requiredOperations[item.toolId], resource: { sharing: "exclusive", resourceKey: serviceId } },
      connection: { kind: "stdio_mcp", executable: process.execPath, executableDigest: sha(await readFile(process.execPath)),
        argv: [launcher, specPath, specDigest, launcherDigest], environmentBindings: {}, ownership: "bflow", bridgeRequired: true },
      authentication: { mode: "none" }, healthTimeoutMs: 15_000, idleTimeoutMs: 60_000, restartLimit: 2 });
    if (digest(definition) !== digest(expectedDefinition)) throw new Error(`Managed ${item.toolId} service policy changed`);
  }
}

/** Replaces only the two existing components; planning never loads or launches a managed tool. */
export function wrapSetupComponents(components: readonly SetupComponent[], input: SetupGatewayInput): SetupComponent[] {
  const { platform, store } = input;
  const config = MachineConfigSchema.parse(input.config);
  const configPath = join(platform.paths.config, "setup-gateway.json");
  const receiptPath = join(platform.paths.state, "setup-gateway-ready.json");
  const repositoryRoot = input.repositoryRoot ? realpathSync(input.repositoryRoot) : resolve(join(platform.paths.data, "gateway-repository"));
  const repositoryId = `setup-${sha(repositoryRoot).slice(0, 24)}`;
  const operation = ScopedOperationSchema.parse({ schemaVersion: 3, scope: { kind: "session", machineId: platform.machineId,
    repositoryId, workspaceRoot: repositoryRoot, sessionId: "setup-gateway" }, idempotencyKey: "setup-gateway" });
  const requirements = input.launchRequirements.map(item => {
    const pin = config.toolPins.find(candidate => candidate.toolId === item.toolId);
    return { ...item, pin, version: pin?.version ?? "" };
  });
  const activeRequirements = requirements.filter(item => item.toolId !== "gitnexus" || input.repositoryRoot);
  for (const item of requirements) {
    if (!isAbsolute(item.executable) || !item.version) throw new Error(`Missing pinned managed executable/version for ${item.toolId}`);
  }
  const priorConfiguration = ownedConfiguration(configPath);
  const priorOwnedIds = new Set((priorConfiguration?.generatedIds ?? []).filter(id =>
    config.mcpServices.some(current => current.serviceId === id && priorConfiguration!.services.some(previous => previous.serviceId === id && digest(previous) === digest(current)))));
  const operatorServices = config.mcpServices.filter(item => !priorOwnedIds.has(item.serviceId));
  const approval = ApprovalSchema.parse({ policyVersion: 2, repositorySelected: Boolean(input.repositoryRoot),
    browserExecutable: approvedBrowser(platform), requirements });
  const desiredDigest = digest({ setupPolicyVersion: 2, machineId: platform.machineId, repositoryRoot,
    paths: platform.paths,
    repositorySelected: approval.repositorySelected, browserExecutable: approval.browserExecutable, requirements, services: operatorServices });
  const service: ServiceDefinition = { serviceId: "mcp-gateway", program: process.execPath,
    args: [fileURLToPath(new URL("../dist/setup-gateway.js", import.meta.url)), "--serve", configPath, desiredDigest], env: {}, keepAlive: true };
  if (config.services.some(item => item.serviceId === service.serviceId &&
    (item.program !== service.program || digest(item.args.slice(0, 3)) !== digest(service.args.slice(0, 3)) ||
      item.args.length !== 4 || !/^[a-f0-9]{64}$/.test(item.args[3]!) || Object.keys(item.env).length || !item.keepAlive))) {
    throw new Error("An operator-defined mcp-gateway service already exists; preserve it and reconcile its definition explicitly");
  }
  const desiredServices = [...config.services.filter(item => item.serviceId !== service.serviceId), service];
  const plannedMcpIds = [...operatorServices.map(item => item.serviceId), ...activeRequirements.map(item =>
    item.toolId === "gitnexus" ? `gitnexus-${sha(repositoryRoot).slice(0, 24)}` :
      `chrome-${sha(join(platform.paths.data, "browser-profiles", "chrome", repositoryId, "setup-browser-probe")).slice(0, 24)}`)];
  for (const component of components) if (component instanceof EnvironmentManifestComponent)
    component.bindServiceInventory(plannedMcpIds, desiredServices.map(item => item.serviceId));
  const servicesBase = new ServicesComponent({ platform, store, manager: input.serviceManager, services: desiredServices });

  const loadConfigured = async () => {
    const saved = GatewayConfigSchema.parse(await readJson(configPath));
    if (saved.desiredDigest !== desiredDigest || saved.definitionDigest !== digest(saved.services) ||
      digest(saved.operation) !== digest(operation) || saved.receiptPath !== receiptPath || digest(saved.paths) !== digest(platform.paths))
      throw new Error("Gateway configuration does not match the approved setup specification");
    if (digest(saved.approval) !== digest(approval)) throw new Error("Gateway canonical launch approval changed");
    await validateLaunches(saved);
    for (const item of activeRequirements) if (item.toolId === "gitnexus") {
      const tools = await leaf("tool-installer");
      const result = await tools.systemToolHost.run(item.executable, ["status", "--json"], { cwd: repositoryRoot, timeoutMs: 15_000,
        environment: { GITNEXUS_HOME: await realpath(join(platform.paths.state, "gitnexus", "gitnexus-home")), GITNEXUS_SHARED_STORE: "off" } });
      const status = z.object({ schemaVersion: z.literal(1), repository: z.string(), status: z.literal("up-to-date") }).passthrough().safeParse(
        (() => { try { const text = result.stdout.trim(); return JSON.parse(text.slice(text.indexOf("{"))); } catch { return null; } })());
      if (result.exitCode !== 0 || !status.success || await realpath(status.data.repository) !== repositoryRoot)
        throw new Error("GitNexus repository index is stale or cannot be verified; run the approved repository setup plan");
    }
    const machine = await loadMachineConfig(join(platform.paths.config, MACHINE_CONFIG_FILE));
    if (machine.status !== "valid" || !machine.config ||
      digest(machine.config.mcpServices) !== digest(saved.services) || digest(machine.config.services) !== digest(desiredServices))
      throw new Error("Machine configuration does not match generated Gateway services");
    const mcp = new McpConfigComponent({ platform, store, services: saved.services });
    return { saved, mcp };
  };

  const mcpComponent: SetupComponent = {
    componentId: "mcp-config", action: "register_mcp", rollback: "restore_owned_config",
    desired: async () => ({ digest: desiredDigest,
      summary: "Configure pinned shared MCP services and a loopback Gateway; verify actual MCP protocol and required tools after installation",
      targets: [configPath, join(platform.paths.config, "mcp.json"), join(platform.paths.config, MACHINE_CONFIG_FILE),
        ...(input.repositoryRoot && requirements.some(item => item.toolId === "gitnexus")
          ? [join(repositoryRoot, ".gitnexus"), join(repositoryRoot, ".git", "info", "exclude")] : [])], machineWide: true, repairNeeded: false }),
    observe: async ctx => {
      try {
        const { mcp } = await loadConfigured();
        const observed = await mcp.observe(ctx), desired = await mcp.desired(ctx);
        if (!observed.valid || observed.stateDigest !== desired.digest) throw new Error("MCP configuration readback differs from approved services");
        return { stateDigest: desiredDigest, valid: true, diagnostics: [] };
      } catch (error) { return { stateDigest: null, valid: false, diagnostics: [why(error)] }; }
    },
    apply: async ctx => {
      if (readonly(ctx)) return { ownedPaths: [], diagnostics: [] };
      try {
        const tools = await leaf("tool-installer");
        let prior: z.infer<typeof GatewayConfigSchema> | undefined;
        try { prior = GatewayConfigSchema.parse(await readJson(configPath)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const generated: MCPServiceDefinition[] = [];
        for (const item of activeRequirements) {
          let definition: MCPServiceDefinition;
          const machineOperation = { ...operation, scope: { kind: "machine", machineId: platform.machineId } };
          if (item.toolId === "gitnexus") {
            const indexed = await tools.ensureGitNexusIndex({ repositoryRoot, stateRoot: join(platform.paths.state, "gitnexus"),
              executable: item.executable, timeoutMs: 300_000 });
            if (!["fresh", "indexed"].includes(indexed.status)) throw new Error(indexed.diagnostic);
            definition = await tools.createGitNexusService({ executable: item.executable, version: item.version, repositoryRoot,
              stateRoot: join(platform.paths.state, "gitnexus"), configRoot: join(platform.paths.config, "tool-launches"), operation: machineOperation });
          } else {
            const browserExecutable = approval.browserExecutable;
            if (!browserExecutable) throw new Error("Chrome/Chromium is unavailable; install a supported browser before Gateway browser verification");
            const browserProbe = await input.runner.run([browserExecutable, "--version"], { timeoutMs: 5000, ...(ctx.signal ? { signal: ctx.signal } : {}) });
            if (browserProbe.exitCode !== 0 || !/chrome|chromium/i.test(browserProbe.stdout + browserProbe.stderr)) throw new Error("Approved browser failed its version probe");
            definition = await tools.createChromeService({ managedRoot: join(platform.paths.data, "browser-profiles"), repositoryId,
              taskId: "setup-browser-probe", browserExecutable, serverExecutable: item.executable, version: item.version,
              configRoot: join(platform.paths.config, "tool-launches"), operation: machineOperation });
            if (definition.connection.kind === "stdio_mcp") {
              const spec = tools.ToolLaunchSpecSchema.parse(await readJson(definition.connection.argv[1]!));
              const argv = [...spec.argv];
              for (const arg of item.args) {
                if (!["--no-usage-statistics", "--no-performance-crux"].includes(arg)) throw new Error("Unapproved Chrome setup argument");
                if (!argv.includes(arg)) argv.push(arg);
              }
              definition = await tools.createManagedMcpService({ toolId: item.toolId, version: item.version,
                serviceId: definition.serviceId, operation: machineOperation, configRoot: join(platform.paths.config, "tool-launches"),
                resourceKey: definition.tool.resource.sharing === "exclusive" ? definition.tool.resource.resourceKey : undefined,
                launch: { ...spec, argv } });
            }
          }
          definition = MCPServiceDefinitionSchema.parse({ ...definition, tool: { ...definition.tool, required: true, operations: requiredOperations[item.toolId] } });
          if (config.mcpServices.some(existing => existing.serviceId === definition.serviceId && digest(existing) !== digest(definition) &&
            (!prior?.generatedIds.includes(existing.serviceId) || !prior.services.some(old => old.serviceId === existing.serviceId && digest(old) === digest(existing)))))
            throw new Error(`MCP service ${definition.serviceId} already has an operator definition; preserve it and reconcile explicitly`);
          generated.push(definition);
        }
        const generatedIds = new Set(generated.map(item => item.serviceId));
        const services = [...operatorServices, ...generated];
        const mcpFile = join(platform.paths.config, "mcp.json");
        try {
          const existing = McpConfigFileSchema.parse(await readJson(mcpFile));
          let changed = false;
          for (const id of priorOwnedIds) if (!generatedIds.has(id) && existing.managedIds.includes(id) &&
            priorConfiguration!.services.some(previous => previous.serviceId === id && digest(previous) === digest(existing.services[id]))) {
            delete existing.services[id]; existing.managedIds = existing.managedIds.filter(candidate => candidate !== id); changed = true;
          }
          if (changed) { unwrap(await store.backupFile(mcpFile)); unwrap(await store.writeFileAtomic(mcpFile, JSON.stringify(existing) + "\n", 0o600)); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const mcp = new McpConfigComponent({ platform, store, services });
        const mcpResult = await mcp.apply(ctx);
        if (mcpResult.diagnostics.length) return mcpResult;
        const saved = GatewayConfigSchema.parse({ schemaVersion: 3, desiredDigest, definitionDigest: digest(services), operation,
          services, generatedIds: [...generatedIds], receiptPath, paths: platform.paths, approval });
        const machine = MachineConfigSchema.parse({ ...config, mcpServices: services, services: desiredServices });
        const paths = [join(platform.paths.config, MACHINE_CONFIG_FILE), configPath];
        for (const [index, payload] of [machine, saved].entries()) {
          unwrap(await store.backupFile(paths[index]!));
          unwrap(await store.writeFileAtomic(paths[index]!, `${JSON.stringify(payload, null, 2)}\n`, 0o600));
        }
        await loadConfigured();
        return { ownedPaths: [...mcpResult.ownedPaths, ...paths], diagnostics: [] };
      } catch (error) { return { ownedPaths: [], diagnostics: [why(error)] }; }
    }
  };
  const servicesComponent: SetupComponent = {
    componentId: "services", action: "configure", rollback: "remove_owned_install",
    desired: async ctx => ({ ...await servicesBase.desired(ctx), summary: "Start the Bflow-owned loopback MCP Gateway user service and verify negotiated MCP tools" }),
    observe: async ctx => {
      try {
        const { saved } = await loadConfigured();
        const observed = await servicesBase.observe(ctx), desired = await servicesBase.desired(ctx);
        if (!observed.valid || observed.stateDigest !== desired.digest) throw new Error("Gateway user service is not active with the approved definition");
        const ready = ReadySchema.parse(await readJson(receiptPath));
        const age = ctx.now().getTime() - Date.parse(ready.observedAt);
        if (ready.definitionDigest !== saved.definitionDigest || age < -1000 || age > 60_000 ||
          !ready.endpoint.startsWith("http://127.0.0.1:")) throw new Error("Gateway readiness evidence is missing, stale or uncorrelated");
        process.kill(ready.pid, 0);
        for (const definition of saved.services) {
          const evidence = ready.observations.find(item => item.serviceId === definition.serviceId);
          if (definition.tool.required && (!evidence || evidence.status !== "ready" || evidence.revision !== definition.revision ||
            definition.tool.operations.some(tool => !evidence.discoveredTools.includes(tool))))
            throw new Error(`Gateway has not negotiated required tools for ${definition.serviceId}`);
        }
        return { ...observed, diagnostics: [...observed.diagnostics,
          ...ready.observations.filter(item => item.status !== "ready").map(item => `Optional MCP service ${item.serviceId} is unavailable (${item.diagnosticCode})`)] };
      } catch (error) { return { stateDigest: null, valid: false, diagnostics: [why(error)] }; }
    },
    apply: async ctx => {
      if (readonly(ctx)) return { ownedPaths: [], diagnostics: [] };
      try {
        await loadConfigured();
        for (const definition of desiredServices) {
          const unit = input.serviceManager.unitPath(definition.serviceId);
          try {
            const info = await lstat(unit);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000 || !(await readFile(unit, "utf8")).includes(SERVICE_MARKER))
              throw new Error(`Refusing to replace an unowned user service: ${unit}`);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        // Reconcile only desired services. Existing external workers and unrelated units remain intact.
        const applied = await servicesBase.apply({ ...ctx, mode: "apply" });
        if (applied.diagnostics.length) return applied;
        for (let attempt = 0; attempt < 360; attempt++) {
          const observed = await servicesComponent.observe(ctx);
          if (observed.valid) return applied;
          if (ctx.signal?.aborted) throw new Error("Gateway startup interrupted; preserve the installed service and inspect its logs");
          if (attempt === 359) return { ...applied, diagnostics: observed.diagnostics };
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error("Gateway readiness unavailable");
      } catch (error) { return { ownedPaths: [], diagnostics: [why(error)] }; }
    }
  };
  const replacements = new Map([["mcp-config", mcpComponent], ["services", servicesComponent]]);
  const result = components.map(component => replacements.get(component.componentId) ?? component);
  for (const [id, component] of replacements) if (!result.some(candidate => candidate.componentId === id)) result.push(component);
  return result;
}

/** Actual daemon entrypoint; provider/role registrations remain owned by Runtime. */
export async function startSetupGatewayRuntime(configPath: string, expectedDesiredDigest?: string) {
  const configured = GatewayConfigSchema.parse(await readJson(configPath));
  if (configured.definitionDigest !== digest(configured.services)) throw new Error("Gateway service definition checksum mismatch");
  if (expectedDesiredDigest && configured.desiredDigest !== expectedDesiredDigest) throw new Error("Gateway service configuration differs from its installed setup plan");
  await validateLaunches(configured);
  const module = await leaf("mcp-gateway");
  const gateway = new module.BflowSharedMCPGateway();
  const server = new module.StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
  const store = new SetupStateStore(configured.paths, { uid: process.getuid?.() ?? null, now: () => new Date() });
  const observations: MCPServiceObservation[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const shutdown = new AbortController();
  const unavailable = (service: MCPServiceDefinition) => MCPServiceObservationSchema.parse({ schemaVersion: 3,
    serviceId: service.serviceId, revision: service.revision, instanceId: `unavailable-${service.serviceId}`, status: "blocked",
    discoveredTools: [], ownership: service.connection.ownership, activeClientCount: 0,
    observedAt: new Date().toISOString(), diagnosticCode: "optional_backend_unavailable" });
  const stop = async () => {
    stopped = true; shutdown.abort();
    clearInterval(timer);
    await rm(configured.receiptPath, { force: true });
    await server.stop();
    for (const service of configured.services) if (service.connection.ownership === "bflow")
      await gateway.serviceManager.stop(service.serviceId, configured.operation);

  };
  try {
    const tools = await leaf("tool-installer");
    for (const service of configured.services) {
      try {
        if (service.tool.toolId === "chrome-devtools-mcp") await tools.verifyChromeStartup(service);
        const result = await gateway.serviceManager.ensure(service, configured.operation, { timeoutMs: service.healthTimeoutMs, signal: shutdown.signal });
        const observation = MCPServiceObservationSchema.parse(unwrap<MCPServiceObservation>(result));
        if (observation.status !== "ready" || service.tool.operations.some(tool => !observation.discoveredTools.includes(tool)))
          throw new Error(`Gateway upstream ${service.serviceId} did not negotiate required tools`);
        observations.push(observation);
      } catch (error) {
        if (service.tool.required) throw error;
        observations.push(unavailable(service));
      }
    }
    const readyServices = configured.services.filter(service => observations.some(item => item.serviceId === service.serviceId && item.status === "ready"));

    const endpoint = `${await server.start()}/mcp`;
    if (readyServices.length) {
      const registrationId = `setup-probe-${randomUUID()}`;
      const registration = MCPClientRegistrationSchema.parse({ schemaVersion: 3, registrationId, provider: "codex", role: "reviewer",
        scope: configured.operation.scope, environmentId: "setup-probe", serviceIds: readyServices.map(service => service.serviceId),
        allowedTools: [...new Set(readyServices.flatMap(service => service.tool.operations))],
        connection: { transport: "streamable_http", endpoint, token: `secret://setup/${registrationId}` },
        configDigest: configured.definitionDigest, expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: registrationId });
      unwrap(await gateway.register(registration));
      try {
        const token = gateway.secretStore.getClientTokenByRegistration(registrationId);
        const call = async (id: number, method: string, sessionId?: string) => {
          const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
            signal: AbortSignal.timeout(15_000), redirect: "error" });
          const result = RpcSchema.parse(await response.json());
          if (!response.ok || result.id !== id || result.error || !result.result) throw new Error(`Gateway ${method} failed its correlated MCP postcheck`);
          return { response, result: result.result };
        };

        const initialized = await call(1, "initialize");

        InitializeSchema.parse(initialized.result);
        const listed = await call(2, "tools/list", initialized.response.headers.get("Mcp-Session-Id") ?? undefined);
        const discovered = ToolsSchema.parse(listed.result);
        for (const service of readyServices) for (const tool of service.tool.operations)
          if (!discovered.tools.some(item => item.serviceId === service.serviceId && item.name === tool))
            throw new Error(`Gateway did not discover required tool ${tool}`);
      } finally { await gateway.revoke(registrationId, configured.operation); }
    }
    const publish = async () => {
      for (let index = 0; index < configured.services.length; index++) {
        const service = configured.services[index]!;
        try {
          const current = MCPServiceObservationSchema.parse(unwrap<MCPServiceObservation>(await gateway.serviceManager.inspect(service.serviceId, configured.operation)));
          const entry = gateway.registry.getService(service.serviceId);
          const partition = entry && unwrap<string>(module.computePartitionKey(entry.definition, entry.policy, configured.operation.scope));
          const driver = partition && gateway.serviceManager.getDriver(partition);
          if (current.status !== "ready" || !driver) throw new Error(`Gateway upstream ${service.serviceId} lost readiness`);
          const timeoutMs = Math.min(service.healthTimeoutMs, 5000);
          const discovered = z.array(z.string().min(1)).parse(unwrap<readonly string[]>(await driver.listTools("setup-health", {
            timeoutMs, signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)])
          })));
          if (!discovered.length || service.tool.operations.some(tool => !discovered.includes(tool)))
            throw new Error(`Gateway upstream ${service.serviceId} no longer exposes required tools`);
          observations[index] = MCPServiceObservationSchema.parse({ ...current, discoveredTools: discovered, observedAt: new Date().toISOString() });
        } catch (error) {
          if (service.tool.required) throw error;
          observations[index] = unavailable(service);
        }
      }
      if (stopped) return;
      unwrap(await store.writeFileAtomic(configured.receiptPath, `${JSON.stringify(ReadySchema.parse({ schemaVersion: 3,
        definitionDigest: configured.definitionDigest, pid: process.pid, endpoint, observedAt: new Date().toISOString(), observations }))}\n`, 0o600));
    };

    await publish();
    let publishing = false;
    timer = setInterval(() => {
      if (publishing || stopped) return;
      publishing = true;
      void publish().catch(async error => {
        if (stopped) return;
        await rm(configured.receiptPath, { force: true });
        process.stderr.write(`Gateway protocol health failed: ${module.scrubSecrets(why(error))}\n`);
      }).finally(() => { publishing = false; });
    }, 10_000);
    timer.unref();
    return { endpoint, observations, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === "--serve") {
  const configPath = process.argv[3];
  if (!configPath) throw new Error("Gateway service requires its private configuration path");
  void startSetupGatewayRuntime(configPath, process.argv[4]).then(runtime => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.stop().then(() => process.exit(0)); });
  }).catch(error => { process.stderr.write(`Gateway startup failed: ${why(error)}\n`); process.exitCode = 1; });
}
