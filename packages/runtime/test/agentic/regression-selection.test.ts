import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import type { ImpactIndex } from "../../src/agentic/impact-index.js";
import { selectRegressionTests } from "../../src/agentic/regression-selection.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempRepo(files: Record<string, string>): Promise<{ repo: string; base: string }> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "bflow-reg-select-")));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(repo, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@bflow.invalid", "commit", "-qm", "base"], {
    cwd: repo
  });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return { repo, base };
}

async function commitChanges(
  repo: string,
  changes: { write?: Record<string, string>; remove?: string[] },
  message = "head"
): Promise<string> {
  for (const [relPath, content] of Object.entries(changes.write ?? {})) {
    const fullPath = join(repo, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  for (const relPath of changes.remove ?? []) {
    await unlink(join(repo, relPath));
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@bflow.invalid", "commit", "-qm", message], {
    cwd: repo
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function makeProfile(repositoryRoot: string): RunnerProfile {
  return {
    id: "vitest",
    command: "vitest run",
    executable: "/usr/bin/node",
    args: ["vitest", "run"],
    method: "unit_test",
    levels: ["unit", "regression"],
    reporter: "vitest_json",
    timeoutMs: 30_000,
    checkoutDependencyRoots: [],
    dependencySource: repositoryRoot,
    source: "detected"
  };
}

describe("selectRegressionTests", () => {
  it("scope full selects every runner test file", async () => {
    const { repo, base } = await makeTempRepo({
      "src/math.ts": "export const x = 1;\n",
      "test/a.test.ts": "export {};\n",
      "test/b.test.ts": "export {};\n",
      "README.md": "# readme\n"
    });
    const head = await commitChanges(repo, {
      write: { "src/math.ts": "export const x = 2;\n" }
    });

    let indexCalled = false;
    const index: ImpactIndex = {
      async importersOf() {
        indexCalled = true;
        return { status: "ok", indexCommit: base, files: [] };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "full",
      index
    });

    expect(indexCalled).toBe(false);
    expect(result).toEqual({
      scope: "full",
      base,
      head,
      testPaths: ["test/a.test.ts", "test/b.test.ts"],
      changedFiles: ["src/math.ts"],
      changedFilesTruncated: false,
      widening: [],
      index: { notQueried: true }
    });
  });

  it("graph selects importer tests and changed tests", async () => {
    const { repo, base } = await makeTempRepo({
      "src/math.ts": "export const add = (a: number, b: number) => a + b;\n",
      "src/report.ts": "export const report = () => 'ok';\n",
      "test/math.test.ts": "export {};\n",
      "test/report.test.ts": "export {};\n",
      "test/unrelated.test.ts": "export {};\n"
    });
    const head = await commitChanges(repo, {
      write: {
        "src/math.ts": "export const add = (a: number, b: number) => a + b + 0;\n",
        "test/added.test.ts": "export {};\n"
      }
    });

    const index: ImpactIndex = {
      async importersOf(input) {
        expect(input).toEqual({
          repositoryRoot: repo,
          base,
          files: ["src/math.ts", "test/added.test.ts"]
        });
        return {
          status: "ok",
          indexCommit: base,
          files: ["test/math.test.ts", "src/report.ts", "test/report.test.ts"]
        };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "affected",
      index
    });

    expect(result).toEqual({
      scope: "graph",
      base,
      head,
      testPaths: ["test/added.test.ts", "test/math.test.ts", "test/report.test.ts"],
      changedFiles: ["src/math.ts", "test/added.test.ts"],
      changedFilesTruncated: false,
      widening: [],
      index: { commit: base }
    });
  });

  it("index unavailable widens code files to their package", async () => {
    const { repo, base } = await makeTempRepo({
      "package.json": '{"name":"root"}\n',
      "packages/x/package.json": '{"name":"@scope/x"}\n',
      "packages/x/src/math.ts": "export const x = 1;\n",
      "packages/x/test/a.test.ts": "export {};\n",
      "packages/x/test/b.test.ts": "export {};\n",
      "packages/y/package.json": '{"name":"@scope/y"}\n',
      "packages/y/test/y.test.ts": "export {};\n"
    });
    const head = await commitChanges(repo, {
      write: { "packages/x/src/math.ts": "export const x = 2;\n" }
    });

    const index: ImpactIndex = {
      async importersOf() {
        return {
          status: "unavailable",
          code: "commit_mismatch",
          detail: "Index commit does not match base"
        };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "affected",
      index
    });

    expect(result.scope).toBe("package");
    expect(result.testPaths).toEqual(["packages/x/test/a.test.ts", "packages/x/test/b.test.ts"]);
    expect(result.widening[0]?.reason).toBe("index_unavailable:commit_mismatch");
    expect(result.widening).toEqual([
      {
        path: "packages/x/src/math.ts",
        tier: "package",
        reason: "index_unavailable:commit_mismatch",
        packageRoot: "packages/x"
      }
    ]);
    expect(result.index).toEqual({
      unavailable: "commit_mismatch",
      detail: "Index commit does not match base"
    });
  });

  it("package without sub-package widens to full", async () => {
    const { repo, base } = await makeTempRepo({
      "package.json": '{"name":"single-pkg"}\n',
      "src/math.ts": "export const x = 1;\n",
      "test/a.test.ts": "export {};\n",
      "test/b.test.ts": "export {};\n"
    });
    const head = await commitChanges(repo, {
      write: { "src/math.ts": "export const x = 2;\n" }
    });

    const index: ImpactIndex = {
      async importersOf() {
        return {
          status: "unavailable",
          code: "not_configured",
          detail: "GitNexus not configured"
        };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "affected",
      index
    });

    expect(result).toEqual({
      scope: "full",
      base,
      head,
      testPaths: ["test/a.test.ts", "test/b.test.ts"],
      changedFiles: ["src/math.ts"],
      changedFilesTruncated: false,
      widening: [
        {
          path: "src/math.ts",
          tier: "full",
          reason: "index_unavailable:not_configured"
        }
      ],
      index: {
        unavailable: "not_configured",
        detail: "GitNexus not configured"
      }
    });
  });

  it("docs only selects nothing", async () => {
    const { repo, base } = await makeTempRepo({
      "README.md": "# Title\n",
      "docs/guide.md": "Guide\n",
      "test/a.test.ts": "export {};\n"
    });
    const head = await commitChanges(repo, {
      write: {
        "README.md": "# Updated Title\n",
        "docs/guide.md": "Updated Guide\n"
      }
    });

    let indexCalled = false;
    const index: ImpactIndex = {
      async importersOf() {
        indexCalled = true;
        return { status: "ok", indexCommit: base, files: [] };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "affected",
      index
    });

    expect(indexCalled).toBe(false);
    expect(result).toEqual({
      scope: "none",
      base,
      head,
      testPaths: [],
      changedFiles: ["README.md", "docs/guide.md"],
      changedFilesTruncated: false,
      widening: [],
      index: { notQueried: true }
    });
  });

  it("drops importer paths that no longer exist at head", async () => {
    const { repo, base } = await makeTempRepo({
      "src/math.ts": "export const x = 1;\n",
      "test/kept.test.ts": "export {};\n",
      "test/deleted.test.ts": "export {};\n"
    });
    const head = await commitChanges(repo, {
      write: { "src/math.ts": "export const x = 2;\n" },
      remove: ["test/deleted.test.ts"]
    });

    const index: ImpactIndex = {
      async importersOf() {
        return {
          status: "ok",
          indexCommit: base,
          files: ["test/kept.test.ts", "test/deleted.test.ts"]
        };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "affected",
      index
    });

    expect(result.scope).toBe("graph");
    expect(result.testPaths).toEqual(["test/kept.test.ts"]);
  });

  it("caps changedFiles at 200", async () => {
    const { repo, base } = await makeTempRepo({
      "test/a.test.ts": "export {};\n"
    });
    const write: Record<string, string> = {};
    for (let i = 0; i < 205; i += 1) {
      write[`docs/doc-${String(i).padStart(3, "0")}.md`] = `doc ${i}\n`;
    }
    const head = await commitChanges(repo, { write });

    const index: ImpactIndex = {
      async importersOf() {
        return { status: "ok", indexCommit: base, files: [] };
      }
    };

    const result = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head,
      profile: makeProfile(repo),
      scope: "affected",
      index
    });

    expect(result.changedFiles).toHaveLength(200);
    expect(result.changedFilesTruncated).toBe(true);
    expect(result.scope).toBe("none");
    expect(result.testPaths).toEqual([]);
  });
});
