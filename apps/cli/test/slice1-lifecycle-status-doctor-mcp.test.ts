import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { SessionManifestSchema, StoredRunSchema, type SessionManifest, type StoredRun } from "@bflow/contracts";
import { defaultHostEnvironment, detectPlatform, digest, isolatedPlatformProfile } from "@bflow/machine-setup";
import { resolvePrivateRuntimeStateDirectory } from "@bflow/runtime";
import { EnvironmentLifecycle } from "../src/environment.js";
import { formatEnvironmentStatus } from "../src/formatters.js";
import { runHighLevelCli } from "../src/high-level/index.js";
import { runCli } from "../src/index.js";
import { identifyRepository, type RepositoryIdentity } from "../src/repository.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";

class StubHerdrRunner implements ProcessRunner {
  public running = false;

  constructor(private readonly sessionName: string) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.executable === "git") {
      try {
        const stdout = execFileSync("git", [...request.args], {
          cwd: request.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error: any) {
        return { exitCode: error?.status ?? 1, stdout: "", stderr: String(error?.stderr ?? error) };
      }
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
    projectName: "slice1-repo",
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
      boundAt: "2026-02-01T00:00:00.000Z"
    })),
    attachTarget: { role: "conversation", paneId: "w1:p0" },
    activeRunIds: [],
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:01:00.000Z",
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
      id: "wf-slice1",
      version: "1.0.0",
      name: "Slice 1 Workflow",
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
      workflowId: "wf-slice1",
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
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:02:00.000Z"
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
const netServers: NetServer[] = [];
const httpServers: HttpServer[] = [];

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(async () => {
  for (const s of netServers.splice(0)) {
    await new Promise<void>((done) => s.close(() => done()));
  }
  for (const s of httpServers.splice(0)) {
    await new Promise<void>((done) => s.close(() => done()));
  }
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempRepo(): Promise<{ dir: string; bflowHome: string; repository: RepositoryIdentity }> {
  const root = await realpath(await mkdtemp(join(os.tmpdir(), "bflow-s1-cli-")));
  tempRoots.push(root);
  const dir = join(root, "repo");
  const bflowHome = join(root, "bflow-home");
  await mkdir(dir, { recursive: true });
  await mkdir(bflowHome, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--quiet", dir]);
  const initRes = await runCli(["init", "--no-gitnexus"], { cwd: dir });
  expect(initRes.ok).toBe(true);
  const repository = await identifyRepository(dir);
  return { dir, bflowHome, repository };
}

describe("Slice 1 — Authoritative RunStore vs session.json Projection Drift, Host Build Skew & Standalone mcp status", () => {
  it("status() and doctor() surface authoritative active/cancelling runs in SQLite runs.db when session.json activeRunIds is empty, without spawning a daemon", async () => {
    const { dir, bflowHome, repository } = await createTempRepo();
    const runner = new StubHerdrRunner(repository.sessionName);
    runner.running = true;

    const manifest = makeManifest(repository, { activeRunIds: [] });
    await mkdir(join(dir, ".bflow", "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, ".bflow", "state", "session.json"), JSON.stringify(manifest, null, 2));

    // Populate real SQLite runs.db in private runtime state while leaving <privateState>/host untouched
    const privateState = resolvePrivateRuntimeStateDirectory(dir);
    tempRoots.push(privateState);
    const agenticDir = join(privateState, "agentic");
    await mkdir(agenticDir, { recursive: true, mode: 0o700 });
    seedSqliteRunStore(join(agenticDir, "runs.db"), [
      makeStoredRun("run-live-1", "running"),
      makeStoredRun("run-stuck-2", "cancelling"),
      makeStoredRun("run-done-3", "succeeded")
    ]);

    const progressMessages: string[] = [];
    const lifecycle = new EnvironmentLifecycle(dir, {
      runner,
      env: { ...process.env, BFLOW_HOME: bflowHome },
      providerOverrides: {
        codex: { available: true, authenticated: true },
        claude: { available: true, authenticated: true },
        agy: { available: true, authenticated: true }
      },
      skillsOverride: { catalogDir: join(dir, ".bflow", "skills") },
      integration: {
        manager: {
          init: async () => ({ ok: true, value: manifest }),
          up: async () => ({ ok: true, value: manifest }),
          down: async () => ({ ok: true, value: { ...manifest, status: "down" } }),
          attach: async () => ({ ok: true, value: manifest.attachTarget }),
          getManifest: async () => ({ ok: true, value: manifest }),
          doctorSession: async () => ({
            schemaVersion: 2,
            workspaceRoot: dir,
            sessionId: repository.sessionName,
            healthy: true,
            checks: [],
            checkedAt: new Date().toISOString()
          })
        }
      },
      onProgress: (msg) => progressMessages.push(msg)
    });

    const status = await lifecycle.status();
    expect(status.server).toBe("running");
    expect(status.issues.some((i) => i.includes("run-live-1") && i.includes("run-stuck-2"))).toBe(true);
    expect(status.issues.some((i) => i.includes("--reconcile"))).toBe(true);

    // Human output must NOT show green [OK] when projection drift / active runs exist
    const formatted = formatEnvironmentStatus(status, false);
    expect(formatted).not.toContain("[OK]");
    expect(formatted).toContain("Vấn đề phát hiện:");
    expect(formatted).toContain("run-live-1");

    progressMessages.length = 0;
    const doctor = await lifecycle.doctor();
    // Preserve exact 6 Vietnamese progress observations contract
    expect(progressMessages).toEqual([
      "Đang đọc cấu hình kho mã nguồn để chẩn đoán...",
      "Đang kiểm tra sức khỏe Runtime và vòng đời phiên...",
      "Đang kiểm tra các agent provider và trạng thái xác thực...",
      "Đang kiểm tra các dịch vụ MCP dùng chung...",
      "Đang kiểm tra các công cụ đã cài đặt...",
      "Đang kiểm tra các kỹ năng (skills) được phê duyệt..."
    ]);

    const activeRunsCheck = doctor.checks.find((c) => c.checkId === "runtime-active-runs");
    expect(activeRunsCheck).toBeDefined();
    expect(activeRunsCheck?.status).toBe("warn");
    expect(activeRunsCheck?.message).toContain("run-live-1");
    expect(activeRunsCheck?.message).toContain("run-stuck-2");

    // Must NEVER spawn a background host daemon as a side effect of status/doctor
    expect(existsSync(join(privateState, "host"))).toBe(false);
  });

  it("status() warns on unfinished runs when session is stopped and on disconnected dynamic developer panes when running", async () => {
    const { dir, bflowHome, repository } = await createTempRepo();
    const runner = new StubHerdrRunner(repository.sessionName);
    runner.running = false;

    const privateState = resolvePrivateRuntimeStateDirectory(dir);
    tempRoots.push(privateState);
    const agenticDir = join(privateState, "agentic");
    await mkdir(agenticDir, { recursive: true, mode: 0o700 });
    seedSqliteRunStore(join(agenticDir, "runs.db"), [makeStoredRun("run-orphan-1", "running")]);

    const baseManifest = makeManifest(repository, { status: "down", activeRunIds: ["run-orphan-1"] });
    await mkdir(join(dir, ".bflow", "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, ".bflow", "state", "session.json"), JSON.stringify(baseManifest, null, 2));

    const stoppedLifecycle = new EnvironmentLifecycle(dir, {
      runner,
      env: { ...process.env, BFLOW_HOME: bflowHome }
    });
    const stoppedStatus = await stoppedLifecycle.status();
    expect(stoppedStatus.server).toBe("stopped");
    expect(stoppedStatus.issues.some((i) => i.includes("run-orphan-1"))).toBe(true);

    // Running session with a disconnected dynamic developer pane
    runner.running = true;
    const withDeadDeveloper = makeManifest(repository, {
      activeRunIds: ["run-orphan-1"],
      panes: [
        ...makeManifest(repository).panes,
        {
          schemaVersion: 2,
          bindingId: "binding-dev-9",
          sessionId: repository.sessionName,
          role: "developer",
          agentId: "agent-dev-9",
          workspaceId: "w1",
          tabId: "w1:t2",
          paneId: "pane-dev-9",
          provider: "openai",
          agentKind: "codex",
          cwd: repository.root,
          isolationMode: "dedicated_pane",
          readOnlyWorkspace: false,
          transportState: "disconnected",
          boundAt: "2026-02-01T00:00:00.000Z"
        }
      ]
    });
    const runningLifecycle = new EnvironmentLifecycle(dir, {
      runner,
      env: { ...process.env, BFLOW_HOME: bflowHome },
      integration: {
        manager: {
          init: async () => ({ ok: true, value: withDeadDeveloper }),
          up: async () => ({ ok: true, value: withDeadDeveloper }),
          down: async () => ({ ok: true, value: { ...withDeadDeveloper, status: "down" } }),
          attach: async () => ({ ok: true, value: withDeadDeveloper.attachTarget }),
          getManifest: async () => ({ ok: true, value: withDeadDeveloper }),
          doctorSession: async () => ({
            schemaVersion: 2,
            workspaceRoot: dir,
            sessionId: repository.sessionName,
            healthy: true,
            checks: [],
            checkedAt: new Date().toISOString()
          })
        }
      }
    });
    const runningStatus = await runningLifecycle.status();
    expect(runningStatus.issues.some((i) => i.includes("pane-dev-9") && i.includes("disconnected"))).toBe(true);
  });

  it("status() and doctor() detect Gate B loaded-host build skew when a live host daemon predates newer local build artifacts", async () => {
    const { dir, bflowHome, repository } = await createTempRepo();
    const runner = new StubHerdrRunner(repository.sessionName);
    runner.running = true;
    const manifest = makeManifest(repository);

    const privateState = resolvePrivateRuntimeStateDirectory(dir);
    tempRoots.push(privateState);
    const hostDir = join(privateState, "host", repository.sessionName);
    await mkdir(hostDir, { recursive: true, mode: 0o700 });

    const sockDir = await realpath(await mkdtemp(join("/tmp", "bflow-s1-sk-")));
    tempRoots.push(sockDir);
    const socketPath = join(sockDir, "host.sock");
    const netServer = createNetServer((socket) => {
      socket.on("data", () => {
        socket.end(JSON.stringify({ ok: true, value: "pong" }) + "\n");
      });
    });
    netServers.push(netServer);
    await new Promise<void>((accept, reject) => {
      netServer.once("error", reject);
      netServer.listen(socketPath, accept);
    });

    await writeFile(
      join(hostDir, "host.json"),
      JSON.stringify({
        repositoryPath: dir,
        sessionId: repository.sessionName,
        directory: hostDir,
        socketPath,
        token: "a".repeat(64)
      }),
      { mode: 0o600 }
    );
    // Host started way in the past (before current local CLI/Runtime files were modified)
    await writeFile(
      join(hostDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }),
      { mode: 0o600 }
    );

    const makeLifecycle = () =>
      new EnvironmentLifecycle(dir, {
        runner,
        env: { ...process.env, BFLOW_HOME: bflowHome },
        providerOverrides: {
          codex: { available: true, authenticated: true },
          claude: { available: true, authenticated: true },
          agy: { available: true, authenticated: true }
        },
        skillsOverride: { catalogDir: join(dir, ".bflow", "skills") },
        integration: {
          manager: {
            init: async () => ({ ok: true, value: manifest }),
            up: async () => ({ ok: true, value: manifest }),
            down: async () => ({ ok: true, value: { ...manifest, status: "down" } }),
            attach: async () => ({ ok: true, value: manifest.attachTarget }),
            getManifest: async () => ({ ok: true, value: manifest }),
            doctorSession: async () => ({
              schemaVersion: 2,
              workspaceRoot: dir,
              sessionId: repository.sessionName,
              healthy: true,
              checks: [],
              checkedAt: new Date().toISOString()
            })
          }
        }
      });

    const skewedStatus = await makeLifecycle().status();
    expect(skewedStatus.issues.some((i) => i.includes("predates") && i.includes("bflow down"))).toBe(true);

    const skewedDoctor = await makeLifecycle().doctor();
    const skewedCheck = skewedDoctor.checks.find((c) => c.checkId === "runtime-host-build");
    expect(skewedCheck).toBeDefined();
    expect(skewedCheck?.status).toBe("warn");
    expect(skewedCheck?.remediation).toContain("bflow down");

    // Freshly started host after build -> no skew warning
    await writeFile(
      join(hostDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() + 10_000).toISOString() }),
      { mode: 0o600 }
    );
    const freshStatus = await makeLifecycle().status();
    expect(freshStatus.issues).toEqual([]);
    const freshDoctor = await makeLifecycle().doctor();
    expect(freshDoctor.checks.find((c) => c.checkId === "runtime-host-build")?.status).toBe("passed");
  });

  it("standalone bflow mcp status discovers machine-setup Gateway state and live dynamic HTTP port by default", async () => {
    const { dir, bflowHome } = await createTempRepo();
    const basePlatform = detectPlatform(defaultHostEnvironment());
    const platform = isolatedPlatformProfile(basePlatform, bflowHome);
    await mkdir(platform.paths.config, { recursive: true, mode: 0o700 });
    await mkdir(platform.paths.state, { recursive: true, mode: 0o700 });

    const deepwikiService = {
      schemaVersion: 3 as const,
      serviceId: "deepwiki",
      revision: 1,
      scope: { kind: "machine" as const, machineId: platform.machineId },
      tool: {
        schemaVersion: 3 as const,
        toolId: "deepwiki",
        kind: "native_remote_mcp" as const,
        version: "1.0.0",
        operations: ["read_wiki_structure"],
        resource: { sharing: "concurrent" as const, maxConcurrency: 4 },
        required: false
      },
      connection: {
        kind: "native_remote_mcp" as const,
        endpoint: "https://mcp.deepwiki.com/mcp",
        ownership: "external" as const
      },
      authentication: { mode: "none" as const },
      healthTimeoutMs: 5000,
      idleTimeoutMs: 60000,
      restartLimit: 1
    };

    const servicesList = [deepwikiService];
    const definitionDigest = digest(servicesList);
    const receiptPath = join(platform.paths.state, "setup-gateway-ready.json");

    await writeFile(
      join(platform.paths.config, "mcp.json"),
      JSON.stringify({
        schemaVersion: 3,
        services: { deepwiki: deepwikiService },
        managedIds: ["deepwiki"]
      }),
      { mode: 0o600 }
    );

    await writeFile(
      join(platform.paths.config, "setup-gateway.json"),
      JSON.stringify({
        schemaVersion: 3,
        desiredDigest: createHash("sha256").update("desired").digest("hex"),
        definitionDigest,
        operation: {
          schemaVersion: 3,
          scope: { kind: "machine", machineId: platform.machineId },
          idempotencyKey: "setup-gateway"
        },
        services: servicesList,
        generatedIds: ["deepwiki"],
        receiptPath,
        paths: platform.paths
      }),
      { mode: 0o600 }
    );

    const server = createHttpServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } }));
    });
    httpServers.push(server);
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    const endpoint = `http://127.0.0.1:${addr.port}/mcp`;

    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 3,
        definitionDigest,
        pid: process.pid,
        endpoint,
        observedAt: new Date().toISOString(),
        observations: [
          {
            schemaVersion: 3,
            serviceId: "deepwiki",
            revision: 1,
            instanceId: "inst-deepwiki",
            status: "ready",
            protocolVersion: "2025-11-25",
            discoveredTools: ["read_wiki_structure"],
            ownership: "external",
            activeClientCount: 0,
            observedAt: new Date().toISOString(),
            diagnosticCode: "healthy"
          }
        ]
      }),
      { mode: 0o600 }
    );

    const prevBflowHome = process.env.BFLOW_HOME;
    process.env.BFLOW_HOME = bflowHome;
    try {
      const liveResult = await runHighLevelCli(["mcp", "status", "--json"], { cwd: dir });
      expect(liveResult.exitCode).toBe(0);
      const liveData = JSON.parse(liveResult.stdout).result.output.data;
      expect(liveData.gateway).toMatchObject({ configured: true, reachable: true });
      expect(liveData.backends).toEqual([
        expect.objectContaining({ serviceId: "deepwiki", state: "healthy", healthy: true })
      ]);

      // Stop the HTTP listener while receipt file is still <60s old -> must verify live HTTP reachability and report reachable: false!
      await new Promise<void>((done) => server.close(() => done()));
      httpServers.pop();

      const deadResult = await runHighLevelCli(["mcp", "status", "--json"], { cwd: dir });
      expect(deadResult.exitCode).toBe(3);
      const deadData = JSON.parse(deadResult.stdout).result.output.data;
      expect(deadData.gateway).toMatchObject({ configured: true, reachable: false });
    } finally {
      if (prevBflowHome === undefined) delete process.env.BFLOW_HOME;
      else process.env.BFLOW_HOME = prevBflowHome;
    }
  });
});
