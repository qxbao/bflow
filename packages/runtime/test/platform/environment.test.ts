import { describe, expect, it } from "vitest";
import { AgentEnvironmentSchema, type RolePlatformRequirement } from "@bflow/contracts";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import type { PlatformSessionIdentity } from "../../src/platform/ports.js";

const identity: PlatformSessionIdentity = {
  machineId: "machine-1",
  repositoryId: "repo-1",
  workspaceRoot: "/repo",
  sessionId: "session-1",
  generation: 2,
  stateDirectory: "/repo/.bflow/state/platform"
};
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

function requirement(overrides: Partial<RolePlatformRequirement> = {}): RolePlatformRequirement {
  return {
    role: "developer",
    provider: "claude",
    required: true,
    permissionMode: "workspace_auto",
    cwd: "/repo/.worktrees/t1",
    taskId: "t1",
    capabilityIds: ["cap-a"],
    mcpServiceIds: ["svc-a"],
    toolIds: ["tool-a"],
    skillSelections: [],
    ...overrides
  };
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("RoleEnvironmentResolver", () => {
  const resolver = new RoleEnvironmentResolver();

  it("resolves restricted roles to read-only provider-policy profiles", () => {
    const env = expectOk(resolver.resolve(identity, requirement({ permissionMode: "restricted", cwd: "/repo" }),
      { skillManifestDigest: digest }));
    expect(env.permissionProfile.mode).toBe("restricted");
    expect(env.permissionProfile.filesystem).toBe("read_only");
    expect(env.permissionProfile.writableRoots).toEqual([]);
    expect(env.permissionProfile.isolation).toBe("provider_policy");
    expect(env.permissionProfile.readableRoots).toEqual(["/repo"]);
    expect(env.permissionProfile.allowGlobalPermissionBypass).toBe(false);
    expect(env.permissionProfile.deniedAction).toBe("request_via_conversation");
    expect(env.permissionProfile.network).toEqual({ mode: "deny", allowedHosts: [] });
  });

  it("grants write access only to the requested cwd for workspace_auto", () => {
    const env = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    expect(env.permissionProfile.mode).toBe("workspace_auto");
    expect(env.permissionProfile.filesystem).toBe("workspace_write");
    expect(env.permissionProfile.writableRoots).toEqual(["/repo/.worktrees/t1"]);
    expect(env.permissionProfile.readableRoots).toEqual(["/repo", "/repo/.worktrees/t1"]);
    expect(env.permissionProfile.isolation).toBe("provider_policy");
    expect(env.permissionProfile.allowedTools).toEqual(["tool-a"]);
  });

  it("refuses unattended_isolated without verified isolation instead of downgrading", () => {
    const result = resolver.resolve(identity, requirement({ permissionMode: "unattended_isolated" }),
      { skillManifestDigest: digest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.details).toEqual({ code: "unsupported_isolation" });
  });

  it("uses the proven isolation kind for unattended_isolated", () => {
    const env = expectOk(resolver.resolve(identity, requirement({
      permissionMode: "unattended_isolated",
      isolation: { kind: "container", proofId: "proof-1" }
    }), { skillManifestDigest: digest }));
    expect(env.permissionProfile.mode).toBe("unattended_isolated");
    expect(env.permissionProfile.isolation).toBe("container");
    expect(env.permissionProfile.scope.kind).toBe("session");
  });

  it("produces a deterministic id and fingerprint for the same inputs", () => {
    const a = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    const b = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    expect(a.environmentId).toBe("env-session-1-g2-developer-t1");
    expect(a).toEqual(b);
    expect(resolver.environmentId(identity, requirement())).toBe(a.environmentId);
  });

  it("changes the fingerprint with the skill manifest digest and generation", () => {
    const base = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    const skillChanged = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: otherDigest }));
    const generationChanged = expectOk(resolver.resolve({ ...identity, generation: 3 }, requirement(),
      { skillManifestDigest: digest }));
    expect(skillChanged.configFingerprint).not.toBe(base.configFingerprint);
    expect(generationChanged.configFingerprint).not.toBe(base.configFingerprint);
    expect(generationChanged.stateDirectory).toBe("/repo/.bflow/state/platform/gen-3/roles/developer-t1");
  });

  it("binds model and effort selections into the role configuration fingerprint", () => {
    const base = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    const modelChanged = expectOk(resolver.resolve(identity, requirement({ model: "sonnet" }), { skillManifestDigest: digest }));
    const effortChanged = expectOk(resolver.resolve(identity, requirement({ effort: "high" }), { skillManifestDigest: digest }));
    expect(modelChanged.configFingerprint).not.toBe(base.configFingerprint);
    expect(effortChanged.configFingerprint).not.toBe(base.configFingerprint);
  });

  it("nests the state directory by generation, role and task without creating it", () => {
    const env = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    expect(env.stateDirectory).toBe("/repo/.bflow/state/platform/gen-2/roles/developer-t1");
    expect(env.requiredCapabilityIds).toEqual(["cap-a"]);
    expect(env.requiredMcpServiceIds).toEqual(["svc-a"]);
    expect(env.skillManifestDigest).toBe(digest);
    expect(env.secretBindings).toEqual({});
  });

  it("keeps an overlong environment id within the identifier limit, deterministically", () => {
    const longIdentity = { ...identity, sessionId: "s".repeat(250) };
    const id = resolver.environmentId(longIdentity, requirement());
    expect(id.length).toBeLessThanOrEqual(200);
    expect(resolver.environmentId(longIdentity, requirement())).toBe(id);
    expect(id).not.toBe(resolver.environmentId({ ...longIdentity, sessionId: "s".repeat(249) }, requirement()));
  });

  it("emits environments that pass AgentEnvironmentSchema", () => {
    const env = expectOk(resolver.resolve(identity, requirement(), { skillManifestDigest: digest }));
    expect(AgentEnvironmentSchema.safeParse(env).success).toBe(true);
  });

  it("rejects an invalid generation, a relative cwd and an unsafe task id", () => {
    const badGeneration = resolver.resolve({ ...identity, generation: 0 }, requirement(), { skillManifestDigest: digest });
    const relativeCwd = resolver.resolve(identity, requirement({ cwd: "relative/path" }), { skillManifestDigest: digest });
    const traversal = resolver.resolve(identity, requirement({ taskId: "../escape" }), { skillManifestDigest: digest });
    expect(badGeneration.ok).toBe(false);
    expect(relativeCwd.ok).toBe(false);
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error.code).toBe("validation");
  });
});
