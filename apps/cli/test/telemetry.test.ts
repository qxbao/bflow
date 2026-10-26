import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { createDefaultRepositoryConfig } from "../src/config.js";
import { stringifyConfigYaml } from "../src/config-format.js";
import { main } from "../src/bin.js";
import { runCli } from "../src/commands.js";
import { parseCliArgs } from "../src/parser.js";
import { buildWorkflowTelemetry } from "../../../packages/runtime/src/telemetry/report.js";

const report = () => buildWorkflowTelemetry({ runId: "run-1", asOf: "2026-10-27T00:00:00Z", source: "agentic",
  taskIds: [], events: [], complete: false });
const io = { stdout: vi.fn(), stderr: vi.fn() };
afterEach(() => { process.exitCode = 0; vi.clearAllMocks(); });
describe("status telemetry", () => {
  it("accepts opt-in run telemetry and rejects absent run/list filters", () => {
    expect(parseCliArgs(["status", "run-1", "--telemetry", "--json"])).toMatchObject({ ok: true, value: { telemetry: true } });
    expect(parseCliArgs(["status", "--telemetry"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["status", "--telemetry", "--status", "running"])).toMatchObject({ ok: false });
  });
  it("binary returns structured report without composing a workflow runtime or starting a host", async () => {
    const telemetry = vi.fn(async () => report());
    const result = await main(["status", "run-1", "--telemetry", "--json"], { io, telemetry, cwd: "/nonexistent" });
    expect(result.exitCode).toBe(0);
    expect(telemetry).toHaveBeenCalledWith("run-1");
    expect(JSON.parse(result.stdout!)).toMatchObject({ ok: true, data: { reportVersion: 1,
      tokens: { value: null, quality: "unavailable" } } });
  });
  it("shows metric units, denominator, coverage and unavailable cost in text", async () => {
    const result = await runCli(["status", "run-1", "--telemetry"], { io, telemetry: async () => report() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unavailable");
    expect(result.stdout).toContain("USD");
    expect(result.stdout).toContain("denominator=0");
    expect(result.stdout).toContain("core_events");
  });
  it("isolates report source errors and strips raw exception text", async () => {
    const getRun = vi.fn();
    const result = await runCli(["status", "run-1", "--telemetry", "--json"], { io, runtime: { getRun } as any,
      telemetry: async () => { throw new Error("SECRET-PROMPT"); } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source_unavailable");
    expect(result.stdout).not.toContain("SECRET-PROMPT");
    expect(getRun).not.toHaveBeenCalled();
  });
  it("rejects malformed report from a private reader without copying untrusted fields", async () => {
    const result = await runCli(["status", "run-1", "--telemetry", "--json"], { io,
      telemetry: async () => ({ ...report(), secret: "SECRET-PROMPT" }) as any });
    expect(result.stdout).toContain("source_unavailable");
    expect(result.stdout).not.toContain("SECRET-PROMPT");
  });
  it("does not bootstrap legacy registry, adapters or storage to view telemetry in a configured repository", async () => {
    const root = await mkdtemp("/tmp/bflow-telemetry-cli-");
    try {
      execFileSync("git", ["init", "--quiet", root]);
      await mkdir(`${root}/.bflow`);
      await writeFile(`${root}/.bflow/config.yml`, stringifyConfigYaml(createDefaultRepositoryConfig()));
      const before = await readdir(`${root}/.bflow`);
      const result = await main(["status", "run-1", "--telemetry", "--json"], { io, cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("legacy_readonly_source_unavailable");
      expect(await readdir(`${root}/.bflow`)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
