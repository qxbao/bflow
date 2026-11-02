import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import os from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open)
  };
});

import { defaultHostEnvironment, detectPlatform, digest, isolatedPlatformProfile } from "@bflow/machine-setup";
import { createGitNexusService } from "@bflow/tool-installer";
import { loadRepositoryConfig, resolveReadableConfigPath } from "../src/config.js";
import { migrateRepositoryConfig } from "../src/config-migration.js";
import {
  applySkillApproval,
  applySkillImport,
  customSkillStatus,
  listSkillApprovals,
  planSkillApproval,
  planSkillImport,
  readCustomCatalog
} from "../src/custom-skills.js";
import { migrateLegacyContext7Config } from "../src/deepwiki-migration.js";
import { readEnvironmentConfig } from "../src/environment-config.js";
import { upsertRegisteredRepositoryService } from "../src/gateway-repositories.js";
import { CommandJournal } from "../src/high-level/journal.js";
import { runHighLevelCli } from "../src/high-level/index.js";
import { runCli } from "../src/index.js";
import { withLifecycleLock } from "../src/lifecycle-lock.js";
import { CommandOperationLedger, withCommandLock } from "../src/operation-ledger.js";
import { ProfileSetupComponent } from "../src/profile-setup.js";
import { identifyRepository } from "../src/repository.js";
import {
  IndependentGate,
  RUN_ID,
  TASK_ID,
  approvedSpecification,
  bflow,
  createRepository,
  openStore,
  resolver,
  services,
  storedChangeSet,
  verificationPlanInput,
  writeJson as writeFixtureJson
} from "./high-level/fixtures.js";

const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

const tempRoots: string[] = [];
const httpServers: HttpServer[] = [];
let syncErrorCode: string | null = null;
let failOwnerWrite = false;

