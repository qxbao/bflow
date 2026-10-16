import { chmod, mkdtemp, mkdir, readdir, realpath, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PATH_BLOCK_END,
  PATH_BLOCK_START,
  PathComponent,
  SetupStateStore,
  type PlatformProfile,
  type SetupContext
} from "../src/index.js";

let root: string;
let home: string;
let platform: PlatformProfile;
const NOW = new Date("2026-01-02T03:04:05.678Z");
const uid = typeof process.getuid === "function" ? process.getuid() : null;

function profile(over: Partial<PlatformProfile> = {}): PlatformProfile {
  return {
    os: "linux", arch: "x64", supportStatus: "supported", shell: "bash", shellPath: "/bin/bash",
    uid, gid: null, isRoot: false, elevationAvailable: false, homeDir: home, hostname: "h", machineId: "m-1",
    paths: {
      config: path.join(root, "cfg/bflow"), data: path.join(root, "data/bflow"),
      state: path.join(root, "state/bflow"), managedBin: path.join(home, ".local/bin")
    },
    pathEntries: ["/usr/bin"], ...over
  };
}
const ctx = (mode: SetupContext["mode"] = "apply"): SetupContext => ({
  platform, mode, now: () => NOW, runner: { run: async () => { throw new Error("no commands"); } }
});
function comp(env: Record<string, string | undefined> = {}, dirs: (string | null)[] = [], p = platform) {
  return new PathComponent({
    platform: p,
    store: new SetupStateStore(p.paths, { uid, now: () => NOW }),
    observations: dirs.map((d) => ({ pathMissingDir: d })),
    env
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bflow-path-")));
  home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  platform = profile();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PathComponent", () => {
  it("creates the rc file with the managed block when absent", async () => {
    const c = comp();
    const res = await c.apply(ctx());
    const file = path.join(home, ".bashrc");
    expect(res).toEqual({ ownedPaths: [file], diagnostics: [] });
    const text = await readFile(file, "utf8");
    const d = path.join(home, ".local/bin");
    expect(text).toBe(
      `${PATH_BLOCK_START}\ncase ":\${PATH}:" in *:'${d}':*) ;; *) PATH='${d}':"$PATH" ;; esac\nexport PATH\n${PATH_BLOCK_END}\n`
    );
  });

  it("selects targets per shell", () => {
    expect(comp({}, [], profile({ shell: "bash", os: "darwin" })).targetFile()).toBe(path.join(home, ".bash_profile"));
    expect(comp({ ZDOTDIR: "/z" }, [], profile({ shell: "zsh" })).targetFile()).toBe("/z/.zshrc");
    expect(comp({}, [], profile({ shell: "zsh" })).targetFile()).toBe(path.join(home, ".zshrc"));
    expect(comp({}, [], profile({ shell: "unknown" })).targetFile()).toBe(path.join(home, ".profile"));
    expect(comp({ XDG_CONFIG_HOME: "/x" }, [], profile({ shell: "fish" })).targetFile()).toBe("/x/fish/conf.d/bflow.fish");
  });

  it("dedupes dirs, drops those already on PATH, keeps managedBin", async () => {
    const p = profile({ pathEntries: ["/opt/a", path.join(home, ".local/bin")] });
    const c = comp({}, ["/opt/a", "/opt/b", "/opt/b", null], p);
    expect(await c.desiredDirs()).toEqual([path.join(home, ".local/bin"), "/opt/b"]);
  });

  it("preserves user content byte for byte and appends with one leading newline", async () => {
    const file = path.join(home, ".bashrc");
    const orig = "export FOO=1\r\n# comment\nalias x='y'\n";
    await writeFile(file, orig, { mode: 0o640 });
    await chmod(file, 0o640);
    await comp().apply(ctx());
    const text = await readFile(file, "utf8");
    expect(text.startsWith(`${orig}\n${PATH_BLOCK_START}\n`)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it("replaces an existing block in place, leaving other bytes untouched", async () => {
    const file = path.join(home, ".bashrc");
    await writeFile(file, `top\n${PATH_BLOCK_START}\nOLDLINE\n${PATH_BLOCK_END}\nbottom`);
    await comp().apply(ctx());
    const text = await readFile(file, "utf8");
    expect(text.startsWith("top\n" + PATH_BLOCK_START)).toBe(true);
    expect(text.endsWith(`${PATH_BLOCK_END}\nbottom`)).toBe(true);
    expect(text).not.toContain("OLDLINE");
  });

  it("rerun performs no write and digests are equal", async () => {
    const c = comp();
    await c.apply(ctx());
    const file = path.join(home, ".bashrc");
    const before = await stat(file);
    const bytes = await readFile(file);
    await new Promise((r) => setTimeout(r, 20));
    const res = await c.apply(ctx());
    const after = await stat(file);
    expect(res.diagnostics).toEqual([]);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(file)).toEqual(bytes);
    const obs = await c.observe(ctx());
    expect(obs.valid).toBe(true);
    expect(obs.stateDigest).toBe((await c.desired(ctx())).digest);
    expect((await c.desired(ctx())).repairNeeded).toBe(false);
  });

  it("observe reports null digest when no block exists", async () => {
    expect(await comp().observe(ctx())).toEqual({ stateDigest: null, valid: true, diagnostics: [] });
  });

  it("duplicate blocks are invalid; non-repair apply writes nothing; repair dedupes", async () => {
    const file = path.join(home, ".bashrc");
    const dup = `a\n${PATH_BLOCK_START}\nx\n${PATH_BLOCK_END}\nb\n${PATH_BLOCK_START}\ny\n${PATH_BLOCK_END}\nc\n`;
    await writeFile(file, dup);
    const c = comp();
    expect((await c.observe(ctx())).valid).toBe(false);
    expect((await c.desired(ctx())).repairNeeded).toBe(true);
    const res = await c.apply(ctx("apply"));
    expect(res).toEqual({ ownedPaths: [], diagnostics: ["PATH block malformed; run setup --repair"] });
    expect(await readFile(file, "utf8")).toBe(dup);
    const fixed = await c.apply(ctx("repair"));
    expect(fixed.diagnostics).toEqual([]);
    const text = await readFile(file, "utf8");
    expect(text.split(PATH_BLOCK_START).length - 1).toBe(1);
    expect(text.split(PATH_BLOCK_END).length - 1).toBe(1);
    expect(text.startsWith("a\n")).toBe(true);
    expect(text).toContain("\nb\n");
    expect(text.endsWith("\nc\n")).toBe(true);
    expect((await c.observe(ctx())).valid).toBe(true);
  });

  it("repairs an unterminated block, keeping unrelated user lines", async () => {
    const file = path.join(home, ".bashrc");
    const d = path.join(home, ".local/bin");
    await writeFile(
      file,
      `a\n${PATH_BLOCK_START}\ncase ":\${PATH}:" in *:'${d}':*) ;; *) PATH='${d}':"$PATH" ;; esac\nexport PATH\nuser line\n`
    );
    const c = comp();
    expect((await c.observe(ctx())).valid).toBe(false);
    await c.apply(ctx("repair"));
    const text = await readFile(file, "utf8");
    expect(text).toContain("user line");
    expect(text.split(PATH_BLOCK_START).length - 1).toBe(1);
    expect(text.split("export PATH").length - 1).toBe(1);
    expect((await c.observe(ctx())).valid).toBe(true);
  });

  it("creates a backup before modifying an existing file, none for a new file", async () => {
    const file = path.join(home, ".bashrc");
    await comp().apply(ctx());
    expect(await readdir(path.join(platform.paths.state, "backups")).catch(() => [])).toEqual([]);
    await writeFile(file, "orig\n");
    await comp({}, ["/opt/new"]).apply(ctx());
    const idx = await readFile(path.join(platform.paths.state, "backups/index.jsonl"), "utf8");
    const entry = JSON.parse(idx.trim().split("\n")[0]!);
    expect(entry.original).toBe(file);
    expect(await readFile(entry.backup, "utf8")).toContain("orig");
  });

  it("fish: owns the whole file and creates conf.d", async () => {
    const p = profile({ shell: "fish" });
    const c = comp({ XDG_CONFIG_HOME: path.join(root, "xdg") }, ["/opt/b"], p);
    const res = await c.apply(ctx());
    const file = path.join(root, "xdg/fish/conf.d/bflow.fish");
    expect(res.ownedPaths).toEqual([file]);
    const text = await readFile(file, "utf8");
    expect(text).toContain("contains -- '/opt/b' $PATH; or set -gx PATH '/opt/b' $PATH");
    expect(text).not.toContain("export PATH");
    expect(text.startsWith(PATH_BLOCK_START)).toBe(true);
    expect((await c.observe(ctx())).stateDigest).toBe((await c.desired(ctx())).digest);
  });

  it("rejects dirs with quote, newline, NUL or relative", async () => {
    for (const bad of ["/opt/it's", "/opt/a\nb", "/opt/a\0b", "rel/dir", "/opt/a:b"]) {
      const c = comp({}, [bad]);
      const res = await c.apply(ctx());
      expect(res.ownedPaths).toEqual([]);
      expect(res.diagnostics.length).toBeGreaterThan(0);
      expect((await c.observe(ctx())).valid).toBe(false);
    }
    await expect(stat(path.join(home, ".bashrc"))).rejects.toThrow();
  });

  it("fish rejects backslash; posix allows it", async () => {
    const f = comp({}, ["/opt/a\\b"], profile({ shell: "fish" }));
    expect((await f.apply(ctx())).ownedPaths).toEqual([]);
    expect((await comp({}, ["/opt/a\\b"]).observe(ctx())).valid).toBe(true);
  });

  it("keeps block dirs stable once they appear on PATH (no flapping)", async () => {
    await comp({}, ["/opt/new"]).apply(ctx());
    const file = path.join(home, ".bashrc");
    const before = await stat(file);
    const bytes = await readFile(file);
    const p2 = profile({ pathEntries: ["/usr/bin", "/opt/new"] });
    const c2 = comp({}, [null], p2);
    expect(await c2.desiredDirs()).toEqual([path.join(home, ".local/bin"), "/opt/new"]);
    const obs = await c2.observe(ctx());
    expect(obs.stateDigest).toBe((await c2.desired(ctx())).digest);
    await new Promise((r) => setTimeout(r, 20));
    await c2.apply(ctx());
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file)).toEqual(bytes);
  });

  describe("generated block executes", () => {
    const run = (sh: string, script: string, pathEnv: string): string =>
      execFileSync(sh, ["-c", script], { env: { PATH: pathEnv }, encoding: "utf8" });
    const hasFish = spawnSync("fish", ["--version"]).status === 0;

    it("sh: dir appears once after sourcing twice; unchanged if already present", async () => {
      const dir = path.join(home, "my bin");
      const c = comp({}, [], profile({ paths: { ...platform.paths, managedBin: dir } }));
      await c.apply(ctx());
      const rc = path.join(home, ".bashrc");
      const base = "/usr/bin:/bin";
      const out = run("/bin/sh", `. '${rc}'; . '${rc}'; echo "$PATH"`, base).trim();
      expect(out).toBe(`${dir}:${base}`);
      const present = `/x:${dir}:/y`;
      expect(run("/bin/sh", `. '${rc}'; echo "$PATH"`, present).trim()).toBe(present);
    });

    it.skipIf(!hasFish)("fish: dir appears once", async () => {
      const dir = path.join(home, "fbin");
      const p = profile({ shell: "fish", paths: { ...platform.paths, managedBin: dir } });
      await comp({ XDG_CONFIG_HOME: path.join(root, "x") }, [], p).apply(ctx());
      const f = path.join(root, "x/fish/conf.d/bflow.fish");
      const out = run("fish", `source '${f}'; source '${f}'; string join : $PATH`, "/usr/bin:/bin").trim();
      expect(out.split(":").filter((e) => e === dir)).toHaveLength(1);
    });
  });

  it("check and dry_run never write", async () => {
    for (const m of ["check", "dry_run"] as const) {
      const res = await comp().apply(ctx(m));
      expect(res.ownedPaths).toEqual([]);
      expect(res.diagnostics.length).toBe(1);
    }
    await expect(stat(path.join(home, ".bashrc"))).rejects.toThrow();
  });

  it("win32/pwsh/cmd report unsupported and never write", async () => {
    for (const p of [profile({ os: "win32", shell: "pwsh" }), profile({ shell: "cmd" }), profile({ os: "win32", shell: "bash" })]) {
      const c = comp({}, [], p);
      expect(await c.apply(ctx())).toEqual({ ownedPaths: [], diagnostics: ["windows support not verified"] });
      expect((await c.desired(ctx())).targets).toEqual([]);
    }
    expect(await readdir(home)).toEqual([]);
  });
});
