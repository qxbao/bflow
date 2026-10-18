import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSetupCommand, runCli, formatCommandSuccess } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const plan = { schemaVersion: 3, planId: "setup-outcomes", machineId: "test-machine", revision: 1,
  planDigest: "a".repeat(64), createdAt: new Date().toISOString(), idempotencyKey: "setup-outcomes", steps: [] };
async function context(report: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "bflow-setup-outcomes-")); roots.push(root);
  return { cwd: root, setup: { isolatedRoot: join(root, "home"), machineSetup: { run: async () => ({ plan, observations: [], diagnostics: [], receipts: [], ...report }) } } };
}

describe("setup result reporting", () => {
  it("returns failure exit status and full receipt evidence when setup was declined", async () => {
    const ctx = await context({ outcome: "approval_declined", diagnostics: ["approval required; rerun with --yes or interactively"] });
    const result = await runCli(["setup", "--json"], ctx);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.outcome).toBe("approval_declined");
  });

  it("preserves every step receipt and displays applied steps without pending approval", async () => {
    const receipts = ["resolve_skills:role-skills", "configure:environment-manifest"].map(stepId => ({
      schemaVersion: 3, receiptId: `receipt-${stepId}`, planId: plan.planId, stepId, status: "applied", observedStateDigest: "b".repeat(64),
      ownedPaths: [], diagnostics: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }));
    const ctx = await context({ outcome: "applied", receipts });
    const output = await executeSetupCommand({ command: "setup", mode: "apply", yes: true, json: false, help: false }, ctx);
    expect(output).toHaveProperty("receipts", receipts);
    const formatted = formatCommandSuccess("setup", { ...output, plan: { ...plan, steps: receipts.map(r => ({ stepId: r.stepId, componentId: r.stepId.split(":")[1], action: r.stepId.split(":")[0], requiresApproval: true })) } } as any, false);
    expect(formatted).toContain("[1] Install agent skills [applied]");
    expect(formatted).not.toContain("[requires approval]");
  });

  it.each(["check", "dry_run"] as const)("keeps %s mode free of directory writes", async mode => {
    const ctx = await context({ outcome: "healthy" });
    await executeSetupCommand({ command: "setup", mode, yes: false, json: true, help: false }, ctx);
    expect(await readdir(ctx.cwd)).toEqual([]);
  });
});

describe("standard setup composition", () => {
  it("applies skills and launcher in the selected account and works from another directory", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { detectPlatform, defaultHostEnvironment, defaultMachineConfig, ToolInstallerRegistry } = await import("@bflow/machine-setup");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const root = await mkdtemp(join(tmpdir(), "bflow-real-setup-")); roots.push(root);
    const bin = join(root, "fixtures"); await mkdir(bin);
    for (const name of ["node", "git", "pnpm", "herdr"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const platform = detectPlatform({ ...defaultHostEnvironment(), homeDir: root,
      env: { PATH: bin, SHELL: "/bin/bash", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") } });
    const runner = { run: async (argv: readonly string[]) => ({ exitCode: 0, timedOut: false, stderr: "",
      stdout: argv[0]!.endsWith("/pnpm") ? "12.5.1" : argv[0]!.endsWith("/git") ? "git version 2.45.0" : argv[0]!.endsWith("/herdr") ? "herdr 0.9.5" : "v24.16.0" }) };
    const approvalPrompts: string[] = [];
    const output = await executeSetupCommand({ command: "setup", mode: "apply", yes: false, json: false, help: false }, {
      cwd: root, setup: { platform, runner, machineConfig: defaultMachineConfig(), toolInstaller: new ToolInstallerRegistry(),
        confirm: async preview => { approvalPrompts.push(preview); return true; } }
    });
    expect(approvalPrompts).toHaveLength(1);
    expect(approvalPrompts[0]).toContain("configure:path");
    expect(output.outcome).toBe("applied");
    expect(output.receipts?.find(r => r.stepId === "resolve_skills:role-skills")?.status).toBe("applied");
    expect(output.receipts?.find(r => r.stepId === "configure:environment-manifest")?.status).toBe("applied");
    expect(output.doctor?.healthy).toBe(true);
    const shell = await readFile(join(root, ".bashrc"), "utf8");
    expect(shell).toContain(platform.paths.managedBin);
    const other = join(root, "unrelated"); await mkdir(other);
    const result = await promisify(execFile)(join(platform.paths.managedBin, "bflow"), ["--version"], { cwd: other });
    expect(result.stdout).toContain("0.1.0");
    expect(await readFile(join(platform.paths.config, "machine.json"), "utf8")).toContain('"schemaVersion": 3');
  });
});

describe("memory observer selection", () => {
  it.each(["auto", "claude", "codex", "host"])("parses --memory-provider %s", async memoryProvider => {
    const { parseCliArgs } = await import("../src/index.js");
    const parsed = parseCliArgs(["setup", "--memory-provider", memoryProvider]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toHaveProperty("memoryProvider", memoryProvider);
  });
  it("rejects an unknown observer provider", async () => {
    const { parseCliArgs } = await import("../src/index.js");
    const parsed = parseCliArgs(["setup", "--memory-provider", "unexpected"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("auto, claude, codex, or host");
  });
});

describe("required skills catalog", () => {
  it("reports an unavailable explicit catalog before setup writes", async () => {
    const ctx = await context({ outcome: "healthy" });
    await expect(executeSetupCommand({ command: "setup", mode: "apply", yes: true, json: true, help: false,
      catalogDir: join(ctx.cwd, "missing-catalog") }, ctx)).rejects.toThrow(/skills catalog/i);
    expect(await readdir(ctx.cwd)).toEqual([]);
  });
});