beforeEach(async () => {
  tempRoots.length = 0;
  syncErrorCode = null;
  failOwnerWrite = false;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsPromises.open).mockImplementation((async (pathLike, flags, mode) => {
    const handle = await actual.open(pathLike, flags, mode);
    const targetStr = String(pathLike);
    if (syncErrorCode !== null || (failOwnerWrite && targetStr.endsWith("lifecycle-owner.json"))) {
      const code = syncErrorCode;
      const shouldFailWrite = failOwnerWrite && targetStr.endsWith("lifecycle-owner.json");
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "writeFile" && shouldFailWrite) {
            return async () => {
              throw Object.assign(new Error("ENOSPC: simulated disk full writing lifecycle-owner.json"), {
                code: "ENOSPC"
              });
            };
          }
          if (prop === "sync" && code !== null) {
            return async () => {
              throw Object.assign(new Error(`${code}: fsync not supported on FUSE/NTFS`), { code });
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
    return handle;
  }) as typeof fsPromises.open);
});

afterEach(async () => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of httpServers.splice(0)) {
    await new Promise<void>((done) => s.close(() => done()));
  }
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  for (const dir of tempRoots.splice(0)) {
    await actual.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempRoot(prefix = "bflow-r2s1-cli-"): Promise<string> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const dir = await actual.realpath(await actual.mkdtemp(join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

async function makeGitNexusService(
  machineId: string,
  repositoryId: string,
  workspaceRoot: string,
  executable: string
) {
  return createGitNexusService({
    executable,
    version: "1.6.12",
    repositoryRoot: workspaceRoot,
    stateRoot: join(workspaceRoot, ".bflow", "state", "gitnexus-test"),
    configRoot: join(workspaceRoot, ".bflow", "state", "gitnexus-cfg"),
    operation: {
      schemaVersion: 3,
      scope: {
        kind: "repository",
        machineId,
        repositoryId,
        workspaceRoot
      },
      idempotencyKey: `init-gn-${repositoryId.slice(0, 12)}`
    }
  });
}

describe("Round 2 Slice 1 — CLI FUSE/NTFS fsync, Stale Locks, EISDIR/Corruption, Gateway HTTP & Docs Worktree", () => {
  it("tolerates FUSE/NTFS FileHandle.sync() errors across CLI state writers and cleans up lifecycle-owner.json on write failure", async () => {
    const root = await makeTempRoot();
    const repo = join(root, "repo");
    const stateDir = join(root, "state");
    const skillStateDir = join(root, "skill-state");
    await mkdir(repo, { recursive: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(skillStateDir, { recursive: true, mode: 0o700 });
    execFileSync(realGit, ["init", "--quiet", repo]);
    expect((await runCli(["init", "--no-gitnexus"], { cwd: repo })).ok).toBe(true);

    const lifecycleStateDir = join(repo, ".bflow", "state");

    // 1. Write failure on lifecycle-owner.json must unlink lifecycle-owner.json and release flock cleanly
    failOwnerWrite = true;
    await expect(withLifecycleLock(lifecycleStateDir, async () => "never")).rejects.toThrow("ENOSPC");
    expect(existsSync(join(lifecycleStateDir, "lifecycle-owner.json"))).toBe(false);
    failOwnerWrite = false;

    const executable = join(root, "gitnexus-bin");
    const exeBody = "#!/bin/sh\nexit 0\n";
    await writeFile(executable, exeBody, { mode: 0o755 });
    const machineId = "machine-r2s1-test";
    vi.stubEnv("BFLOW_HOME", join(root, "bflow-home"));

    // 2. FUSE/NTFS sync() throwing EINVAL / ENOTSUP / EPERM must succeed across lifecycle-lock, journal, gateway-repositories, custom-skills, migrations
    for (const code of ["EINVAL", "ENOTSUP", "EPERM"]) {
      // Pre-seed migration repos before injecting sync errors on open()
      const migRepoDir = join(root, `mig-${code}`);
      await mkdir(migRepoDir, { recursive: true });
      execFileSync(realGit, ["init", "--quiet", migRepoDir]);
      expect((await runCli(["init", "--no-gitnexus"], { cwd: migRepoDir })).ok).toBe(true);
      await rename(join(migRepoDir, ".bflow", "config.yml"), join(migRepoDir, ".bflow", "config.yaml"));

      const dwRepoDir = join(root, `dw-${code}`);
      await mkdir(join(dwRepoDir, ".bflow"), { recursive: true });
      await writeFile(
        join(dwRepoDir, ".bflow", "config.yml"),
        'schemaVersion: "1"\nprojectName: dw-test\nenvironment:\n  context7:\n    enabled: true\n    required: false\n'
      );

      syncErrorCode = code;

      expect(await withLifecycleLock(lifecycleStateDir, async () => `ok-${code}`)).toBe(`ok-${code}`);

      const journal = await CommandJournal.open(join(root, `journal-${code}`));
      const lockedVal = await journal.withLock("tool.status", async () => `locked-${code}`);
      expect(lockedVal).toBe(`locked-${code}`);
      const begun = await journal.begin({
        key: `key-${code}`,
        command: "tool.status",
        request: { code },
        identity: { commandId: `cmd-${code}`, correlationId: `corr-${code}` },
        retrySafe: true,
        resume: false,
        now: () => "2026-03-01T00:00:00.000Z"
      });
      expect(begun.kind).toBe("execute");
      if (begun.kind === "execute") {
        await begun.attempt.complete({
          command: "tool.status",
          outcome: "ready",
          status: "succeeded",
          exitCode: 0,
          steps: [],
          data: { code }
        });
        await begun.attempt.release();
      }

      const repoId = createHash("sha256").update(`repo-${code}`).digest("hex");
      const upsertedState = await upsertRegisteredRepositoryService(stateDir, machineId, {
        schemaVersion: 3,
        repositoryId: repoId,
        workspaceRoot: repo,
        service: await makeGitNexusService(machineId, repoId, repo, executable),
        registeredAt: "2026-03-01T00:00:00.000Z"
      });
      expect(upsertedState.repositories.some((r) => r.repositoryId === repoId)).toBe(true);

      const migRes = await migrateRepositoryConfig(migRepoDir);
      expect(migRes.migrated).toBe(true);

      const dwRes = await migrateLegacyContext7Config(dwRepoDir);
      expect(dwRes.migrated).toBe(true);

      syncErrorCode = null;
    }

    // Custom skills import & approve under FUSE/NTFS EINVAL
    const skillSrc = join(root, "my-skill");
    await mkdir(skillSrc, { recursive: true });
    await writeFile(
      join(skillSrc, "SKILL.md"),
      "---\nname: My Clean Skill\ndescription: Safe local skill\n---\nFollow project conventions carefully.\n"
    );
    const repository = await identifyRepository(repo);
    const envCfg = await readEnvironmentConfig(repository);

    syncErrorCode = "EINVAL";
    const importPlan = await planSkillImport(repository, envCfg, {
      sources: [{ path: skillSrc }],
      skillId: "my-clean-skill",
      version: "1.0.0",
      roles: ["developer"],
      providers: ["claude", "codex", "agy"]
    });
    const written = await applySkillImport(importPlan);
    expect(written.length).toBe(1);
    const digestVal = importPlan.conversions[0]!.definition.digest;
    const approvalPlan = await planSkillApproval(repository, envCfg, {
      skillId: "my-clean-skill",
      version: "1.0.0",
      digest: digestVal,
      now: new Date("2026-03-01T00:00:00.000Z")
    });
    const approved = await applySkillApproval(repository, envCfg, approvalPlan, skillStateDir);
    expect(approved.approvalReceiptId).toContain("skill-my-clean-skill-");
    syncErrorCode = null;
  });

  it("recovers dead-PID and aged 0-byte crash locks across operation-ledger, custom-skills, gateway-repositories, and CommandJournal", async () => {
    const root = await makeTempRoot();
    const repo = join(root, "repo");
    const stateDir = join(root, "gw-state");
    const skillStateDir = join(root, "skill-state");
    await mkdir(repo, { recursive: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(skillStateDir, { recursive: true, mode: 0o700 });
    execFileSync(realGit, ["init", "--quiet", repo]);
    expect((await runCli(["init", "--no-gitnexus"], { cwd: repo })).ok).toBe(true);
    vi.stubEnv("BFLOW_HOME", join(root, "bflow-home"));
    const aged = new Date(Date.now() - 20_000);

    // 1. operation-ledger withCommandLock: dead-PID lock & aged 0-byte lock recover; live-PID lock still blocks
    const ledgerKey = "up:test";
    const keyHash = createHash("sha256").update(ledgerKey).digest("hex");
    const ledgerLockDir = join(repo, ".bflow", "state", "commands", "locks");
    const ledgerLockPath = join(ledgerLockDir, `${keyHash}.lock`);
    await mkdir(ledgerLockDir, { recursive: true, mode: 0o700 });

    await writeFile(ledgerLockPath, JSON.stringify({ pid: 2_147_483_646, acquiredAt: "2026-01-01T00:00:00.000Z" }));
    expect(await withCommandLock(repo, ledgerKey, async () => ({ ok: true, value: "from-dead-pid" }))).toEqual({
      ok: true,
      value: "from-dead-pid"
    });

    await writeFile(ledgerLockPath, "");
    await utimes(ledgerLockPath, aged, aged);
    expect(await withCommandLock(repo, ledgerKey, async () => ({ ok: true, value: "from-0byte" }))).toEqual({
      ok: true,
      value: "from-0byte"
    });

    await writeFile(ledgerLockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    const blockedLock = await withCommandLock(repo, ledgerKey, async () => ({ ok: true, value: "blocked" }));
    expect(blockedLock.ok).toBe(false);
    if (!blockedLock.ok) expect(blockedLock.error.code).toBe("conflict");
    await rm(ledgerLockPath, { force: true });

    // 2. custom-skills mutateApprovals: aged 0-byte skill-approvals.json.lock recovers
    const skillSrc = join(root, "lock-skill");
    await mkdir(skillSrc, { recursive: true });
    await writeFile(
      join(skillSrc, "SKILL.md"),
      "---\nname: Lock Skill\ndescription: Safe skill\n---\nClean instructions.\n"
    );
    const repository = await identifyRepository(repo);
    const envCfg = await readEnvironmentConfig(repository);
    const importPlan = await planSkillImport(repository, envCfg, {
      sources: [{ path: skillSrc }],
      skillId: "lock-skill",
      version: "1.0.0",
      roles: ["developer"],
      providers: ["claude", "codex", "agy"]
    });
    await applySkillImport(importPlan);
    const approvalPlan = await planSkillApproval(repository, envCfg, {
      skillId: "lock-skill",
      version: "1.0.0",
      digest: importPlan.conversions[0]!.definition.digest,
      now: new Date("2026-03-01T00:00:00.000Z")
    });
    const approvalsLock = join(skillStateDir, "skill-approvals.json.lock");
    await writeFile(approvalsLock, "");
    await utimes(approvalsLock, aged, aged);
    const approval = await applySkillApproval(repository, envCfg, approvalPlan, skillStateDir);
    expect(approval.approvalReceiptId).toContain("skill-lock-skill-");

    // 3. gateway-repositories withGatewayRepositoriesLock: aged 0-byte crash lock recovers immediately without timeout
    const gwLock = join(stateDir, "gateway-repositories.json.lock");
    await writeFile(gwLock, "");
    await utimes(gwLock, aged, aged);
    const exe = join(root, "gitnexus");
    const exeText = "#!/bin/sh\nexit 0\n";
    await writeFile(exe, exeText, { mode: 0o755 });
    const repoId = createHash("sha256").update("repo-1").digest("hex");
    const upserted = await upsertRegisteredRepositoryService(stateDir, "machine-1", {
      schemaVersion: 3,
      repositoryId: repoId,
      workspaceRoot: repo,
      service: await makeGitNexusService("machine-1", repoId, repo, exe),
      registeredAt: "2026-03-01T00:00:00.000Z"
    });
    expect(upserted.repositories[0]?.repositoryId).toBe(repoId);

    // 4. CommandJournal.acquire: aged 0-byte crash lock recovers instead of permanently throwing busy
    const journalDir = join(root, "journal-dir");
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const lockHash = createHash("sha256").update("lock:tool.status").digest("hex");
    const cmdLock = join(journalDir, `${lockHash}.lock`);
    await writeFile(cmdLock, "");
    await utimes(cmdLock, aged, aged);
    const journal = await CommandJournal.open(journalDir);
    const jOut = await journal.withLock("tool.status", async () => "recovered");
    expect(jOut).toBe("recovered");
  });

  it("handles EISDIR, ENOTDIR, and corrupt JSON cleanly across custom-skills, config, operation-ledger, context, mcp-status, and verify", async () => {
    const root = await makeTempRoot();
    const repo = join(root, "repo");
    const bflowHome = join(root, "bflow-home");
    const skillStateDir = join(root, "skill-state");
    const skillDataDir = join(root, "skill-data");
    await mkdir(repo, { recursive: true });
    await mkdir(bflowHome, { recursive: true, mode: 0o700 });
    await mkdir(skillStateDir, { recursive: true, mode: 0o700 });
    await mkdir(skillDataDir, { recursive: true, mode: 0o700 });
    execFileSync(realGit, ["init", "--quiet", repo]);
    await writeFile(join(repo, ".gitignore"), ".bflow/\n");
    expect((await runCli(["init", "--no-gitnexus"], { cwd: repo })).ok).toBe(true);
    const repository = await identifyRepository(repo);
    const envCfg = await readEnvironmentConfig(repository);

    // 1. custom-skills: readCustomCatalog on a regular file, stray .gitkeep file in importsRoot, directory at skill-approvals.json
    const regularFile = join(root, "not-a-dir");
    await writeFile(regularFile, "plain text");
    expect(await readCustomCatalog(regularFile)).toEqual([]);

    const importsRoot = join(repo, ".bflow", "skills", "imports");
    await mkdir(importsRoot, { recursive: true });
    await writeFile(join(importsRoot, ".gitkeep"), "");
    const statusOut = await customSkillStatus(
      repository,
      envCfg,
      { stateDirectory: skillStateDir, dataDirectory: skillDataDir },
      new Date("2026-03-01T00:00:00.000Z")
    );
    expect(statusOut.pendingImports).toEqual([]);

    const approvalsPath = join(skillStateDir, "skill-approvals.json");
    await mkdir(approvalsPath, { recursive: true });
    await expect(listSkillApprovals(skillStateDir)).rejects.toThrow(/regular file/i);
    await rm(approvalsPath, { recursive: true, force: true });

    // 2. config.ts: directory at .bflow/config.yml falls back to .bflow/config.yaml; explicit directory returns corruption (not not_found)
    const cfgRepo = join(root, "cfg-repo");
    await mkdir(join(cfgRepo, ".bflow", "config.yml"), { recursive: true });
    await writeFile(join(cfgRepo, ".bflow", "config.yaml"), 'schemaVersion: "1"\nprojectName: fallback-ok\n');
    expect(resolveReadableConfigPath(cfgRepo)).toBe(join(cfgRepo, ".bflow", "config.yaml"));

    const dirLoad = await loadRepositoryConfig(join(cfgRepo, ".bflow", "config.yml"));
    expect(dirLoad.ok).toBe(false);
    if (!dirLoad.ok) {
      expect(dirLoad.error.code).toBe("corruption");
    }

    // 3. operation-ledger getReceipt: directory or truncated JSON returns null instead of crashing replay lookup
    const ledgerKey = "idemp-corrupt";
    const keyHash = createHash("sha256").update(`tool status:${ledgerKey}`).digest("hex");
    const receiptsDir = join(repo, ".bflow", "state", "commands", "receipts");
    const receiptPath = join(receiptsDir, `${keyHash}.json`);
    const ledger = new CommandOperationLedger(repo);
    await mkdir(receiptPath, { recursive: true });
    expect(await ledger.getReceipt("tool status", ledgerKey)).toBeNull();
    await rm(receiptPath, { recursive: true, force: true });
    await writeFile(receiptPath, '{"broken":');
    expect(await ledger.getReceipt("tool status", ledgerKey)).toBeNull();

    // 4. high-level context readJsonFile: passing a directory to --spec exits with structured validation error, not raw EISDIR
    const specDir = join(root, "spec-is-a-dir");
    await mkdir(specDir, { recursive: true });
    const planRes = await runHighLevelCli(["task", "plan", "--spec", specDir, "--json"], { cwd: repo });
    expect(planRes.exitCode).toBe(1);
    expect(JSON.parse(planRes.stdout).result.error.code).toBe("validation");

    // 5. high-level mcp status when machine mcp.json is a directory -> reports invalid config instead of unhandled EISDIR
    const basePlatform = detectPlatform(defaultHostEnvironment());
    const platform = isolatedPlatformProfile(basePlatform, bflowHome);
    await mkdir(join(platform.paths.config, "mcp.json"), { recursive: true });
    const prevBflowHome = process.env.BFLOW_HOME;
    process.env.BFLOW_HOME = bflowHome;
    try {
      const mcpRes = await runHighLevelCli(["mcp", "status", "--json"], { cwd: repo });
      expect(mcpRes.exitCode).toBe(3);
      expect(JSON.parse(mcpRes.stdout).result.output.data.config.state).toBe("invalid");
    } finally {
      if (prevBflowHome === undefined) delete process.env.BFLOW_HOME;
      else process.env.BFLOW_HOME = prevBflowHome;
    }
    await rm(join(platform.paths.config, "mcp.json"), { recursive: true, force: true });

    // 6. high-level verify when .bflow/state/cli/verification/<id>.cycle.json is corrupt JSON or directory -> returns structured corruption error, not SyntaxError/EISDIR
    const verifyRepo = createRepository();
    tempRoots.push(verifyRepo);
    const store = await openStore(verifyRepo);
    const spec = await approvedSpecification(verifyRepo, store);
    const strategy = resolver.resolve(spec);
    const planInput = verificationPlanInput(spec, strategy);
    const verifyInputsDir = join(root, "verify-inputs");
    await mkdir(verifyInputsDir, { recursive: true });
    const planFile = writeFixtureJson(verifyInputsDir, "plan.json", planInput);
    const change = await storedChangeSet(store);
    store.close();
    const changeSetFile = writeFixtureJson(verifyInputsDir, "change.json", change);
    const runners = planInput.checks.map((check) => new IndependentGate(check.id));
    const svc = await services({ gates: runners });

    const cycleIdHash = createHash("sha256").update(`${RUN_ID}\0${TASK_ID}`).digest("hex").slice(0, 32);
    const verifyStateDir = join(verifyRepo, ".bflow", "state", "cli", "verification");
    await mkdir(verifyStateDir, { recursive: true, mode: 0o700 });
    const cycleFile = join(verifyStateDir, `${cycleIdHash}.cycle.json`);

    await writeFile(cycleFile, "{truncated");
    const corruptEnv = await bflow(
      verifyRepo,
      svc,
      "verify",
      TASK_ID,
      "--run",
      RUN_ID,
      "--plan",
      planFile,
      "--change-set",
      changeSetFile
    );
    expect(corruptEnv.result.error?.code).toBe("corruption");

    await rm(cycleFile, { force: true });
    await mkdir(cycleFile, { recursive: true });
    const dirCycleEnv = await bflow(
      verifyRepo,
      svc,
      "verify",
      TASK_ID,
      "--run",
      RUN_ID,
      "--plan",
      planFile,
      "--change-set",
      changeSetFile,
      "--idempotency-key",
      "verify-dir-cycle"
    );
    expect(dirCycleEnv.result.error?.code).toBe("corruption");
  });

  it("rejects HTTP 503 Gateway /health false positives, resolves host repo for bflow docs status inside task worktrees, resets rejected profile-setup cache, and has zero intra-package ESM value cycles", async () => {
    const root = await makeTempRoot();
    const repo = join(root, "repo");
    const wtDir = join(root, "task-worktree");
    const bflowHome = join(root, "bflow-home");
    await mkdir(repo, { recursive: true });
    await mkdir(bflowHome, { recursive: true, mode: 0o700 });

    execFileSync(realGit, ["init", "--quiet", repo]);
    execFileSync(realGit, ["-C", repo, "config", "user.email", "test@bflow.local"]);
    execFileSync(realGit, ["-C", repo, "config", "user.name", "Bflow Test"]);
    await writeFile(join(repo, ".gitignore"), ".bflow/state/\n");
    const initRes = await runCli(["init", "--no-gitnexus"], { cwd: repo });
    expect(initRes.ok).toBe(true);

    // Explicitly disable deepwiki in main repo .bflow/config.yml, commit, and create a linked Developer task worktree
    const cfgPath = join(repo, ".bflow", "config.yml");
    const cfgText = await readFile(cfgPath, "utf8");
    const updatedCfg = cfgText.includes("deepwiki:")
      ? cfgText.replace(/deepwiki:\s*\n\s*enabled:\s*true/, "deepwiki:\n    enabled: false")
      : `${cfgText.trimEnd()}\n  deepwiki:\n    enabled: false\n`;
    await writeFile(cfgPath, updatedCfg);
    execFileSync(realGit, ["-C", repo, "add", ".gitignore", ".bflow/config.yml"]);
    execFileSync(realGit, ["-C", repo, "commit", "--quiet", "-m", "disable deepwiki"]);
    execFileSync(realGit, ["-C", repo, "worktree", "add", "--quiet", "-b", "bflow/dev-docs-wt", wtDir]);

    // 1. Gateway HTTP 503 on /health MUST be treated as unreachable (not reachable: true!)
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
      JSON.stringify({ schemaVersion: 3, services: { deepwiki: deepwikiService }, managedIds: ["deepwiki"] }),
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

    const server503 = createHttpServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Service Unavailable");
    });
    httpServers.push(server503);
    await new Promise<void>((accept) => server503.listen(0, "127.0.0.1", accept));
    const addr = server503.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");

    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 3,
        definitionDigest,
        pid: process.pid,
        endpoint: `http://127.0.0.1:${addr.port}/mcp`,
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
      const badHealthRes = await runHighLevelCli(["mcp", "status", "--json"], { cwd: repo });
      expect(badHealthRes.exitCode).toBe(3);
      expect(JSON.parse(badHealthRes.stdout).result.output.data.gateway.reachable).toBe(false);

      // 2. bflow docs status inside linked Developer task worktree resolves host repository's .bflow/config.yml!
      const docsWtRes = await runCli(["docs", "status", "--json"], { cwd: wtDir });
      expect((docsWtRes.data as any)?.health?.enabled).toBe(false);
      expect((docsWtRes.data as any)?.health?.state).toBe("disabled");
    } finally {
      if (prevBflowHome === undefined) delete process.env.BFLOW_HOME;
      else process.env.BFLOW_HOME = prevBflowHome;
    }

    // 3. ProfileSetupComponent clears rejected python discovery promise so subsequent calls can succeed
    let failRunner = true;
    const comp = new ProfileSetupComponent({
      helperPath: join(bflowHome, "helper.py"),
      sourceHome: bflowHome,
      stateRoot: join(bflowHome, "isolator"),
      expectedIdentity: "v1"
    });
    const ctx: any = {
      platform,
      mode: "check",
      now: () => new Date(),
      runner: {
        async run(argv: string[]) {
          if (failRunner) throw new Error("transient runner abort");
          if (argv.includes("-c")) {
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              valid: true,
              profileCount: 0,
              stateDigest: "a".repeat(64),
              desiredDigest: "a".repeat(64),
              targets: [],
              ownedPaths: [],
              diagnostics: []
            }),
            stderr: "",
            timedOut: false
          };
        }
      }
    };
    const firstObs = await comp.observe(ctx);
    expect(firstObs.valid).toBe(false);
    expect(firstObs.diagnostics[0]).toContain("transient runner abort");

    failRunner = false;
    const recoveredObs = await comp.observe(ctx);
    expect(recoveredObs.valid).toBe(true);

    // 4. Zero intra-package circular ESM value-import cycles in apps/cli/src
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(path.resolve(full));
      }
    };
    walk(srcDir);

    const graph = new Map<string, string[]>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const deps: string[] = [];
      const stmtRe = /^\s*(?:import|export)\s+([^;]+?)\s+from\s+["'](\.[^"']+)["']/gm;
      let match: RegExpExecArray | null;
      while ((match = stmtRe.exec(text)) !== null) {
        const clause = match[1]!.trim();
        if (/^type\b/.test(clause)) continue;
        if (clause.startsWith("{") && clause.endsWith("}")) {
          const specs = clause
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (specs.length > 0 && specs.every((s) => /^type\b/.test(s))) continue;
        }
        const resolved = path.resolve(path.dirname(file), match[2]!.replace(/\.js$/, ".ts"));
        if (existsSync(resolved)) deps.push(resolved);
      }
      graph.set(file, deps);
    }

    const visited = new Set<string>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    let counter = 0;
    const cycles: string[][] = [];

    const dfs = (v: string) => {
      idx.set(v, counter);
      low.set(v, counter);
      counter += 1;
      visited.add(v);
      stack.push(v);
      onStack.add(v);
      for (const w of graph.get(v) ?? []) {
        if (!visited.has(w)) {
          dfs(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const compNodes: string[] = [];
        while (true) {
          const x = stack.pop()!;
          onStack.delete(x);
          compNodes.push(path.relative(srcDir, x));
          if (x === v) break;
        }
        if (compNodes.length > 1) cycles.push(compNodes);
      }
    };

    for (const file of graph.keys()) {
      if (!visited.has(file)) dfs(file);
    }
    expect(cycles).toEqual([]);
  });
});
