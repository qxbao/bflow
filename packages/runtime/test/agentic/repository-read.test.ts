import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryReadInputSchema, repositoryRead } from "../../src/agentic/repository-read.js";
import { verificationGit } from "../../src/agentic/behavioral-runner.js";

const roots: string[] = [];
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bflow-repository-read-"));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function asDifferentOwner<T>(action: () => Promise<T>): Promise<T> {
  const shim = await mkdtemp(join(tmpdir(), "bflow-git-owner-shim-"));
  roots.push(shim);
  const actual = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const script = `#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec '${actual.replaceAll("'", "'\\''")}' "$@"\n`;
  const bin = join(shim, "git"); await writeFile(bin, script); await chmod(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim}:${oldPath ?? ""}`;
  try { return await action(); }
  finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
}

describe("repository reader input schema", () => {
  it("accepts only the documented operations and rejects extra fields and unsafe values", () => {
    expect(RepositoryReadInputSchema.safeParse({ op: "read", path: "README.md" }).success).toBe(true);
    expect(RepositoryReadInputSchema.safeParse({ op: "read", path: "../secret" }).success).toBe(false);
    expect(RepositoryReadInputSchema.safeParse({ op: "git", action: "diff", args: ["--output=x"] }).success).toBe(false);
    expect(RepositoryReadInputSchema.safeParse({ op: "git", action: "show" }).success).toBe(false);
    expect(RepositoryReadInputSchema.safeParse({ op: "list", path: "/tmp" }).success).toBe(false);
    expect(RepositoryReadInputSchema.safeParse({ op: "read", path: "a", limit: 999999 }).success).toBe(false);
  });
});

describe("repositoryRead", () => {
  it("reports an unborn HEAD of a fresh git init explicitly for head and log, but still fails on broken metadata", async () => {
    const root = await repo();
    git(root, "init", "-b", "main");
    expect(await repositoryRead(root, { op: "git", action: "head", limit: 1 })).toEqual({ op: "git", action: "head", output: "", unborn: true });
    expect(await repositoryRead(root, { op: "git", action: "log", limit: 5 })).toEqual({ op: "git", action: "log", output: "", unborn: true });
    expect(await repositoryRead(root, { op: "list", path: ".", limit: 1 })).toMatchObject({ op: "list" });
    await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n0000\n");
    await expect(repositoryRead(root, { op: "git", action: "head", limit: 1 })).rejects.toThrow();
  });
  it("reads UTF-8 source by bounded byte offset and limit", async () => {
    const root = await repo();
    await writeFile(join(root, "src.ts"), "0123456789", "utf8");
    const result = await repositoryRead(root, { op: "read", path: "src.ts", offset: 3, limit: 4 }) as Record<string, unknown>;
    expect(result).toMatchObject({ op: "read", path: "src.ts", offset: 3, content: "3456", bytes: 4, truncated: true });
  });

  it("keeps UTF-8 byte chunks valid when offsets or limits cross multibyte characters", async () => {
    const root = await repo();
    await writeFile(join(root, "unicode.txt"), "a€b", "utf8");
    const fromMiddle = await repositoryRead(root, { op: "read", path: "unicode.txt", offset: 2, limit: 2 }) as { content: string; offset: number };
    expect(fromMiddle).toMatchObject({ content: "b", offset: 4 });
    const partialEnd = await repositoryRead(root, { op: "read", path: "unicode.txt", offset: 0, limit: 2 }) as { content: string };
    expect(partialEnd.content).toBe("a");
  });

  it("rejects absolute/traversal paths, symlinks, binary files, and sensitive locations", async () => {
    const root = await repo();
    const outside = await mkdtemp(join(tmpdir(), "bflow-reader-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "do not read");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, ".env"), "TOKEN=secret");
    await expect(repositoryRead(root, { op: "read", path: "../secret.txt" })).rejects.toThrow();
    await expect(repositoryRead(root, { op: "read", path: join(outside, "secret.txt") })).rejects.toThrow();
    await expect(repositoryRead(root, { op: "read", path: "escape.txt" })).rejects.toThrow();
    await expect(repositoryRead(root, { op: "read", path: "image.bin" })).rejects.toThrow();
    await expect(repositoryRead(root, { op: "read", path: ".env" })).rejects.toThrow();
  });

  it("lists only bounded, non-sensitive direct children and never follows symlinks", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "id_ed25519"), "private-key");
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;");
    await writeFile(join(root, ".env.local"), "secret");
    await writeFile(join(root, "one.txt"), "1");
    await writeFile(join(root, "two.txt"), "2");
    await symlink(join(root, "src"), join(root, "linked"));
    const result = await repositoryRead(root, { op: "list", limit: 2 }) as { entries: Array<{ name: string }>; truncated: boolean };
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/node_modules|\.env|\.ssh|linked/);
  });

  it("paginates bounded directory listings past the first page", async () => {
    const root = await repo();
    for (let index = 0; index < 125; index++) await writeFile(join(root, `file-${String(index).padStart(3, "0")}.ts`), "x");
    const pages: string[] = [];
    let cursor: number | undefined;
    do {
      const page = await repositoryRead(root, { op: "list", limit: 40, ...(cursor ? { cursor } : {}) }) as { entries: Array<{ name: string }>; nextCursor?: string };
      pages.push(...page.entries.map(entry => entry.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toHaveLength(125);
    expect(new Set(pages).size).toBe(125);
    expect(pages).toContain("file-124.ts");
  });

  it("rejects FIFOs without opening or blocking on them", async () => {
    const root = await repo();
    spawnSync("mkfifo", [join(root, "pipe")]);
    const started = Date.now();
    await expect(repositoryRead(root, { op: "read", path: "pipe" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("provides fixed safe Git summaries and never returns patch contents", async () => {
    const root = await repo();
    git(root, "init", "-q");
    git(root, "-c", "user.name=Reader Test", "-c", "user.email=reader@example.invalid", "-c", "commit.gpgsign=false", "config", "--local", "core.autocrlf", "false");
    await writeFile(join(root, "source.ts"), "const publicValue = 1;\n");
    await writeFile(join(root, ".env"), "TOKEN=private-value\n");
    git(root, "add", "--", "source.ts", ".env");
    git(root, "-c", "user.name=Reader Test", "-c", "user.email=reader@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    await writeFile(join(root, "source.ts"), "const publicValue = 2;\n");
    await writeFile(join(root, ".env"), "TOKEN=changed-private-value\n");
    const status = await repositoryRead(root, { op: "git", action: "status" }) as { output: string };
    expect(status.output).toContain("source.ts");
    expect(status.output).not.toContain(".env");
    const diff = await repositoryRead(root, { op: "git", action: "diff" }) as { output: string };
    expect(diff.output).not.toContain("publicValue");
    expect(diff.output).not.toContain("private-value");
    expect(diff.output).not.toContain(".env");
    const head = await repositoryRead(root, { op: "git", action: "head" }) as { output: string };
    expect(head.output.trim()).toMatch(/^[0-9a-f]{40,64}$/);
    const log = await repositoryRead(root, { op: "git", action: "log" }) as { output: string };
    expect(log.output).toContain("initial");
  });

  it("never executes repository-configured clean filters during Git reads", async () => {
    const root = await repo();
    git(root, "init", "-q");
    git(root, "config", "user.name", "Reader Test");
    git(root, "config", "user.email", "reader@example.invalid");
    const hook = join(root, "filter.cjs");
    const sentinel = join(root, "filter-ran");
    await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');process.stdin.pipe(process.stdout);`);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=probe\n");
    await writeFile(join(root, "source.txt"), "before\n");
    git(root, "add", ".gitattributes", "source.txt");
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
    git(root, "config", "filter.probe.clean", `node ${hook}`);
    await writeFile(join(root, "source.txt"), "changed longer\n");
    await asDifferentOwner(async () => {
      for (const action of ["status", "diff"] as const) {
        await rm(sentinel, { force: true });
        await expect(repositoryRead(root, { op: "git", action })).rejects.toThrow(/unsupported/);
        await expect(access(sentinel)).rejects.toThrow();
      }
    });
  });

  it("supports a linked worktree only through validated gitfile/common-dir metadata", async () => {
    const root = await repo();
    git(root, "init", "-q");
    git(root, "config", "user.name", "Reader Test");
    git(root, "config", "user.email", "reader@example.invalid");
    await writeFile(join(root, "README.md"), "base\n");
    git(root, "add", "README.md");
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const linked = join(root, "..", `bflow-reader-linked-${Date.now()}`);
    roots.push(linked);
    git(root, "worktree", "add", "--detach", linked);
    await asDifferentOwner(async () => {
      for (const action of ["status", "log", "head", "files", "diff"] as const)
        expect(await repositoryRead(linked, { op: "git", action, limit: 5 })).toMatchObject({ op: "git", action });
    });
  });

  it("reader trusts only the exact canonical session root for all five safe Git summaries", async () => {
    const root = await repo(), outside = await repo(), home = await mkdtemp(join(tmpdir(), "bflow-git-owner-home-")); roots.push(home);
    for (const path of [root, outside]) {
      git(path, "init", "-q"); git(path, "config", "user.name", "Reader Test"); git(path, "config", "user.email", "reader@example.invalid");
      await writeFile(join(path, "source.txt"), "safe source\n"); git(path, "add", "source.txt");
      git(path, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    }
    await writeFile(join(root, "source.txt"), "changed source\n");
    const global = join(home, ".gitconfig");
    await writeFile(global, `[safe]\n\tdirectory = ${outside}\n`);
    const original = await readFile(global, "utf8");
    const oldHome = process.env.HOME, oldCount = process.env.GIT_CONFIG_COUNT, oldKey = process.env.GIT_CONFIG_KEY_0, oldValue = process.env.GIT_CONFIG_VALUE_0;
    process.env.HOME = home;
    process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "safe.directory"; process.env.GIT_CONFIG_VALUE_0 = outside;
    try {
      await asDifferentOwner(async () => {
        for (const action of ["status", "log", "head", "files", "diff"] as const) {
          const result = await repositoryRead(root, { op: "git", action, limit: 5 }) as { output: string };
          if (action === "status" || action === "files" || action === "diff") expect(result.output).toContain("source.txt");
          else expect(result.output).toMatch(action === "head" ? /^[0-9a-f]{40,64}$/ : /initial/);
        }
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldCount === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = oldCount;
      if (oldKey === undefined) delete process.env.GIT_CONFIG_KEY_0; else process.env.GIT_CONFIG_KEY_0 = oldKey;
      if (oldValue === undefined) delete process.env.GIT_CONFIG_VALUE_0; else process.env.GIT_CONFIG_VALUE_0 = oldValue;
    }
    expect(await readFile(global, "utf8")).toBe(original);
  });

  it("verificationGit trusts only its exact canonical cwd and ignores inherited/global safe.directory", async () => {
    const root = await repo(), outside = await repo(), home = await mkdtemp(join(tmpdir(), "bflow-git-verify-home-")); roots.push(home);
    for (const path of [root, outside]) {
      git(path, "init", "-q"); git(path, "config", "user.name", "Reader Test"); git(path, "config", "user.email", "reader@example.invalid");
      await writeFile(join(path, "source.txt"), "safe source\n"); git(path, "add", "source.txt");
      git(path, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    }
    const global = join(home, ".gitconfig"); await writeFile(global, `[safe]\n\tdirectory = ${outside}\n`);
    const original = await readFile(global, "utf8");
    const oldHome = process.env.HOME, oldCount = process.env.GIT_CONFIG_COUNT, oldKey = process.env.GIT_CONFIG_KEY_0, oldValue = process.env.GIT_CONFIG_VALUE_0;
    process.env.HOME = home; process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "safe.directory"; process.env.GIT_CONFIG_VALUE_0 = outside;
    try {
      await asDifferentOwner(async () => {
        await expect(verificationGit(root, ["rev-parse", "HEAD"]).then(value => value.trim())).resolves.toMatch(/^[0-9a-f]{40,64}$/);
        await expect(verificationGit(root, ["-C", outside, "rev-parse", "HEAD"])).rejects.toThrow(/dubious ownership/);
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldCount === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = oldCount;
      if (oldKey === undefined) delete process.env.GIT_CONFIG_KEY_0; else process.env.GIT_CONFIG_KEY_0 = oldKey;
      if (oldValue === undefined) delete process.env.GIT_CONFIG_VALUE_0; else process.env.GIT_CONFIG_VALUE_0 = oldValue;
    }
    expect(await readFile(global, "utf8")).toBe(original);
  });

  it("verificationGit applies exact trust recursively to a newly created detached worktree", async () => {
    const root = await repo();
    git(root, "init", "-q"); git(root, "config", "user.name", "Reader Test"); git(root, "config", "user.email", "reader@example.invalid");
    await writeFile(join(root, "README.md"), "base\n"); git(root, "add", "README.md"); git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const linked = join(root, "..", `bflow-owner-verify-linked-${Date.now()}`); roots.push(linked);
    const head = git(root, "rev-parse", "HEAD").trim();
    await asDifferentOwner(async () => {
      await expect(verificationGit(root, ["worktree", "add", "--detach", linked, head])).resolves.toBeDefined();
      await expect(verificationGit(linked, ["rev-parse", "HEAD"]).then(value => value.trim())).resolves.toBe(head);
      await expect(verificationGit(linked, ["rev-parse", "HEAD"]).then(value => value.trim())).resolves.toMatch(/^[0-9a-f]{40,64}$/);
    });
  });
});
