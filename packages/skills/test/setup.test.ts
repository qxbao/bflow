import { mkdtemp, mkdir, realpath, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillManager,
  SkillFileStore,
  SkillsSetupSynchronizer,
  bundleDigest,
  readBundle,
  BASELINE_COMMANDS,
} from "../src/index.js";
import { files } from "./fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
describe("P26 setup bridge and repository init data", () => {
  it("upgrades the published MemPalace catalog without replacing the installed generation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-upgrade-")));
    roots.push(root);
    // Published 1.0.0 bytes from 111c40d, also retained by existing machine catalogs.
    const previousFiles = await readBundle(
      fileURLToPath(new URL("./fixtures/use-mempalace-1.0.0", import.meta.url)),
    );
    const previousDigest =
      "83c6764caecd61f922764765d5ad945dd362aa2bd326d4a8ed3dc6b9a62e120c";
    expect(bundleDigest(previousFiles)).toBe(previousDigest);
    const source = fileURLToPath(
      new URL("../../../skills/tooling/use-mempalace", import.meta.url),
    );
    const currentDigest = bundleDigest(await readBundle(source));
    const store = new SkillFileStore(join(root, "store"));
    const manager = new SkillManager({
      store,
      supportedCommands: BASELINE_COMMANDS,
      approvedBuiltinDigests: [previousDigest, currentDigest],
    });
    const previous = await manager.installBundle(previousFiles, {
      source: "builtin",
      expectedDigest: previousDigest,
    });
    const generation = await manager.sync({
      manifestId: "existing-generation",
      environmentId: "existing-environment",
      scope: {
        kind: "session",
        machineId: "machine",
        repositoryId: "repository",
        workspaceRoot: "/repository",
        sessionId: "existing-session",
      },
      role: "developer",
      provider: "codex",
      selections: [
        {
          skill: {
            skillId: previous.skillId,
            version: previous.version,
            digest: previous.digest,
          },
          required: true,
        },
      ],
      capabilityIds: [],
      toolIds: ["mempalace"],
    });
    const setup = new SkillsSetupSynchronizer(manager, store, [
      { root: source, source: "builtin", expectedDigest: currentDigest },
    ]);
    const result = await setup.sync({ mode: "apply" });
    expect(await setup.sync({ mode: "apply" })).toEqual(result);
    expect((await setup.observe({ mode: "check" })).valid).toBe(true);
    expect(await manager.list()).toEqual([
      previous,
      await manager.validate(source, "builtin"),
    ]);
    expect(await manager.recover(generation.manifest.digest)).toEqual(
      generation.manifest,
    );
  });
  it("upgrades test-planning with nested references without invalidating an installed 1.0.0 generation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-tp-upgrade-")));
    roots.push(root);
    const previousFiles = await readBundle(
      fileURLToPath(new URL("./fixtures/test-planning-1.0.0", import.meta.url)),
    );
    const previousDigest = bundleDigest(previousFiles);
    const source = fileURLToPath(
      new URL("../../../skills/verification/test-planning", import.meta.url),
    );
    const currentFiles = await readBundle(source);
    const currentDigest = bundleDigest(currentFiles);
    expect(currentDigest).not.toBe(previousDigest);
    expect(currentFiles["references/risk-viewpoints.md"]).toBeDefined();
    const store = new SkillFileStore(join(root, "store"));
    const manager = new SkillManager({
      store,
      supportedCommands: BASELINE_COMMANDS,
      approvedBuiltinDigests: [previousDigest, currentDigest],
    });
    const previous = await manager.installBundle(previousFiles, {
      source: "builtin",
      expectedDigest: previousDigest,
    });
    const generation = await manager.sync({
      manifestId: "tester-generation-1",
      environmentId: "tester-environment-1",
      scope: {
        kind: "session",
        machineId: "machine",
        repositoryId: "repository",
        workspaceRoot: "/repository",
        sessionId: "tester-session",
      },
      role: "tester",
      provider: "claude",
      selections: [
        {
          skill: {
            skillId: previous.skillId,
            version: previous.version,
            digest: previous.digest,
          },
          required: true,
        },
      ],
      capabilityIds: [],
      toolIds: [],
    });
    const setup = new SkillsSetupSynchronizer(manager, store, [
      { root: source, source: "builtin", expectedDigest: currentDigest },
    ]);
    await setup.sync({ mode: "apply" });
    const latest = await manager.validate(source, "builtin");
    expect(latest.version).toBe("1.0.1");
    expect(await manager.list()).toEqual([previous, latest]);
    expect(await manager.recover(generation.manifest.digest)).toEqual(
      generation.manifest,
    );
    const storedLatest = await store.getBundle(currentDigest);
    expect(storedLatest["references/risk-viewpoints.md"]).toBe(
      currentFiles["references/risk-viewpoints.md"],
    );
  });
  it("plans without writes, applies pinned skills idempotently and observes content drift", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-setup-")));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source);
    const f = files();
    for (const [p, c] of Object.entries(f)) await writeFile(join(source, p), c);
    const store = new SkillFileStore(join(root, "store"));
    const manager = new SkillManager({
      store,
      supportedCommands: ["status"],
      approvedBuiltinDigests: [bundleDigest(f)],
    });
    const setup = new SkillsSetupSynchronizer(manager, store, [
      { root: source, source: "builtin", expectedDigest: bundleDigest(f) },
    ]);
    const plan = await setup.desired({ mode: "dry_run" });
    expect(plan.repairNeeded).toBe(false);
    expect(await readdir(root)).toEqual(["source"]);
    expect(await setup.sync({ mode: "dry_run" })).toEqual({
      ownedPaths: [],
      diagnostics: ["Skills setup dry_run: nothing written"],
    });
    expect(await manager.list()).toEqual([]);
    expect(await readdir(root)).toEqual(["source"]);
    const result = await setup.sync({ mode: "apply" });
    expect(result.ownedPaths).toHaveLength(2);
    expect(await setup.sync({ mode: "apply" })).toEqual(result);
    expect(await setup.observe({ mode: "check" })).toEqual({
      stateDigest: plan.digest,
      valid: true,
      diagnostics: [],
    });
    expect((await setup.desired({ mode: "check" })).repairNeeded).toBe(false);
    await writeFile(join(source, "SKILL.md"), "unapproved change");
    await expect(setup.sync({ mode: "apply" })).rejects.toThrow();
    expect((await setup.observe({ mode: "check" })).valid).toBe(false);
  });
  it("aborts before installation, preserves unrelated role pins and user settings", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-setup-")));
    roots.push(root);
    const store = new SkillFileStore(join(root, "store"));
    const manager = new SkillManager({ store, supportedCommands: ["status"] });
    const setup = new SkillsSetupSynchronizer(manager, store, []);
    const controller = new AbortController();
    controller.abort();
    await expect(
      setup.sync({ mode: "apply", signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    const a = { skillId: "existing", version: "1", digest: "a".repeat(64) };
    const b = { skillId: "new", version: "2", digest: "b".repeat(64) };
    const before = {
      schemaVersion: 3 as const,
      pinsByRole: { reviewer: [a] },
      userSettings: { custom: { nested: true } },
    };
    const config = manager.repositoryConfig(before, { developer: [b] });
    expect(config.pinsByRole).toEqual({ reviewer: [a], developer: [b] });
    expect(config.userSettings).toEqual(before.userSettings);
    expect(before.pinsByRole).toEqual({ reviewer: [a] });
  });
});
