import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SkillManager,
  SkillFileStore,
  bundleDigest,
  type BundleFiles,
} from "../src/index.js";
import { body, files } from "./fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const scope = {
  kind: "session" as const,
  machineId: "m",
  repositoryId: "r",
  workspaceRoot: "/repo",
  sessionId: "s",
};
async function setup(bundles: BundleFiles[] = [files()]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skills-manager-")));
  roots.push(root);
  const store = new SkillFileStore(join(root, "store"));
  const manager = new SkillManager({
    store,
    supportedCommands: ["status", "help", "doctor"],
    approvedBuiltinDigests: bundles.map(bundleDigest),
  });
  const defs = [];
  for (const bundle of bundles)
    defs.push(
      await manager.installBundle(bundle, {
        source: "builtin",
        expectedDigest: bundleDigest(bundle),
      }),
    );
  const request = {
    manifestId: "manifest",
    environmentId: "env",
    scope,
    role: "developer",
    provider: "claude",
    capabilityIds: [],
    toolIds: [],
    selections: defs.map((d) => ({
      skill: { skillId: d.skillId, version: d.version, digest: d.digest },
      required: true,
    })),
  };
  return { manager, store, defs, request };
}
describe("SkillManager exact pins and authority", () => {
  it("resolves validated catalog snapshots through execution dependency/permission policy without opening the store", async () => {
    const dependency = files("dependency");
    const parent = files("parent");
    const metadata = JSON.parse(parent["skill.json"]!);
    metadata.dependencies = [{ skillId: "dependency", version: "1.0.0", digest: bundleDigest(dependency) }];
    parent["skill.json"] = JSON.stringify(metadata);
    const { manager, store, defs, request } = await setup([dependency, parent]);
    const selected = { ...request, selections: request.selections.slice(1) };
    const execution = await manager.resolve(selected);
    const forbidden = ["list", "getBundle", "writeImmutableDocument", "putBundle", "withCatalogLock"] as const;
    for (const name of forbidden) vi.spyOn(store, name).mockImplementation(() => { throw Error("Forbidden preview store access"); });
    const snapshot = [{ definition: defs[0]!, files: dependency }, { definition: defs[1]!, files: parent }];
    const preview = await manager.resolveCatalog(selected, snapshot);
    expect(preview).toEqual(execution);
    expect(preview.manifest.skills.map(skill => skill.skillId)).toEqual(["dependency", "parent"]);
    for (const name of forbidden) expect(store[name]).not.toHaveBeenCalled();
    await expect(manager.resolveCatalog(selected, [{ ...snapshot[0]!, files: { ...dependency, "SKILL.md": body("tampered") } }, snapshot[1]!]))
      .rejects.toThrow();
    await expect(manager.resolveCatalog({ ...selected, role: "conversation" }, snapshot)).rejects.toThrow();
  });
  it("resolves, persists, restarts, and renders only selected references on all providers", async () => {
    const { manager, store, request } = await setup([files(), files("second")]);
    for (const provider of ["claude", "codex", "agy"]) {
      const result = await manager.sync({
        ...request,
        provider,
        selections: request.selections.slice(0, 1),
      });
      expect(result.manifest.skills.map((d) => d.skillId)).toEqual(["example"]);
      expect(result.rendered.instructionText).toContain("example");
      expect(result.rendered.instructionText).not.toContain(
        "Use the accepted task",
      );
      expect(result.rendered.instructionText).not.toContain("second");
      expect(await manager.verify(result.manifest)).toEqual(result.manifest);
      const restarted = new SkillManager({
        store,
        supportedCommands: ["status", "help", "doctor"],
        approvedBuiltinDigests: request.selections.map((s) => s.skill.digest),
      });
      expect(await restarted.recover(result.manifest.digest)).toEqual(
        result.manifest,
      );
    }
  });
  it("rejects unauthorized role, unknown pin and duplicate name", async () => {
    const { manager, request } = await setup();
    await expect(
      manager.resolve({ ...request, role: "conversation" }),
    ).rejects.toThrow(/role/);
    await expect(
      manager.resolve({
        ...request,
        selections: [
          {
            ...request.selections[0],
            skill: { ...request.selections[0]!.skill, digest: "0".repeat(64) },
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      manager.resolve({
        ...request,
        selections: [...request.selections, ...request.selections],
      }),
    ).rejects.toThrow(/duplicate/i);
  });
  it("rejects unapproved content, forged or stale repository approvals", async () => {
    const { manager, request } = await setup();
    const repo = files("repo");
    await manager.installBundle(repo, {
      source: "repository",
      expectedDigest: bundleDigest(repo),
    });
    await expect(
      manager.resolve({
        ...request,
        selections: [
          {
            skill: {
              skillId: "repo",
              version: "1.0.0",
              digest: bundleDigest(repo),
            },
            required: true,
            approvalReceiptId: "forged",
          },
        ],
      }),
    ).rejects.toThrow(/approval/);
    await expect(
      manager.installBundle(files("unapproved"), {
        source: "builtin",
        expectedDigest: bundleDigest(files("unapproved")),
      }),
    ).rejects.toThrow(/approv/);
  });
  it("keeps old generation valid after update and preserves user repository settings", async () => {
    const before = files();
    const next = {
      ...files(),
      "SKILL.md": body() + "\nUpdated content.\n",
      "skill.json": files()["skill.json"]!.replace("1.0.0", "2.0.0"),
    };
    const { manager, request } = await setup([before, next]);
    const old = await manager.sync({
      ...request,
      selections: request.selections.slice(0, 1),
    });
    const update = await manager.update(next, {
      source: "builtin",
      expectedDigest: bundleDigest(next),
      previous: request.selections[0]!.skill,
    });
    expect(update.version).toBe("2.0.0");
    expect(
      (await manager.recover(old.manifest.digest)).skills[0]!.version,
    ).toBe("1.0.0");
    const user = { editor: { theme: "dark" }, custom: "keep" };
    const config = manager.repositoryConfig(
      { userSettings: user },
      { developer: [request.selections[0]!.skill] },
    );
    expect(config.userSettings).toEqual(user);
  });
  it("resolves dependencies topologically", async () => {
    const dep = files("dep");
    const pin = { skillId: "dep", version: "1.0.0", digest: bundleDigest(dep) };
    const parent = files("parent");
    const meta = JSON.parse(parent["skill.json"]!);
    meta.dependencies = [pin];
    parent["skill.json"] = JSON.stringify(meta);
    const { manager, request } = await setup([parent, dep]);
    const resolved = await manager.resolve({
      ...request,
      selections: request.selections.slice(0, 1),
    });
    expect(resolved.manifest.skills.map((s) => s.skillId)).toEqual([
      "dep",
      "parent",
    ]);
  });
});

it('resolves a custom dependency with its separately pinned receipt without selecting extra skills', async () => {
  const dependency = files('dependency'); const parent = files('parent'); const extra = files('extra');
  const dependencyPin = { skillId: 'dependency', version: '1.0.0', digest: bundleDigest(dependency) };
  parent['skill.json'] = JSON.stringify({ ...JSON.parse(parent['skill.json']!), dependencies: [dependencyPin] });
  const { store, request } = await setup([]);
  const manager = new SkillManager({ store, supportedCommands: ['status'], authorize: async check =>
    check.approvalReceiptId === `receipt-${check.definition.skillId}` && check.role === 'developer' &&
    check.provider === 'claude' && check.scope.sessionId === 's' });
  const dependencyDefinition = await manager.installBundle(dependency, { source: 'repository', expectedDigest: dependencyPin.digest });
  const parentDefinition = await manager.installBundle(parent, { source: 'repository', expectedDigest: bundleDigest(parent) });
  await manager.installBundle(extra, { source: 'repository', expectedDigest: bundleDigest(extra) });
  const selected = { ...request, selections: [{ skill: { skillId: 'parent', version: '1.0.0', digest: bundleDigest(parent) }, required: true, approvalReceiptId: 'receipt-parent' }],
    dependencyApprovals: [ { skill: dependencyPin, approvalReceiptId: 'receipt-dependency' },
      { skill: { skillId: 'extra', version: '1.0.0', digest: bundleDigest(extra) }, approvalReceiptId: 'receipt-extra' } ] };
  const live = await manager.resolve(selected);
  const snapshot = await manager.resolveCatalog(selected, [{ definition: dependencyDefinition, files: dependency }, { definition: parentDefinition, files: parent }]);
  expect(snapshot).toEqual(live); expect(live.manifest.skills.map(skill => skill.skillId)).toEqual(['dependency', 'parent']);
  expect(live.manifest.bindings.find(binding => binding.skill.skillId === 'dependency')?.approvalReceiptId).toBe('receipt-dependency');
  for (const invalid of [ { skill: { ...dependencyPin, digest: 'f'.repeat(64) }, approvalReceiptId: 'receipt-dependency' },
    { skill: dependencyPin, approvalReceiptId: 'receipt-parent' } ])
    await expect(manager.resolve({ ...selected, dependencyApprovals: [invalid] })).rejects.toThrow();
});
