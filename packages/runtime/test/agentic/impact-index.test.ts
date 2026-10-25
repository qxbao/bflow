import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitNexusImpactIndex,
  parseCypherFilePaths,
  unconfiguredImpactIndex,
  type GitNexusImpactIndexOptions
} from "../../src/agentic/impact-index.js";

const BASE = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function freshStatusJson(repository: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repository,
    status: "up-to-date",
    contentDrift: { status: "current" },
    index: { commit: BASE, incompleteReasons: [] },
    ...overrides
  });
}

describe("ImpactIndex & GitNexus CLI adapter", () => {
  it("returns not_configured from unconfiguredImpactIndex", async () => {
    const result = await unconfiguredImpactIndex.importersOf({
      repositoryRoot: "/workspace/repo",
      base: BASE,
      files: ["src/math.ts"]
    });
    expect(result).toEqual({
      status: "unavailable",
      code: "not_configured",
      detail: expect.any(String)
    });
  });

  it("returns importers when index is fresh at base", async () => {
    const root = await makeTempDir("bflow-impact-ok-");
    const home = join(root, "gn-home");
    const lockPath = join(root, "storage.lock");
    const calls: Array<{ executable: string; args: string[]; options: { cwd: string; env: Record<string, string>; timeoutMs: number } }> = [];

    const run: NonNullable<GitNexusImpactIndexOptions["run"]> = async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (args[0] === "status") {
        return { exitCode: 0, stdout: freshStatusJson(root), stderr: "" };
      }
      if (args[0] === "cypher") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            markdown: "| t.filePath |\n| --- |\n| test/math.test.ts |\n| src/report.ts |",
            row_count: 2
          }),
          stderr: ""
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const index = createGitNexusImpactIndex({
      executable: "/usr/local/bin/gitnexus",
      home,
      storageLockPath: lockPath,
      run
    });

    const result = await index.importersOf({
      repositoryRoot: root,
      base: BASE,
      files: ["src/math.ts"]
    });

    expect(result).toEqual({
      status: "ok",
      indexCommit: BASE,
      files: ["test/math.test.ts", "src/report.ts"]
    });

    expect(calls.some(call => call.args.includes("analyze"))).toBe(false);
    const cypherCall = calls.find(call => call.args[0] === "cypher");
    expect(cypherCall).toBeDefined();
    expect(cypherCall!.args).toEqual([
      "cypher",
      "-r",
      root,
      "-l",
      "5000",
      "MATCH (t:File)-[:CodeRelation* 1..10 (r, n | WHERE r.type = 'IMPORTS')]->(f:File) WHERE f.filePath IN ['src/math.ts'] RETURN DISTINCT t.filePath"
    ]);
    for (const call of calls) {
      expect(call.options.env).toEqual({
        GITNEXUS_HOME: home,
        GITNEXUS_SHARED_STORE: "off"
      });
      expect(Object.keys(call.options.env).sort()).toEqual(["GITNEXUS_HOME", "GITNEXUS_SHARED_STORE"]);
    }
  });

  it("returns status_failed when status command exits non-zero", async () => {
    const root = await makeTempDir("bflow-impact-status-fail-");
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async () => ({ exitCode: 1, stdout: "", stderr: "failed" })
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "status_failed",
      detail: expect.any(String)
    });
  });

  it("returns repository_mismatch when status repository differs", async () => {
    const root = await makeTempDir("bflow-impact-repo-mismatch-");
    const otherRoot = await makeTempDir("bflow-impact-other-repo-");
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async () => ({ exitCode: 0, stdout: freshStatusJson(otherRoot), stderr: "" })
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "repository_mismatch",
      detail: expect.any(String)
    });
  });

  it("returns not_up_to_date when status is stale", async () => {
    const root = await makeTempDir("bflow-impact-stale-");
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async () => ({ exitCode: 0, stdout: freshStatusJson(root, { status: "stale" }), stderr: "" })
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "not_up_to_date",
      detail: expect.any(String)
    });
  });

  it("returns content_drift when contentDrift status is drifted", async () => {
    const root = await makeTempDir("bflow-impact-drift-");
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async () => ({
        exitCode: 0,
        stdout: freshStatusJson(root, { contentDrift: { status: "drifted" } }),
        stderr: ""
      })
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "content_drift",
      detail: expect.any(String)
    });
  });

  it("returns commit_mismatch when index commit differs from base", async () => {
    const root = await makeTempDir("bflow-impact-commit-");
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async () => ({
        exitCode: 0,
        stdout: freshStatusJson(root, { index: { commit: OTHER_COMMIT, incompleteReasons: [] } }),
        stderr: ""
      })
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "commit_mismatch",
      detail: expect.any(String)
    });
  });

  it("returns incomplete when incompleteReasons is non-empty", async () => {
    const root = await makeTempDir("bflow-impact-incomplete-");
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async () => ({
        exitCode: 0,
        stdout: freshStatusJson(root, { index: { commit: BASE, incompleteReasons: ["x"] } }),
        stderr: ""
      })
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "incomplete",
      detail: expect.any(String)
    });
  });

  it("returns storage_locked when storage lock file exists", async () => {
    const root = await makeTempDir("bflow-impact-locked-");
    const lockPath = join(root, "storage.lock");
    await writeFile(lockPath, "locked");
    let called = false;
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: lockPath,
      run: async () => {
        called = true;
        return { exitCode: 0, stdout: freshStatusJson(root), stderr: "" };
      }
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "storage_locked",
      detail: expect.any(String)
    });
    expect(called).toBe(false);
  });

  it("returns query_failed when cypher exits non-zero or row_count mismatches parsed rows", async () => {
    const root = await makeTempDir("bflow-impact-query-fail-");
    const indexExitFail = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async (_exe, args) => {
        if (args[0] === "status") return { exitCode: 0, stdout: freshStatusJson(root), stderr: "" };
        return { exitCode: 2, stdout: "", stderr: "cypher failed" };
      }
    });

    const res1 = await indexExitFail.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(res1).toEqual({
      status: "unavailable",
      code: "query_failed",
      detail: expect.any(String)
    });

    const indexMismatch = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async (_exe, args) => {
        if (args[0] === "status") return { exitCode: 0, stdout: freshStatusJson(root), stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            markdown: "| t.filePath |\n| --- |\n| test/math.test.ts |",
            row_count: 2
          }),
          stderr: ""
        };
      }
    });

    const res2 = await indexMismatch.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(res2).toEqual({
      status: "unavailable",
      code: "query_failed",
      detail: expect.any(String)
    });
  });

  it("returns changed_during_query when second status probe reports a different commit", async () => {
    const root = await makeTempDir("bflow-impact-changed-");
    let statusCalls = 0;
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async (_exe, args) => {
        if (args[0] === "status") {
          statusCalls += 1;
          const commit = statusCalls === 1 ? BASE : OTHER_COMMIT;
          return {
            exitCode: 0,
            stdout: freshStatusJson(root, { index: { commit, incompleteReasons: [] } }),
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            markdown: "| t.filePath |\n| --- |\n| test/math.test.ts |",
            row_count: 1
          }),
          stderr: ""
        };
      }
    });

    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files: ["src/math.ts"] });
    expect(result).toEqual({
      status: "unavailable",
      code: "changed_during_query",
      detail: expect.any(String)
    });
    expect(statusCalls).toBe(2);
  });

  it("rejects unsafe file paths before querying", async () => {
    const root = await makeTempDir("bflow-impact-unsafe-");
    const cypherCalls: string[][] = [];
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async (_exe, args) => {
        if (args[0] === "cypher") cypherCalls.push(args);
        return { exitCode: 0, stdout: freshStatusJson(root), stderr: "" };
      }
    });

    for (const unsafePath of ["src/o'hare.ts", "src\\math.ts", "src/math\n.ts", "../secret.ts", "src/../math.ts"]) {
      const result = await index.importersOf({
        repositoryRoot: root,
        base: BASE,
        files: [unsafePath]
      });
      expect(result).toEqual({
        status: "unavailable",
        code: "query_failed",
        detail: expect.any(String)
      });
    }
    expect(cypherCalls).toEqual([]);
  });

  it("queries cypher in batches of 100 files and deduplicates results", async () => {
    const root = await makeTempDir("bflow-impact-batch-");
    const cypherQueries: string[] = [];
    const index = createGitNexusImpactIndex({
      executable: "gitnexus",
      home: join(root, "home"),
      storageLockPath: join(root, "storage.lock"),
      run: async (_exe, args) => {
        if (args[0] === "status") {
          return { exitCode: 0, stdout: freshStatusJson(root), stderr: "" };
        }
        cypherQueries.push(args[5]!);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            markdown: `| t.filePath |\n| --- |\n| test/shared.test.ts |\n| test/batch-${cypherQueries.length}.test.ts |`,
            row_count: 2
          }),
          stderr: ""
        };
      }
    });

    const files = Array.from({ length: 150 }, (_, i) => `src/file-${i}.ts`);
    const result = await index.importersOf({ repositoryRoot: root, base: BASE, files });
    expect(cypherQueries).toHaveLength(2);
    expect(result).toEqual({
      status: "ok",
      indexCommit: BASE,
      files: ["test/shared.test.ts", "test/batch-1.test.ts", "test/batch-2.test.ts"]
    });
  });

  it("parseCypherFilePaths handles empty table (row_count: 0) and ignores banner text before JSON", () => {
    expect(parseCypherFilePaths(JSON.stringify({ markdown: "", row_count: 0 }))).toEqual([]);
    expect(parseCypherFilePaths(JSON.stringify({ markdown: "| t.filePath |\n| --- |", row_count: 0 }))).toEqual([]);

    const withBanner = [
      "  GitNexus Cypher (1.6.12)",
      "Note: {banner brace that is not the final JSON}",
      `Banner prefix ${JSON.stringify({
        markdown: "| t.filePath |\n| --- |\n| test/math.test.ts |\n| src/report.ts |",
        row_count: 2
      })}`
    ].join("\n");
    expect(parseCypherFilePaths(withBanner)).toEqual(["test/math.test.ts", "src/report.ts"]);

    expect(() =>
      parseCypherFilePaths(
        JSON.stringify({
          markdown: "| t.filePath |\n| --- |",
          row_count: 5000
        })
      )
    ).toThrow();
  });

  const gitNexusBin =
    process.env.BFLOW_GITNEXUS_BIN ??
    join(homedir(), ".local/share/bflow/tools/gitnexus/node_modules/.bin/gitnexus");
  const hasGitNexusBin = existsSync(gitNexusBin);

  it.skipIf(!hasGitNexusBin)(
    "queries real GitNexus CLI for transitive importers and selects tests that only import a constant",
    async () => {
      const workspace = await makeTempDir("bflow-impact-live-");
      const repo = join(workspace, "repo");
      const worktree = join(workspace, "wt");
      const home = join(workspace, "gitnexus-home");
      const lockPath = join(workspace, "gitnexus-storage.lock");
      await mkdir(join(repo, "src"), { recursive: true });
      await mkdir(join(repo, "test"), { recursive: true });
      await mkdir(home, { recursive: true });

      await writeFile(join(repo, "src/math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
      await writeFile(
        join(repo, "src/report.ts"),
        'import { add } from "./math";\nexport function formatSum(a: number, b: number) {\n  return `sum=${add(a, b)}`;\n}\n'
      );
      await writeFile(join(repo, "src/config.ts"), "export const LIMIT = 10;\n");
      await writeFile(join(repo, "src/other.ts"), "export function unrelated() {\n  return true;\n}\n");

      await writeFile(
        join(repo, "test/math.test.ts"),
        'import { add } from "../src/math";\nif (add(1, 2) !== 3) throw new Error("math");\n'
      );
      await writeFile(
        join(repo, "test/report.test.ts"),
        'import { formatSum } from "../src/report";\nif (formatSum(1, 2) !== "sum=3") throw new Error("report");\n'
      );
      await writeFile(
        join(repo, "test/config.test.ts"),
        'import { LIMIT } from "../src/config";\nif (LIMIT !== 10) throw new Error("config");\n'
      );
      await writeFile(
        join(repo, "test/other.test.ts"),
        'import { unrelated } from "../src/other";\nif (!unrelated()) throw new Error("other");\n'
      );

      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@bflow.invalid", "commit", "-qm", "base"], {
        cwd: repo
      });
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

      await promisify(execFile)(gitNexusBin, ["analyze", "--index-only", "--skip-skills"], {
        cwd: repo,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          GITNEXUS_HOME: home,
          GITNEXUS_SHARED_STORE: "off"
        }
      });

      // Commit change to add in a task worktree so repositoryRoot stays indexed at base
      execFileSync("git", ["worktree", "add", "-q", "-b", "task-change", worktree, base], { cwd: repo });
      await writeFile(
        join(worktree, "src/math.ts"),
        "export function add(a: number, b: number) {\n  return a + b + 0;\n}\n"
      );
      execFileSync("git", ["add", "."], { cwd: worktree });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@bflow.invalid", "commit", "-qm", "change add"],
        { cwd: worktree }
      );

      const index = createGitNexusImpactIndex({
        executable: gitNexusBin,
        home,
        storageLockPath: lockPath
      });

      const mathImporters = await index.importersOf({
        repositoryRoot: repo,
        base,
        files: ["src/math.ts"]
      });
      expect(mathImporters.status).toBe("ok");
      if (mathImporters.status === "ok") {
        expect(mathImporters.indexCommit).toBe(base);
        expect(mathImporters.files).toContain("test/math.test.ts");
        expect(mathImporters.files).toContain("test/report.test.ts");
        expect(mathImporters.files).not.toContain("test/other.test.ts");
      }

      const configImporters = await index.importersOf({
        repositoryRoot: repo,
        base,
        files: ["src/config.ts"]
      });
      expect(configImporters.status).toBe("ok");
      if (configImporters.status === "ok") {
        expect(configImporters.files).toContain("test/config.test.ts");
        expect(configImporters.files).not.toContain("test/other.test.ts");
      }
    },
    120_000
  );
});
