import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentConfigSchema, parseCliArgs, parseConfigYaml, runCli } from "../src/index.js";
import { BFLOW_EXCLUDE_ENTRY, BFLOW_EXCLUDE_MARKER } from "../src/git-exclude.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const roles = async (root: string) =>
  EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(join(root, ".bflow/config.yml"), "utf8"))).environment.roles;
const byRole = async (root: string) => Object.fromEntries((await roles(root)).map(role => [role.role, role]));
const excludeLines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean);

describe("bflow init role/model presets", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-init-preset-")));
    git(dir, "init", "--quiet");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("pre-populates every role with the claude preset and reports the table", async () => {
    const result = await runCli(["init", "--provider", "claude", "--no-gitnexus", "--json"], { cwd: dir });
    expect(result.ok).toBe(true);
    const saved = await byRole(dir);
    expect(saved["coordinator"]).toMatchObject({ cli: "claude", model: "claude-opus-4-7", required: true });
    expect(saved["developer"]).toEqual({ role: "developer", cli: "claude", model: "claude-sonnet-4-6", required: false });
    expect(saved["conversation"]).toMatchObject({ cli: "claude", model: "claude-sonnet-4-6" });
    const data = JSON.parse(result.stdout).data;
    expect(data.rolePresets).toMatchObject({ provider: "claude", applied: true });
    expect(data.rolePresets.roles.find((row: { role: string }) => row.role === "architect")).toMatchObject({ cli: "claude", model: "claude-opus-4-7" });
  });

  it("applies the codex preset by default and accepts --preset as an alias", async () => {
    expect((await runCli(["init", "--no-gitnexus"], { cwd: dir })).ok).toBe(true);
    expect(Object.values(await byRole(dir)).every(role => role.cli === "codex" && role.model?.startsWith("gpt-5.4"))).toBe(true);
    expect((await byRole(dir))["qa"]?.model).toBe("gpt-5.4-mini");
    const parsed = parseCliArgs(["init", "--preset", "agy"]);
    expect(parsed.ok && parsed.value.command === "init" && parsed.value.provider).toBe("agy");
    expect(parseCliArgs(["init", "--preset", "claude", "--provider", "codex"]).ok).toBe(false);
    expect(parseCliArgs(["init", "--preset", "gemini"]).ok).toBe(false);
  });

  it("routes the agy Conversation role to Claude and omits effort/model for Agy specialists", async () => {
    const result = await runCli(["init", "--preset", "agy", "--no-gitnexus"], { cwd: dir });
    expect(result.ok).toBe(true);
    const saved = await byRole(dir);
    expect(saved["conversation"]).toMatchObject({ cli: "claude", model: "claude-sonnet-4-6" });
    for (const role of ["coordinator", "architect", "reviewer", "qa", "developer"]) {
      expect(saved[role]?.cli).toBe("agy");
      expect(saved[role]?.model).toBeUndefined();
      expect(saved[role]?.effort).toBeUndefined();
    }
    expect(result.stdout).toContain("Agy does not support the Conversation role");
  });

  it("uses the interactive selection, offered with the installed CLIs, for a new configuration", async () => {
    const offered: unknown[] = [];
    const result = await runCli(["init", "--no-gitnexus"], { cwd: dir, selectInitProvider: async options => { offered.push(options); return "claude"; } });
    expect(result.ok).toBe(true);
    expect(offered).toHaveLength(1);
    expect((await byRole(dir))["reviewer"]).toMatchObject({ cli: "claude", model: "claude-opus-4-7" });
    // An existing configuration is preserved without asking again.
    expect((await runCli(["init", "--no-gitnexus"], { cwd: dir, selectInitProvider: async () => { offered.push("again"); return "codex"; } })).ok).toBe(true);
    expect(offered).toHaveLength(1);
    expect((await byRole(dir))["reviewer"]?.cli).toBe("claude");
  });

  it("keeps saved choices on --update and switches only changed-CLI roles to the new preset", async () => {
    expect((await runCli(["init", "--provider", "claude", "--no-gitnexus"], { cwd: dir })).ok).toBe(true);
    const path = join(dir, ".bflow/config.yml");
    await writeFile(path, (await readFile(path, "utf8")).replace(
      /(- role: qa\n\s+cli: claude\n\s+model: )claude-sonnet-4-6/, "$1custom-qa-model"));
    expect((await byRole(dir))["qa"]?.model).toBe("custom-qa-model");

    expect((await runCli(["init", "--update", "--no-gitnexus"], { cwd: dir })).ok).toBe(true);
    expect((await byRole(dir))["qa"]).toMatchObject({ cli: "claude", model: "custom-qa-model" });

    const switched = await runCli(["init", "--update", "--preset", "agy", "--no-gitnexus", "--json"], { cwd: dir });
    expect(switched.ok).toBe(true);
    const saved = await byRole(dir);
    expect(saved["qa"]).toMatchObject({ cli: "agy" });
    expect(saved["qa"]?.model).toBeUndefined();
    // Conversation stays on Claude under the agy preset, so its saved model is kept.
    expect(saved["conversation"]).toMatchObject({ cli: "claude", model: "claude-sonnet-4-6" });
    expect(JSON.parse(switched.stdout).data.rolePresets).toMatchObject({ provider: "agy", applied: true });
  });
});

