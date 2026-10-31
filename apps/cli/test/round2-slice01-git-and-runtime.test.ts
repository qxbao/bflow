import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bflow/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bflow/runtime")>()),
  diagnoseVerificationSandbox: vi.fn(async () => ({
    checkId: "runtime-verification-sandbox",
    name: "Independent verification sandbox",
    status: "passed",
    message: "Sandbox probe passed"
  }))
}));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { SessionManifestSchema, StoredRunSchema, type SessionManifest, type StoredRun } from "@bflow/contracts";
import { resolvePrivateRuntimeStateDirectory } from "@bflow/runtime";
import { main } from "../src/bin.js";
import { resolveHostRepositoryRoot } from "../src/docs-gateway.js";
import { runDeepWikiProbe } from "../src/docs-probe.js";
import { EnvironmentLifecycle } from "../src/environment.js";
import { prepareExecutionExpectation } from "../src/execution-expectation.js";
import { loadExecutionPreview } from "../src/execution-preview.js";
import { HighLevelCliFacade } from "../src/high-level-facade.js";
import { runHighLevelCli } from "../src/high-level/index.js";
import { runCli } from "../src/index.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";
import { identifyRepository, type RepositoryIdentity } from "../src/repository.js";
import { repositoryHasCommits } from "../src/setup-gateway.js";

const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

class RealGitStubHerdrRunner implements ProcessRunner {
  public running = false;
  public readonly seenGitArgs: string[][] = [];

  constructor(
    private readonly sessionName: string,
    private readonly gitBinary = "git"
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.executable === "git") {
      this.seenGitArgs.push([...request.args]);
      try {
        const stdout = execFileSync(this.gitBinary, [...request.args], {
          cwd: request.cwd,
          env: request.env as NodeJS.ProcessEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error: any) {
        return { exitCode: error?.status ?? 1, stdout: "", stderr: String(error?.stderr ?? error) };
      }
    }
    if (request.executable === "agy" && request.args.join(" ") === "models") {
      return { exitCode: 0, stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n", stderr: "" };
    }
    if (request.args.join(" ") === "auth status --json") {
      return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
    }
    if (request.args[0] === "--version") {
      return { exitCode: 0, stdout: `${request.executable} 1.0.0\n`, stderr: "" };
    }
    if (request.args[0] === "--help") {
      return { exitCode: 0, stdout: "herdr --session <name> headless server\n", stderr: "" };
    }
    if (request.args[0] === "api" && request.args[1] === "schema") {
      return { exitCode: 0, stdout: JSON.stringify({ protocol: 22, schema_version: 1 }), stderr: "" };
    }
    if (request.args[0] === "status" && request.args[1] === "server") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session: this.sessionName,
          running: this.running,
          protocol: 22,
          compatible: true,
          endpoint_compatible: true
        }),
        stderr: ""
      };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  }
}

function makeManifest(repository: RepositoryIdentity, overrides: Partial<SessionManifest> = {}): SessionManifest {
  const roles = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"] as const;
  return SessionManifestSchema.parse({
    schemaVersion: 2,
    sessionId: repository.sessionName,
    projectName: "r2s1-repo",
    workspaceRoot: repository.root,
    herdrWorkspaceId: "w1",
    herdrTabId: "w1:t1",
    status: "up",
    conversationSessionId: "conversation-1",
    panes: roles.map((role, idx) => ({
      schemaVersion: 2,
      bindingId: `binding-${idx}`,
      sessionId: repository.sessionName,
      role,
      agentId: `agent-${idx}`,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: `w1:p${idx}`,
      provider: "openai",
      agentKind: "codex",
      cwd: repository.root,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: role === "conversation",
      transportState: "idle",
      boundAt: "2026-03-01T00:00:00.000Z"
    })),
    attachTarget: { role: "conversation", paneId: "w1:p0" },
    activeRunIds: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:01:00.000Z",
    metadata: {
      repositoryId: repository.id,
      sessionName: repository.sessionName,
      panePresentationVersion: 1
    },
    ...overrides
  });
}

