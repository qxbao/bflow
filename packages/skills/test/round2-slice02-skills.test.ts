import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFrontmatter, scanSkillSources } from "../src/importer.js";
import { SkillFileStore } from "../src/storage.js";

const roots: string[] = [];
const originalOpen = fsPromises.open;

afterEach(async () => {
  if (fsPromises.open !== originalOpen) {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

describe("Round 2 Slice 2 — skills hardening", () => {
  it("readFrontmatter and scanSkillSources safely handle Object.prototype keys (constructor, toString, __proto__) without crashing canonical digesting or mutating prototypes", async () => {
    const dir = await makeTempDir("bflow-r2-skills-proto-");
    const bundleDir = join(dir, "untrusted-skill");
    await mkdir(bundleDir, { mode: 0o700 });
    const untrustedMarkdown = [
      "---",
      "name: untrusted-proto-skill",
      "description: Skill with adversarial frontmatter keys",
      "constructor:",
      "  - item-one",
      "toString:",
      "  - item-two",
      "__proto__:",
      "  - item-three",
      "---",
      "",
      "# Untrusted Skill",
      "",
      "Follow standard Bflow verification."
    ].join("\n");
    await writeFile(join(bundleDir, "SKILL.md"), untrustedMarkdown, { mode: 0o600 });

    const parsed = readFrontmatter(untrustedMarkdown);
    expect(Object.getPrototypeOf(parsed.fields)).toBe(Object.prototype);
    expect(parsed.fields["constructor"]).toEqual(["item-one"]);
    expect(parsed.fields["toString"]).toEqual(["item-two"]);
    expect(Object.getOwnPropertyDescriptor(parsed.fields, "__proto__")?.value).toEqual(["item-three"]);

    const scanned = await scanSkillSources([{ path: bundleDir, kind: "skill_bundle" }]);
    expect(scanned.inventory.items).toHaveLength(1);
    expect(scanned.inventory.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("SkillFileStore tolerates FUSE/NTFS EINVAL/ENOTSUP on file fsync across withCatalogLock, putBundle, and writeImmutableDocument", async () => {
    const dir = await makeTempDir("bflow-r2-skills-fsync-");

    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      handle.sync = async () => {
        const err = new Error("ENOTSUP: operation not supported on socket/mount, fsync") as NodeJS.ErrnoException;
        err.code = "ENOTSUP";
        throw err;
      };
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    const store = new SkillFileStore(join(dir, "store"));
    const lockResult = await store.withCatalogLock(async () => "locked-ok");
    expect(lockResult).toBe("locked-ok");

    const digest = await store.putBundle({
      "SKILL.md": "# FUSE Skill\n",
      "references/guide.md": "Guide\n"
    });
    expect(await store.getBundle(digest)).toEqual({
      "SKILL.md": "# FUSE Skill\n",
      "references/guide.md": "Guide\n"
    });

    await store.writeImmutableDocument("catalog-v1", { version: 1, skills: [digest] });
    expect(await store.readDocument("catalog-v1")).toEqual({ version: 1, skills: [digest] });
  });
});
