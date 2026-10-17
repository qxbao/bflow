import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupReceiptSchema,
  type MCPServiceDefinition,
  type SetupReceipt,
  type SetupStep,
  type ToolInstaller
} from "@bflow/contracts";
import {
  DOCTOR_STEP_ID,
  MachineSetupService,
  NonInteractiveApprover,
  PATH_BLOCK_END,
  PATH_BLOCK_START,
  SetupStateStore,
  ToolInstallerRegistry,
  defaultMachineConfig,
  detectPlatform,
  digest,
  type CommandRunner,
  type HostEnvironment,
  type ServiceDefinition
} from "../src/index.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const SECRET = "sk-super-secret-production-token-987654";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const gid = typeof process.getgid === "function" ? process.getgid() : null;

let home: string;
let bin: string;
let host: HostEnvironment;

const VERSIONS: Record<string, string> = {
  node: "v22.13.0",
  pnpm: "12.5.1",
  git: "git version 2.40.0",
  herdr: "herdr 0.9.0",
  claude: "claude 1.0.0"
};

class FakeScenarioRunner implements CommandRunner {
  calls: string[][] = [];
  serviceActive = true;

  async run(argv: readonly string[]) {
    this.calls.push([...argv]);
    const base = path.basename(argv[0] ?? "");
    if (VERSIONS[base] !== undefined) {
      return { exitCode: 0, stdout: `${VERSIONS[base]}\n`, stderr: "", timedOut: false };
    }
    if (argv.includes("is-active")) {
      return { exitCode: 0, stdout: this.serviceActive ? "active\n" : "inactive\n", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

let runner: FakeScenarioRunner;

async function makeExecutable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const p = path.join(dir, name);
  await writeFile(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(p, 0o755);
  return p;
}

type Snapshot = Map<string, string>;
async function snapshot(dir: string, out: Snapshot = new Map()): Promise<Snapshot> {
  try {
    for (const name of await readdir(dir)) {
      const p = path.join(dir, name);
      const st = await lstat(p);
      if (st.isDirectory()) {
        out.set(p, `dir:${st.mtimeMs}:${st.mode}`);
        await snapshot(p, out);
      } else {
        const bytes = st.isFile() ? createHash("sha256").update(await readFile(p)).digest("hex") : "link";
        out.set(p, `file:${st.mtimeMs}:${st.size}:${st.mode}:${bytes}`);
      }
    }
  } catch {
    // dir may not exist yet
  }
  return out;
}

function changed(a: Snapshot, b: Snapshot): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

const xdg = () => ({
  config: path.join(home, ".config", "bflow"),
  state: path.join(home, ".local", "state", "bflow"),
  data: path.join(home, ".local", "share", "bflow")
});

function createService(over: Partial<ConstructorParameters<typeof MachineSetupService>[0]> = {}) {
  return new MachineSetupService({
    host,
    runner,
    approver: new NonInteractiveApprover(),
    now: () => NOW,
    knownInstallDirs: () => [path.join(home, ".local", "bin")],
    ...over
  });
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "bflow-scenario-"));
  bin = path.join(home, "bin");
  await mkdir(bin, { recursive: true, mode: 0o755 });
  runner = new FakeScenarioRunner();
  host = {
    platform: "linux",
    arch: "x64",
    homeDir: home,
    hostname: "scenario-host",
    uid,
    gid,
    env: {
      PATH: bin,
      SHELL: "/bin/bash",
      HOME: home,
      BFLOW_TEST_SECRET: SECRET
    }
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("P26 End-to-End Scenarios", () => {
  it("Scenario 1: clean machine simulation (all tools missing, no pins, config absent)", async () => {
    // Clean machine: bin directory is empty, no tools installed
    const svc = createService();

    // check mode
    const beforeCheck = await snapshot(home);
    const checkReport = await svc.run({ mode: "check" });
    expect(changed(beforeCheck, await snapshot(home))).toEqual([]);
    expect(checkReport.configStatus).toBe("absent");
    expect(checkReport.doctor?.healthy).toBe(false);
    // When required tools are missing, check outcome is failed
    expect(checkReport.outcome).toBe("failed");

    const failedChecks = checkReport.doctor?.checks.filter((c) => c.status === "failed");
    expect(failedChecks?.map((c) => c.checkId).sort()).toEqual(["tool-git", "tool-herdr", "tool-node", "tool-pnpm"]);

    // dry_run mode
    const beforeDry = await snapshot(home);
    const dryReport = await svc.run({ mode: "dry_run", assumeYes: true });
    expect(changed(beforeDry, await snapshot(home))).toEqual([]);
    expect(dryReport.plan?.steps.some((s) => s.action === "install_tool")).toBe(false);
    expect(dryReport.preview?.manual.length).toBeGreaterThanOrEqual(4);
    const manualToolIds = dryReport.preview?.manual.map((m) => m.toolId);
    expect(manualToolIds).toContain("node");
    expect(manualToolIds).toContain("pnpm");
    expect(manualToolIds).toContain("git");
    expect(manualToolIds).toContain("herdr");
  });

  it("Scenario 2: partial installation (missing tool installed via installer)", async () => {
    for (const t of ["node", "git", "herdr"]) await makeExecutable(bin, t);
    // pnpm is missing from bin

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const pin = {
      schemaVersion: 3,
      toolId: "pnpm",
      installerId: "fake-pnpm-installer",
      method: "npm" as const,
      version: "12.5.1",
      source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz",
      integrity: "b".repeat(64),
      platforms: ["linux" as const, "darwin" as const],
      requiresElevation: false
    };
    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({ ...defaultMachineConfig(), toolPins: [pin] }),
      { mode: 0o600 }
    );

    let installed = false;
    const fakeInstaller: ToolInstaller = {
      installerId: "fake-pnpm-installer",
      plan: async (req) => ({
        ok: true,
        value: {
          schemaVersion: 3,
          stepId: "install_tool:pnpm",
          action: "install_tool",
          componentId: "pnpm",
          level: "machine",
          scope: req.scope,
          dependsOn: [],
          desiredStateDigest: digest(req.version),
          expectedStateDigest: null,
          requiresApproval: true,
          rollback: "remove_owned_install",
          toolInstall: req,
          idempotencyKey: req.idempotencyKey
        } satisfies SetupStep
      }),
      apply: async (req) => {
        await makeExecutable(bin, "pnpm");
        installed = true;
        return {
          ok: true,
          value: SetupReceiptSchema.parse({
            schemaVersion: 3,
            receiptId: "rcpt-pnpm",
            planId: req.planId,
            planDigest: req.planDigest,
            stepId: req.step.stepId,
            scope: req.step.scope,
            status: "applied",
            desiredStateDigest: req.step.desiredStateDigest,
            observedStateDigest: req.step.desiredStateDigest,
            ownedPaths: [path.join(bin, "pnpm")],
            observedAt: NOW.toISOString(),
            diagnostics: [],
            idempotencyKey: req.step.idempotencyKey
          })
        };
      },
      reconcile: async (req) => ({
        ok: true,
        value: SetupReceiptSchema.parse({
          schemaVersion: 3,
          receiptId: "rcpt-reconcile",
          planId: req.planId,
          planDigest: req.planDigest,
          stepId: req.step.stepId,
          scope: req.step.scope,
          status: installed ? "applied" : "failed",
          desiredStateDigest: req.step.desiredStateDigest,
          observedStateDigest: installed ? req.step.desiredStateDigest : null,
          ownedPaths: installed ? [path.join(bin, "pnpm")] : [],
          observedAt: NOW.toISOString(),
          diagnostics: [],
          idempotencyKey: req.step.idempotencyKey
        })
      })
    };

    const registry = new ToolInstallerRegistry();
    registry.register(fakeInstaller);

    const svc = createService({ registry });
    const report = await svc.run({ mode: "apply", assumeYes: true });

    expect(report.outcome).toBe("applied");
    expect(report.receipts.find((r) => r.stepId === "install_tool:pnpm")?.status).toBe("applied");
    expect(report.doctor?.healthy).toBe(true);
    expect(installed).toBe(true);
  });

  it("Scenario 3: existing installation (all satisfied → only doctor, zero config writes)", async () => {
    for (const t of ["node", "pnpm", "git", "herdr"]) await makeExecutable(bin, t);

    const svc = createService();
    // First run creates base configuration & manifest
    const firstRun = await svc.run({ mode: "apply", assumeYes: true });
    expect(firstRun.outcome).toBe("applied");

    // Second run: everything is already satisfied
    const beforeSecond = await snapshot(home);
    const secondRun = await svc.run({ mode: "apply", assumeYes: true });

    expect(secondRun.outcome).toBe("healthy");
    expect(secondRun.plan?.steps.map((s) => s.stepId)).toEqual([DOCTOR_STEP_ID]);
    expect(secondRun.receipts.map((r) => r.stepId)).toEqual([DOCTOR_STEP_ID]);

    // Check that user config files (.bashrc, etc.) were NOT written or touched
    const diff = changed(beforeSecond, await snapshot(home));
    const setupDir = path.join(xdg().state, "setup");
    expect(diff.every((p) => p === xdg().state || p === setupDir || p.startsWith(setupDir + path.sep))).toBe(true);
  });

  it("Scenario 4: PATH missing (tool in knownInstallDir -> PATH block, rerun no duplicate)", async () => {
    for (const t of ["node", "pnpm", "git", "herdr"]) await makeExecutable(bin, t);
    // claude is in ~/.local/bin but not on PATH. Not required in machine.json so doctor stays healthy.
    const localBin = path.join(home, ".local", "bin");
    await makeExecutable(localBin, "claude");

    const svc = createService();
    const first = await svc.run({ mode: "apply", assumeYes: true });
    expect(first.outcome).toBe("applied");

    const bashrcPath = path.join(home, ".bashrc");
    const bashrcContent = await readFile(bashrcPath, "utf8");
    expect(bashrcContent.includes(localBin)).toBe(true);
    expect(bashrcContent.split(PATH_BLOCK_START).length).toBe(2);

    // Rerun: no duplicate blocks, no duplicate entries
    const second = await svc.run({ mode: "apply", assumeYes: true });
    expect(second.outcome).toBe("healthy");
    const bashrcRerun = await readFile(bashrcPath, "utf8");
    expect(bashrcRerun).toBe(bashrcContent);
  });

  it("Scenario 5: failed installation preserves backups and applies independent configuration", async () => {
    for (const t of ["node", "git", "herdr"]) await makeExecutable(bin, t);
    // pnpm is missing and installer fails

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const pin = {
      schemaVersion: 3,
      toolId: "pnpm",
      installerId: "failing-installer",
      method: "npm" as const,
      version: "12.5.1",
      source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz",
      integrity: "c".repeat(64),
      platforms: ["linux" as const, "darwin" as const],
      requiresElevation: false
    };
    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({ ...defaultMachineConfig(), toolPins: [pin] }),
      { mode: 0o600 }
    );

    // Seed existing .bashrc to verify backup integrity
    const bashrc = path.join(home, ".bashrc");
    const initialBashrc = "# custom user bashrc\nalias ll='ls -l'\n";
    await writeFile(bashrc, initialBashrc, { mode: 0o644 });

    const failingInstaller: ToolInstaller = {
      installerId: "failing-installer",
      plan: async (req) => ({
        ok: true,
        value: {
          schemaVersion: 3,
          stepId: "install_tool:pnpm",
          action: "install_tool",
          componentId: "pnpm",
          level: "machine",
          scope: req.scope,
          dependsOn: [],
          desiredStateDigest: digest(req.version),
          expectedStateDigest: null,
          requiresApproval: true,
          rollback: "remove_owned_install",
          toolInstall: req,
          idempotencyKey: req.idempotencyKey
        } satisfies SetupStep
      }),
      apply: async (req) => ({
        ok: true,
        value: SetupReceiptSchema.parse({
          schemaVersion: 3,
          receiptId: "rcpt-fail",
          planId: req.planId,
          planDigest: req.planDigest,
          stepId: req.step.stepId,
          scope: req.step.scope,
          status: "failed",
          desiredStateDigest: req.step.desiredStateDigest,
          observedStateDigest: null,
          ownedPaths: [],
          observedAt: NOW.toISOString(),
          diagnostics: ["npm network failure simulation"],
          idempotencyKey: req.step.idempotencyKey
        })
      }),
      reconcile: async (req) => ({
        ok: true,
        value: SetupReceiptSchema.parse({
          schemaVersion: 3,
          receiptId: "rcpt-rec-fail",
          planId: req.planId,
          planDigest: req.planDigest,
          stepId: req.step.stepId,
          scope: req.step.scope,
          status: "failed",
          desiredStateDigest: req.step.desiredStateDigest,
          observedStateDigest: null,
          ownedPaths: [],
          observedAt: NOW.toISOString(),
          diagnostics: [],
          idempotencyKey: req.step.idempotencyKey
        })
      })
    };

    const registry = new ToolInstallerRegistry();
    registry.register(failingInstaller);

    const svc = createService({ registry });
    const report = await svc.run({ mode: "apply", assumeYes: true });

    expect(report.outcome).toBe("partially_applied");
    expect(report.receipts.find((r) => r.stepId === "install_tool:pnpm")?.status).toBe("failed");
    expect(report.receipts.find((r) => r.stepId === "configure:path")?.status).toBe("applied");
    expect(report.receipts.find((r) => r.stepId === "configure:environment-manifest")?.status).toBe("blocked");

    // The user's original content is retained while the independent PATH block is appended.
    expect(await readFile(bashrc, "utf8")).toContain(initialBashrc);
    expect(await readFile(bashrc, "utf8")).toContain(PATH_BLOCK_START);
  });

  it("Scenario 6: interrupted setup (abort mid-step → unknown; rerun reconciles)", async () => {
    for (const t of ["node", "git", "herdr"]) await makeExecutable(bin, t);
    // pnpm is missing

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const pin = {
      schemaVersion: 3,
      toolId: "pnpm",
      installerId: "interrupted-installer",
      method: "npm" as const,
      version: "12.5.1",
      source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz",
      integrity: "d".repeat(64),
      platforms: ["linux" as const, "darwin" as const],
      requiresElevation: false
    };
    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({ ...defaultMachineConfig(), toolPins: [pin] }),
      { mode: 0o600 }
    );

    let installed = false;
    let shouldAbort = true;
    const abortCtrl = new AbortController();

    const installer: ToolInstaller = {
      installerId: "interrupted-installer",
      plan: async (req) => ({
        ok: true,
        value: {
          schemaVersion: 3,
          stepId: "install_tool:pnpm",
          action: "install_tool",
          componentId: "pnpm",
          level: "machine",
          scope: req.scope,
          dependsOn: [],
          desiredStateDigest: digest(req.version),
          expectedStateDigest: null,
          requiresApproval: true,
          rollback: "remove_owned_install",
          toolInstall: req,
          idempotencyKey: req.idempotencyKey
        } satisfies SetupStep
      }),
      apply: async (req) => {
        if (shouldAbort) {
          // Do not write executable into bin yet
          installed = true;
          abortCtrl.abort();
          throw new Error("aborted mid-step");
        }
        await makeExecutable(bin, "pnpm");
        installed = true;
        return {
          ok: true,
          value: SetupReceiptSchema.parse({
            schemaVersion: 3,
            receiptId: "rcpt-interrupted",
            planId: req.planId,
            planDigest: req.planDigest,
            stepId: req.step.stepId,
            scope: req.step.scope,
            status: "applied",
            desiredStateDigest: req.step.desiredStateDigest,
            observedStateDigest: req.step.desiredStateDigest,
            ownedPaths: [path.join(bin, "pnpm")],
            observedAt: NOW.toISOString(),
            diagnostics: [],
            idempotencyKey: req.step.idempotencyKey
          })
        };
      },
      reconcile: async (req) => {
        if (installed) {
          await makeExecutable(bin, "pnpm");
        }
        return {
          ok: true,
          value: SetupReceiptSchema.parse({
            schemaVersion: 3,
            receiptId: "rcpt-rec",
            planId: req.planId,
            planDigest: req.planDigest,
            stepId: req.step.stepId,
            scope: req.step.scope,
            status: installed ? "applied" : "failed",
            desiredStateDigest: req.step.desiredStateDigest,
            observedStateDigest: installed ? req.step.desiredStateDigest : null,
            ownedPaths: installed ? [path.join(bin, "pnpm")] : [],
            observedAt: NOW.toISOString(),
            diagnostics: [],
            idempotencyKey: req.step.idempotencyKey
          })
        };
      }
    };

    const registry = new ToolInstallerRegistry();
    registry.register(installer);

    const svc = createService({ registry });

    // First run is interrupted mid-step
    const firstRun = await svc.run({ mode: "apply", assumeYes: true, signal: abortCtrl.signal });
    expect(firstRun.outcome).toBe("failed");
    expect(firstRun.receipts.find((r) => r.stepId === "install_tool:pnpm")?.status).toBe("unknown");

    // Second run: rerun reconciles the interrupted step
    shouldAbort = false;
    const rerun = await svc.run({ mode: "apply", assumeYes: true });

    expect(rerun.outcome).toBe("applied");
    const pnpmReceipt = rerun.receipts.find((r) => r.stepId === "install_tool:pnpm");
    expect(pnpmReceipt?.status).toBe("applied");
    expect(pnpmReceipt?.diagnostics).toContain("reconciled after interruption");
    expect(rerun.doctor?.healthy).toBe(true);
  });

  it("Scenario 7: repair (malformed PATH block + invalid mcp.json + unknown step fixed by repair)", async () => {
    for (const t of ["node", "pnpm", "git", "herdr"]) await makeExecutable(bin, t);

    // Malformed .bashrc with duplicate and broken markers
    const bashrc = path.join(home, ".bashrc");
    await writeFile(
      bashrc,
      `echo "before"\n${PATH_BLOCK_START}\nexport PATH="/broken:$PATH"\n${PATH_BLOCK_START}\n`,
      { mode: 0o644 }
    );

    // Malformed mcp.json
    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const mcpFile = path.join(cfgDir, "mcp.json");
    await writeFile(mcpFile, "{ invalid json content", { mode: 0o600 });

    // Seed state store with an unknown step in journal
    const stateDir = xdg().state;
    await mkdir(path.join(stateDir, "setup"), { recursive: true, mode: 0o700 });
    const store = new SetupStateStore(xdg(), { uid, now: () => NOW });
    await store.writeJournal({
      schemaVersion: 3,
      planId: "plan-corrupt",
      planDigest: "1".repeat(64),
      revision: 1,
      steps: {
        "configure:path": {
          status: "started",
          startedAt: "2026-01-01T00:00:00.000Z",
          idempotencyKey: "setup:test:configure:path:unknown-digest",
          expectedStateDigest: "mismatched-digest"
        }
      }
    });

    const svc = createService();

    // Normal apply should see repairNeeded / unknown and refuse or block
    const applyReport = await svc.run({ mode: "apply", assumeYes: true });
    expect(applyReport.outcome).not.toBe("applied");

    // Repair mode
    const repairReport = await svc.run({ mode: "repair", assumeYes: true });
    expect(repairReport.outcome).toBe("applied");

    // Verify .bashrc repaired to exactly one valid block
    const repairedBashrc = await readFile(bashrc, "utf8");
    expect(repairedBashrc.split(PATH_BLOCK_START).length).toBe(2);
    expect(repairedBashrc.split(PATH_BLOCK_END).length).toBe(2);

    // Verify mcp.json repaired to valid schema v3
    const repairedMcp = JSON.parse(await readFile(mcpFile, "utf8"));
    expect(repairedMcp.schemaVersion).toBe(3);

    // Verify backups exist for modified files
    const backupsDir = path.join(stateDir, "backups");
    const indexContent = await readFile(path.join(backupsDir, "index.jsonl"), "utf8");
    expect(indexContent.includes(".bashrc")).toBe(true);
    expect(indexContent.includes("mcp.json")).toBe(true);
  });

  it("Scenario 8: idempotent rerun (all already_satisfied, rc/mcp/unit bytes identical, single block, single MCP entry, single unit)", async () => {
    for (const t of ["node", "pnpm", "git", "herdr"]) await makeExecutable(bin, t);

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });

    const machineId = detectPlatform(host).machineId;
    const mcpServiceDef: MCPServiceDefinition = {
      schemaVersion: 3,
      serviceId: "test-mcp-svc",
      revision: 1,
      scope: { kind: "machine", machineId },
      tool: {
        schemaVersion: 3,
        toolId: "test-mcp-svc",
        kind: "native_remote_mcp",
        version: "1.0.0",
        operations: ["read"],
        resource: { sharing: "concurrent", maxConcurrency: 2 },
        required: true
      },
      connection: { kind: "native_remote_mcp", endpoint: "https://mcp.internal/api", ownership: "external" },
      authentication: { mode: "none" },
      healthTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      restartLimit: 1
    };

    const osServiceDef: ServiceDefinition = {
      serviceId: "gateway-daemon",
      program: path.join(bin, "herdr"),
      args: ["daemon"],
      env: { PORT: "9000" },
      keepAlive: true
    };

    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({
        ...defaultMachineConfig(),
        mcpServices: [mcpServiceDef],
        services: [osServiceDef]
      }),
      { mode: 0o600 }
    );

    const svc = createService();

    // First apply: configures PATH, MCP, OS Service, and environment manifest
    const first = await svc.run({ mode: "apply", assumeYes: true });
    expect(first.outcome).toBe("applied");

    const bashrc = path.join(home, ".bashrc");
    const mcpFile = path.join(cfgDir, "mcp.json");
    const unitFile = path.join(home, ".config", "systemd", "user", "bflow-gateway-daemon.service");

    const bashrcBytes1 = await readFile(bashrc);
    const mcpBytes1 = await readFile(mcpFile);
    const unitBytes1 = await readFile(unitFile);

    // Second apply: all already satisfied
    const second = await svc.run({ mode: "apply", assumeYes: true });
    expect(second.outcome).toBe("healthy");
    expect(second.plan?.steps.map((s) => s.stepId)).toEqual([DOCTOR_STEP_ID]);

    const bashrcBytes2 = await readFile(bashrc);
    const mcpBytes2 = await readFile(mcpFile);
    const unitBytes2 = await readFile(unitFile);

    // Byte-for-byte identical verification
    expect(bashrcBytes2.equals(bashrcBytes1)).toBe(true);
    expect(mcpBytes2.equals(mcpBytes1)).toBe(true);
    expect(unitBytes2.equals(unitBytes1)).toBe(true);

    // Single block, single entry, single unit
    const bashrcStr = bashrcBytes2.toString("utf8");
    expect(bashrcStr.split(PATH_BLOCK_START).length).toBe(2);
    const parsedMcp = JSON.parse(mcpBytes2.toString("utf8"));
    expect(Object.keys(parsedMcp.services)).toEqual(["test-mcp-svc"]);
  });

  it("Scenario 9: invalid global configuration (apply blocked, check reports failed, repair backs up & restores)", async () => {
    for (const t of ["node", "pnpm", "git", "herdr"]) await makeExecutable(bin, t);

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const cfgPath = path.join(cfgDir, "machine.json");
    await writeFile(cfgPath, "{ syntax error in json", { mode: 0o600 });

    const svc = createService();

    // Check mode
    const checkReport = await svc.run({ mode: "check" });
    expect(checkReport.outcome).toBe("failed");
    expect(checkReport.doctor?.checks.find((c) => c.checkId === "machine-config")?.status).toBe("failed");

    // Apply mode without repair: blocked, zero writes
    const beforeApply = await snapshot(home);
    const applyReport = await svc.run({ mode: "apply", assumeYes: true });
    expect(applyReport.outcome).toBe("blocked");
    expect(applyReport.configStatus).toBe("invalid");
    expect(applyReport.diagnostics).toContain("machine config invalid; run setup --repair");
    expect(changed(beforeApply, await snapshot(home))).toEqual([]);

    // Repair mode: backs up invalid config and restores defaults
    const repairReport = await svc.run({ mode: "repair", assumeYes: true });
    expect(repairReport.outcome).toBe("applied");
    expect(repairReport.configStatus).toBe("valid");

    const restoredConfig = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(restoredConfig).toEqual(defaultMachineConfig());

    const backupsDir = path.join(xdg().state, "backups");
    const indexContent = await readFile(path.join(backupsDir, "index.jsonl"), "utf8");
    expect(indexContent.includes("machine.json")).toBe(true);
  });

  it("Additional policy verification: --yes does not approve elevation steps", async () => {
    for (const t of ["node", "git", "herdr"]) await makeExecutable(bin, t);

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const elevationPin = {
      schemaVersion: 3,
      toolId: "pnpm",
      installerId: "elevation-installer",
      method: "homebrew" as const,
      version: "12.5.1",
      source: "https://brew.sh",
      integrity: "e".repeat(64),
      platforms: ["linux" as const, "darwin" as const],
      requiresElevation: true
    };
    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({ ...defaultMachineConfig(), toolPins: [elevationPin] }),
      { mode: 0o600 }
    );

    const elevationInstaller: ToolInstaller = {
      installerId: "elevation-installer",
      plan: async (req) => ({
        ok: true,
        value: {
          schemaVersion: 3,
          stepId: "install_tool:pnpm",
          action: "install_tool",
          componentId: "pnpm",
          level: "machine",
          scope: req.scope,
          dependsOn: [],
          desiredStateDigest: digest(req.version),
          expectedStateDigest: null,
          requiresApproval: true,
          rollback: "remove_owned_install",
          toolInstall: req,
          idempotencyKey: req.idempotencyKey
        } satisfies SetupStep
      }),
      apply: async () => ({
        ok: false,
        error: { code: "validation", message: "should never run", details: {} }
      }),
      reconcile: async () => ({
        ok: false,
        error: { code: "validation", message: "should never run", details: {} }
      })
    };

    const registry = new ToolInstallerRegistry();
    registry.register(elevationInstaller);

    const svc = createService({ registry });
    const report = await svc.run({ mode: "apply", assumeYes: true });

    expect(report.outcome).toBe("partially_applied");
    const pnpmReceipt = report.receipts.find((r) => r.stepId === "install_tool:pnpm");
    expect(pnpmReceipt?.status).toBe("blocked");
    expect(pnpmReceipt?.diagnostics.join(" ")).toContain("requires OS elevation; run manually");
  });

  it("Additional policy verification: no secret string from environment appears in any file under temp HOME", async () => {
    for (const t of ["node", "pnpm", "git", "herdr"]) await makeExecutable(bin, t);

    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({
        ...defaultMachineConfig(),
        services: [
          {
            serviceId: "secret-svc",
            program: path.join(bin, "herdr"),
            args: ["daemon"],
            env: { AUTH_REF: "secret://vault/key1" },
            keepAlive: false
          }
        ]
      }),
      { mode: 0o600 }
    );

    const svc = createService();
    const report = await svc.run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("applied");

    // Recursively read all files under home and assert secret value is never present
    const sn = await snapshot(home);
    for (const filePath of sn.keys()) {
      const st = await lstat(filePath);
      if (st.isFile()) {
        const content = await readFile(filePath, "utf8");
        expect(content.includes(SECRET)).toBe(false);
      }
    }
  });
});
