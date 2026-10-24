import { resolve, join } from "node:path";
import { DocsClient, FileDocsCache, DEFAULT_CACHE_POLICY, type CachePolicy, type DocsFailure, type DocsMetricsSnapshot, type LookupSuccess, type SearchSuccess } from "@bflow/docs-retrieval";
import { GatewayDocsCaller, discoverAgentAccess, enrollOperatorAccess, resolveHostRepositoryRoot, type DocsAccess } from "./docs-gateway.js";
import { evaluateContext7Health, type Context7Health } from "./docs-health.js";
import { readStoredContext7Key } from "./context7-secret.js";
import { readEnvironmentConfig } from "./environment-config.js";
import { identifyRepository, type RepositoryIdentity } from "./repository.js";
import type { CliContext, DocsCommandArgs } from "./types.js";

/** Seams for tests; production resolves everything from the machine and the repository. */
export interface DocsCommandDependencies {
  readonly access?: (() => Promise<DocsAccess>) | undefined;
  readonly stateDirectory?: string | undefined;
  readonly machineId?: string | undefined;
  readonly grantedRoles?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface DocsCommandOutput {
  readonly docs: true;
  readonly action: "search" | "lookup" | "status";
  readonly ok: boolean;
  readonly access: { readonly mode: "agent" | "operator" | "none"; readonly reason?: string | undefined };
  readonly warnings: readonly string[];
  readonly search?: Omit<SearchSuccess, "ok"> | undefined;
  readonly lookup?: Omit<LookupSuccess, "ok"> | undefined;
  readonly health?: Context7Health | undefined;
  readonly failure?: (DocsFailure & { readonly stage?: string | undefined }) | undefined;
  readonly metrics?: DocsMetricsSnapshot | undefined;
}

async function machine(): Promise<{ stateDirectory: string; machineId: string }> {
  const setup = await import("@bflow/machine-setup");
  const host = setup.defaultHostEnvironment();
  let platform = await setup.detectPlatformWithProbe(host);
  if (host.env.BFLOW_HOME) platform = setup.isolatedPlatformProfile(platform, resolve(host.env.BFLOW_HOME));
  return { stateDirectory: platform.paths.state, machineId: platform.machineId };
}

async function grantedRoles(): Promise<readonly string[]> {
  const { loadMachineSkillCatalog } = await import("./skill-catalog.js");
  const catalog = await loadMachineSkillCatalog();
  return catalog.definitions.filter(definition => definition.skillId === "use-context7").flatMap(definition => [...definition.allowedRoles]);
}

/** Resolves machine state, the roles granted Context7 by the approved skill catalog, and evaluates health. Shared with `bflow doctor`. */
export async function collectContext7Health(input: {
  readonly repository: RepositoryIdentity | undefined;
  readonly config: { readonly environment: { readonly context7?: { enabled?: boolean | undefined; required?: boolean | undefined } | undefined; readonly roles: ReadonlyArray<{ role: string; cli: string }> } } | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly probe?: boolean;
  readonly role?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly deps?: DocsCommandDependencies | undefined;
}): Promise<Context7Health> {
  const deps = input.deps ?? {};
  const where = deps.stateDirectory !== undefined && deps.machineId !== undefined ? { stateDirectory: deps.stateDirectory, machineId: deps.machineId } : await machine();
  const effectiveContext7 = input.config?.environment
    ? {
        enabled: input.config.environment.context7?.enabled !== false,
        required: input.config.environment.context7?.required === true
      }
    : undefined;
  return evaluateContext7Health({ context7: effectiveContext7, roles: input.config?.environment.roles ?? [],
    grantedRoles: deps.grantedRoles ?? await grantedRoles().catch(() => []), stateDirectory: where.stateDirectory, machineId: where.machineId,
    repository: input.repository, env: input.env, ...(input.probe !== undefined ? { probe: input.probe } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(deps.access ? { deps: { access: deps.access } } : {}) });
}

export async function executeDocsCommand(args: DocsCommandArgs, context?: CliContext, onProgress?: (phase: string) => void): Promise<DocsCommandOutput> {
  const progress = (phase: string) => { try { onProgress?.(phase); } catch { /* observational only */ } };
  progress("Reading documentation configuration...");
  const deps: DocsCommandDependencies = context?.docs ?? {};
  const cwd = context?.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const where = deps.stateDirectory !== undefined && deps.machineId !== undefined ? { stateDirectory: deps.stateDirectory, machineId: deps.machineId } : await machine();
  let repository: RepositoryIdentity | undefined;
  try { repository = await identifyRepository(cwd); } catch { repository = undefined; }
  let config: Awaited<ReturnType<typeof readEnvironmentConfig>> | undefined;
  if (repository) { try { config = await readEnvironmentConfig(repository); } catch { config = undefined; } }

  if (args.action === "status") {
    progress("Checking Context7 Gateway access and health...");
    const health = await collectContext7Health({ repository, config, env, role: args.role, timeoutMs: args.timeoutMs,
      deps: { ...deps, stateDirectory: where.stateDirectory, machineId: where.machineId } });
    return { docs: true, action: "status", ok: health.state === "healthy" || health.state === "disabled", access: { mode: health.probe.mode, ...(health.probe.reason ? { reason: health.probe.reason } : {}) },
      warnings: health.checks.filter(check => check.status === "warn").map(check => check.message), health };
  }

  progress("Checking scoped documentation access...");
  const access = await (deps.access ?? (async (): Promise<DocsAccess> => {
    if (!repository) return { mode: "none", kind: "no_gateway", reason: "Run this inside a Git repository whose agents were started with 'bflow up'." };
    // From a task worktree, the host's state and the Gateway's session scope are those of the main working tree.
    const hostRoot = await resolveHostRepositoryRoot(cwd) ?? repository.root;
    const agent = await discoverAgentAccess(env, hostRoot);
    if (agent) return { mode: "agent", target: agent };
    const host = hostRoot === repository.root ? repository : await identifyRepository(hostRoot).catch(() => repository);
    return enrollOperatorAccess({ stateDirectory: where.stateDirectory, machineId: where.machineId, repository: host, role: args.role ?? "developer" });
  }))();
  if (access.mode === "none") {
    const kind = access.kind === "not_granted" ? "permission_denied" : "unavailable";
    return { docs: true, action: args.action, ok: false, access: { mode: "none", reason: access.reason }, warnings: [],
      failure: { kind, message: access.reason, retryable: kind === "unavailable", stage: "access" } };
  }
  try {
    const caller = new GatewayDocsCaller(access.target, deps.fetchImpl);
    const settings = config?.environment.context7?.cache;
    const key = await readStoredContext7Key({ state: where.stateDirectory });
    const policy: CachePolicy = { ...DEFAULT_CACHE_POLICY, enabled: settings?.enabled === true, ttlSeconds: settings?.ttlSeconds ?? DEFAULT_CACHE_POLICY.ttlSeconds,
      allowAuthenticated: settings?.allowAuthenticated === true };
    const client = new DocsClient({ caller, timeoutMs: args.timeoutMs ?? 30_000, authenticated: key.status === "ok",
      ...(policy.enabled ? { cache: new FileDocsCache({ directory: join(where.stateDirectory, "docs-cache"), maxEntries: policy.maxEntries, maxBytes: policy.maxBytes }) } : {}),
      cachePolicy: policy });
    const projectRoot = repository?.root ?? cwd;
    const accessInfo = { mode: access.mode } as const;
    if (args.action === "search") {
      progress("Searching Context7 libraries...");
      const result = await client.search({ library: args.library, projectRoot, startDir: cwd, ...(args.query !== undefined ? { query: args.query } : {}), ...(args.version !== undefined ? { version: args.version } : {}) });
      if (!result.ok) return { docs: true, action: "search", ok: false, access: accessInfo, warnings: [], failure: { ...result.failure, stage: result.stage }, metrics: client.metrics() };
      const { ok: _ok, ...search } = result;
      return { docs: true, action: "search", ok: result.selection !== "no_match", access: accessInfo, warnings: result.warnings, search, metrics: client.metrics(),
        ...(result.selection === "no_match" ? { failure: { kind: "library_not_found", message: `Context7 has no library matching "${args.library}".`, retryable: false, stage: "resolve" } } : {}) };
    }
    progress("Looking up Context7 documentation...");
    const result = await client.lookup({ query: args.query, projectRoot, startDir: cwd, ...(args.library !== undefined ? { library: args.library } : {}),
      ...(args.libraryId !== undefined ? { libraryId: args.libraryId } : {}), ...(args.language !== undefined ? { language: args.language } : {}),
      ...(args.version !== undefined ? { version: args.version } : {}), ...(args.noCache ? { noCache: true } : {}) });
    if (!result.ok) return { docs: true, action: "lookup", ok: false, access: accessInfo, warnings: [], failure: { ...result.failure, stage: result.stage }, metrics: client.metrics() };
    const { ok: _ok, ...lookup } = result;
    return { docs: true, action: "lookup", ok: true, access: accessInfo, warnings: result.warnings, lookup, metrics: client.metrics() };
  } finally { await access.release?.(); }
}
