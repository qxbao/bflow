import type { DocsFailureKind, ProbeCheck } from "@bflow/docs-retrieval";
import { DocsClient } from "@bflow/docs-retrieval";
import { CONTEXT7_SERVICE, GatewayDocsCaller, discoverAgentAccess, enrollOperatorAccess, type DocsAccess } from "./docs-gateway.js";
import { readStoredContext7Key } from "./context7-secret.js";
import { readGatewayReadiness, type ServiceReadiness } from "./gateway-readiness.js";
import type { RepositoryIdentity } from "./repository.js";

export type HealthStatus = "pass" | "warn" | "fail" | "skipped";

export interface Context7HealthCheck {
  readonly id: "enabled" | "gateway" | "service" | "authentication" | "connection" | "discovery" | "resolve-library-id" | "query-docs" | "quota" | "access";
  readonly status: HealthStatus;
  readonly message: string;
  readonly remediation?: string;
  /** Present when the check failed for a classified reason. */
  readonly failureKind?: DocsFailureKind;
}

export type Context7State = "disabled" | "healthy" | "degraded" | "unavailable";

export interface Context7Health {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly state: Context7State;
  readonly checks: readonly Context7HealthCheck[];
  /** How the live probe reached the Gateway, or why it did not run. */
  readonly probe: { readonly mode: "agent" | "operator" | "none"; readonly reason?: string };
  /** Provider access is derived from configuration (which roles are granted), not from a running session. */
  readonly providers: ReadonlyArray<{ readonly provider: string; readonly granted: boolean; readonly roles: readonly string[] }>;
  readonly serviceReadiness: Pick<ServiceReadiness, "gateway" | "status" | "discoveredTools" | "observedAt" | "ageMs" | "diagnosticCode">;
}

export interface Context7HealthInput {
  readonly context7: { readonly enabled?: boolean | undefined; readonly required?: boolean | undefined } | undefined;
  readonly roles: ReadonlyArray<{ readonly role: string; readonly cli: string }>;
  /** Roles whose approved `use-context7` skill definition allows them to use it. */
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
    readonly keyStatus?: () => Promise<Awaited<ReturnType<typeof readStoredContext7Key>>>;
  };
}
export type GatewayTargetHolder = Extract<DocsAccess, { target: unknown }>;

const FAILURE_REMEDIATION: Record<DocsFailureKind, string> = {
  network: "Check the network connection to context7.com (and any proxy), then rerun. Documentation lookups degrade until it returns.",
  timeout: "Context7 answered too slowly. Retry; if it persists check network latency.",
  auth_missing: "The Gateway was configured with an API key it cannot read. Store the key again: printf %s \"$KEY\" | bflow setup --apply --context7-api-key-stdin.",
  auth_invalid: "Context7 rejected the API key. Create a key at https://context7.com/dashboard and store it: printf %s \"$KEY\" | bflow setup --apply --context7-api-key-stdin.",
  rate_limited: "Context7's rate or quota limit was reached. Wait for the stated delay, or store an API key for higher limits.",
  library_not_found: "The probe library was not found, which suggests the service answered unexpectedly. Rerun later.",
  version_not_found: "The probe version was not found. Rerun later.",
  no_documentation: "Context7 returned no documentation for the probe. Rerun later.",
  invalid_arguments: "Context7 rejected the probe arguments, which suggests an incompatible service version. Report it.",
  permission_denied: "This role has no Context7 grant. Enable environment.context7 in .bflow/config.yml and restart with 'bflow up'.",
  unavailable: "The Gateway or Context7 is unavailable. Run 'bflow setup --apply' to restart the Gateway.",
  upstream_error: "Context7 reported an error. Rerun; if it persists, report it with the message shown.",
  protocol: "Context7 or the Gateway sent an unexpected response. Run 'bflow setup --repair'."
};

/**
 * The refusal `bflow up` raises when the repository marks Context7 required and it is not ready, or undefined when startup may
 * proceed (not required, disabled, or healthy). Optional Context7 never blocks startup.
 */
