import { describe, expect, it } from "vitest";
import { AgenticHostPlatformOptionsSchema, HostLaunchMaterialSchema, HostRoleLaunchSchema } from "../../src/platform/host-options.js";
import { profile } from "./role-profile-fixture.js";
import { computeLaunchFingerprint } from "@bflow/agent-providers";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";

const role = { provider: "claude", required: true, permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] };
const options = () => ({ schemaVersion: 3, machineId: "machine", repositoryId: "repo", skillsStoreRoot: "/skills", approvedBuiltinSkillDigests: [],
  roles: [{ ...role, role: "conversation" }, { ...role, role: "coordinator" }, { ...role, role: "developer", specialistProfile: profile().pin }], roleProfiles: [profile()] });
const material = () => ({ provider: "claude", argv: [], env: {}, launchId: "launch", launchFingerprint: "a".repeat(64), roleProfile: profile().pin, features: ["custom-specialist-profiles-v1"] });

describe("role profile platform wire joins", () => {
  it("joins defaults to their exact catalog pin and base role", () => {
    expect(AgenticHostPlatformOptionsSchema.safeParse(options()).success).toBe(true);
    expect(AgenticHostPlatformOptionsSchema.safeParse({ ...options(), roleProfiles: [] }).success).toBe(false);
    const wrongRole = options(); wrongRole.roles[0]!.specialistProfile = profile().pin;
    expect(AgenticHostPlatformOptionsSchema.safeParse(wrongRole).success).toBe(false);
    expect(AgenticHostPlatformOptionsSchema.safeParse({ ...options(), roleProfiles: [profile({ additionalInstructions: "changed" })] }).success).toBe(false);
  });
  it("requires feature support and an exact pin through host launch material", () => {
    expect(HostLaunchMaterialSchema.safeParse(material()).success).toBe(true);
    expect(HostLaunchMaterialSchema.safeParse({ ...material(), features: [] }).success).toBe(false);
    const launch = { systemPrompt: "original", mcpConfigFile: "/mcp", hooksSettingsFile: "/hooks", roleProfile: profile().pin, launch: material() };
    expect(HostRoleLaunchSchema.safeParse(launch).success).toBe(true);
    expect(HostRoleLaunchSchema.safeParse({ ...launch, roleProfile: profile({ profileId: "data-engineer" }).pin }).success).toBe(false);
    expect(HostRoleLaunchSchema.safeParse({ ...launch, launch: undefined }).success).toBe(false);
    expect(HostRoleLaunchSchema.safeParse({ systemPrompt: "original", mcpConfigFile: "/mcp", hooksSettingsFile: "/hooks" }).success).toBe(true);
  });
  it("binds typed pins independently in provider launch fingerprints", () => {
    const identity = { machineId: "m", repositoryId: "r", workspaceRoot: "/repo", sessionId: "s", generation: 1, stateDirectory: "/state" };
    const environment = new RoleEnvironmentResolver().resolve(identity, { role: "developer", provider: "claude", required: true, permissionMode: "restricted", cwd: "/repo", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] }, { skillManifestDigest: "b".repeat(64) });
    if (!environment.ok) throw new Error("environment failed");
    const input = { environment: { ...environment.value, roleProfile: profile().pin }, executableDigest: "c".repeat(64), providerVersion: "test", argv: [], configFiles: [], interaction: "no_direct_user_input" as const };
    expect(computeLaunchFingerprint(input)).not.toBe(computeLaunchFingerprint({ ...input, environment: { ...input.environment, roleProfile: profile({ profileId: "data-engineer" }).pin } }));
  });
});
