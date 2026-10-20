import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateRunnerMount, validateDependencyTrees } from "../../src/agentic/behavioral-sandbox.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "bflow-dependency-boundary-")); roots.push(root); return root; }
it("permits source directories named token while rejecting credential files", async () => {
  const root = await fixture(); await mkdir(join(root, "go/token"), { recursive: true });
  await writeFile(join(root, "go/token/token.go"), "package token\n");
  await expect(validateRunnerMount({ source: root, target: root }, "/checkout")).resolves.toBeUndefined();
  for (const name of ["token", "tokens", "passwords"]) {
    await writeFile(join(root, name), "fixture credential");
    await expect(validateRunnerMount({ source: root, target: root }, "/checkout")).rejects.toThrow("Credential material");
    await rm(join(root, name));
  }
});
it("rejects credential directories and escaped links without requiring a sandbox", async () => {
  const root = await fixture(); await mkdir(join(root, ".ssh"));
  await expect(validateRunnerMount({ source: root, target: root }, "/checkout")).rejects.toThrow("Credential material");
});
it("rejects a selected dependency tree with a workspace link outside the mounted layout", async () => {
  const { symlink } = await import("node:fs/promises");
  const root = await fixture(), modules = join(root, "node_modules"); await mkdir(modules); await mkdir(join(root, "workspace"));
  await symlink(join(root, "workspace"), join(modules, "workspace"));
  await expect(validateDependencyTrees([modules])).rejects.toThrow("Dependency symlink escapes");
});