export function requiredContext7Refusal(health: Pick<Context7Health, "enabled" | "required" | "checks">): string | undefined {
  if (!health.enabled || !health.required) return undefined;
  const failing = health.checks.find(check => check.status === "fail");
  return failing ? `Required Context7 documentation service is not ready: ${failing.message} Remediation: ${failing.remediation ?? "Run 'bflow doctor' for details."}` : undefined;
}

const PROBE_LABEL: Record<ProbeCheck["name"], Context7HealthCheck["id"]> = { discovery: "discovery", "resolve-library-id": "resolve-library-id", "query-docs": "query-docs" };

/**
 * One definition of "Context7 is healthy", shared by `bflow docs status` and `bflow doctor`. An HTTP answer is never enough:
 * the service must be listed ready by the Gateway, expose both tools, and both tools must work with a real call.
 * When `required` is false a problem yields `degraded`, not `unavailable`: roles start without documentation lookup.
 */
export async function evaluateContext7Health(input: Context7HealthInput): Promise<Context7Health> {
  const enabled = input.context7?.enabled === true;
  const required = input.context7?.required === true;
  const checks: Context7HealthCheck[] = [];
  const deps = input.deps ?? {};
  const readiness = await (deps.readiness ?? readGatewayReadiness)(input.stateDirectory, CONTEXT7_SERVICE);
  const providers = ["claude", "codex", "agy"].map(provider => {
    const roles = input.roles.filter(item => item.cli === provider && input.grantedRoles.includes(item.role) && item.role !== "conversation").map(item => item.role);
    return { provider, granted: roles.length > 0, roles };
  });
  const base = { enabled, required, providers, serviceReadiness: { gateway: readiness.gateway, status: readiness.status, discoveredTools: readiness.discoveredTools,
    ...(readiness.observedAt ? { observedAt: readiness.observedAt } : {}), ...(readiness.ageMs !== undefined ? { ageMs: readiness.ageMs } : {}),
    ...(readiness.diagnosticCode ? { diagnosticCode: readiness.diagnosticCode } : {}) } };

  if (!enabled) {
    checks.push({ id: "enabled", status: "skipped", message: "Context7 is not enabled for this repository (environment.context7.enabled).",
      remediation: "Set environment.context7.enabled: true in .bflow/config.yml to let granted roles look documentation up." });
    return { ...base, state: "disabled", checks, probe: { mode: "none", reason: "disabled" } };
  }
  checks.push({ id: "enabled", status: "pass", message: `Context7 is enabled${required ? " and required" : " (optional: roles start without it when it is unavailable)"}.` });

  // Gateway reachability and what it reports for the service.
  if (readiness.gateway !== "running") {
    const why = readiness.gateway === "absent" ? "The Gateway has never published readiness." : readiness.gateway === "stale" ? "The Gateway's readiness receipt is stale or its process is gone." : "The Gateway's readiness receipt cannot be read.";
    checks.push({ id: "gateway", status: "fail", message: why, remediation: "Run 'bflow setup --apply' to install and start the shared MCP Gateway.", failureKind: "unavailable" });
  } else checks.push({ id: "gateway", status: "pass", message: `The Gateway is running (receipt ${Math.round((readiness.ageMs ?? 0) / 1000)}s old).` });

  if (readiness.gateway === "running") {
    if (readiness.status === "ready") checks.push({ id: "service", status: "pass", message: `The Gateway reports Context7 ready with ${readiness.discoveredTools.length} tool(s): ${readiness.discoveredTools.join(", ")}.` });
    else if (readiness.status === "missing") checks.push({ id: "service", status: "fail", message: "The Gateway does not list Context7.", remediation: "Run 'bflow setup --apply'. Setup adds Context7 unless it was run with --no-context7.", failureKind: "unavailable" });
    else checks.push({ id: "service", status: "fail", message: `The Gateway reports Context7 ${readiness.status}${readiness.diagnosticCode ? ` (${readiness.diagnosticCode})` : ""}.`, remediation: "Run 'bflow doctor' again after the network recovers, or 'bflow setup --repair'.", failureKind: "unavailable" });
  } else checks.push({ id: "service", status: "skipped", message: "The Gateway is not running, so the service state is unknown." });

  // Authentication mode, from the private key file (never its value).
  const stored = await (deps.keyStatus ?? (() => readStoredContext7Key({ state: input.stateDirectory })))();
  if (stored.status === "ok") checks.push({ id: "authentication", status: "pass", message: "An API key is stored; Context7 is used with higher rate limits." });
  else if (stored.status === "absent") checks.push({ id: "authentication", status: "pass", message: "No API key is stored; Context7 is used anonymously with lower rate limits." });
  else checks.push({ id: "authentication", status: "fail", message: `The stored API key cannot be used: ${stored.reason}`, remediation: FAILURE_REMEDIATION.auth_missing, failureKind: "auth_missing" });

  // Live probe with a real call through the Gateway under a real registration.
  let probe: Context7Health["probe"] = { mode: "none" };
  const wantProbe = input.probe !== false;
  const gatewayUsable = readiness.gateway === "running" && readiness.status === "ready";
  if (!wantProbe || !gatewayUsable) {
    const reason = !wantProbe ? "Live probing was not requested." : "The Gateway does not report Context7 ready, so no call was attempted.";
    for (const id of ["connection", "discovery", "resolve-library-id", "query-docs", "quota"] as const) checks.push({ id, status: "skipped", message: reason });
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
      for (const id of ["connection", "discovery", "resolve-library-id", "query-docs", "quota"] as const) checks.push({ id, status: "skipped", message: "No Gateway access." });
      probe = { mode: "none", reason: access.reason };
    } else {
      try {
        const caller = deps.caller ? deps.caller(access) : new GatewayDocsCaller(access.target);
        const client = new DocsClient({ caller, timeoutMs: input.timeoutMs ?? 20_000, authenticated: stored.status === "ok" });
        const results = await client.probe();
        probe = { mode: access.mode };
        const reached = results.some(item => item.status === "ok");
        const networkFault = results.find(item => item.failure && ["network", "timeout", "unavailable"].includes(item.failure.kind));
        checks.push(reached ? { id: "connection", status: "pass", message: "A real call through the Gateway reached Context7." }
          : { id: "connection", status: "fail", message: networkFault?.failure?.message ?? "No call reached Context7.", remediation: FAILURE_REMEDIATION[networkFault?.failure?.kind ?? "unavailable"], failureKind: networkFault?.failure?.kind ?? "unavailable" });
        for (const item of results) {
          const id = PROBE_LABEL[item.name];
          if (item.status === "ok") checks.push({ id, status: "pass", message: `${item.name} works${item.detail ? ` (${item.detail})` : ""} in ${item.latencyMs} ms.` });
          else if (item.status === "skipped") checks.push({ id, status: "skipped", message: item.detail ?? "Skipped because an earlier step failed." });
          else checks.push({ id, status: "fail", message: item.failure?.message ?? `${item.name} failed.`, remediation: item.failure ? FAILURE_REMEDIATION[item.failure.kind] : undefined,
            ...(item.failure ? { failureKind: item.failure.kind } : {}) } as Context7HealthCheck);
        }
        const limited = results.find(item => item.failure?.kind === "rate_limited");
        checks.push(limited ? { id: "quota", status: "warn", message: `Context7 reported a rate limit${limited.failure?.retryAfterMs ? ` (retry after ${Math.ceil(limited.failure.retryAfterMs / 1000)}s)` : ""}.`, remediation: FAILURE_REMEDIATION.rate_limited, failureKind: "rate_limited" }
          : { id: "quota", status: "pass", message: "No rate limit was reported by this probe. Remaining quota is not exposed by Context7." });
      } finally { await access.release?.(); }
    }
  }

  const failing = checks.filter(check => check.status === "fail");
  const state: Context7State = failing.length === 0 ? "healthy" : required ? "unavailable" : "degraded";
  return { ...base, state, checks, probe };
}
