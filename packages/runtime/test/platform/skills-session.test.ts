import { profile } from "./role-profile-fixture.js";
import { mkdtemp, readFile, realpath, rm, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RolePlatformRequirement } from "../../src/platform/ports.js";
import { SkillManager, SkillFileStore, bundleDigest, type BundleFiles } from "@bflow/skills";
import { SkillSessionStore } from "../../src/platform/skills-session.js";
import type { PlatformSessionIdentity } from "../../src/platform/ports.js";

const body = (name: string) => `---\nname: ${name}\ndescription: Inspect an assigned task before implementation.\n---\n\n${[
  "Supported roles", "Prerequisites", "Trigger conditions", "Required inputs", "Expected outputs", "Procedure",
  "Bflow commands", "Verification requirements", "Error handling", "Escalation rules", "Concrete examples"
].map(h => `## ${h}\n\nUse the accepted task and preserve Runtime authority.`).join("\n\n")}\n`;
const bundle = (name: string): BundleFiles => ({
  "SKILL.md": body(name),
  "skill.json": JSON.stringify({
    version: "1.0.0",
    allowedRoles: ["developer"],
    supportedProviders: ["claude", "codex", "agy"],
    requiredCapabilityIds: [],
    requiredToolIds: [],
    dependencies: []
  })
});

let root: string;
let identity: PlatformSessionIdentity;
let manager: SkillManager;
let skillId: string;
let skillVersion: string;
let skillDigest: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "skills-session-")));
  identity = {
    machineId: "machine-1",
    repositoryId: "repo-1",
    workspaceRoot: "/repo",
    sessionId: "session-1",
    generation: 1,
    stateDirectory: join(root, "state")
  };
  const files = bundle("example");
  const digest = bundleDigest(files);
  manager = new SkillManager({
    store: new SkillFileStore(join(root, "store")),
    supportedCommands: ["status", "help", "doctor"],
    approvedBuiltinDigests: [digest]
  });
  const installed = await manager.installBundle(files, { source: "builtin", expectedDigest: digest });
  skillId = installed.skillId;
  skillVersion = installed.version;
  skillDigest = installed.digest;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function requirement(overrides: Partial<RolePlatformRequirement> = {}): RolePlatformRequirement {
  return {
    role: "developer",
    provider: "claude",
    required: true,
    permissionMode: "workspace_auto",
    cwd: "/repo/.worktrees/t1",
    taskId: "t1",
    capabilityIds: [],
    mcpServiceIds: [],
    toolIds: [],
    skillSelections: [{ skill: { skillId, version: skillVersion, digest: skillDigest }, required: true }],
    ...overrides
  };
}

const ENV_ID = "env-session-1-g1-developer-t1";
const recordFile = () => join(identity.stateDirectory, "gen-1", "skills", "developer-t1.json");

describe("SkillSessionStore with the real SkillManager", () => {
  it("resolves, persists with 0600 file and 0700 directories, and loads the same manifest", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    const resolved = await store.resolveForRole(identity, requirement(), ENV_ID);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
    expect(resolved.value.manifest.skills.map(s => s.skillId)).toEqual([skillId]);
    expect(resolved.value.rendered.manifestDigest).toBe(resolved.value.manifest.digest);

    expect((await stat(recordFile())).mode & 0o777).toBe(0o600);
    expect((await stat(join(identity.stateDirectory, "gen-1", "skills"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(identity.stateDirectory, "gen-1"))).mode & 0o777).toBe(0o700);

    const loaded = await store.load(identity, "developer", "t1");
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect(loaded.value).toEqual(resolved.value);
  });

  it("isolates exact skill records by profile digest and assignment identity", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    const first = profile(), second = profile({ profileId: "data-engineer" });
    expect((await store.resolveForRole(identity, requirement({ roleProfile: first, assignmentId: "a1" }), "env-one")).ok).toBe(true);
    expect((await store.resolveForRole(identity, requirement({ roleProfile: second, assignmentId: "a1" }), "env-two")).ok).toBe(true);
    const a = await store.load(identity, "developer", "t1", first.pin, "a1");
    const b = await store.load(identity, "developer", "t1", second.pin, "a1");
    expect(a.ok && a.value?.manifest.environmentId).toBe("env-one");
    expect(b.ok && b.value?.manifest.environmentId).toBe("env-two");
    const missing = await store.load(identity, "developer", "t1", first.pin, "a2");
    expect(missing.ok && missing.value).toBe(null);
  });

  it("is idempotent for the same manifest digest", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    expect((await store.resolveForRole(identity, requirement(), ENV_ID)).ok).toBe(true);
    expect((await store.resolveForRole(identity, requirement(), ENV_ID)).ok).toBe(true);
  });

  it("refuses to overwrite a record whose manifest digest differs", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    expect((await store.resolveForRole(identity, requirement(), ENV_ID)).ok).toBe(true);
    const before = await readFile(recordFile(), "utf8");

    const different = await store.resolveForRole(identity, requirement({ skillSelections: [] }), ENV_ID);
    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.error.code).toBe("conflict");
    expect(await readFile(recordFile(), "utf8")).toBe(before);
  });

  it("returns null when no record exists", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    expect(await store.load(identity, "developer", "t1")).toEqual({ ok: true, value: null });
  });

  it("reports corruption for a malformed record and never treats it as success", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    await mkdir(join(identity.stateDirectory, "gen-1", "skills"), { recursive: true, mode: 0o700 });
    await writeFile(recordFile(), "{not json", { mode: 0o600 });
    const loaded = await store.load(identity, "developer", "t1");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("corruption");
  });

  it("reports conflict when the stored manifest drifted from the recovered store manifest", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    expect((await store.resolveForRole(identity, requirement(), ENV_ID)).ok).toBe(true);
    const record = JSON.parse(await readFile(recordFile(), "utf8")) as { manifest: { manifestId: string } };
    record.manifest.manifestId = "tampered-manifest";
    await writeFile(recordFile(), JSON.stringify(record));
    const loaded = await store.load(identity, "developer", "t1");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("conflict");
  });

  it("fails without persisting when a required pin is missing from the catalog", async () => {
    const store = new SkillSessionStore({ resolver: manager });
    const missing = requirement({
      skillSelections: [{ skill: { skillId, version: skillVersion, digest: "c".repeat(64) }, required: true }]
    });
    const result = await store.resolveForRole(identity, missing, ENV_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    await expect(stat(recordFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked directory in the state path", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(identity.stateDirectory, { recursive: true });
    await symlink(elsewhere, join(identity.stateDirectory, "gen-1"));
    const store = new SkillSessionStore({ resolver: manager });
    const result = await store.resolveForRole(identity, requirement(), ENV_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    await expect(stat(join(elsewhere, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
