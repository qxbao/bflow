import { describe, expect, it } from "vitest";
import { EnvironmentRoleConfigSchema } from "../src/environment-config.js";
const policy = { schemaVersion: 3, policyVersion: "approved-1", role: "developer",
  candidates: [{ provider: "codex", model: "m2", profile: "backup" }], maxSwitches: 2, cooldownMs: 1000, maxRetries: 2 };
describe("approved role failover configuration", () => {
  it("preserves an optional exact chain and keeps old configuration valid", () => {
    expect(EnvironmentRoleConfigSchema.parse({ role: "developer", cli: "claude" }).failover).toBeUndefined();
    expect(EnvironmentRoleConfigSchema.parse({ role: "developer", cli: "claude", model: "m1", "profile-name": "primary", failover: policy }).failover).toEqual(policy);
  });
  it("rejects a policy for another governance role or an implicit primary account/model", () => {
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "reviewer", cli: "claude", model: "m1", "profile-name": "primary", failover: policy }).success).toBe(false);
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "developer", cli: "claude", failover: policy }).success).toBe(false);
  });
});
