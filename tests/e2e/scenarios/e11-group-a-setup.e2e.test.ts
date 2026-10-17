import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "@bflow/cli";
import {
  NodeCommandRunner,
  SetupStateStore,
  defaultHostEnvironment,
  detectPlatform,
  probeTools,
  selectServiceManager,
  validateServiceDefinition
} from "@bflow/machine-setup";
import { BflowOSServiceManager } from "@bflow/mcp-services";
import { afterEach, describe, expect, it } from "vitest";

describe("Scenario E11 (Group A) — Machine Setup, Doctor, Binary Discovery & OS Service Registration", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "bflow-e11-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe("[REAL HOST] Platform, PATH & Binary Discovery", () => {
    it("detects supported Linux x64 platform and resolves real host binaries on PATH without trusting CWD", async () => {
      const runner = new NodeCommandRunner();
      const hostEnv = defaultHostEnvironment();
      const platform = detectPlatform(hostEnv);
      expect(platform.os).toBe("linux");
      expect(platform.supportStatus).toBe("supported");

      const workspaceDir = makeTempDir("bflow-e11-cwd-");
      // Plant a malicious/decoy 'git' in CWD and "." in PATH to verify CWD/relative PATH entries are ignored
      const decoyGit = join(workspaceDir, "git");
      writeFileSync(decoyGit, "#!/usr/bin/env bash\necho 'git version 9.9.9'\n", { mode: 0o755 });

      const cwdPlatform = detectPlatform({
        ...hostEnv,
        env: { ...hostEnv.env, PATH: `.:${hostEnv.env.PATH ?? ""}` }
      });

      const observations = await probeTools(cwdPlatform, runner, {
        required: new Set(["git", "node", "herdr"])
      });

      const gitObs = observations.find((o) => o.toolId === "git")!;
      expect(gitObs.status).toBe("present");
      expect(gitObs.resolvedPath).not.toBe(decoyGit);
      expect(gitObs.version).toMatch(/\d+\.\d+\.\d+/);

      const nodeObs = observations.find((o) => o.toolId === "node")!;
      expect(nodeObs.status).toBe("present");
      expect(nodeObs.version).toMatch(/\d+\.\d+\.\d+/);

      const herdrObs = observations.find((o) => o.toolId === "herdr")!;
      expect(herdrObs.status).toBe("present");
      expect(herdrObs.version).toBeTruthy();
    });

    it("discovers tools in knownInstallDirs (managedBin) when not yet on PATH and flags path_missing", async () => {
      const runner = new NodeCommandRunner();
      const root = makeTempDir("bflow-e11-managed-");
      const managedBin = join(root, "managed-bin");
      mkdirSync(managedBin, { recursive: true, mode: 0o700 });
      const managedHerdr = join(managedBin, "herdr");
      writeFileSync(managedHerdr, "#!/usr/bin/env bash\necho '0.9.5'\n", { mode: 0o755 });

      const hostEnv = defaultHostEnvironment();
      const customPlatform = {
        ...detectPlatform({ ...hostEnv, env: { ...hostEnv.env, PATH: "/nonexistent-bin" } }),
        paths: {
          config: join(root, "config"),
          data: join(root, "data"),
          state: join(root, "state"),
          managedBin
        },
        pathEntries: ["/nonexistent-bin"]
      };

      const observations = await probeTools(customPlatform, runner, {
        required: new Set(["herdr"]),
        knownInstallDirs: () => [managedBin]
      });
      const herdrObs = observations.find((o) => o.toolId === "herdr")!;
      expect(herdrObs.status).toBe("path_missing");
      expect(herdrObs.resolvedPath).toBe(managedHerdr);
      expect(herdrObs.pathMissingDir).toBe(managedBin);
      expect(herdrObs.version).toBe("0.9.5");
    });
  });

  describe("[REAL HOST] Isolated bflow setup (1st run, 2nd run idempotency, --check, --repair) & QA-P34-01 / QA-P34-02 Fix Verification", () => {
    it("verifies QA-P34-01 (automatic 0700 skills-store creation) and QA-P34-02 (1st apply installs all 32 skills) plus idempotency, --check, and --repair", async () => {
      const root = makeTempDir("bflow-e11-setup-");
      const repoDir = join(root, "repo");
      const isolatedState = join(root, "isolated");
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-q", repoDir]);

      const skillsStoreDir = join(isolatedState, "data", "skills-store");
      const ctx = { cwd: repoDir, setup: { isolatedRoot: isolatedState } };

      // 1st run on clean isolated state: creates 0700 skills-store (QA-P34-01 fixed) and installs all 32 skills on 1st apply (QA-P34-02 fixed)
      const firstRun = await runCli(["setup", "--yes", "--json"], ctx);
      expect(firstRun.ok).toBe(true);
      expect(firstRun.exitCode).toBe(0);
      expect(statSync(skillsStoreDir).mode & 0o777).toBe(0o700);
      const firstData = firstRun.data as unknown as {
        mode: string;
        receipt?: { status: string };
        skills: { catalogLoaded: boolean; skillCount: number; syncedManifests: number };
        diagnostics: string[];
      };
      expect(firstData.mode).toBe("apply");
      expect(firstData.skills.catalogLoaded).toBe(true);
      expect(firstData.skills.skillCount).toBe(32);
      expect(firstData.diagnostics.some((d) => d.includes("role-skills requires --repair"))).toBe(false);
      expect(readdirSync(join(skillsStoreDir, "bundles")).length).toBe(32);

      // 2nd run (idempotency): bflow setup --yes --json after skills are synchronized
      const secondRun = await runCli(["setup", "--yes", "--json"], ctx);
      expect(secondRun.ok).toBe(true);
      expect(secondRun.exitCode).toBe(0);
      const secondData = secondRun.data as unknown as {
        mode: string;
        receipt?: { status: string };
        skills: { catalogLoaded: boolean; skillCount: number };
        diagnostics: string[];
      };
      expect(secondData.mode).toBe("apply");
      expect(secondData.skills.catalogLoaded).toBe(true);
      expect(secondData.skills.skillCount).toBe(32);
      expect(secondData.diagnostics.some((d) => d.includes("role-skills requires --repair"))).toBe(false);
      expect(readdirSync(join(skillsStoreDir, "bundles")).length).toBe(32);

      // Check run: bflow setup --check --json
      const checkRun = await runCli(["setup", "--check", "--json"], ctx);
      expect(checkRun.ok).toBe(true);
      expect(checkRun.exitCode).toBe(0);
      const checkData = checkRun.data as unknown as {
        mode: string;
        skills: { catalogLoaded: boolean; skillCount: number };
        diagnostics: string[];
      };
      expect(checkData.mode).toBe("check");
      expect(checkData.skills.catalogLoaded).toBe(true);
      expect(checkData.skills.skillCount).toBe(32);
      expect(readdirSync(join(skillsStoreDir, "bundles")).length).toBe(32);

      // Remove one skill bundle and verify setup --check is read-only (31 bundles) and setup --repair restores all 32 bundles
      const bundlesDir = join(skillsStoreDir, "bundles");
      const firstBundle = readdirSync(bundlesDir)[0]!;
      rmSync(join(bundlesDir, firstBundle), { recursive: true, force: true });
      expect(readdirSync(bundlesDir).length).toBe(31);

      const checkDrifted = await runCli(["setup", "--check", "--json"], ctx);
      expect(checkDrifted.ok).toBe(true);
      expect(readdirSync(bundlesDir).length).toBe(31);

      const repairDrifted = await runCli(["setup", "--repair", "--yes", "--json"], ctx);
      expect(repairDrifted.ok).toBe(true);
      expect(repairDrifted.exitCode).toBe(0);
      expect(readdirSync(bundlesDir).length).toBe(32);
    }, 180_000);
  });

  describe("[REAL HOST] bflow doctor & OS Service Registration (systemd --user)", () => {
    it("executes bflow doctor on an initialized repository and validates structured checks", async () => {
      const repoDir = makeTempDir("bflow-e11-doctor-");
      execFileSync("git", ["init", "-q", repoDir]);
      const initRes = await runCli(["init", "--json"], { cwd: repoDir });
      expect(initRes.ok).toBe(true);

      const doctorRes = await runCli(["doctor", "--json"], { cwd: repoDir });
      const report = doctorRes.data as {
        schemaVersion: number;
        workspaceRoot: string;
        checks: Array<{ checkId: string; status: string }>;
        metadata?: {
          groups?: {
            runtime?: Array<{ checkId: string; status: string }>;
          };
        };
      };
      expect(report.schemaVersion).toBe(2);
      expect(report.workspaceRoot).toBe(repoDir);
      expect(report.checks.some((c) => c.checkId === "node" && c.status === "passed")).toBe(true);
      expect(report.checks.some((c) => c.checkId === "pnpm" && c.status === "passed")).toBe(true);
      expect(report.metadata?.groups?.runtime?.some((c) => c.checkId === "git" && c.status === "pass")).toBe(true);
      expect(report.metadata?.groups?.runtime?.some((c) => c.checkId === "herdr" && c.status === "pass")).toBe(true);
    });

    it("resolves systemd-user unit plans and registers/starts/stops a real systemd --user service unit", async () => {
      const runner = new NodeCommandRunner();
      const platform = detectPlatform(defaultHostEnvironment());
      const root = makeTempDir("bflow-e11-svc-");
      const isolatedPlatform = {
        ...platform,
        paths: {
          config: join(root, "config", "bflow"),
          data: join(root, "data", "bflow"),
          state: join(root, "state", "bflow"),
          managedBin: join(root, "data", "bflow", "bin")
        }
      };
      mkdirSync(isolatedPlatform.paths.state, { recursive: true, mode: 0o700 });
      const store = new SetupStateStore(isolatedPlatform.paths, { uid: isolatedPlatform.uid, now: () => new Date() });
      const svcMgr = selectServiceManager(isolatedPlatform, runner, store);
      expect(svcMgr.kind).toBe("systemd-user");

      const validDef = {
        serviceId: "bflow-mcp-gateway",
        program: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: { NODE_ENV: "production" },
        keepAlive: true
      };
      expect(validateServiceDefinition(validDef)).toBeNull();
      expect(svcMgr.unitPath("bflow-mcp-gateway")).toContain("systemd/user/bflow-bflow-mcp-gateway.service");
      expect(svcMgr.render(validDef)).toContain("Managed by bflow");

      // Rejects newline injection in service program/args
      expect(
        validateServiceDefinition({
          serviceId: "bflow-mcp-gateway",
          program: "/bin/sh\nExecStart=/bin/evil",
          args: [],
          env: {},
          keepAlive: false
        })
      ).toContain("control character");

      // Live systemd --user registration, start, status check, and cleanup via BflowOSServiceManager
      const unitDir = join(process.env["HOME"] ?? "/root", ".config/systemd/user");
      mkdirSync(unitDir, { recursive: true });
      const osSvcManager = new BflowOSServiceManager({
        platform: "linux",
        homeDir: process.env["HOME"]
      });
      const testServiceId = `qa-e11-${process.pid}`;
      try {
        const installRes = await osSvcManager.install({
          schemaVersion: 3,
          serviceId: testServiceId,
          description: "Bflow QA E11 Transient Service",
          program: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          workingDirectory: root,
          env: { BFLOW_QA_E11: "1" },
          enableOnLogin: false,
          keepAliveOnCrash: true,
          restartSec: 2,
          maxRestartBurst: 3,
          healthTimeoutMs: 5_000
        });
        expect(installRes.ok).toBe(true);

        const startRes = await osSvcManager.start(testServiceId);
        expect(startRes.ok).toBe(true);
        if (startRes.ok) {
          expect(startRes.value.state).toBe("running");
          expect(startRes.value.pid).toBeGreaterThan(1);
        }

        const stopRes = await osSvcManager.stop(testServiceId);
        expect(stopRes.ok).toBe(true);
        if (stopRes.ok) {
          expect(stopRes.value.state).toBe("stopped");
        }
      } finally {
        await osSvcManager.stop(testServiceId).catch(() => {});
        const unitFile = join(unitDir, `bflow-${testServiceId}.service`);
        if (existsSync(unitFile)) {
          rmSync(unitFile, { force: true });
          try {
            execFileSync("systemctl", ["--user", "daemon-reload"]);
          } catch {}
        }
      }
    });
  });
});
