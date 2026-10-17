import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { MCPClientRegistrationSchema, MCPServiceDefinitionSchema, MCPServiceObservationSchema, ScopedOperationSchema,
  type MCPServiceDefinition, type MCPServiceObservation } from "@bflow/contracts";
import { MachineConfigSchema, McpConfigComponent, ServicesComponent, SetupStateStore, EnvironmentManifestComponent,
  loadMachineConfig, MACHINE_CONFIG_FILE, digest, findExecutable, SERVICE_MARKER,
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
const GatewayConfigSchema = z.object({
  schemaVersion: z.literal(3), desiredDigest: z.string().regex(/^[a-f0-9]{64}$/),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: ScopedOperationSchema,
  services: z.array(MCPServiceDefinitionSchema), generatedIds: z.array(z.string()),
  receiptPath: z.string().min(1), paths: z.object({ config: z.string(), data: z.string(), state: z.string(), managedBin: z.string() }).strict()
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

/** Replaces only the two existing components; planning never loads or launches a managed tool. */
export function wrapSetupComponents(components: readonly SetupComponent[], input: SetupGatewayInput): SetupComponent[] {
  const { platform, store } = input;
  const config = MachineConfigSchema.parse(input.config);
  const configPath = join(platform.paths.config, "setup-gateway.json");
  const receiptPath = join(platform.paths.state, "setup-gateway-ready.json");
  const repositoryRoot = resolve(input.repositoryRoot ?? join(platform.paths.data, "gateway-repository"));
  const repositoryId = `setup-${sha(repositoryRoot).slice(0, 24)}`;
  const operation = ScopedOperationSchema.parse({ schemaVersion: 3, scope: { kind: "session", machineId: platform.machineId,
    repositoryId, workspaceRoot: repositoryRoot, sessionId: "setup-gateway" }, idempotencyKey: "setup-gateway" });
  const requirements = input.launchRequirements.map(item => ({ ...item,
    version: config.toolPins.find(pin => pin.toolId === item.toolId)?.version ?? "" }));
  const activeRequirements = requirements.filter(item => item.toolId !== "gitnexus" || input.repositoryRoot);
  for (const item of requirements) {
    if (!isAbsolute(item.executable) || !item.version) throw new Error(`Missing pinned managed executable/version for ${item.toolId}`);
  }
  const autoIds = new Set(requirements.map(item => item.toolId === "gitnexus" ? `gitnexus-${sha(repositoryRoot).slice(0, 24)}`
    : `chrome-${sha(join(platform.paths.data, "browser-profiles", "chrome", repositoryId, "setup-browser-probe")).slice(0, 24)}`));
  const operatorServices = config.mcpServices.filter(item => !autoIds.has(item.serviceId));
  const desiredDigest = digest({ machineId: platform.machineId, repositoryRoot, requirements, services: operatorServices });
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
    const expectedIds = new Set(saved.generatedIds);
    if (expectedIds.size !== activeRequirements.length) throw new Error("Managed MCP service inventory does not match setup");
    if (digest(saved.services.filter(item => !expectedIds.has(item.serviceId))) !== digest(operatorServices))
      throw new Error("Operator MCP services differ from the approved setup configuration");
    for (const item of activeRequirements) {
      const definition = saved.services.find(candidate => expectedIds.has(candidate.serviceId) && candidate.tool.toolId === item.toolId);
      if (!definition || definition.connection.kind !== "stdio_mcp" || definition.tool.version !== item.version ||
        digest(definition.tool.operations) !== digest(requiredOperations[item.toolId]) ||
        definition.connection.executable !== process.execPath || definition.connection.argv.length !== 4)
        throw new Error(`Managed ${item.toolId} service changed since configuration`);
      const [launcher, specPath, specDigest, launcherDigest] = definition.connection.argv;
      const tools = await leaf("tool-installer");
      const spec = tools.ToolLaunchSpecSchema.parse(await readJson(specPath!));
      const expectedLauncher = fileURLToPath(new URL("../../../packages/tool-installer/dist/service-launcher.js", import.meta.url));
      if (sha(JSON.stringify(spec)) !== specDigest || sha(await readFile(launcher!)) !== launcherDigest ||
        sha(await readFile(expectedLauncher)) !== launcherDigest ||
        sha(await readFile(process.execPath)) !== definition.connection.executableDigest || spec.executable !== item.executable ||
        sha(await readFile(item.executable)) !== spec.executableDigest)
        throw new Error(`Managed ${item.toolId} executable or launch specification changed`);
      const expectedDefinition = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: definition.serviceId, revision: 1,
        scope: { kind: "machine", machineId: platform.machineId },
        tool: { ...tools.createToolCapability(item.toolId, item.version, platform.machineId), operations: requiredOperations[item.toolId],
          resource: { sharing: "exclusive", resourceKey: definition.serviceId } },
        connection: { kind: "stdio_mcp", executable: process.execPath, executableDigest: sha(await readFile(process.execPath)),
          argv: [launcher, specPath, specDigest, launcherDigest], environmentBindings: {}, ownership: "bflow", bridgeRequired: true },
        authentication: { mode: "none" }, healthTimeoutMs: 15_000, idleTimeoutMs: 60_000, restartLimit: 2 });
      if (digest(definition) !== digest(expectedDefinition)) throw new Error(`Managed ${item.toolId} service policy changed`);
      if (item.toolId === "gitnexus" && (digest(spec.argv) !== digest(["mcp"]) || spec.cwd !== repositoryRoot ||
        spec.environment.GITNEXUS_MCP_ALLOWED_REPOS !== repositoryRoot || spec.environment.GITNEXUS_MCP_READ_ONLY !== "1"))
        throw new Error("GitNexus repository boundary changed");
      if (item.toolId === "chrome-devtools-mcp" && (!spec.browserOwner ||
        !spec.browserOwner.profileDir.startsWith(`${join(platform.paths.data, "browser-profiles")}${sep}`)))
        throw new Error("Chrome is missing its dedicated Bflow profile");
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
            let browserExecutable: string | undefined;
            for (const binary of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
              try {
                const candidate = isAbsolute(binary) ? binary : await findExecutable(binary, platform.pathEntries, process.platform);
                if (!candidate) continue;
                const probe = await input.runner.run([candidate, "--version"], { timeoutMs: 5000, ...(ctx.signal ? { signal: ctx.signal } : {}) });
                if (probe.exitCode === 0 && /chrome|chromium/i.test(probe.stdout + probe.stderr)) { browserExecutable = candidate; break; }
              } catch { /* Try the next installed browser. */ }
            }
            if (!browserExecutable) throw new Error("Chrome/Chromium is unavailable; install a supported browser before Gateway browser verification");
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
          definition = MCPServiceDefinitionSchema.parse({ ...definition, tool: { ...definition.tool, operations: requiredOperations[item.toolId] } });
          if (config.mcpServices.some(existing => existing.serviceId === definition.serviceId && digest(existing) !== digest(definition) &&
            (!prior?.generatedIds.includes(existing.serviceId) || !prior.services.some(old => old.serviceId === existing.serviceId && digest(old) === digest(existing)))))
            throw new Error(`MCP service ${definition.serviceId} already has an operator definition; preserve it and reconcile explicitly`);
          generated.push(definition);
        }
        const generatedIds = new Set(generated.map(item => item.serviceId));
        const services = [...config.mcpServices.filter(item => !generatedIds.has(item.serviceId)), ...generated];
        const mcp = new McpConfigComponent({ platform, store, services });
        const mcpResult = await mcp.apply(ctx);
        if (mcpResult.diagnostics.length) return mcpResult;
        const saved = GatewayConfigSchema.parse({ schemaVersion: 3, desiredDigest, definitionDigest: digest(services), operation,
          services, generatedIds: [...generatedIds], receiptPath, paths: platform.paths });
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
          if (!evidence || evidence.status !== "ready" || evidence.revision !== definition.revision ||
            definition.tool.operations.some(tool => !evidence.discoveredTools.includes(tool)))
            throw new Error(`Gateway has not negotiated required tools for ${definition.serviceId}`);
        }
        return observed;
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
  const module = await leaf("mcp-gateway");
  const gateway = new module.BflowSharedMCPGateway();
  const server = new module.StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
  const store = new SetupStateStore(configured.paths, { uid: process.getuid?.() ?? null, now: () => new Date() });
  const observations: MCPServiceObservation[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = async () => {
    clearInterval(timer);
    await server.stop();
    for (const service of configured.services) if (service.connection.ownership === "bflow")
      await gateway.serviceManager.stop(service.serviceId, configured.operation);

  };
  try {
    const tools = await leaf("tool-installer");
    for (const service of configured.services) {
      if (service.tool.toolId === "chrome-devtools-mcp") await tools.verifyChromeStartup(service);

      const result = await gateway.serviceManager.ensure(service, configured.operation, { timeoutMs: service.healthTimeoutMs });

      const observation = MCPServiceObservationSchema.parse(unwrap<MCPServiceObservation>(result));
      if (observation.status !== "ready" || service.tool.operations.some(tool => !observation.discoveredTools.includes(tool)))
        throw new Error(`Gateway upstream ${service.serviceId} did not negotiate required tools`);
      observations.push(observation);
    }

    const endpoint = `${await server.start()}/mcp`;
    if (configured.services.length) {
      const registrationId = `setup-probe-${randomUUID()}`;
      const registration = MCPClientRegistrationSchema.parse({ schemaVersion: 3, registrationId, provider: "codex", role: "reviewer",
        scope: configured.operation.scope, environmentId: "setup-probe", serviceIds: configured.services.map(service => service.serviceId),
        allowedTools: [...new Set(configured.services.flatMap(service => service.tool.operations))],
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
        for (const service of configured.services) for (const tool of service.tool.operations)
          if (!discovered.tools.some(item => item.serviceId === service.serviceId && item.name === tool))
            throw new Error(`Gateway did not discover required tool ${tool}`);
      } finally { await gateway.revoke(registrationId, configured.operation); }
    }
    const publish = async () => {
      for (let index = 0; index < configured.services.length; index++) {
        const service = configured.services[index]!;
        const current = MCPServiceObservationSchema.parse(unwrap<MCPServiceObservation>(await gateway.serviceManager.inspect(service.serviceId, configured.operation)));
        if (current.status !== "ready" || service.tool.operations.some(tool => !current.discoveredTools.includes(tool)))
          throw new Error(`Gateway upstream ${service.serviceId} lost readiness`);
        observations[index] = current;
      }
      unwrap(await store.writeFileAtomic(configured.receiptPath, `${JSON.stringify(ReadySchema.parse({ schemaVersion: 3,
        definitionDigest: configured.definitionDigest, pid: process.pid, endpoint, observedAt: new Date().toISOString(), observations }))}\n`, 0o600));
    };

    await publish();

    timer = setInterval(() => { void publish().catch(() => {}); }, 10_000);
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
