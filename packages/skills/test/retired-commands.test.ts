import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillManager, SkillFileStore, bundleDigest, type BundleFiles } from "../src/index.js";
import { body, files } from "./fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const withCommand = (name: string, command: string): BundleFiles => {
  const bundle = files(name);
  return { ...bundle, "SKILL.md": `${body(name)}\nRun bflow ${command} before relying on it.\n` };
};

describe("catalog entries installed before a Bflow command was removed", () => {
  it("stay retired without hiding other entries, while any other corruption still fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-retired-")));
    roots.push(root);
    const store = new SkillFileStore(join(root, "store"));
    const retired = withCommand("retired-docs", "docs search react");
    const current = files("current-skill");
    const approved = [retired, current].map(bundleDigest);
    const before = new SkillManager({ store, supportedCommands: ["status", "docs search"], approvedBuiltinDigests: approved });
    for (const bundle of [retired, current]) await before.installBundle(bundle, { source: "builtin", expectedDigest: bundleDigest(bundle) });
    expect((await before.list()).map(entry => entry.skillId).sort()).toEqual(["current-skill", "retired-docs"]);

    const after = new SkillManager({ store, supportedCommands: ["status", "docs ask"], approvedBuiltinDigests: approved });
    expect((await after.list()).map(entry => entry.skillId)).toEqual(["current-skill"]);
  });
});
