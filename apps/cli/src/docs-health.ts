import type { DocsFailureKind, ProbeCheck } from "@bflow/docs-retrieval";
import { DocsClient } from "@bflow/docs-retrieval";
import { DEEPWIKI_SERVICE, GatewayDocsCaller, discoverAgentAccess, enrollOperatorAccess, type DocsAccess } from "./docs-gateway.js";
import { readGatewayReadiness, type ServiceReadiness } from "./gateway-readiness.js";
import type { RepositoryIdentity } from "./repository.js";

export type HealthStatus = "pass" | "warn" | "fail" | "skipped";

export interface DeepWikiHealthCheck {
  readonly id: "enabled" | "gateway" | "service" | "connection" | "discovery" | "read_wiki_structure" | "quota" | "access";
  readonly status: HealthStatus;
  readonly message: string;
  readonly remediation?: string;
  /** Present when the check failed for a classified reason. */
  readonly failureKind?: DocsFailureKind;
}

export type DeepWikiState = "disabled" | "healthy" | "degraded" | "unavailable";

export interface DeepWikiHealth {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly state: DeepWikiState;
  readonly checks: readonly DeepWikiHealthCheck[];
  /** How the live probe reached the Gateway, or why it did not run. */
  readonly probe: { readonly mode: "agent" | "operator" | "none"; readonly reason?: string };
  /** Provider access is derived from configuration (which roles are granted), not from a running session. */
  readonly providers: ReadonlyArray<{ readonly provider: string; readonly granted: boolean; readonly roles: readonly string[] }>;
  readonly serviceReadiness: Pick<ServiceReadiness, "gateway" | "status" | "discoveredTools" | "observedAt" | "ageMs" | "diagnosticCode">;
}

export interface DeepWikiHealthInput {
  readonly deepwiki: { readonly enabled?: boolean | undefined; readonly required?: boolean | undefined } | undefined;
  readonly roles: ReadonlyArray<{ readonly role: string; readonly cli: string }>;
  /** Roles whose approved `use-deepwiki` skill definition allows them to use it. */
  readonly grantedRoles: readonly string[];
  readonly stateDirectory: string;
  readonly machineId: string;
  readonly repository: RepositoryIdentity | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly probe?: boolean;
  readonly role?: string;
  readonly timeoutMs?: number;
  readonly deps?: {
    readonly readiness?: (stateDirectory: string, serviceId: string) => Promise<ServiceReadiness>;
    readonly access?: () => Promise<DocsAccess>;
    readonly caller?: (access: GatewayTargetHolder) => ConstructorParameters<typeof DocsClient>[0]["caller"];
  };
}
export type GatewayTargetHolder = Extract<DocsAccess, { target: unknown }>;

const FAILURE_REMEDIATION: Record<DocsFailureKind, string> = {
  network: "Check the network connection to mcp.deepwiki.com (and any proxy), then rerun. Documentation lookups degrade until it returns.",
  timeout: "DeepWiki answered too slowly. Retry; if it persists check network latency.",
  auth_missing: "DeepWiki needs no credential; rerun 'bflow setup --repair' to rewrite the service definition.",
  auth_invalid: "DeepWiki needs no credential; rerun 'bflow setup --repair' to rewrite the service definition.",
  rate_limited: "DeepWiki's rate limit was reached. Wait for the stated delay and retry.",
  library_not_found: "DeepWiki has no wiki for the probe repository, which suggests the service answered unexpectedly. Rerun later.",
  version_not_found: "DeepWiki did not recognise the request. Rerun later.",
  no_documentation: "DeepWiki returned no documentation for the probe. Rerun later.",
  invalid_arguments: "DeepWiki rejected the probe arguments, which suggests an incompatible service version. Report it.",
  permission_denied: "This role has no DeepWiki grant. Enable environment.deepwiki in .bflow/config.yml and restart with 'bflow up'.",
  unavailable: "The Gateway or DeepWiki is unavailable. Run 'bflow setup --apply' to restart the Gateway.",
  upstream_error: "DeepWiki reported an error. Rerun; if it persists, report it with the message shown.",
  protocol: "DeepWiki or the Gateway sent an unexpected response. Run 'bflow setup --repair'."
};

