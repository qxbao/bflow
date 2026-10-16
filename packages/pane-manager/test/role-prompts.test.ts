import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readBuiltinRolePrompt } from "../src/role-prompts.js";
const execute = promisify(execFile), cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
describe("canonical installed role prompts", () => {
  it("loads genuine Chat/Coordinator assets and maps specialist aliases", async () => {
    expect((await readBuiltinRolePrompt("conversation"))?.prompt).toContain("Bflow Conversation Agent");
    expect((await readBuiltinRolePrompt("coordinator"))?.prompt).toContain("technical lead");
    expect((await readBuiltinRolePrompt("specifier"))?.source).toContain("agents/analyst/system-prompt.md");
  });
  it("fails closed when a packaged required prompt is absent, a symlink, or oversized", async () => {
    const root = await mkdtemp("/tmp/bflow-role-assets-"); cleanup.push(root);
    const target = join(root, "packages/pane-manager/dist"), assets = join(root, "agents/chat");
    await mkdir(target, { recursive: true }); await mkdir(assets, { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    for (const name of ["role-prompts.js", "types.js"]) await copyFile(new URL("../dist/" + name, import.meta.url), join(target, name));
    const code = `import {readBuiltinRolePrompt} from ${JSON.stringify(join(target, "role-prompts.js"))};try{await readBuiltinRolePrompt('chat');process.exitCode=1;}catch(error){console.log(String(error));}`;
    const probe = () => execute(process.execPath, ["--input-type=module", "-e", code]);
    expect((await probe()).stdout).toContain("Cannot load the original chat agent prompt");
    await writeFile(join(root, "outside"), "secret canary"); await symlink(join(root, "outside"), join(assets, "system-prompt.md"));
    const linked = (await probe()).stdout; expect(linked).toContain("Cannot load"); expect(linked).not.toContain("secret canary");
    await rm(join(assets, "system-prompt.md")); await writeFile(join(assets, "system-prompt.md"), "x".repeat(65_537));
    expect((await probe()).stdout).toContain("64 KiB");
  });
});
