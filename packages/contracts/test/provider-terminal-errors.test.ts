import { describe, expect, it } from "vitest";
import { ProviderNativeFailureEventSchema } from "../src/index.js";

// Shape observed from Codex 0.166.0 under a controlled native protocol spike.
// Native transport/session authentication remains the host's responsibility.
const terminal = (error: unknown) => ({ type: "event_msg", payload: {
  type: "task_complete", turn_id: "turn-actual", root_turn_id: "turn-actual", error
} });

describe("Codex terminal failure ingress compatibility", () => {
  it("normalizes the observed terminal quota code without retaining error prose or turn metadata", () => {
    expect(ProviderNativeFailureEventSchema.parse(terminal({ codex_error_info: "usage_limit_exceeded", message: "private-error" })))
      .toEqual({ type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } });
  });
  it("retains HTTP failure classification data and discards unrecognized fields", () => {
    expect(ProviderNativeFailureEventSchema.parse(terminal({ codex_error_info: {
      http_connection_failed: { http_status_code: 429, message: "private-error" }
    }, message: "private-error" }))).toEqual({ type: "event_msg", payload: {
      type: "error", codex_error_info: { http_connection_failed: { http_status_code: 429 } }
    } });
  });
  it("maps an unknown terminal code to unknown rather than deriving quota from prose", () => {
    expect(ProviderNativeFailureEventSchema.parse(terminal({ codex_error_info: "future_code", message: "usage_limit_exceeded" })))
      .toEqual({ type: "event_msg", payload: { type: "error", codex_error_info: "unknown" } });
  });
  it.each([undefined, null, "usage_limit_exceeded", { message: "usage_limit_exceeded" }, { codex_error_info: 429 },
    { codex_error_info: { http_connection_failed: { http_status_code: 99 } } }])("rejects missing or malformed structured terminal errors: %j", error => {
    expect(ProviderNativeFailureEventSchema.safeParse(terminal(error)).success).toBe(false);
  });
  it("requires a native terminal turn identity and never reads a nested error from assistant prose", () => {
    const event = terminal({ codex_error_info: "usage_limit_exceeded" });
    expect(ProviderNativeFailureEventSchema.safeParse({ ...event, payload: { ...event.payload, turn_id: undefined } }).success).toBe(false);
    expect(ProviderNativeFailureEventSchema.safeParse({ ...event, payload: { ...event.payload, type: "agent_message" } }).success).toBe(false);
  });
  it("preserves existing direct Codex and Claude ingress projections", () => {
    expect(ProviderNativeFailureEventSchema.parse({ type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } }))
      .toEqual({ type: "event_msg", payload: { type: "error", codex_error_info: "usage_limit_exceeded" } });
    expect(ProviderNativeFailureEventSchema.parse({ hook_event_name: "StopFailure", error: "rate_limit", message: "private-error" }))
      .toEqual({ hook_event_name: "StopFailure", error: "rate_limit" });
  });
});
