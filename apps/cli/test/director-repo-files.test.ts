import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDirectorRepoFiles,
  checkDirectorRepoFiles,
  directorRepoFilePaths,
  removeDirectorRepoFiles,
  type DirectorProvider,
  type DirectorRepoFilesInput,
} from "../src/director-repo-files.js";

const ALL: DirectorProvider[] = ["claude", "codex", "agy"];
const EXCL = ".git/info/exclude";
const LEGACY = ".gitignore";
let root: string;

function input(overrides: Partial<DirectorRepoFilesInput> = {}): DirectorRepoFilesInput {
  return { repositoryRoot: root, bflowCommand: ["/usr/bin/bflow"], providers: ALL, ...overrides };
}
const read = (rel: string) => readFile(join(root, rel), "utf8");
const readJson = async (rel: string) => JSON.parse(await read(rel)) as Record<string, any>;
const exists = (rel: string) => read(rel).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "director-repo-"));
  execFileSync("git", ["init", "--quiet", root]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("director repo files", () => {
  it("writes every unit for all providers", async () => {
    const { written } = await applyDirectorRepoFiles(input());
    expect(written).toEqual([...directorRepoFilePaths(ALL), EXCL].sort());
    const mcp = await readJson(".mcp.json");
    expect(mcp.mcpServers.bflow.args.slice(-2)).toEqual(["director", "mcp"]);
    const toml = await read(".codex/config.toml");
    expect(toml.match(/# >>> bflow director >>>/g)).toHaveLength(1);
    expect(toml).toContain("tool_timeout_sec = 330");
    expect(toml).toContain('command = "/usr/bin/bflow"');
    expect(toml).toContain('args = ["director", "mcp"]');
    expect(await readdir(join(root, ".agents/skills/bflow-start"))).toEqual(["SKILL.md"]);
    const settings = await readJson(".claude/settings.local.json");
    expect(settings.enabledMcpjsonServers).toEqual(["bflow"]);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("'/usr/bin/bflow' director hook claude");
    expect((await readJson(".codex/hooks.json")).hooks.UserPromptSubmit[0].hooks[0].command).toBe("'/usr/bin/bflow' director hook codex");
    const ignore = await read(EXCL);
    expect(ignore).toContain(".mcp.json\n");
    expect(ignore).toContain(".bflow/director-files.json");
    expect((await readJson(".bflow/director-files.json")).units.length).toBe(8);
  });

  it("preserves unrelated JSON keys", async () => {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }));
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
    await applyDirectorRepoFiles(input());
    const mcp = await readJson(".mcp.json");
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.extra).toBe(1);
    expect((await readJson(".claude/settings.local.json")).permissions).toEqual({ allow: ["Bash"] });
  });

  it("is idempotent", async () => {
    await applyDirectorRepoFiles(input());
    const files = [...directorRepoFilePaths(ALL), EXCL, ".bflow/director-files.json"];
    const before = await Promise.all(files.map(read));
    expect((await applyDirectorRepoFiles(input())).written).toEqual([]);
    expect(await Promise.all(files.map(read))).toEqual(before);
    const settings = await readJson(".claude/settings.local.json");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.enabledMcpjsonServers).toEqual(["bflow"]);
  });

  it("replaces the TOML block and keeps user content", async () => {
    await mkdir(join(root, ".codex"));
    await writeFile(join(root, ".codex/config.toml"), 'model = "x"');
    await applyDirectorRepoFiles(input());
    await applyDirectorRepoFiles(input({ bflowCommand: ["/opt/b\"flow", "run"] }));
    const toml = await read(".codex/config.toml");
    expect(toml.startsWith('model = "x"\n# >>> bflow director >>>')).toBe(true);
    expect(toml.match(/# >>> bflow director >>>/g)).toHaveLength(1);
    expect(toml).toContain('command = "/opt/b\\"flow"');
    expect(toml).toContain('args = ["run", "director", "mcp"]');
    expect(toml).not.toContain('"/usr/bin/bflow"');
    const hooks = await readJson(".codex/hooks.json");
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("refuses invalid JSON without writing anything", async () => {
    await writeFile(join(root, ".mcp.json"), "{ nope");
    await expect(applyDirectorRepoFiles(input())).rejects.toThrow("Cannot merge .mcp.json: invalid JSON");
    expect(await exists(LEGACY)).toBe(false);
    expect(await read(EXCL)).not.toContain("bflow director");
    expect(await exists(".claude/skills/bflow-start/SKILL.md")).toBe(false);
    expect(await exists(".bflow/director-files.json")).toBe(false);
  });

  it("checks missing, current and modified", async () => {
    expect((await checkDirectorRepoFiles(input())).every(c => c.status === "missing")).toBe(true);
    await applyDirectorRepoFiles(input());
    const after = await checkDirectorRepoFiles(input());
    expect(after.map(c => c.path)).toEqual([...directorRepoFilePaths(ALL), EXCL].sort());
    expect(after.every(c => c.status === "current")).toBe(true);
    await writeFile(join(root, ".claude/skills/bflow-start/SKILL.md"), "edited");
    const modified = await checkDirectorRepoFiles(input());
    expect(modified.find(c => c.path === ".claude/skills/bflow-start/SKILL.md")?.status).toBe("modified");
    expect(modified.filter(c => c.status !== "modified").every(c => c.status === "current")).toBe(true);
  });

  it("removes only unmodified Bflow units", async () => {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    await applyDirectorRepoFiles(input());
    await writeFile(join(root, ".claude/skills/bflow-start/SKILL.md"), "edited");
    const result = await removeDirectorRepoFiles(root);
    expect(result.kept).toEqual([".claude/skills/bflow-start/SKILL.md"]);
    expect(result.removed).toContain(".mcp.json");
    expect(result.removed).toContain(".agents/skills/bflow-start/SKILL.md");
    expect(await readJson(".mcp.json")).toEqual({ mcpServers: { other: { command: "x" } } });
    expect(await read(".claude/skills/bflow-start/SKILL.md")).toBe("edited");
    expect(await exists(".codex/config.toml")).toBe(false);
    expect(await exists(".codex/hooks.json")).toBe(false);
    expect(await exists(".claude/settings.local.json")).toBe(false);
    expect(await exists(".agents/skills/bflow-start/SKILL.md")).toBe(false);
    expect(await exists(LEGACY)).toBe(false);
    expect(await read(EXCL)).not.toContain("bflow director");
    expect(await exists(".bflow/director-files.json")).toBe(false);
    expect(await removeDirectorRepoFiles(root)).toEqual({ removed: [], kept: [] });
  });

  it("keeps user exclude lines without the marker block after removal", async () => {
    await writeFile(join(root, EXCL), "node_modules");
    await applyDirectorRepoFiles(input({ providers: ["agy"] }));
    await removeDirectorRepoFiles(root);
    expect((await read(EXCL)).trim()).toBe("node_modules");
  });

  it("refuses to write through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "director-outside-"));
    try {
      await symlink(outside, join(root, ".claude"));
      await expect(applyDirectorRepoFiles(input())).rejects.toThrow("Refusing to write through a symlink");
      expect(await readdir(outside)).toEqual([]);
      expect(await read(EXCL)).not.toContain("bflow director");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("treats a dangling START marker as malformed in apply, check and remove", async () => {
    const dangling = "node_modules\n# >>> bflow director >>>\nmy-secret.env\ndist/\n";
    await writeFile(join(root, EXCL), dangling);
    await expect(applyDirectorRepoFiles(input({ providers: ["agy"] }))).rejects.toThrow(
      "Cannot merge .git/info/exclude: malformed bflow director block",
    );
    expect(await read(EXCL)).toBe(dangling);
    expect(await exists(".bflow/director-files.json")).toBe(false);
    expect((await checkDirectorRepoFiles(input({ providers: ["agy"] }))).find(c => c.path === EXCL)?.status).toBe("modified");

    await rm(join(root, EXCL));
    await applyDirectorRepoFiles(input({ providers: ["agy"] }));
    const broken = (await read(EXCL)).replace("# <<< bflow director <<<\n", "");
    await writeFile(join(root, EXCL), broken);
    const result = await removeDirectorRepoFiles(root);
    expect(result.kept).toContain(EXCL);
    expect(await read(EXCL)).toBe(broken);
  });

  it("removes units of dropped providers on re-apply and keeps hand-modified ones", async () => {
    await applyDirectorRepoFiles(input());
    const second = await applyDirectorRepoFiles(input({ providers: ["claude"] }));
    expect(second.written).toEqual(expect.arrayContaining([".agents/skills/bflow-start/SKILL.md", ".codex/config.toml", ".codex/hooks.json"]));
    expect(await exists(".agents/skills/bflow-start/SKILL.md")).toBe(false);
    expect(await exists(".codex/config.toml")).toBe(false);
    expect(await exists(".codex/hooks.json")).toBe(false);
    const receipt = await readJson(".bflow/director-files.json");
    expect(receipt.providers).toEqual(["claude"]);
    expect(receipt.units.map((u: { path: string }) => u.path).every((p: string) => !p.startsWith(".codex") && !p.startsWith(".agents"))).toBe(true);
    const ignore = await read(EXCL);
    expect(ignore).not.toContain(".codex");
    expect(ignore).toContain(".mcp.json");

    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    execFileSync("git", ["init", "--quiet", root]);
    await applyDirectorRepoFiles(input());
    await writeFile(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine director hook codex" }] }] } }));
    await applyDirectorRepoFiles(input({ providers: ["claude"] }));
    expect(await exists(".codex/hooks.json")).toBe(true);
    expect(await exists(".codex/config.toml")).toBe(false);
  });
});

describe("commitSkills", () => {
  it("writes no exclude block when commitSkills is true", async () => {
    const { written } = await applyDirectorRepoFiles(input({ commitSkills: true }));
    expect(written).not.toContain(EXCL);
    expect(await read(EXCL)).not.toContain("bflow director");
    expect(await exists(LEGACY)).toBe(false);
    const checks = await checkDirectorRepoFiles(input({ commitSkills: true }));
    expect(checks.map(c => c.path)).not.toContain(EXCL);
    expect(checks.every(c => c.status === "current")).toBe(true);
  });

  it("removes a previously managed exclude block when re-applied with commitSkills", async () => {
    await applyDirectorRepoFiles(input());
    expect(await read(EXCL)).toContain("bflow director");
    await applyDirectorRepoFiles(input({ commitSkills: true }));
    expect(await read(EXCL)).not.toContain("bflow director");
  });
});

describe("git exclude location", () => {
  const legacyBlock = (inner: string) => `# >>> bflow director >>>\n${inner}\n# <<< bflow director <<<\n`;

  it("hides the Director files from git status without touching .gitignore", async () => {
    await applyDirectorRepoFiles(input());
    expect(await exists(LEGACY)).toBe(false);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    expect(status).toBe("");
  });

  it("migrates a legacy .gitignore block (bflow-only file is deleted)", async () => {
    // Install the exclude layout, then rewrite state to look like the earlier .gitignore install.
    await applyDirectorRepoFiles(input());
    const ignored = [...directorRepoFilePaths(ALL), ".bflow/director-files.json"].sort().join("\n");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(ignored).digest("hex");
    await writeFile(join(root, LEGACY), legacyBlock(ignored));
    const receipt = await readJson(".bflow/director-files.json");
    receipt.units = receipt.units.filter((u: { path: string }) => u.path !== EXCL).concat([{ path: LEGACY, kind: "gitignore-block", sha256: hash }]);
    await writeFile(join(root, ".bflow/director-files.json"), JSON.stringify(receipt));
    await writeFile(join(root, EXCL), "");

    await applyDirectorRepoFiles(input());
    expect(await exists(LEGACY)).toBe(false);
    expect(await read(EXCL)).toContain(".mcp.json\n");
    const units = (await readJson(".bflow/director-files.json")).units.map((u: { path: string }) => u.path);
    expect(units).toContain(EXCL);
    expect(units).not.toContain(LEGACY);
  });

  it("migrates a legacy block but keeps the user's .gitignore lines", async () => {
    await applyDirectorRepoFiles(input());
    const ignored = [...directorRepoFilePaths(ALL), ".bflow/director-files.json"].sort().join("\n");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(ignored).digest("hex");
    await writeFile(join(root, LEGACY), `node_modules\n${legacyBlock(ignored)}dist\n`);
    const receipt = await readJson(".bflow/director-files.json");
    receipt.units = receipt.units.filter((u: { path: string }) => u.path !== EXCL).concat([{ path: LEGACY, kind: "gitignore-block", sha256: hash }]);
    await writeFile(join(root, ".bflow/director-files.json"), JSON.stringify(receipt));

    await applyDirectorRepoFiles(input());
    expect(await read(LEGACY)).toBe("node_modules\ndist\n");
  });

  it("leaves a hand-edited legacy .gitignore block alone", async () => {
    await applyDirectorRepoFiles(input());
    const receipt = await readJson(".bflow/director-files.json");
    receipt.units = receipt.units.filter((u: { path: string }) => u.path !== EXCL).concat([{ path: LEGACY, kind: "gitignore-block", sha256: "0".repeat(64) }]);
    await writeFile(join(root, ".bflow/director-files.json"), JSON.stringify(receipt));
    const edited = legacyBlock("mine");
    await writeFile(join(root, LEGACY), edited);
    await applyDirectorRepoFiles(input());
    expect(await read(LEGACY)).toBe(edited);
  });

  it("writes to the common git dir from a linked worktree", async () => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "i", "--quiet"], { cwd: root });
    const linked = await mkdtemp(join(tmpdir(), "director-linked-"));
    await rm(linked, { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "add", "--quiet", "-b", "linked", linked], { cwd: root });
      await applyDirectorRepoFiles({ ...input(), repositoryRoot: linked });
      expect(await read(EXCL)).toContain(".mcp.json\n");
      expect(await exists(LEGACY)).toBe(false);
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: linked, encoding: "utf8" });
      expect(status).toBe("");
      await removeDirectorRepoFiles(linked);
      expect(await read(EXCL)).not.toContain("bflow director");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: root, stdio: "ignore" });
    }
  });
});
