import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillManager,
  SkillFileStore,
  bundleDigest,
  type BundleFiles,
} from "../src/index.js";
import { files } from "./fixtures.js";
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
const req = {
  manifestId: "manifest",
  environmentId: "env",
  scope,
  role: "developer" as const,
  provider: "claude" as const,
  capabilityIds: [],
  toolIds: [],
};
function change(f: BundleFiles, patch: Record<string, unknown>): BundleFiles {
  return {
    ...f,
    "skill.json": JSON.stringify({ ...JSON.parse(f["skill.json"]!), ...patch }),
  };
}
async function store() {
  const root = await mkdtemp(join(tmpdir(), "skills-authority-"));
  roots.push(root);
  return new SkillFileStore(join(root, "store"));
}
const selection = (f: BundleFiles, name = "example", required = true) => ({
  skill: { skillId: name, version: "1.0.0", digest: bundleDigest(f) },
  required,
});
describe("skills fail closed at authority and integrity boundaries", () => {
  it("requires actual capability/tool inventory and provider compatibility", async () => {
    const f = change(files(), {
      requiredCapabilityIds: ["implementation"],
      requiredToolIds: ["gitnexus"],
      supportedProviders: ["claude"],
    });
    const manager = new SkillManager({
      store: await store(),
      supportedCommands: ["status"],
      approvedBuiltinDigests: [bundleDigest(f)],
    });
    await manager.installBundle(f, {
      source: "builtin",
      expectedDigest: bundleDigest(f),
    });
    const request = { ...req, selections: [selection(f)] };
    await expect(manager.resolve(request)).rejects.toThrow(/capability/);
    await expect(
      manager.resolve({ ...request, capabilityIds: ["implementation"] }),
    ).rejects.toThrow(/tool/);
    await expect(
      manager.resolve({
        ...request,
        capabilityIds: ["implementation"],
        toolIds: ["gitnexus"],
        provider: "codex",
      }),
    ).rejects.toThrow(/provider/);
    expect(
      (
        await manager.resolve({
          ...request,
          capabilityIds: ["implementation"],
          toolIds: ["gitnexus"],
        })
      ).manifest.skills,
    ).toHaveLength(1);
  });
  it("authenticates exact repository approval and expires it on resume", async () => {
    const f = files();
    let approved = true;
    const manager = new SkillManager({
      store: await store(),
      supportedCommands: ["status"],
      authorize: async (check) =>
        approved &&
        check.definition.digest === bundleDigest(f) &&
        check.role === "developer" &&
        check.provider === "claude" &&
        check.scope.sessionId === "s" &&
        check.approvalReceiptId === "human-42",
    });
    await manager.installBundle(f, {
      source: "repository",
      expectedDigest: bundleDigest(f),
    });
    const request = {
      ...req,
      selections: [{ ...selection(f), approvalReceiptId: "human-42" }],
    };
    const { manifest } = await manager.sync(request);
    approved = false;
    await expect(manager.recover(manifest.digest)).rejects.toThrow(/stale/);
    await expect(
      manager.resolve({
        ...request,
        scope: { ...scope, sessionId: "different" },
      }),
    ).rejects.toThrow();
  });
  it("checks manifest digest and current file bytes before rendering and restart", async () => {
    const f = files();
    const storage = await store();
    const manager = new SkillManager({
      store: storage,
      supportedCommands: ["status"],
      approvedBuiltinDigests: [bundleDigest(f)],
    });
    await manager.installBundle(f, {
      source: "builtin",
      expectedDigest: bundleDigest(f),
    });
    const { manifest } = await manager.sync({
      ...req,
      selections: [selection(f)],
    });
    await expect(
      manager.link({ ...manifest, environmentId: "different" }),
    ).rejects.toThrow(/digest/);
    await writeFile(
      join(storage.root, "bundles", bundleDigest(f), "SKILL.md"),
      "changed",
      { mode: 0o600 },
    );
    await expect(manager.link(manifest)).rejects.toThrow(/Corrupted/);
    await expect(manager.recover(manifest.digest)).rejects.toThrow(/Corrupted/);
  });
  it("omits optional unresolvable trees without leaking a partial dependency", async () => {
    const dep = files("dep");
    const parent = change(files("parent"), {
      dependencies: [
        selection(dep, "dep").skill,
        { skillId: "missing", version: "1.0.0", digest: "0".repeat(64) },
      ],
    });
    const manager = new SkillManager({
      store: await store(),
      supportedCommands: ["status"],
      approvedBuiltinDigests: [bundleDigest(dep), bundleDigest(parent)],
    });
    for (const f of [dep, parent])
      await manager.installBundle(f, {
        source: "builtin",
        expectedDigest: bundleDigest(f),
      });
    const result = await manager.resolve({
      ...req,
      selections: [selection(parent, "parent", false)],
    });
    expect(result.manifest.skills).toEqual([]);
    expect(result.diagnostics).toEqual(["Optional skill omitted: parent"]);
    await expect(
      manager.resolve({ ...req, selections: [selection(parent, "parent")] }),
    ).rejects.toThrow(/Missing exact/);
  });
  it("rejects conflicting pins and preserves previous catalog entry after rejected update", async () => {
    const a = files();
    const b = change(files(), { version: "2.0.0" });
    const p = change(files("parent"), { dependencies: [selection(a).skill] });
    const manager = new SkillManager({
      store: await store(),
      supportedCommands: ["status"],
      approvedBuiltinDigests: [a, b, p].map(bundleDigest),
    });
    for (const f of [a, b, p])
      await manager.installBundle(f, {
        source: "builtin",
        expectedDigest: bundleDigest(f),
      });
    await expect(
      manager.resolve({
        ...req,
        selections: [
          selection(p, "parent"),
          {
            skill: { ...selection(b).skill, version: "2.0.0" },
            required: true,
          },
        ],
      }),
    ).rejects.toThrow(/Conflicting/);
    await expect(
      manager.resolve({
        ...req,
        selections: [
          selection(p, "parent", false),
          {
            skill: { ...selection(b).skill, version: "2.0.0" },
            required: true,
          },
        ],
      }),
    ).rejects.toThrow(/Conflicting/);
    const corrupt = { ...a, "SKILL.md": a["SKILL.md"] + "changed" };
    await expect(
      manager.update(corrupt, {
        source: "builtin",
        expectedDigest: bundleDigest(a),
        previous: selection(a).skill,
      }),
    ).rejects.toThrow();
    expect(
      (await manager.list()).filter((d) => d.skillId === "example"),
    ).toHaveLength(2);
  });
  it("does not allow concurrent name/version publication or automatically remove a live lock", async () => {
    const storage = await store();
    const a = files();
    const b = { ...a, "extra.txt": "different" };
    const manager = new SkillManager({
      store: storage,
      supportedCommands: ["status"],
      approvedBuiltinDigests: [a, b].map(bundleDigest),
    });
    const results = await Promise.allSettled([
      manager.installBundle(a, {
        source: "builtin",
        expectedDigest: bundleDigest(a),
      }),
      manager.installBundle(b, {
        source: "builtin",
        expectedDigest: bundleDigest(b),
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await manager.list()).toHaveLength(1);
    await writeFile(join(storage.root, "catalog.lock"), "interrupted", {
      mode: 0o600,
    });
    await expect(
      manager.installBundle(a, {
        source: "builtin",
        expectedDigest: bundleDigest(a),
      }),
    ).rejects.toThrow();
  });
});

it("owns installed bytes before yielding to catalog I/O", async () => {
  const f = files();
  const original = bundleDigest(f);
  const storage = await store();
  const manager = new SkillManager({
    store: storage,
    supportedCommands: ["status"],
    approvedBuiltinDigests: [original],
  });
  const installing = manager.installBundle(f, {
    source: "builtin",
    expectedDigest: original,
  });
  f["SKILL.md"] = "caller mutation after request";
  const result = await installing;
  expect(result.digest).toBe(original);
  expect((await manager.list())[0]!.digest).toBe(original);
  expect((await storage.getBundle(original))["SKILL.md"]).not.toBe(
    f["SKILL.md"],
  );
});
