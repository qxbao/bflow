import { describe, expect, it } from "vitest";
import { evaluateFailover } from "../../src/platform/failover-decision.js";

const now = "2026-10-28T00:00:00.000Z";
const current = { provider: "claude", model: "m1", profile: "p1" } as const;
const target = { provider: "codex", model: "m2", profile: "p2" } as const;
const base = {
  now, failure: { schemaVersion: 3, provider: "claude", kind: "quota_exhausted", source: "provider_structured", observedAt: now, executionId: "exec-1", evidenceDigest: "a".repeat(64) },
  current, policy: { schemaVersion: 3, policyVersion: "p1", role: "developer", candidates: [target], maxSwitches: 2, cooldownMs: 1000, maxRetries: 2 },
  switchHistory: [], retryCount: 0, task: { role: "developer", executionId: "exec-1", cancelled: false, delivery: "reconciled", mutation: "reconciled", oldExecution: "stopped", lease: "current" },
  readiness: [{ candidate: target, ready: true, capabilities: true, tools: true, permission: true, rolePolicy: true, independent: true }]
};

describe("failover decision", () => {
  it("selects only an approved ready candidate after a confirmed quota failure", () => {
    expect(evaluateFailover(base)).toMatchObject({ kind: "eligible_fallback", candidate: target });
  });
  it.each(["unknown_delivery", "running", "cancelled", "stale_lease", "uncertain_mutation"])("blocks %s", condition => {
    const task = { ...base.task, ...(condition === "unknown_delivery" ? { delivery: "unknown" } : {}),
      ...(condition === "running" ? { oldExecution: "running" } : {}), ...(condition === "cancelled" ? { cancelled: true } : {}),
      ...(condition === "stale_lease" ? { lease: "stale" } : {}), ...(condition === "uncertain_mutation" ? { mutation: "unknown" } : {}) };
    expect(evaluateFailover({ ...base, task }).kind).toBe("blocked");
  });
  it.each(["capabilities", "tools", "permission", "rolePolicy", "independent", "ready"])("rejects candidate without %s", field => {
    expect(evaluateFailover({ ...base, readiness: [{ ...base.readiness[0], [field]: false }] }).kind).toBe("blocked");
  });
  it.each(["authentication_failure", "permission_failure", "unknown"])("blocks %s", kind => {
    expect(evaluateFailover({ ...base, failure: { ...base.failure, kind } }).kind).toBe("blocked");
  });
  it("waits for transient rate limit rather than treating it as quota", () => {
    expect(evaluateFailover({ ...base, failure: { ...base.failure, kind: "transient_rate_limit", retryAfter: "2026-10-28T00:01:00.000Z" } })).toMatchObject({ kind: "retry_after" });
  });
  it("does not repeat an attempted candidate or exceed the switch budget", () => {
    expect(evaluateFailover({ ...base, switchHistory: [{ candidate: target, switchedAt: "2026-10-27T23:00:00.000Z" }] }).kind).toBe("blocked");
    expect(evaluateFailover({ ...base, policy: { ...base.policy, maxSwitches: 0 } }).kind).toBe("blocked");
  });
  it("waits for cooldown and never infers a quota reset", () => {
    const previous = { provider: "agy", model: "m3", profile: "p3" };
    expect(evaluateFailover({ ...base, switchHistory: [{ candidate: previous, switchedAt: now }] }).kind).toBe("wait");
    expect(evaluateFailover({ ...base, policy: { ...base.policy, candidates: [] } }).kind).toBe("blocked");
  });
  it("rejects raw pane text as failure evidence", () => {
    expect(evaluateFailover({ ...base, failure: { ...base.failure, source: "pane_text" } }).kind).toBe("blocked");
  });
  it("rejects observations and policies bound to a different execution or role", () => {
    expect(evaluateFailover({ ...base, failure: { ...base.failure, executionId: "old-exec" } }).kind).toBe("blocked");
    expect(evaluateFailover({ ...base, task: { ...base.task, role: "reviewer" } }).kind).toBe("blocked");
  });
});
