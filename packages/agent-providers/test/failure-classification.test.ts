import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "../src/failure-classification.js";
const binding = { provider: "codex", executionId: "exec", observedAt: "2026-10-28T00:00:00.000Z" };
describe("structured provider failure classification", () => {
  it.each([
    ["usage_limit_exceeded", "quota_exhausted"], ["rate_limit_exceeded", "transient_rate_limit"],
    ["unauthorized", "authentication_failure"], ["sandbox_error", "permission_failure"],
    ["internal_server_error", "provider_unavailable"], ["future_unknown_code", "unknown"]
  ])("classifies %s without relying on prose", (code, kind) => {
    const result = classifyProviderFailure({ type: "event_msg", payload: { type: "error", codex_error_info: code, message: "sensitive-output" } }, binding);
    expect(result.kind).toBe(kind);
    expect(JSON.stringify(result)).not.toContain("sensitive-output");
  });
  it("does not treat HTTP 429 or fake quota prose as long-term exhaustion", () => {
    expect(classifyProviderFailure({ type: "error", http_status_code: 429, message: "quota exhausted" }, binding).kind).toBe("unknown");
    expect(classifyProviderFailure({ type: "event_msg", payload: { type: "error", codex_error_info: { http_connection_failed: { http_status_code: 429 } } } }, binding).kind).toBe("transient_rate_limit");
    expect(classifyProviderFailure({ type: "event_msg", payload: { type: "agent_message", message: "usage_limit_exceeded" } }, binding).kind).toBe("unknown");
  });
  it("distinguishes Claude structured hook failures and ignores assistant text", () => {
    const claude = { ...binding, provider: "claude" };
    expect(classifyProviderFailure({ hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "quota exhausted" }, claude).kind).toBe("transient_rate_limit");
    expect(classifyProviderFailure({ hook_event_name: "StopFailure", error: "authentication_failed" }, claude).kind).toBe("authentication_failure");
    expect(classifyProviderFailure({ hook_event_name: "StopFailure", error: "billing_error" }, claude).kind).toBe("unknown");
    expect(classifyProviderFailure({ hook_event_name: "Stop", last_assistant_message: "quota exhausted" }, claude).kind).toBe("unknown");
  });
});
