import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupReceiptSchema, type SetupReceipt, type SetupStep, type ToolInstaller } from "@bflow/contracts";
import {
  DOCTOR_STEP_ID,
  EnvironmentManifestSchema,
  MachineSetupService,
  NonInteractiveApprover,
  PATH_BLOCK_START,
  ToolInstallerRegistry,
  defaultMachineConfig,
  digest,
  parseEnvironmentManifest,
  type CommandRunner,
  type HostEnvironment
} from "../src/index.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const SECRET = "sk-livesecretvalue123456";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const gid = typeof process.getgid === "function" ? process.getgid() : null;
let home: string;
let bin: string;
let host: HostEnvironment;

const VERSIONS: Record<string, string> = {
  node: "v22.13.0", pnpm: "12.5.1", git: "git version 2.40.0", herdr: "herdr 0.9.0"
};
const runner: CommandRunner = {
  run: async (argv) => {
    const base = path.basename(argv[0]!);
    if (VERSIONS[base] !== undefined) return { exitCode: 0, stdout: `${VERSIONS[base]}\n`, stderr: "", timedOut: false };
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; // systemctl etc.
  }
};

async function tool(name: string): Promise<void> {
  const f = path.join(bin, name);
  await writeFile(f, "#!/bin/sh\nexit 0\n");
  await chmod(f, 0o755);
}

