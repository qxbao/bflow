import { createHash } from "node:crypto";
import { ProviderFailureBindingSchema, ProviderNativeFailureEventSchema, ProviderFailureObservationSchema,
  type ProviderFailureObservation } from "@bflow/contracts";

/** Only call after authenticating the native event's exact launch/session/execution. No pane/text classifier exists. */
export function classifyProviderFailure(rawEvent: unknown, rawBinding: unknown): ProviderFailureObservation {
  const binding = ProviderFailureBindingSchema.parse(rawBinding);
  const parsed = ProviderNativeFailureEventSchema.safeParse(rawEvent);
  let kind: ProviderFailureObservation["kind"] = "unknown";
  if (parsed.success) {
    const event = parsed.data;
    if (binding.provider === "claude" && "hook_event_name" in event) {
      if (event.error === "rate_limit") kind = "transient_rate_limit";
      if (["authentication_failed", "cloud_credential_error"].includes(event.error)) kind = "authentication_failure";
      if (["oauth_org_not_allowed", "account_on_hold"].includes(event.error)) kind = "permission_failure";
      if (["overloaded", "server_error"].includes(event.error)) kind = "provider_unavailable";
      // billing_error and rate_limit do not prove a long-lived quota exhaustion.
    }
    if (binding.provider === "codex" && "payload" in event) {
      const info = event.payload.codex_error_info;
      const mapping: Record<string, ProviderFailureObservation["kind"]> = { usage_limit_exceeded: "quota_exhausted",
        rate_limit_exceeded: "transient_rate_limit", unauthorized: "authentication_failure", sandbox_error: "permission_failure",
        internal_server_error: "provider_unavailable", server_overloaded: "provider_unavailable", flex_unavailable: "provider_unavailable" };
      if (typeof info === "string") kind = mapping[info] ?? "unknown";
      else if (Object.keys(info).length === 1) {
        const [code, details] = Object.entries(info)[0]!;
        if (["http_connection_failed", "response_stream_connection_failed", "response_stream_disconnected", "response_too_many_failed_attempts"].includes(code)) {
          if (details.http_status_code === 429) kind = "transient_rate_limit";
          else if (details.http_status_code === 401) kind = "authentication_failure";
          else if (details.http_status_code === 403) kind = "permission_failure";
          else if (details.http_status_code && details.http_status_code >= 500) kind = "provider_unavailable";
        }
      }
    }
  }
  return ProviderFailureObservationSchema.parse({ schemaVersion: 3, ...binding, kind, source: "provider_structured",
    evidenceDigest: createHash("sha256").update(JSON.stringify(parsed.success ? parsed.data : { unrecognized: true })).digest("hex") });
}