function makeStoredRun(runId: string, status: "running" | "cancelling" | "waiting" | "blocked" | "queued" | "succeeded") {
  const taskStatus =
    status === "succeeded" ? "succeeded" : status === "waiting" ? "waiting" : status === "blocked" ? "blocked" : "running";
  return StoredRunSchema.parse({
    definition: {
      schemaVersion: "1",
      id: "wf-r2s1",
      version: "1.0.0",
      name: "Round 2 Slice 1 Workflow",
      tasks: [
        {
          id: "task-1",
          title: "Implement feature",
          role: "developer",
          instruction: "Implement feature cleanly",
          acceptanceCriteria: ["Tests pass"],
          input: {},
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: []
        }
      ],
      dependencies: [],
      qualityGates: [],
      maxConcurrency: 1,
      failurePolicy: "fail-fast",
      recovery: {
        checkpoint: "task-boundary",
        resumeStrategy: "checkpoint-then-replay",
        staleExecution: "reconcile"
      }
    },
    snapshot: {
      runId,
      workflowId: "wf-r2s1",
      workflowVersion: "1.0.0",
      status,
      input: {},
      tasks: [
        {
          taskId: "task-1",
          status: taskStatus,
          attempt: 1,
          generation: 0,
          version: 1
        }
      ],
      version: 2,
      lastEventSequence: 2,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:02:00.000Z"
    }
  });
}

