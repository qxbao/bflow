import { z } from "zod";
import { AgentRoleSchema, FailoverCandidateSchema, ProviderFailoverPolicySchema, ProviderFailureObservationSchema, type FailoverCandidate } from "@bflow/contracts";

const readiness = z.object({ candidate: FailoverCandidateSchema, ready: z.boolean(), capabilities: z.boolean(), tools: z.boolean(),
  permission: z.boolean(), rolePolicy: z.boolean(), independent: z.boolean() }).strict();
const inputSchema = z.object({
  now: z.string().datetime({ offset: true }), failure: ProviderFailureObservationSchema, current: FailoverCandidateSchema,
  policy: ProviderFailoverPolicySchema, switchHistory: z.array(z.object({ candidate: FailoverCandidateSchema,
    switchedAt: z.string().datetime({ offset: true }) }).strict()), retryCount: z.number().int().nonnegative(),
  task: z.object({ role: AgentRoleSchema, executionId: z.string().trim().min(1).max(200), cancelled: z.boolean(), delivery: z.enum(["reconciled", "unknown"]), mutation: z.enum(["reconciled", "unknown"]),
    oldExecution: z.enum(["stopped", "running", "unknown"]), lease: z.enum(["current", "stale", "unknown"]) }).strict(),
  readiness: z.array(readiness),
  attemptedCandidates: z.array(FailoverCandidateSchema).optional()
}).strict();
export type FailoverDecision = { kind: "blocked"; reason: string } | { kind: "wait"; reason: string; until?: string } |
  { kind: "retry_after"; until: string } | { kind: "eligible_fallback"; candidate: FailoverCandidate };
const key = (candidate: FailoverCandidate) => JSON.stringify([candidate.provider, candidate.model, candidate.profile]);
const blocked = (reason: string): FailoverDecision => ({ kind: "blocked", reason });

/** Pure policy evaluation. Readiness facts and the observation must be verified by the caller at ingress. */
export function evaluateFailover(raw: unknown): FailoverDecision {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return blocked("invalid_input");
  const { now, failure, current, policy, task, switchHistory, retryCount, readiness: facts } = parsed.data;
  const time = Date.parse(now);
  if (failure.provider !== current.provider || failure.executionId !== task.executionId || policy.role !== task.role || Date.parse(failure.observedAt) > time) return blocked("failure_binding_mismatch");
  if (task.cancelled) return blocked("cancelled");
  if (task.delivery !== "reconciled") return blocked("unreconciled_delivery");
  if (task.mutation !== "reconciled") return blocked("unreconciled_mutation");
  if (task.lease !== "current") return blocked("lease_not_current");
  if (failure.kind === "transient_rate_limit") {
    if (retryCount >= policy.maxRetries) return blocked("retry_budget_exhausted");
    return { kind: "retry_after", until: failure.retryAfter ?? new Date(Date.parse(failure.observedAt) + Math.min(900_000, 60_000 * 2 ** retryCount)).toISOString() };
  }
  if (task.oldExecution !== "stopped") return blocked("old_execution_not_stopped");
  if (failure.kind !== "quota_exhausted" && failure.kind !== "provider_unavailable") return blocked("failure_not_eligible");
  if (switchHistory.length >= policy.maxSwitches) return blocked("switch_budget_exhausted");
  if (switchHistory.some(item => Date.parse(item.switchedAt) > time)) return blocked("invalid_switch_history");
  const lastSwitch = Math.max(0, ...switchHistory.map(item => Date.parse(item.switchedAt)));
  if (lastSwitch && time < lastSwitch + policy.cooldownMs) return { kind: "wait", reason: "cooldown", until: new Date(lastSwitch + policy.cooldownMs).toISOString() };
  const tried = new Set([key(current), ...switchHistory.map(item => key(item.candidate)), ...parsed.data.attemptedCandidates?.map(key) ?? []]);
  for (const candidate of policy.candidates) {
    if (tried.has(key(candidate))) continue;
    const matches = facts.filter(fact => key(fact.candidate) === key(candidate));
    if (matches.length === 1 && Object.entries(matches[0]!).every(([name, value]) => name === "candidate" || value === true))
      return { kind: "eligible_fallback", candidate };
  }
  return blocked("no_eligible_candidate");
}
