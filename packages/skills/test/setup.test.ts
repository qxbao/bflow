import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillManager,
  SkillFileStore,
  SkillsSetupSynchronizer,
  bundleDigest,
} from "../src/index.js";
import { files } from "./fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
describe("P26 setup bridge and repository init data", () => {
  it("plans without writes, applies pinned skills idempotently and observes content drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-setup-"));
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
    expect(plan.repairNeeded).toBe(true);
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
    const root = await mkdtemp(join(tmpdir(), "skills-setup-"));
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
