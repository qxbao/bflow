import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHostEnvironment, detectPlatform } from "@bflow/machine-setup";
import { runHighLevelCli } from "../src/high-level/index.js";
import { mcpStatus, MCP_STATUS_SPEC } from "../src/high-level/commands/mcp-status.js";
import { parseCommandArgs } from "../src/high-level/args.js";
import { newCommandIdentity } from "../src/high-level/envelope.js";
import { main } from "../src/bin.js";
import { createDefaultSetupConfiguration } from "../src/setup-defaults.js";
import type { CliIo } from "../src/types.js";
import type { HighLevelServices } from "../src/high-level/services.js";

const roots: string[] = [];
afterEach(async () => { process.exitCode = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "bflow-progress-coverage-")); roots.push(root); return root; }
function capture() {
  const progress: string[] = [], raw: string[] = [], out: string[] = [], errors: string[] = [];
  const io: CliIo = { stdout: line => out.push(line), stderr: line => errors.push(line),
    progress: line => progress.push(line), stderrRaw: chunk => raw.push(chunk) };
  return { progress, raw, out, errors, io };
}

describe("progress command coverage", () => {
  it.each([false, true])("reports documentation phases before the access result and stays quiet for JSON (%s)", async json => {
    const root = await directory();
    const captured = capture();
    const result = await main(["docs", "ask", "--repo", "facebook/react", "--public", "--question", "How are hooks scheduled?", ...(json ? ["--json"] : [])], {
      cwd: root, io: captured.io, presentation: { interactive: true }, docs: {
        stateDirectory: root, machineId: "fixture-machine", env: {},
        access: async () => {
          if (!json) expect(captured.progress.join("\n")).toContain("Checking scoped documentation access");
          return { mode: "none", kind: "not_granted", reason: "The role needs a grant" };
        }
      }
    });
    expect(result.exitCode).toBe(1);
    if (json) { expect(captured.progress).toEqual([]); expect(captured.raw).toEqual([]); expect(JSON.parse(result.stdout).data.failure.kind).toBe("permission_denied"); }
    else { expect(captured.progress.join("\n")).toContain("Reading documentation configuration"); expect(captured.raw.at(-1)).toBe("\r\x1b[2K"); }
  });

  it("counts every inspected backend including unknown/unhealthy results without claiming health", async () => {
    const root = await directory();
    const platform = detectPlatform({ ...defaultHostEnvironment(), platform: "linux", homeDir: root, env: { PATH: "", HOME: root } });
    await mkdir(platform.paths.config, { recursive: true });
    const service = (id: string) => ({ schemaVersion: 3, serviceId: id, revision: 1, scope: { kind: "machine", machineId: platform.machineId },
      tool: { schemaVersion: 3, toolId: id, kind: "native_remote_mcp", version: "1.0.0", operations: ["search"], resource: { sharing: "concurrent", maxConcurrency: 4 }, required: false },
      connection: { kind: "native_remote_mcp", endpoint: "https://example.invalid/mcp", ownership: "external" }, authentication: { mode: "none" }, healthTimeoutMs: 1000, idleTimeoutMs: 1000, restartLimit: 1 });
    await writeFile(join(platform.paths.config, "mcp.json"), JSON.stringify({ schemaVersion: 3, services: { docs: service("docs"), search: service("search") }, managedIds: ["docs", "search"] }));
    const units: unknown[] = [];
    const services = { machine: { platform: async () => platform }, mcpGateway: { status: async () => ({ reachable: true,
      backends: [{ serviceId: "docs", state: "healthy" }, { serviceId: "search", state: "unavailable" }] }) } } as unknown as HighLevelServices;
    const result = await mcpStatus(parseCommandArgs(MCP_STATUS_SPEC, []), { cwd: root, clock: () => new Date(), services,
      onUnits: (...args) => units.push(args) }, newCommandIdentity());
    expect(units).toEqual([[0, 2, "MCP backends inspected"], [1, 2, "MCP backends inspected"], [2, 2, "MCP backends inspected"]]);
    expect(result.outcome).toBe("not_ready");
    expect(result.exitCode).toBe(3);
  });

  it("counts the enumerated tool pins after observations, including missing pins and skipped unrelated pins", async () => {
    const root = await directory();
    const platform = detectPlatform({ ...defaultHostEnvironment(), platform: "linux", homeDir: root, env: { PATH: "", HOME: root } });
    const units: unknown[] = [];
    const defaults = await createDefaultSetupConfiguration({ platform, onUnits: (...args) => units.push(args) });
    const pin = defaults.config.toolPins.find(pin => pin.toolId === "superpowers")!;
    const config = { ...defaults.config, toolPins: [{ ...pin, installerId: "unknown-native-installer" }, { ...pin, toolId: "unrelated-tool" }] };
    const observations = await defaults.additionalToolObservations(platform, config);
    expect(observations).toMatchObject([{ toolId: "superpowers", status: "missing" }]);
    expect(units).toEqual([[0, 1, "Tool pins inspected"], [1, 1, "Tool pins inspected"]]);
  });

  it("shows a compact group directory and keeps help free of progress", async () => {
    const captured = capture();
    const result = await runHighLevelCli(["task", "--help"], { io: captured.io, presentation: { interactive: true } });
    expect(result.stdout).toContain("bflow task plan");
    expect(result.stdout).toContain("bflow task implement");
    expect(result.stdout).toContain("bflow task <command> --help");
    expect(result.stdout.match(/Usage:/g)).toHaveLength(1);
    expect(captured.progress).toEqual([]); expect(captured.raw).toEqual([]);
  });
});
