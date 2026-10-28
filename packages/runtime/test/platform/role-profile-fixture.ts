import { pinRoleProfile, ROLE_PROFILE_FEATURE, type CustomRoleProfile, type ResolvedRoleProfileSnapshot } from "@bflow/contracts";
import { baseRolePolicyDigest } from "../../src/platform/role-profiles.js";
export function profile(overrides: Partial<CustomRoleProfile> = {}): ResolvedRoleProfileSnapshot {
  const definition: CustomRoleProfile = { schemaVersion: 3, profileId: "backend-developer", version: "1.0.0",
    displayName: "Backend Developer", baseRole: "developer", additionalInstructions: "Implement backend APIs.",
    skillPins: [], toolRequirements: [], restrictions: {}, ...overrides };
  return { schemaVersion: 3, definition, pin: pinRoleProfile(definition), baseRolePolicyDigest: baseRolePolicyDigest(definition.baseRole), resolutionPolicyVersion: ROLE_PROFILE_FEATURE };
}
