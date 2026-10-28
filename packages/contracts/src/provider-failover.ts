import { z } from "zod";
import { AgentProviderIdSchema } from "./platform.js";
import { AgentRoleSchema } from "./session.js";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
const selection = IdentifierSchema.refine(value => /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value) && !value.includes("://") && !/^(?:sk-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|bearer)/i.test(value), "Unsafe declarative selection");

/** Exact approved selection; profile is explicit so a provider default cannot silently select another account. */
export const FailoverCandidateSchema = z.object({
  provider: AgentProviderIdSchema, model: selection, profile: selection.refine(value => /^[A-Za-z0-9._-]+$/.test(value), "Invalid profile name")
}).strict();
export type FailoverCandidate = z.infer<typeof FailoverCandidateSchema>;
const relativeScope = z.string().trim().min(1).max(4096).refine(path => !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").includes(".."), "Invalid relative path scope");
export const DeveloperContinuationAllocationSchema = z.object({
  schemaVersion: z.literal(3), sourceBindingId: IdentifierSchema, allocationTaskId: IdentifierSchema, runId: IdentifierSchema,
  worktreePath: z.string().min(1).max(4096), revision: z.string().regex(/^[a-f0-9]{40}$/),
  ownedPaths: z.array(relativeScope).min(1).max(200), forbiddenPaths: z.array(relativeScope).max(200)
}).strict();
export type DeveloperContinuationAllocation = z.infer<typeof DeveloperContinuationAllocationSchema>;

export const ProviderFailoverPolicySchema = z.object({
  schemaVersion: z.literal(3), policyVersion: selection, role: AgentRoleSchema,
  candidates: z.array(FailoverCandidateSchema).max(16), maxSwitches: z.number().int().min(0).max(16),
  cooldownMs: z.number().int().min(0).max(86_400_000), maxRetries: z.number().int().min(0).max(16)
}).strict().superRefine((policy, ctx) => {
  const identities = policy.candidates.map(c => JSON.stringify([c.provider, c.model, c.profile]));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: "custom", message: "duplicate fallback candidate" });
  if (policy.maxSwitches + policy.maxRetries > 16) ctx.addIssue({ code: "custom", message: "combined continuation budget exceeds 16" });
});
export type ProviderFailoverPolicy = z.infer<typeof ProviderFailoverPolicySchema>;

/** This is a sanitized assertion from a trusted adapter boundary, never pane text or raw provider output. */
export const ProviderFailureObservationSchema = z.object({
  schemaVersion: z.literal(3), provider: AgentProviderIdSchema,
  kind: z.enum(["quota_exhausted", "transient_rate_limit", "authentication_failure", "permission_failure", "provider_unavailable", "unknown"]),
  source: z.literal("provider_structured"), observedAt: IsoDateTimeSchema, executionId: IdentifierSchema,
  retryAfter: IsoDateTimeSchema.optional(), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((failure, ctx) => {
  if (failure.retryAfter && Date.parse(failure.retryAfter) < Date.parse(failure.observedAt))
    ctx.addIssue({ code: "custom", message: "retry time precedes observation" });
});
export type ProviderFailureObservation = z.infer<typeof ProviderFailureObservationSchema>;

export const ProviderFailureBindingSchema = z.object({ provider: AgentProviderIdSchema, executionId: IdentifierSchema,
  observedAt: IsoDateTimeSchema }).strict();
/** Native event projection: prose and error details are deliberately discarded at ingress. */
export const ProviderNativeFailureEventSchema = z.union([
  z.object({ hook_event_name: z.literal("StopFailure"), error: z.string().max(100).transform(code =>
    ["rate_limit", "overloaded", "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "invalid_request", "model_not_found", "server_error", "max_output_tokens", "cloud_credential_error"].includes(code) ? code : "unknown") }),
  z.object({ type: z.literal("event_msg"), payload: z.object({ type: z.literal("error"),
    codex_error_info: z.union([z.string().max(100).transform(code => ["usage_limit_exceeded", "rate_limit_exceeded", "unauthorized", "sandbox_error", "internal_server_error", "server_overloaded", "flex_unavailable"].includes(code) ? code : "unknown"),
      z.record(z.object({ http_status_code: z.number().int().min(100).max(599).nullable().optional() })).transform(info => {
        const keys = Object.keys(info);
        return keys.length === 1 && ["http_connection_failed", "response_stream_connection_failed", "response_stream_disconnected", "response_too_many_failed_attempts"].includes(keys[0]!) ? info : "unknown";
      })]) }) })
]);
