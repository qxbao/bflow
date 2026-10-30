import { resolve } from "node:path";
import { DocsClient, checkQuestion, checkRepoName, checkVisibility, type DocsFailure, type DocsMetricsSnapshot, type DocsSuccess } from "@bflow/docs-retrieval";
import { GatewayDocsCaller, discoverAgentAccess, enrollOperatorAccess, resolveHostRepositoryRoot, type DocsAccess } from "./docs-gateway.js";
import { evaluateDeepWikiHealth, type DeepWikiHealth } from "./docs-health.js";
import { runDeepWikiProbe, type DeepWikiProbeResult } from "./docs-probe.js";
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
  readonly action: "ask" | "structure" | "contents" | "status" | "probe";
  readonly ok: boolean;
  readonly access: { readonly mode: "agent" | "operator" | "none"; readonly reason?: string | undefined };
  readonly warnings: readonly string[];
  readonly answer?: Omit<DocsSuccess, "ok"> | undefined;
  readonly health?: DeepWikiHealth | undefined;
  readonly probe?: DeepWikiProbeResult | undefined;
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
  return catalog.definitions.filter(definition => definition.skillId === "use-deepwiki").flatMap(definition => [...definition.allowedRoles]);
}

/** Resolves machine state, the roles granted DeepWiki by the approved skill catalog, and evaluates health. Shared with `bflow doctor`. */
export async function collectDeepWikiHealth(input: {
  readonly repository: RepositoryIdentity | undefined;
  readonly config: { readonly environment: { readonly deepwiki?: { enabled?: boolean | undefined; required?: boolean | undefined } | undefined; readonly roles: ReadonlyArray<{ role: string; cli: string }> } } | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly probe?: boolean;
  readonly role?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly deps?: DocsCommandDependencies | undefined;
}): Promise<DeepWikiHealth> {
  const deps = input.deps ?? {};
  const where = deps.stateDirectory !== undefined && deps.machineId !== undefined ? { stateDirectory: deps.stateDirectory, machineId: deps.machineId } : await machine();
  const effective = input.config?.environment
    ? { enabled: input.config.environment.deepwiki?.enabled !== false, required: input.config.environment.deepwiki?.required === true }
    : undefined;
  return evaluateDeepWikiHealth({ deepwiki: effective, roles: input.config?.environment.roles ?? [],
    grantedRoles: deps.grantedRoles ?? await grantedRoles().catch(() => []), stateDirectory: where.stateDirectory, machineId: where.machineId,
    repository: input.repository, env: input.env, ...(input.probe !== undefined ? { probe: input.probe } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(deps.access ? { deps: { access: deps.access } } : {}) });
}

export async function executeDocsCommand(args: DocsCommandArgs, context?: CliContext, onProgress?: (phase: string) => void): Promise<DocsCommandOutput> {
  const progress = (phase: string) => { try { onProgress?.(phase); } catch { /* observational only */ } };
  const deps: DocsCommandDependencies = context?.docs ?? {};

  if (args.action === "probe") {
    progress("Probing DeepWiki through the Gateway...");
    const probe = await runDeepWikiProbe({ live: args.live, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) });
    return { docs: true, action: "probe", ok: probe.ok, access: { mode: "none", reason: probe.reason ?? `probe mode ${probe.mode}` }, warnings: [], probe,
      ...(probe.ok ? {} : { failure: { kind: "unavailable" as const, message: probe.reason ?? "The probe did not succeed.", retryable: false, stage: "probe" } }) };
  }

  progress("Reading documentation configuration...");
  const cwd = context?.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const where = deps.stateDirectory !== undefined && deps.machineId !== undefined ? { stateDirectory: deps.stateDirectory, machineId: deps.machineId } : await machine();
  let repository: RepositoryIdentity | undefined;
  try { repository = await identifyRepository(cwd); } catch { repository = undefined; }
  let config: Awaited<ReturnType<typeof readEnvironmentConfig>> | undefined;
  if (repository) { try { config = await readEnvironmentConfig(repository); } catch { config = undefined; } }

  if (args.action === "status") {
    progress("Checking DeepWiki Gateway access and health...");
    const health = await collectDeepWikiHealth({ repository, config, env, role: args.role, timeoutMs: args.timeoutMs,
      deps: { ...deps, stateDirectory: where.stateDirectory, machineId: where.machineId } });
    return { docs: true, action: "status", ok: health.state === "healthy" || health.state === "disabled", access: { mode: health.probe.mode, ...(health.probe.reason ? { reason: health.probe.reason } : {}) },
      warnings: health.checks.filter(check => check.status === "warn").map(check => check.message), health };
  }

  // The repository and its visibility come only from the operator's own arguments. They are checked here, before any Gateway
  // access is requested, so a refused request touches nothing; the client repeats the same checks.
  const input = args as { repo?: unknown; publicRepository?: unknown; question?: unknown };
  const checks = [checkRepoName(input.repo), checkVisibility(input.publicRepository ? "public" : undefined), ...(args.action === "ask" ? [checkQuestion(input.question)] : [])];
  const refused = checks.find(check => !check.ok);
  if (refused && !refused.ok)
    return { docs: true, action: args.action, ok: false, access: { mode: "none", reason: refused.message }, warnings: [],
      failure: { kind: "invalid_arguments", message: refused.message, retryable: false, stage: "validate" } };

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
    const client = new DocsClient({ caller, timeoutMs: args.timeoutMs ?? 30_000 });
    const accessInfo = { mode: access.mode } as const;
    progress("Reading DeepWiki documentation...");
    const target = { repoName: args.repo, visibility: "public" as const };
    const result = args.action === "ask" ? await client.ask({ ...target, question: args.question })
      : args.action === "structure" ? await client.structure(target) : await client.contents(target);
    if (!result.ok) return { docs: true, action: args.action, ok: false, access: accessInfo, warnings: [], failure: { ...result.failure, stage: result.stage }, metrics: client.metrics() };
    const { ok: _ok, ...answer } = result;
    return { docs: true, action: args.action, ok: true, access: accessInfo, warnings: [], answer, metrics: client.metrics() };
  } finally { await access.release?.(); }
}