/**
 * The refusal `bflow up` raises when the repository marks DeepWiki required and it is not ready, or undefined when startup may
 * proceed (not required, disabled, or healthy). Optional DeepWiki never blocks startup.
 */
export function requiredDeepWikiRefusal(health: Pick<DeepWikiHealth, "enabled" | "required" | "checks">): string | undefined {
  if (!health.enabled || !health.required) return undefined;
  const failing = health.checks.find(check => check.status === "fail");
  return failing ? `Required DeepWiki documentation service is not ready: ${failing.message} Remediation: ${failing.remediation ?? "Run 'bflow doctor' for details."}` : undefined;
}

const PROBE_LABEL: Record<ProbeCheck["name"], DeepWikiHealthCheck["id"]> = { discovery: "discovery", read_wiki_structure: "read_wiki_structure" };
const PROBE_IDS = ["connection", "discovery", "read_wiki_structure", "quota"] as const;

/**
 * One definition of "DeepWiki is healthy", shared by `bflow docs status` and `bflow doctor`. An HTTP answer is never enough:
 * the service must be listed ready by the Gateway, expose its three tools, and a real read call must work.
 * When `required` is false a problem yields `degraded`, not `unavailable`: roles start without documentation lookup.
 */
export async function evaluateDeepWikiHealth(input: DeepWikiHealthInput): Promise<DeepWikiHealth> {
  const enabled = input.deepwiki?.enabled === true;
  const required = input.deepwiki?.required === true;
  const checks: DeepWikiHealthCheck[] = [];
  const deps = input.deps ?? {};
  const readiness = await (deps.readiness ?? readGatewayReadiness)(input.stateDirectory, DEEPWIKI_SERVICE);
  const providers = ["claude", "codex", "agy"].map(provider => {
    const roles = input.roles.filter(item => item.cli === provider && input.grantedRoles.includes(item.role) && item.role !== "conversation").map(item => item.role);
    return { provider, granted: roles.length > 0, roles };
  });
  const base = { enabled, required, providers, serviceReadiness: { gateway: readiness.gateway, status: readiness.status, discoveredTools: readiness.discoveredTools,
    ...(readiness.observedAt ? { observedAt: readiness.observedAt } : {}), ...(readiness.ageMs !== undefined ? { ageMs: readiness.ageMs } : {}),
    ...(readiness.diagnosticCode ? { diagnosticCode: readiness.diagnosticCode } : {}) } };

  if (!enabled) {
    checks.push({ id: "enabled", status: "skipped", message: "DeepWiki is not enabled for this repository (environment.deepwiki.enabled).",
      remediation: "Set environment.deepwiki.enabled: true in .bflow/config.yml to let granted roles read public repository documentation." });
    return { ...base, state: "disabled", checks, probe: { mode: "none", reason: "disabled" } };
  }
  checks.push({ id: "enabled", status: "pass", message: `DeepWiki is enabled${required ? " and required" : " (optional: roles start without it when it is unavailable)"}.` });

  // Gateway reachability and what it reports for the service.
  if (readiness.gateway !== "running") {
    const why = readiness.gateway === "absent" ? "The Gateway has never published readiness." : readiness.gateway === "stale" ? "The Gateway's readiness receipt is stale or its process is gone." : "The Gateway's readiness receipt cannot be read.";
    checks.push({ id: "gateway", status: "fail", message: why, remediation: "Run 'bflow setup --apply' to install and start the shared MCP Gateway.", failureKind: "unavailable" });
  } else checks.push({ id: "gateway", status: "pass", message: `The Gateway is running (receipt ${Math.round((readiness.ageMs ?? 0) / 1000)}s old).` });

  if (readiness.gateway === "running") {
    if (readiness.status === "ready") checks.push({ id: "service", status: "pass", message: `The Gateway reports DeepWiki ready with ${readiness.discoveredTools.length} tool(s): ${readiness.discoveredTools.join(", ")}.` });
    else if (readiness.status === "missing") checks.push({ id: "service", status: "fail", message: "The Gateway does not list DeepWiki.", remediation: "Run 'bflow setup --apply'. Setup adds DeepWiki unless it was run with --no-deepwiki.", failureKind: "unavailable" });
    else checks.push({ id: "service", status: "fail", message: `The Gateway reports DeepWiki ${readiness.status}${readiness.diagnosticCode ? ` (${readiness.diagnosticCode})` : ""}.`, remediation: "Run 'bflow doctor' again after the network recovers, or 'bflow setup --repair'.", failureKind: "unavailable" });
  } else checks.push({ id: "service", status: "skipped", message: "The Gateway is not running, so the service state is unknown." });

  // Live probe with a real call through the Gateway under a real registration.
  let probe: DeepWikiHealth["probe"] = { mode: "none" };
  const wantProbe = input.probe !== false;
  const gatewayUsable = readiness.gateway === "running" && readiness.status === "ready";
  if (!wantProbe || !gatewayUsable) {
    const reason = !wantProbe ? "Live probing was not requested." : "The Gateway does not report DeepWiki ready, so no call was attempted.";
    for (const id of PROBE_IDS) checks.push({ id, status: "skipped", message: reason });
    probe = { mode: "none", reason };
  } else {
    const access = await (deps.access ?? (async (): Promise<DocsAccess> => {
      if (input.repository) {
        const agent = await discoverAgentAccess(input.env, input.repository.root);
        if (agent) return { mode: "agent", target: agent };
        return enrollOperatorAccess({ stateDirectory: input.stateDirectory, machineId: input.machineId, repository: input.repository, role: input.role ?? "developer" });
      }
      return { mode: "none", kind: "no_gateway", reason: "Run this inside a Git repository." };
    }))();
    if (access.mode === "none") {
      const kind: DocsFailureKind = access.kind === "not_granted" ? "permission_denied" : "unavailable";
      checks.push({ id: "access", status: "fail", message: `No Gateway access for this check: ${access.reason}`, remediation: FAILURE_REMEDIATION[kind], failureKind: kind });
      for (const id of PROBE_IDS) checks.push({ id, status: "skipped", message: "No Gateway access." });
      probe = { mode: "none", reason: access.reason };
    } else {
      try {
        const caller = deps.caller ? deps.caller(access) : new GatewayDocsCaller(access.target);
        const client = new DocsClient({ caller, timeoutMs: input.timeoutMs ?? 20_000 });
        const results = await client.probe();
        probe = { mode: access.mode };
        const reached = results.some(item => item.status === "ok");
        const networkFault = results.find(item => item.failure && ["network", "timeout", "unavailable"].includes(item.failure.kind));
        checks.push(reached ? { id: "connection", status: "pass", message: "A real call through the Gateway reached DeepWiki." }
          : { id: "connection", status: "fail", message: networkFault?.failure?.message ?? "No call reached DeepWiki.", remediation: FAILURE_REMEDIATION[networkFault?.failure?.kind ?? "unavailable"], failureKind: networkFault?.failure?.kind ?? "unavailable" });
        for (const item of results) {
          const id = PROBE_LABEL[item.name];
          if (item.status === "ok") checks.push({ id, status: "pass", message: `${item.name} works${item.detail ? ` (${item.detail})` : ""} in ${item.latencyMs} ms.` });
          else if (item.status === "skipped") checks.push({ id, status: "skipped", message: item.detail ?? "Skipped because an earlier step failed." });
          else checks.push({ id, status: "fail", message: item.failure?.message ?? `${item.name} failed.`, remediation: item.failure ? FAILURE_REMEDIATION[item.failure.kind] : undefined,
            ...(item.failure ? { failureKind: item.failure.kind } : {}) } as DeepWikiHealthCheck);
        }
        const limited = results.find(item => item.failure?.kind === "rate_limited");
        checks.push(limited ? { id: "quota", status: "warn", message: `DeepWiki reported a rate limit${limited.failure?.retryAfterMs ? ` (retry after ${Math.ceil(limited.failure.retryAfterMs / 1000)}s)` : ""}.`, remediation: FAILURE_REMEDIATION.rate_limited, failureKind: "rate_limited" }
          : { id: "quota", status: "pass", message: "No rate limit was reported by this probe. Remaining quota is not exposed by DeepWiki." });
      } finally { await access.release?.(); }
    }
  }

  const failing = checks.filter(check => check.status === "fail");
  const state: DeepWikiState = failing.length === 0 ? "healthy" : required ? "unavailable" : "degraded";
  return { ...base, state, checks, probe };
}