describe("bflow init Git exclude", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-init-exclude-")));
    git(dir, "init", "--quiet");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("creates .git/info when missing, adds .bflow/ once across repeated init/update runs and hides it from status", async () => {
    await rm(join(dir, ".git/info"), { recursive: true, force: true });
    const exclude = join(dir, ".git/info/exclude");
    for (const args of [["init"], ["init"], ["init", "--update"], ["init", "--force"]])
      expect((await runCli([...args, "--no-gitnexus"], { cwd: dir })).ok).toBe(true);
    // Director files are hidden through their own marked block in the same exclude file (D-DIR-05).
    const lines = await excludeLines(exclude);
    const start = lines.indexOf("# >>> bflow director >>>");
    const end = lines.indexOf("# <<< bflow director <<<");
    expect(start).toBeGreaterThanOrEqual(0);
    expect([...lines.slice(0, start), ...lines.slice(end + 1)]).toEqual([BFLOW_EXCLUDE_MARKER, BFLOW_EXCLUDE_ENTRY]);
    expect(git(dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await readFile(join(dir, ".gitignore"), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("does not duplicate a user's own .bflow rule and leaves it in place on --remove", async () => {
    const exclude = join(dir, ".git/info/exclude");
    await writeFile(exclude, "# user rules\n*.swp\n.bflow\n");
    const first = await runCli(["init", "--no-gitnexus", "--json"], { cwd: dir });
    expect(JSON.parse(first.stdout).data.gitExclude).toMatchObject({ status: "user", changed: false });
    expect((await runCli(["init", "--remove"], { cwd: dir })).ok).toBe(true);
    expect(await readFile(exclude, "utf8")).toBe("# user rules\n*.swp\n.bflow\n");
  });

  it("reports the entry in --check and removes only the Bflow-added lines on --remove", async () => {
    const exclude = join(dir, ".git/info/exclude");
    await writeFile(exclude, "*.swp\n");
    expect((await runCli(["init", "--no-gitnexus"], { cwd: dir })).ok).toBe(true);
    const checked = await runCli(["init", "--check", "--json"], { cwd: dir });
    expect(JSON.parse(checked.stdout).data.gitExclude).toMatchObject({ path: exclude, status: "bflow", changed: false });
    const removed = await runCli(["init", "--remove", "--json"], { cwd: dir });
    expect(JSON.parse(removed.stdout).data.gitExclude).toMatchObject({ status: "absent", changed: true });
    expect(await readFile(exclude, "utf8")).toBe("*.swp\n");
    const again = await runCli(["init", "--check", "--json"], { cwd: dir });
    const data = JSON.parse(again.stdout).data;
    expect(data.gitExclude.status).toBe("absent");
    expect(data.diagnostics.some((line: string) => line.includes(".bflow/ is not listed"))).toBe(true);
  });

  it("writes the shared common-dir exclude file from a linked worktree", async () => {
    git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "base");
    const linked = join(dir, "..", `${dir.split("/").pop()}-linked`);
    git(dir, "worktree", "add", "--quiet", linked);
    try {
      expect((await runCli(["init", "--no-gitnexus"], { cwd: linked })).ok).toBe(true);
      expect(await excludeLines(join(dir, ".git/info/exclude"))).toContain(BFLOW_EXCLUDE_ENTRY);
      await expect(stat(join(dir, ".git/worktrees", linked.split("/").pop()!, "info/exclude"))).rejects.toThrow();
      expect(git(linked, "status", "--porcelain", "--untracked-files=all")).toBe("");
    } finally {
      git(dir, "worktree", "remove", "--force", linked);
    }
  });
});