function seedSqliteRunStore(filename: string, runs: readonly StoredRun[]): void {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        version INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        checkpoint_sequence INTEGER NOT NULL,
        checkpoint_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        snapshot_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency_records (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        payload TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (scope, idempotency_key)
      );
    `);
    const insert = db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const run of runs) {
      const payload = JSON.stringify(run);
      const sha = createHash("sha256").update(payload).digest("hex");
      insert.run(
        run.snapshot.runId,
        run.snapshot.workflowId,
        run.snapshot.status,
        Date.parse(run.snapshot.createdAt),
        run.snapshot.version,
        run.snapshot.lastEventSequence,
        run.snapshot.lastEventSequence,
        run.snapshot.version,
        payload,
        sha
      );
    }
  } finally {
    db.close();
  }
}

const tempRoots: string[] = [];

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(async () => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Round 2 Slice 1 — Git Dubious Ownership / NTFS FileMode & Authoritative Runtime Drift", () => {
  it("handles real Git dubious ownership and NTFS +x fileMode across repo + linked worktrees without wildcard safe.directory=*", async () => {
    const root = await realpath(await mkdtemp(join(os.tmpdir(), "bflow-r2s1-git-")));
    tempRoots.push(root);
    const repoDir = join(root, "repo with space");
    const worktreeDir = join(root, "wt-task-1");
    const emptyHome = join(root, "empty-home");
    const bflowHome = join(root, "bflow-home");
    const shimBin = join(root, "shim-bin");
    await mkdir(repoDir, { recursive: true });
    await mkdir(emptyHome, { recursive: true, mode: 0o700 });
    await mkdir(bflowHome, { recursive: true, mode: 0o700 });
    await mkdir(shimBin, { recursive: true });

    execFileSync(realGit, ["init", "--quiet", repoDir]);
    execFileSync(realGit, ["-C", repoDir, "config", "user.email", "test@bflow.local"]);
    execFileSync(realGit, ["-C", repoDir, "config", "user.name", "Bflow Test"]);
    await writeFile(join(repoDir, "README.md"), "# Test Repo\n");
    await writeFile(join(repoDir, ".gitignore"), ".bflow/state/\n.bflow/data/\n");
    execFileSync(realGit, ["-C", repoDir, "add", "README.md", ".gitignore"]);
    execFileSync(realGit, ["-C", repoDir, "commit", "--quiet", "-m", "initial"]);

    const initRes = await runCli(["init", "--no-gitnexus"], { cwd: repoDir });
    expect(initRes.ok).toBe(true);
    execFileSync(realGit, ["-C", repoDir, "add", "-A"]);
    execFileSync(realGit, ["-C", repoDir, "commit", "--quiet", "-m", "chore: bflow init"]);
    execFileSync(realGit, ["-C", repoDir, "worktree", "add", "--quiet", "-b", "task/w1", worktreeDir]);

    // Simulate NTFS/FUSE sticky +x bits on .git/HEAD, worktree .git file, and tracked non-executable files
    await chmod(join(repoDir, ".git", "HEAD"), 0o777);
    await chmod(join(repoDir, "README.md"), 0o777);
    await chmod(join(worktreeDir, ".git"), 0o777);
    await chmod(join(worktreeDir, "README.md"), 0o777);

    // Prepend real Git wrapper enforcing upstream Git dubious-ownership failures unless explicit safe.directory is supplied
    const gitShim = join(shimBin, "git");
    await writeFile(
      gitShim,
      `#!/bin/sh\nHOME='${emptyHome}' GIT_CONFIG_NOSYSTEM=1 GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec '${realGit}' "$@"\n`,
      { mode: 0o755 }
    );

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = `${shimBin}:${prevPath ?? ""}`;
    process.env.HOME = emptyHome;
    try {
      // 1. identifyRepository on main repo AND linked worktree
      const repoIdentity = await identifyRepository(repoDir);
      expect(repoIdentity.root).toBe(repoDir);
      const wtIdentity = await identifyRepository(worktreeDir);
      expect(wtIdentity.root).toBe(worktreeDir);

      // 2. resolveHostRepositoryRoot from inside linked worktree
      expect(await resolveHostRepositoryRoot(worktreeDir)).toBe(repoDir);

      // 3. repositoryHasCommits (setup-gateway / gateway-repositories)
      expect(repositoryHasCommits(repoDir)).toBe(true);

      // 4. docs-probe checkoutRevision on our real worktree under dubious ownership
      const skippedProbe = await runDeepWikiProbe({ live: false });
      expect(skippedProbe.revision).toMatch(/^[0-9a-f]{40}$/);

      // 5. High-level readOnlyGit (repo inspect) & HighLevelCliFacade.inspectRepository (clean despite +x mode bits!)
      const hlInspect = await runHighLevelCli(["repo", "inspect", "--json"], { cwd: repoDir });
      expect(hlInspect.exitCode).toBe(0);
      const hlData = JSON.parse(hlInspect.stdout).result.output.data;
      expect(hlData.git.dirty).toBe(false);

      const facade = new HighLevelCliFacade(repoDir);
      const facadeInspect = await facade.inspectRepository({
        command: "repo inspect",
        json: false,
        resume: false
      });
      expect((facadeInspect.details.git as any).head).toMatch(/^[0-9a-f]{40}$/);
      expect((facadeInspect.details.git as any).dirty).toBe(false);

      // 6. prepareExecutionExpectation invoked from linked worktree against preview saved in main repo
      const savedPlan = await loadExecutionPreview(repoDir);
      const previewPath = join(root, "saved-preview.json");
      await writeFile(previewPath, JSON.stringify(savedPlan));
      const expectation = await prepareExecutionExpectation(worktreeDir, previewPath);
      expect(typeof expectation).toBe("function");

      // 7. EnvironmentLifecycle.down() succeeds cleanly without false dirty prompt or dubious ownership crash, and NEVER uses safe.directory=*
      const runner = new RealGitStubHerdrRunner(repoIdentity.sessionName, gitShim);
      runner.running = true;
      const manifest = makeManifest(repoIdentity, { activeRunIds: [] });
      await mkdir(join(repoDir, ".bflow", "state"), { recursive: true, mode: 0o700 });
      await writeFile(join(repoDir, ".bflow", "state", "session.json"), JSON.stringify(manifest, null, 2));

      const privateState = resolvePrivateRuntimeStateDirectory(repoDir);
      tempRoots.push(privateState);

      const lifecycle = new EnvironmentLifecycle(repoDir, {
        runner,
        integration: {
          runtime: {
            findRuns: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
            getRun: async () => ({ ok: true, value: null })
          },
          quiesce: async () => ({ ok: true, value: undefined }),
          manager: {
            init: async () => ({ ok: true, value: manifest }),
            up: async () => ({ ok: true, value: manifest }),
            down: async () => {
              runner.running = false;
              return { ok: true, value: { ...manifest, status: "down" } };
            },
            attach: async () => ({ ok: true, value: manifest.attachTarget! }),
            getManifest: async () => ({ ok: true, value: manifest }),
            doctorSession: async () => ({
              ok: true,
              value: {
                schemaVersion: 2,
                workspaceRoot: repoDir,
                sessionId: repoIdentity.sessionName,
                healthy: true,
                checks: [],
                checkedAt: new Date().toISOString()
              }
            })
          },
          close: async () => undefined
        }
      });

      const downReport = await lifecycle.down();
      expect((downReport as any).status).toBe("down");
      for (const argv of runner.seenGitArgs) {
        expect(argv.join(" ")).not.toContain("safe.directory=*");
      }
    } finally {
      process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("bflow status <run-id> and bflow status --status running read authoritative Agentic runs.db without creating .bflow/data/", async () => {
    const root = await realpath(await mkdtemp(join(os.tmpdir(), "bflow-r2s1-runstatus-")));
    tempRoots.push(root);
    const dir = join(root, "repo");
    await mkdir(dir, { recursive: true });
    execFileSync(realGit, ["init", "--quiet", dir]);
    const initRes = await runCli(["init", "--no-gitnexus"], { cwd: dir });
    expect(initRes.ok).toBe(true);

    const privateState = resolvePrivateRuntimeStateDirectory(dir);
    tempRoots.push(privateState);
    const agenticDir = join(privateState, "agentic");
    await mkdir(agenticDir, { recursive: true, mode: 0o700 });
    seedSqliteRunStore(join(agenticDir, "runs.db"), [
      makeStoredRun("run-agentic-42", "running"),
      makeStoredRun("run-agentic-99", "cancelling"),
      makeStoredRun("run-agentic-done", "succeeded")
    ]);

    expect(existsSync(join(dir, ".bflow", "data"))).toBe(false);

    const silentIo = { stdout() {}, stderr() {} };
    const singleRes = await main(["status", "run-agentic-42", "--json"], { cwd: dir, io: silentIo });
    expect(singleRes.ok).toBe(true);
    expect(singleRes.exitCode).toBe(0);
    const singlePayload = JSON.parse(singleRes.stdout!);
    expect(singlePayload.data?.runId).toBe("run-agentic-42");
    expect(singlePayload.data?.status).toBe("running");

    const filteredRes = await main(["status", "--status", "running", "--json"], { cwd: dir, io: silentIo });
    expect(filteredRes.ok).toBe(true);
    expect(filteredRes.exitCode).toBe(0);
    const filteredPayload = JSON.parse(filteredRes.stdout!);
    expect(filteredPayload.data?.items?.map((r: any) => r.runId)).toEqual(["run-agentic-42"]);

    // Read-only status query must NEVER create legacy .bflow/data directory on disk
    expect(existsSync(join(dir, ".bflow", "data"))).toBe(false);
  });

  it("detects dirty & lingering Developer worktrees under .bflow/state/worktrees/* in status, doctor, and down confirmation", async () => {
    const root = await realpath(await mkdtemp(join(os.tmpdir(), "bflow-r2s1-wt-")));
    tempRoots.push(root);
    const dir = join(root, "repo");
    const bflowHome = join(root, "bflow-home");
    await mkdir(dir, { recursive: true });
    await mkdir(bflowHome, { recursive: true, mode: 0o700 });
    vi.stubEnv("BFLOW_HOME", bflowHome);

    execFileSync(realGit, ["init", "--quiet", dir]);
    execFileSync(realGit, ["-C", dir, "config", "user.email", "test@bflow.local"]);
    execFileSync(realGit, ["-C", dir, "config", "user.name", "Bflow Test"]);
    await writeFile(join(dir, "app.ts"), "export const v = 1;\n");
    await writeFile(join(dir, ".gitignore"), ".bflow/\n");
    execFileSync(realGit, ["-C", dir, "add", "app.ts", ".gitignore"]);
    execFileSync(realGit, ["-C", dir, "commit", "--quiet", "-m", "initial"]);

    const initRes = await runCli(["init", "--no-gitnexus"], { cwd: dir });
    expect(initRes.ok).toBe(true);
    const repository = await identifyRepository(dir);

    const managedWt = join(dir, ".bflow", "state", "worktrees", "w2-dev-feature");
    await mkdir(join(dir, ".bflow", "state", "worktrees"), { recursive: true, mode: 0o700 });
    execFileSync(realGit, ["-C", dir, "worktree", "add", "--quiet", "-b", "bflow/task-w2", managedWt]);
    // Dirty uncommitted work inside Developer worktree while main repo root is 100% clean and activeRunIds is []!
    await writeFile(join(managedWt, "app.ts"), "export const v = 2; // dirty developer work\n");

    const privateState = resolvePrivateRuntimeStateDirectory(dir);
    tempRoots.push(privateState);

    const runner = new RealGitStubHerdrRunner(repository.sessionName);
    runner.running = true;
    const manifest = makeManifest(repository, { activeRunIds: [] });
    await writeFile(join(dir, ".bflow", "state", "session.json"), JSON.stringify(manifest, null, 2));

    const makeLifecycle = () =>
      new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          codex: { available: true, authenticated: true },
          claude: { available: true, authenticated: true },
          agy: { available: true, authenticated: true }
        },
        integration: {
          runtime: {
            findRuns: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
            getRun: async () => ({ ok: true, value: null })
          },
          quiesce: async () => ({ ok: true, value: undefined }),
          manager: {
            init: async () => ({ ok: true, value: manifest }),
            up: async () => ({ ok: true, value: manifest }),
            down: async () => {
              runner.running = false;
              return { ok: true, value: { ...manifest, status: "down" } };
            },
            attach: async () => ({ ok: true, value: manifest.attachTarget! }),
            getManifest: async () => ({ ok: true, value: manifest }),
            doctorSession: async () => ({
              schemaVersion: 2,
              workspaceRoot: dir,
              sessionId: repository.sessionName,
              healthy: true,
              checks: [],
              checkedAt: new Date().toISOString()
            })
          },
          close: async () => undefined
        }
      });

    // status() and doctor() surface the lingering dirty developer worktree
    const status = await makeLifecycle().status();
    expect(status.issues.some((i) => i.includes("w2-dev-feature") && i.toLowerCase().includes("dirty"))).toBe(true);

    const doctor = await makeLifecycle().doctor();
    const wtCheck = doctor.checks.find((c) => c.checkId === "runtime-managed-worktrees");
    expect(wtCheck).toBeDefined();
    expect(wtCheck?.status).toBe("warn");
    expect(wtCheck?.message).toContain("w2-dev-feature");

    // Non-interactive down() without --yes refuses to proceed silently when a Developer worktree has uncommitted work
    await expect(makeLifecycle().down()).rejects.toThrow(/Unsafe shutdown.*w2-dev-feature.*bflow down --yes/i);

    // down(true) shuts down session while strictly preserving the dirty Developer worktree untouched
    const downRes = await makeLifecycle().down(true);
    expect((downRes as any).status).toBe("down");
    expect(await readFile(join(managedWt, "app.ts"), "utf8")).toContain("dirty developer work");
  });

  it("returns actionable conflict remediation instead of raw ENOENT/ECONNREFUSED when cancel --reconcile runs while host daemon is offline", async () => {
    const root = await realpath(await mkdtemp(join(os.tmpdir(), "bflow-r2s1-cancel-")));
    tempRoots.push(root);
    const dir = join(root, "repo");
    const bflowHome = join(root, "bflow-home");
    await mkdir(dir, { recursive: true });
    await mkdir(bflowHome, { recursive: true, mode: 0o700 });
    vi.stubEnv("BFLOW_HOME", bflowHome);
    execFileSync(realGit, ["init", "--quiet", dir]);
    const initRes = await runCli(["init", "--no-gitnexus"], { cwd: dir });
    expect(initRes.ok).toBe(true);
    const repository = await identifyRepository(dir);

    const privateState = resolvePrivateRuntimeStateDirectory(dir);
    tempRoots.push(privateState);
    const agenticDir = join(privateState, "agentic");
    await mkdir(agenticDir, { recursive: true, mode: 0o700 });
    seedSqliteRunStore(join(agenticDir, "runs.db"), [makeStoredRun("run-wedged-cancel", "cancelling")]);

    // 1. No host.json present -> actionable conflict guiding operator to `bflow up`, NOT raw ENOENT
    const missingHostRes = await main(["cancel", "run-wedged-cancel", "--reconcile", "--json"], {
      cwd: dir,
      io: { stdout() {}, stderr() {} }
    });
    expect(missingHostRes.exitCode).not.toBe(0);
    const missingErr = JSON.parse(missingHostRes.stderr!).error;
    expect(missingErr.code).toBe("conflict");
    expect(missingErr.message).toContain("bflow up");
    expect(missingErr.message).not.toContain("ENOENT");

    // 2. Stale host.json pointing to dead socket -> actionable conflict guiding operator to `bflow up`, NOT raw ECONNREFUSED/ENOENT
    const hostDir = join(privateState, "host", repository.sessionName);
    await mkdir(hostDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(hostDir, "host.json"),
      JSON.stringify({
        repositoryPath: dir,
        sessionId: repository.sessionName,
        directory: hostDir,
        socketPath: join(hostDir, "dead-host.sock"),
        token: "a".repeat(64)
      }),
      { mode: 0o600 }
    );
    const deadSocketRes = await main(["cancel", "run-wedged-cancel", "--reconcile", "--json"], {
      cwd: dir,
      io: { stdout() {}, stderr() {} }
    });
    expect(deadSocketRes.exitCode).not.toBe(0);
    const deadErr = JSON.parse(deadSocketRes.stderr!).error;
    expect(deadErr.code).toBe("conflict");
    expect(deadErr.message).toContain("bflow up");

    // 3. Stopped session status() recommends starting host via `bflow up` first when run is stuck cancelling
    const runner = new RealGitStubHerdrRunner(repository.sessionName);
    runner.running = false;
    const stoppedLifecycle = new EnvironmentLifecycle(dir, {
      runner,
      env: { ...process.env, BFLOW_HOME: bflowHome }
    });
    const stoppedStatus = await stoppedLifecycle.status();
    expect(stoppedStatus.server).toBe("stopped");
    expect(
      stoppedStatus.issues.some((i) => i.includes("run-wedged-cancel") && i.includes("Run 'bflow up'"))
    ).toBe(true);
  });
});
