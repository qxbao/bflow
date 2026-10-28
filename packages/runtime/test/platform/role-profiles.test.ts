import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profile } from "./role-profile-fixture.js";
import { ResolvedToolGrantSchema } from "@bflow/contracts";
import { appendRoleProfileInstructions, assertRoleProfilePin, profilePathAllowed, resolveRoleProfile, roleProfilePolicyDigest, persistRoleProfileSnapshot, loadRoleProfileSnapshot } from "../../src/platform/role-profiles.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import type { RolePlatformRequirement } from "../../src/platform/ports.js";
import { requirementFor } from "../../src/agentic/host-platform.js";
import { PlatformRoleOptionSchema } from "../../src/platform/host-options.js";

const requirement = (overrides: Partial<RolePlatformRequirement> = {}): RolePlatformRequirement => ({
  role: "developer", provider: "agy", required: true, permissionMode: "workspace_auto", cwd: "/repo", taskId: "t1",
  capabilityIds: ["code", "test"], mcpServiceIds: [], toolIds: ["search", "browser"], skillSelections: [], ...overrides
});

describe("custom role profile policy", () => {
  it("retains governance and mandatory skills, merges exact pins idempotently", () => {
    const pin = { skillId: "backend", version: "1.0.0", digest: "a".repeat(64) };
    const snapshot = profile({ skillPins: [pin] });
    const input = requirement({ skillSelections: [{ skill: pin, required: true, approvalReceiptId: "approved-1" }] });
    const output = resolveRoleProfile(snapshot, input);
    expect(output.role).toBe("developer");
    expect(output.skillSelections).toEqual(input.skillSelections);
    expect(resolveRoleProfile(snapshot, output)).toEqual(output);
    expect(resolveRoleProfile(snapshot, requirement({ skillSelections: [{ skill: pin, required: false, approvalReceiptId: "approved-1" }] })).skillSelections)
      .toEqual([{ skill: pin, required: true, approvalReceiptId: "approved-1" }]);
    expect(() => resolveRoleProfile(snapshot, requirement({ skillSelections: [{ skill: { ...pin, digest: "b".repeat(64) }, required: true }] }))).toThrow(/skill.*conflict/i);
  });
  it("never invents missing tool grants and rejects unavailable requirements", () => {
    expect(() => resolveRoleProfile(profile({ toolRequirements: [{ toolId: "search", operations: ["query"] }] }), requirement())).toThrow(/grant/i);
    expect(() => resolveRoleProfile(profile({ toolRequirements: [{ toolId: "unknown", operations: [] }] }), requirement())).toThrow(/tool/i);
  });
  it("attenuates real operation grants and revokes grants with no remaining capability", () => {
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "grant-search", toolId: "search", policyDigest: "a".repeat(64),
      kind: "stdio_mcp", requiredness: "optional", role: "developer", scope: { kind: "session", machineId: "m", repositoryId: "r", workspaceRoot: "/repo", sessionId: "s" },
      serviceId: "search-service", operations: ["read", "update"], capabilityIds: ["code"], triggers: ["explicit"] });
    const input = requirement({ toolIds: ["search"], mcpServiceIds: ["search-service"], toolGrants: [grant] });
    const allowed = profile({ restrictions: { tools: [{ toolId: "search", operations: ["read"] }] } });
    const output = resolveRoleProfile(allowed, input);
    expect(output.toolGrants?.[0]?.operations).toEqual(["read"]);
    expect(output.mcpOperations).toEqual(["read"]);
    expect(output.toolGrants?.every(item => ResolvedToolGrantSchema.safeParse(item).success)).toBe(true);
    expect(resolveRoleProfile(allowed, output)).toEqual(output);
    const revoked = resolveRoleProfile(profile({ restrictions: { capabilityIds: [] } }), input);
    expect(revoked.toolGrants).toEqual([]);
    expect(revoked.toolIds).toEqual([]);
    expect(revoked.mcpServiceIds).toEqual([]);
    expect(() => resolveRoleProfile(allowed, { ...input, toolGrants: [{ ...grant, requiredness: "required" }] })).toThrow(/required/i);
  });
  it("rejects a base-role, policy, pin or unsupported provider preference mismatch", () => {
    expect(() => resolveRoleProfile(profile({ baseRole: "reviewer" }), requirement())).toThrow(/role/i);
    expect(() => resolveRoleProfile({ ...profile(), baseRolePolicyDigest: "f".repeat(64) }, requirement())).toThrow(/policy/i);
    expect(() => assertRoleProfilePin(profile().pin, profile({ profileId: "data-engineer" }).pin)).toThrow(/pin/i);
    expect(() => assertRoleProfilePin(profile().pin, undefined)).toThrow(/pin/i);
    expect(() => resolveRoleProfile(profile({ preferences: { provider: "codex" } }), requirement())).toThrow(/provider/i);
    expect(resolveRoleProfile(profile({ preferences: { model: "new" } }), requirement()).model).toBe("new");
  });
  it("applies profile model and effort preferences over unlocked base role defaults idempotently", () => {
    const snapshot = profile({ preferences: { model: "specialist-model", effort: "high" } });
    const output = resolveRoleProfile(snapshot, requirement({ provider: "codex", model: "base-model", effort: "low" }));
    expect(output.model).toBe("specialist-model");
    expect(output.effort).toBe("high");
    expect(resolveRoleProfile(snapshot, output)).toEqual(output);
    expect(resolveRoleProfile(profile(), requirement({ provider: "codex", model: "base-model", effort: "low" })))
      .toMatchObject({ provider: "codex", model: "base-model", effort: "low" });
  });
  it("preserves exact pack constraints when a profile would replace locked model or effort", () => {
    expect(() => resolveRoleProfile(profile({ preferences: { model: "specialist-model" } }), requirement({
      provider: "codex", model: "pack-model", preferenceConstraints: { model: "pack-model" }
    }))).toThrow(/model.*pack/i);
    expect(() => resolveRoleProfile(profile({ preferences: { effort: "high" } }), requirement({
      provider: "codex", effort: "low", preferenceConstraints: { effort: "low" }
    }))).toThrow(/effort.*pack/i);
    expect(resolveRoleProfile(profile({ preferences: { model: "pack-model", effort: "low" } }), requirement({
      provider: "codex", model: "pack-model", effort: "low", preferenceConstraints: { model: "pack-model", effort: "low" }
    }))).toMatchObject({ model: "pack-model", effort: "low" });
  });
  it("retains actual pack locks across the host template requirement boundary", () => {
    const option = PlatformRoleOptionSchema.parse({ role: "developer", provider: "codex", profileName: "native-login", required: true,
      model: "pack-model", effort: "low", preferenceConstraints: { model: "pack-model", effort: "low" }, permissionMode: "restricted",
      capabilityIds: ["code"], mcpServiceIds: [], toolIds: [], skillSelections: [] });
    const template = requirementFor(option, {}, "/repo", "task-1");
    expect(() => resolveRoleProfile(profile({ preferences: { model: "other-model" } }), template)).toThrow(/model.*pack/i);
    expect(() => resolveRoleProfile(profile({ preferences: { effort: "high" } }), template)).toThrow(/effort.*pack/i);
    expect(resolveRoleProfile(profile({ preferences: { model: "pack-model", effort: "low" } }), template))
      .toMatchObject({ provider: "codex", profileName: "native-login", model: "pack-model", effort: "low" });
  });
  it("fails closed for provider switches and Agy effort instead of silently using base defaults", () => {
    expect(() => resolveRoleProfile(profile({ preferences: { provider: "codex" } }), requirement({ profileName: "native-login" })))
      .toThrow(/provider.*unsupported/i);
    expect(() => resolveRoleProfile(profile({ preferences: { effort: "high" } }), requirement()))
      .toThrow(/Agy effort.*model/i);
  });
  it("narrows capabilities and network while never reopening deny", () => {
    const narrowed = resolveRoleProfile(profile({ restrictions: { capabilityIds: ["code", "other"], networkHosts: [] } }), requirement());
    expect(narrowed.capabilityIds).toEqual(["code"]);
    expect(narrowed.network).toEqual({ mode: "deny", allowedHosts: [] });
    expect(resolveRoleProfile(profile({ restrictions: { networkHosts: ["example.com"] } }), requirement()).network).toEqual({ mode: "deny", allowedHosts: [] });
  });
  it("rejects process-tree read/deny and unsupported writable/network scopes", () => {
    for (const restrictions of [{ readablePaths: ["src"] }, { deniedPaths: ["secret"] }])
      expect(() => resolveRoleProfile(profile({ restrictions }), requirement())).toThrow(/unsupported/i);
    expect(() => resolveRoleProfile(profile({ restrictions: { writablePaths: ["src"] } }), requirement({ provider: "codex" }))).toThrow(/unsupported/i);
    expect(() => resolveRoleProfile(profile({ restrictions: { networkHosts: ["api.example.com"] } }), requirement({ network: { mode: "allowlist", allowedHosts: ["api.example.com"] } }))).toThrow(/unsupported/i);
    expect(resolveRoleProfile(profile({ restrictions: { writablePaths: ["src"] } }), requirement()).writablePaths).toEqual(["src"]);
  });
  it("preserves the original prompt prefix and changes fingerprints for changed instructions", () => {
    const original = "Builtin governance\nKeep approvals.\n";
    expect(appendRoleProfileInstructions(original, profile()).startsWith(original)).toBe(true);
    expect(appendRoleProfileInstructions(original, profile())).toContain("Implement backend APIs.");
    expect(roleProfilePolicyDigest(resolveRoleProfile(profile(), requirement()))).not.toBe(
      roleProfilePolicyDigest(resolveRoleProfile(profile({ additionalInstructions: "Data work" }), requirement())));
  });
  it("uses component boundaries and refuses traversal, absolute and metadata paths", () => {
    expect(profilePathAllowed("src/api/new.ts", ["src/api"])).toBe(true);
    for (const path of [".Git/hooks/pre-commit", ".GIT/config", ".BFLOW/config.yml", ".Bflow/state"]) expect(profilePathAllowed(path, undefined)).toBe(false);
    for (const path of ["src/apis/file.ts", "src/api/../secret", "/src/api", "src/api//file", "src/api/.git/config", "src/api\\file"])
      expect(profilePathAllowed(path, ["src/api"])).toBe(false);
    expect(profilePathAllowed("src/api/token", ["src"], ["src/api"])).toBe(false);
    expect(profilePathAllowed("src/file", [])).toBe(false);
  });
  it("binds profile and assignment identity into environment and native state", () => {
    const resolver = new RoleEnvironmentResolver();
    const identity = { machineId: "m", repositoryId: "r", workspaceRoot: "/repo", sessionId: "s", generation: 1, stateDirectory: "/state" };
    const one = resolver.resolve(identity, resolveRoleProfile(profile(), requirement()), { skillManifestDigest: "a".repeat(64) });
    const two = resolver.resolve(identity, resolveRoleProfile(profile({ profileId: "data-engineer" }), requirement()), { skillManifestDigest: "a".repeat(64) });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.value.roleProfile).toEqual(profile().pin);
    expect(one.value.environmentId).not.toBe(two.value.environmentId);
    expect(one.value.stateDirectory).not.toBe(two.value.stateDirectory);
    expect(one.value.stateDirectory).toContain(profile().pin.digest);
  });
  it("compiles an empty write restriction to actual read-only native permissions", () => {
    const identity = { machineId: "m", repositoryId: "r", workspaceRoot: "/repo", sessionId: "s", generation: 1, stateDirectory: "/state" };
    const result = new RoleEnvironmentResolver().resolve(identity, requirement({ roleProfile: profile({ restrictions: { writablePaths: [] } }) }), { skillManifestDigest: "a".repeat(64) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionProfile.filesystem).toBe("read_only");
    expect(result.value.permissionProfile.writableRoots).toEqual([]);
  });
  it("keeps valid maximum-length task identifiers within filesystem component limits", () => {
    const identity = { machineId: "m", repositoryId: "r", workspaceRoot: "/repo", sessionId: "s", generation: 1, stateDirectory: "/state" };
    const result = new RoleEnvironmentResolver().resolve(identity, requirement({ taskId: "t".repeat(128), assignmentId: "a".repeat(200), roleProfile: profile() }), { skillManifestDigest: "a".repeat(64) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stateDirectory.split("/").every(segment => segment.length <= 255)).toBe(true);
  });
  it("recovers immutable exact snapshots and refuses missing or corrupted proof", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "bflow-profile-")));
    const identity = { machineId: "m", repositoryId: "r", workspaceRoot: "/repo", sessionId: "s", generation: 1, stateDirectory: directory };
    try {
      const file = await persistRoleProfileSnapshot(identity, profile());
      expect(await loadRoleProfileSnapshot(identity, profile().pin)).toEqual(profile());
      await expect(persistRoleProfileSnapshot(identity, profile({ additionalInstructions: "same version changed bytes" }))).rejects.toThrow(/snapshot/i);
      await expect(loadRoleProfileSnapshot(identity, profile({ profileId: "data-engineer" }).pin)).rejects.toThrow(/snapshot/i);
      await writeFile(file, JSON.stringify({ ...profile(), definition: { ...profile().definition, additionalInstructions: "tampered" } }));
      await expect(loadRoleProfileSnapshot(identity, profile().pin)).rejects.toThrow(/snapshot/i);
      await expect(persistRoleProfileSnapshot(identity, profile())).rejects.toThrow(/snapshot/i);
      // Interrupted publish: identity proof exists but the digest-addressed snapshot is missing. Persisting repairs it
      // from the exact pinned definition; loading alone must still refuse to resolve a new profile.
      await rm(file);
      await expect(loadRoleProfileSnapshot(identity, profile().pin)).rejects.toThrow(/snapshot/i);
      await persistRoleProfileSnapshot(identity, profile());
      expect(await loadRoleProfileSnapshot(identity, profile().pin)).toEqual(profile());
      await expect(persistRoleProfileSnapshot(identity, profile({ additionalInstructions: "same version changed bytes" }))).rejects.toThrow(/snapshot/i);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
