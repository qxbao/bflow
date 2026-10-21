import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyIsolatedNodeDependencies } from "../helpers/isolated-node-dependencies.js";
import { validateDependencyTrees } from "../../src/agentic/behavioral-sandbox.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("stages pnpm third-party links without importing workspace files and rebases absolute internal links", async () => {
 const root = await mkdtemp(join(tmpdir(), "bflow-test-tool-deps-")); roots.push(root);
 const source=join(root,"node_modules"),target=join(root,"staged/node_modules"),workspace=join(root,"packages/private");
 await mkdir(join(source,".pnpm/tool"),{recursive:true}); await mkdir(workspace,{recursive:true});
 await writeFile(join(source,".pnpm/tool/index.js"),"module.exports=42"); await writeFile(join(workspace,"secret"),"fixture");
 await symlink(workspace,join(source,"workspace")); await symlink(join(source,".pnpm/tool"),join(source,"tool"));
 await copyIsolatedNodeDependencies(source,target);
 expect(await readFile(join(target,"tool/index.js"),"utf8")).toBe("module.exports=42");
 expect(await realpath(join(target,"tool"))).toBe(join(target,".pnpm/tool"));
 await expect(readFile(join(target,"workspace/secret"))).rejects.toMatchObject({code:"ENOENT"});
 await expect(validateDependencyTrees([target])).resolves.toBeUndefined();
});
it("can launch the staged installed Vitest tool without exposing workspace links", async () => {
 const { execFile } = await import("node:child_process"), { promisify } = await import("node:util"), { fileURLToPath } = await import("node:url"), { relative } = await import("node:path"), { createRequire } = await import("node:module");
 const root = await mkdtemp(join(tmpdir(), "bflow-installed-tool-deps-")); roots.push(root);
 const source=await realpath(fileURLToPath(new URL("../../../../node_modules",import.meta.url))),target=join(root,"node_modules");
 await copyIsolatedNodeDependencies(source,target); await validateDependencyTrees([target]);
 const cli=join(target,relative(source,createRequire(import.meta.url).resolve("vitest/vitest.mjs")));
 const result=await promisify(execFile)(process.execPath,[cli,"--version"],{cwd:root,timeout:10000,env:{PATH:"/usr/bin:/bin"}});
 expect(result.stdout).toMatch(/^vitest\/2\./);
});
