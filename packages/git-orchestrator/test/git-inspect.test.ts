import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { assertClean, inspectRepository } from "../src/git.js";

const run = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]) {
  return (await run("git", args, { cwd })).stdout.trim();
}

async function repository(name: string) {
  const parent = await mkdtemp(join(tmpdir(), "bflow-git-inspect-"));
  roots.push(parent);
  const root = join(parent, name);
  await mkdir(join(root, "nested"), { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "nested", "file.txt"), "one\n");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "initial");
  return { parent, root: await realpath(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

for (const name of ["repo", "re\npo"]) {
  it(`resolves root, common directory and in-progress markers of a linked worktree (${JSON.stringify(name)})`, async () => {
    const { parent, root } = await repository(name);
    const linked = join(parent, `${name}-linked`);
    await git(root, "worktree", "add", "-q", "-b", "task", linked);
    const linkedRoot = await realpath(linked);

    const inspected = await inspectRepository(join(linked, "nested"));
    expect(inspected).toMatchObject({ root: linkedRoot, commonDir: await realpath(join(root, ".git")), branch: "task", dirty: false });
    expect(inspected.head).toBe(await git(root, "rev-parse", "HEAD"));
    await expect(assertClean(linked)).resolves.toBeUndefined();

    // Linked worktree markers live under the common directory's worktrees/<id>/ path.
    const marker = await git(linked, "rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD");
    await writeFile(marker, `${inspected.head}\n`);
    await expect(assertClean(linked)).rejects.toThrow("Git operation is still in progress (CHERRY_PICK_HEAD)");
    await expect(assertClean(root)).resolves.toBeUndefined();

    await mkdir(join(root, ".git", "sequencer"));
    await expect(assertClean(join(root, "nested"))).rejects.toThrow("Git operation is still in progress (sequencer)");
  });
}