type Snapshot = Map<string, string>;
async function snapshot(dir: string, out: Snapshot = new Map()): Promise<Snapshot> {
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

function service(over: Partial<ConstructorParameters<typeof MachineSetupService>[0]> = {}) {
  return new MachineSetupService({
    host, runner, approver: new NonInteractiveApprover(), now: () => NOW, knownInstallDirs: () => [], ...over
  });
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "bflow-svc-"));
  bin = path.join(home, "fakebin");
  await mkdir(bin);
  for (const t of ["node", "pnpm", "git", "herdr"]) await tool(t);
  host = {
    platform: "linux", arch: "x64", homeDir: home, hostname: "testhost", uid, gid,
    env: { PATH: bin, SHELL: "/bin/bash", HOME: home, OPENAI_API_KEY: SECRET }
  };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("MachineSetupService", () => {
  it("check: observe + doctor, no plan, zero writes", async () => {
    const before = await snapshot(home);
    const r = await service().run({ mode: "check" });
    expect(changed(before, await snapshot(home))).toEqual([]);
    expect(r.plan).toBeNull();
    expect(r.preview).toBeNull();
    expect(r.receipts).toEqual([]);
    expect(r.configStatus).toBe("absent");
    expect(r.doctor?.healthy).toBe(true);
    expect(r.outcome).toBe("changes_pending");
    expect(r.observations.find((o) => o.toolId === "pnpm")!.status).toBe("present");
  });

  it("dry_run: plan + preview, no approval, no execution, zero writes", async () => {
    const before = await snapshot(home);
    const r = await service().run({ mode: "dry_run", assumeYes: true });
    expect(changed(before, await snapshot(home))).toEqual([]);
    expect(r.plan!.steps.map((s) => s.stepId)).toEqual(["configure:path", "configure:environment-manifest", DOCTOR_STEP_ID]);
    expect(r.preview!.satisfied.sort()).toEqual(["mcp-config", "services"]);
    expect(r.receipts).toEqual([]);
    expect(r.outcome).toBe("changes_pending");
  });

  it("apply without approval → approval_declined, nothing applied", async () => {
    const r = await service().run({ mode: "apply" });
    expect(r.outcome).toBe("approval_declined");
    expect(r.receipts).toEqual([]);
    await expect(lstat(path.join(home, ".bashrc"))).rejects.toThrow();
  });

  it("apply --yes then idempotent rerun: only already-satisfied doctor, writes limited to setup state", async () => {
    const first = await service().run({ mode: "apply", assumeYes: true });
    expect(first.outcome).toBe("applied");
    expect(Object.fromEntries(first.receipts.map((x) => [x.stepId, x.status]))).toEqual({
      "configure:path": "applied", "configure:environment-manifest": "applied", [DOCTOR_STEP_ID]: "applied"
    });
    expect(first.doctor?.healthy).toBe(true);
    const rc = await readFile(path.join(home, ".bashrc"), "utf8");
    expect(rc.split(PATH_BLOCK_START).length).toBe(2);

    const manifestFile = path.join(xdg().state, "environment.json");
    const manifest = parseEnvironmentManifest(JSON.parse(await readFile(manifestFile, "utf8")));
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(EnvironmentManifestSchema.parse(manifest.value)).toEqual(manifest.value);
      expect(manifest.value.lastPlan).toMatchObject({ planId: first.plan!.planId, revision: 1 });
      expect(manifest.value.pathBlock).toEqual({ target: path.join(home, ".bashrc"), dirs: [path.join(xdg().data, "bin")] });
      expect(manifest.value.tools.map((t) => t.toolId)).toContain("herdr");
    }

    const before = await snapshot(home);
    const second = await service().run({ mode: "apply", assumeYes: true });
    expect(second.outcome).toBe("healthy");
    expect(second.plan!.steps.map((s) => s.stepId)).toEqual([DOCTOR_STEP_ID]);
    expect(second.plan!.revision).toBe(2);
    expect(second.receipts.map((x) => x.status)).toEqual(["applied"]);
    const diff = changed(before, await snapshot(home));
    const setupDir = path.join(xdg().state, "setup");
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((p) => p === xdg().state || p === setupDir || p.startsWith(setupDir + path.sep))).toBe(true);

    // check after apply: healthy and still zero writes
    const before2 = await snapshot(home);
    const check = await service().run({ mode: "check" });
    expect(check.outcome).toBe("healthy");
    expect(changed(before2, await snapshot(home))).toEqual([]);

    // no secret value from the environment lands anywhere under HOME
    for (const p of (await snapshot(home)).keys()) {
      const st = await lstat(p);
      if (st.isFile()) expect((await readFile(p, "utf8")).includes(SECRET)).toBe(false);
    }
  });

  it("installs a pinned missing tool via the registry; doctor post-check re-probes", async () => {
    await rm(path.join(bin, "pnpm"));
    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const pin = {
      schemaVersion: 3, toolId: "pnpm", installerId: "fake-npm", method: "npm", version: "12.5.1",
      source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz", integrity: "a".repeat(64),
      platforms: ["linux", "darwin"], requiresElevation: false
    };
    await writeFile(path.join(cfgDir, "machine.json"), JSON.stringify({ ...defaultMachineConfig(), toolPins: [pin] }), { mode: 0o600 });
    let installed = false;
    const receipt = (req: Parameters<ToolInstaller["apply"]>[0]): SetupReceipt =>
      SetupReceiptSchema.parse({
        schemaVersion: 3, receiptId: "fake", planId: req.planId, planDigest: req.planDigest, stepId: req.step.stepId,
        scope: req.step.scope, status: installed ? "applied" : "failed", desiredStateDigest: req.step.desiredStateDigest,
        observedStateDigest: installed ? req.step.desiredStateDigest : null, ownedPaths: [], observedAt: NOW.toISOString(),
        diagnostics: [], idempotencyKey: req.step.idempotencyKey
      });
    const installer: ToolInstaller = {
      installerId: "fake-npm",
      plan: async (req) => ({
        ok: true,
        value: {
          schemaVersion: 3, stepId: "install_tool:pnpm", action: "install_tool", componentId: "pnpm", level: "machine",
          scope: req.scope, dependsOn: [], desiredStateDigest: digest(req.version), expectedStateDigest: null,
          requiresApproval: true, rollback: "remove_owned_install", toolInstall: req, idempotencyKey: req.idempotencyKey
        } satisfies SetupStep
      }),
      apply: async (req) => {
        await tool("pnpm");
        installed = true;
        return { ok: true, value: receipt(req) };
      },
      reconcile: async (req) => ({ ok: true, value: receipt(req) })
    };
    const registry = new ToolInstallerRegistry();
    registry.register(installer);
    const r = await service({ registry }).run({ mode: "apply", assumeYes: true });
    expect(r.receipts.find((x) => x.stepId === "install_tool:pnpm")!.status).toBe("applied");
    expect(r.doctor?.healthy).toBe(true);
    expect(r.outcome).toBe("applied");
    expect(r.machineWideChanges).toEqual([`install_tool:pnpm: ${path.join(xdg().data, "tools", "pnpm")}`]);
    expect(r.observations.find((o) => o.toolId === "pnpm")!.status).toBe("present");
  });

  it("invalid machine config: apply blocked with zero writes; repair backs up and restores defaults", async () => {
    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const cfg = path.join(cfgDir, "machine.json");
    await writeFile(cfg, "{ not json", { mode: 0o600 });
    const before = await snapshot(home);
    const blocked = await service().run({ mode: "apply", assumeYes: true });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.configStatus).toBe("invalid");
    expect(blocked.diagnostics).toContain("machine config invalid; run setup --repair");
    expect(changed(before, await snapshot(home))).toEqual([]);

    const check = await service().run({ mode: "check" });
    expect(check.doctor!.checks.find((c) => c.checkId === "machine-config")!.status).toBe("failed");

    const repaired = await service().run({ mode: "repair", assumeYes: true });
    expect(repaired.configStatus).toBe("valid");
    expect(JSON.parse(await readFile(cfg, "utf8"))).toEqual(defaultMachineConfig());
    const backups = path.join(xdg().state, "backups");
    const idx = (await readFile(path.join(backups, "index.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { original: string; backup: string });
    expect(idx.some((e) => e.original === cfg)).toBe(true);
    expect(await readFile(idx.find((e) => e.original === cfg)!.backup, "utf8")).toBe("{ not json");
    expect(repaired.outcome).toBe("applied");
  });

  it("unsupported_version machine config is also repaired", async () => {
    const cfgDir = xdg().config;
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    const cfg = path.join(cfgDir, "machine.json");
    await writeFile(cfg, JSON.stringify({ ...defaultMachineConfig(), schemaVersion: 2 }), { mode: 0o600 });
    const blocked = await service().run({ mode: "apply", assumeYes: true });
    expect(blocked.outcome).toBe("blocked");
    const repaired = await service().run({ mode: "repair", assumeYes: true });
    expect(repaired.configStatus).toBe("valid");
  });

  it("lock held → blocked outcome, no receipts", async () => {
    const state = xdg().state;
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(path.join(state, "setup.lock"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: NOW.toISOString() }));
    const r = await service().run({ mode: "apply", assumeYes: true });
    expect(r.outcome).toBe("blocked");
    expect(r.receipts).toEqual([]);
    expect(r.diagnostics.join(" ")).toContain("another setup operation");
  });
});

describe("environment manifest", () => {
  it("rejects unknown version and malformed v3", () => {
    const v = parseEnvironmentManifest({ schemaVersion: 4 });
    expect(!v.ok && v.error.code).toBe("unsupported_version");
    const m = parseEnvironmentManifest({ schemaVersion: 3, machineId: "m-1" });
    expect(!m.ok && m.error.code).toBe("validation");
    const none = parseEnvironmentManifest({});
    expect(!none.ok && none.error.code).toBe("validation");
  });
});
