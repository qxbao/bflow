import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { resolveBflowCommand } from "../src/init-director.js";

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "bflow-init-director-"));
  home = await mkdtemp(join(tmpdir(), "bflow-init-director-home-"));
  execFileSync("git", ["init", "--quiet", repo]);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const run = (args: string[]) => runCli(["init", "--no-gitnexus", ...args, "--json"], { cwd: repo, env: { ...process.env, HOME: home, BFLOW_HOME: home } } as never);
const exists = (p: string) => stat(join(repo, p)).then(() => true, () => false);

describe("bflow init Director files", () => {
  it("writes the skill and MCP config", async () => {
    const res = await run([]);
    expect(res.exitCode).toBe(0);
    expect(await exists(".claude/skills/bflow-start/SKILL.md")).toBe(true);
    expect(await exists(".mcp.json")).toBe(true);
    expect(JSON.parse(res.stdout).data.director.status).toBe("installed");
  });

  it("--no-director writes nothing", async () => {
    const res = await run(["--no-director"]);
    expect(res.exitCode).toBe(0);
    expect(await exists(".claude/skills/bflow-start/SKILL.md")).toBe(false);
    expect(JSON.parse(res.stdout).data.director).toBeUndefined();
  });

  it("--check is unhealthy after the skill is deleted, and --remove deletes files", async () => {
    await run([]);
    await rm(join(repo, ".claude/skills/bflow-start/SKILL.md"));
    const check = await runCli(["init", "--check", "--json"], { cwd: repo, env: { ...process.env, HOME: home, BFLOW_HOME: home } } as never);
    const data = JSON.parse(check.stdout).data;
    expect(data.healthy).toBe(false);
    expect(data.director.status).toBe("missing");
    expect(data.diagnostics.join("\n")).toContain("bflow init --update");

    await run([]);
    const removed = await runCli(["init", "--remove", "--json"], { cwd: repo, env: { ...process.env, HOME: home, BFLOW_HOME: home } } as never);
    expect(JSON.parse(removed.stdout).data.director.status).toBe("removed");
    expect(await exists(".claude/skills/bflow-start/SKILL.md")).toBe(false);
    expect(await exists(".mcp.json")).toBe(false);
  });

  it("a malformed .gitignore block does not fail init", async () => {
    await writeFile(join(repo, ".gitignore"), "# >>> bflow director >>>\nfoo\n");
    const res = await run([]);
    expect(res.exitCode).toBe(0);
    const data = JSON.parse(res.stdout).data;
    expect(data.director.status).toBe("failed");
    expect(data.diagnostics.join("\n")).toContain("malformed bflow director block");
    expect(await readFile(join(repo, ".gitignore"), "utf8")).toContain("foo");
    await mkdir(join(repo, "x"), { recursive: true });
  });

  it("resolveBflowCommand returns absolute paths", async () => {
    const cmd = await resolveBflowCommand({ execPath: "/usr/bin/node", argv1: "bin.js", realpath: async p => p });
    expect(cmd.every(isAbsolute)).toBe(true);
    expect((await resolveBflowCommand()).every(isAbsolute)).toBe(true);
  });
});
