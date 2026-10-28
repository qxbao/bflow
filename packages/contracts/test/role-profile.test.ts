import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { workflow } from "./fixtures.js";

const definition = { schemaVersion: 3, profileId: "backend-developer", version: "1.0.0", displayName: "Backend Developer",
  baseRole: "developer", additionalInstructions: "Prefer small database transactions.", skillPins: [], toolRequirements: [], restrictions: {} };
describe("RP-01 custom specialist profile ingress", () => {
  it("accepts a direct specialist profile and preserves the governance enum", () => {
    expect(contracts.CustomRoleProfileSchema.parse(definition)).toEqual(definition);
    expect(contracts.AgentRoleSchema.safeParse("backend-developer").success).toBe(false);
  });
  it.each(["conversation", "coordinator", "backend-developer"])("rejects base %s and profile chains", baseRole => {
    expect(contracts.CustomRoleProfileSchema.safeParse({ ...definition, baseRole }).success).toBe(false);
  });
  it.each([{ approvalAuthority: true }, { canDelegateToSpecialist: true }, { permissionMode: "unattended_isolated" }])("rejects authority additions %j", fields => {
    expect(contracts.CustomRoleProfileSchema.safeParse({ ...definition, ...fields }).success).toBe(false);
    expect(contracts.CustomRoleProfileSchema.safeParse({ ...definition, restrictions: fields }).success).toBe(false);
  });
  it.each(["latest", "^1.0.0", "~1.2.0", "*", ">=1.0.0"])("rejects floating version %s", version => {
    expect(contracts.CustomRoleProfileSchema.safeParse({ ...definition, version }).success).toBe(false);
    expect(contracts.CustomRoleProfileSchema.safeParse({ ...definition, skillPins: [{ skillId: "test", version, digest: "a".repeat(64) }] }).success).toBe(false);
  });
  it.each(["../escape", "/etc", "src/../secrets", "src/**", "src\\file", ".git", ".bflow/state"])("rejects unsafe restriction %s", path => {
    expect(contracts.CustomRoleProfileSchema.safeParse({ ...definition, restrictions: { writablePaths: [path] } }).success).toBe(false);
  });
  it("binds snapshot to exact normalized definition bytes and role", () => {
    const pin = contracts.pinRoleProfile(definition);
    const snapshot = { schemaVersion: 3, pin, definition, baseRolePolicyDigest: "b".repeat(64), resolutionPolicyVersion: "custom-specialist-profiles-v1" };
    expect(contracts.ResolvedRoleProfileSnapshotSchema.parse(snapshot).pin).toEqual(pin);
    expect(contracts.ResolvedRoleProfileSnapshotSchema.safeParse({ ...snapshot, definition: { ...definition, additionalInstructions: "changed" } }).success).toBe(false);
    expect(contracts.SpecialistProfileSelectionSchema.safeParse({ role: "coordinator", profile: pin }).success).toBe(false);
  });
  it("exposes specialist pins separately from native profiles in execution plans", () => {
    const pin = contracts.pinRoleProfile(definition);
    expect(contracts.PlanFieldSchema.safeParse("roles.developer.specialistProfile").success).toBe(true);
    expect(contracts.isPlanFieldValue("roles.developer.specialistProfile", pin)).toBe(true);
    expect(contracts.isPlanFieldValue("roles.developer.specialistProfile", "native-profile-name")).toBe(false);
    expect(contracts.PlanLocatorSchema.safeParse("environment.roles.developer.specialistProfile").success).toBe(true);
    expect(contracts.PlanBlockerCodeSchema.safeParse("specialist_profile_policy_unavailable").success).toBe(true);
  });
  it("checks profiled task governance role while preserving old tasks", () => {
    const task = workflow([]).tasks[0]!;
    expect(contracts.TaskDefinitionSchema.safeParse(task).success).toBe(true);
    const roleProfile = contracts.pinRoleProfile(definition);
    expect(contracts.TaskDefinitionSchema.parse({ ...task, role: "developer", roleProfile }).roleProfile).toEqual(roleProfile);
    expect(contracts.TaskDefinitionSchema.safeParse({ ...task, role: "coordinator", roleProfile }).success).toBe(false);
  });
});
