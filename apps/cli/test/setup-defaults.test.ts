import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMachineConfig, detectPlatform, defaultHostEnvironment } from "@bflow/machine-setup";
import { createDefaultSetupConfiguration } from "../src/setup-defaults.js";

describe("CLI setup default inventory", () => {
  it("returns a usable pinned registry without installing or activating native plugins", async () => {
    const platform = detectPlatform(defaultHostEnvironment());
    platform.os = "linux"; platform.arch = "x64";
    platform.paths.data = "/tmp/bflow-default-config/data";
    const result = await createDefaultSetupConfiguration({ platform });
    expect(result.config.toolPins.map(pin => pin.toolId)).toContain("rtk");
    expect(result.config.toolPins.map(pin => pin.toolId)).toContain("claude");
    expect(result.config.providers).toEqual(["claude", "codex", "agy"]);
    expect(result.config.mcpServices).toEqual([]);
    expect(result.config.services).toEqual([]);
    expect(result.registry.resolve("rtk", "linux", result.config.toolPins)).not.toBeNull();
    expect(result.inventory.find(item => item.toolId === "mempalace")?.status).toBe("manual");
    expect(result.launchRequirements.map(item => item.toolId)).toEqual(["gitnexus", "chrome-devtools-mcp"]);
    const native = (await result.additionalToolObservations(platform, result.config)).filter(item => ["superpowers"].includes(item.toolId));
    expect(native.map(item => item.toolId).sort()).toEqual(["superpowers"]);
    expect(native.every(item => item.status === "missing" && item.required)).toBe(true);
    expect(native.every(item => item.diagnostics.some(message => message.includes("not installed")))).toBe(true);
    const persisted = await createDefaultSetupConfiguration({ platform, config: result.config });
    const persistedNative = (await persisted.additionalToolObservations(platform, persisted.config)).filter(item => ["superpowers"].includes(item.toolId));
    expect(persistedNative.every(item => item.diagnostics.some(message => message.includes("not installed")))).toBe(true);
  });
  it("preserves explicit operator pins, providers, services and secrets", async () => {
    const platform = detectPlatform(defaultHostEnvironment());platform.os = "linux"; platform.arch = "x64";
    const config = defaultMachineConfig(); config.providers = ["codex"];
    config.toolPins = [{ schemaVersion: 3, toolId: "rtk", installerId: "operator", method: "verified_archive", version: "0.1.0",
      source: "https://example.org/rtk.tgz", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false }];
    const result = await createDefaultSetupConfiguration({ platform, config });
    expect(result.config.providers).toEqual(["codex"]);
    expect(result.config.toolPins.filter(pin => pin.toolId === "rtk")).toEqual(config.toolPins);
    expect(config.toolPins).toHaveLength(1);
  });
  it("uses a provider found in its known installation directory before a managed fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-known-provider-"));
    try {
      const executable = join(root, ".local", "bin", "codex");
      await mkdir(join(root, ".local", "bin"), { recursive: true }); await writeFile(executable, "#!/bin/sh\necho codex-cli 9.0.0\n"); await chmod(executable, 0o700);
      const platform = detectPlatform(defaultHostEnvironment());
      platform.os = "linux"; platform.arch = "x64"; platform.homeDir = root; platform.pathEntries = [];
      platform.paths.data = join(root, "data"); platform.paths.managedBin = join(root, "data", "bin");
      const config = defaultMachineConfig(); config.providers = ["codex"];
      const result = await createDefaultSetupConfiguration({ platform, config });
      expect(result.inventory.find(item => item.toolId === "codex")?.executable).toBe(executable);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("requires the exact managed MCP prerequisite when an external CLI is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-managed-mcp-"));
    try {
      const bin = join(root, "external-bin"); await mkdir(bin);
      for (const toolId of ["gitnexus", "chrome-devtools-mcp"]) {
        const executable = join(bin, toolId); await writeFile(executable, "#!/bin/sh\necho 99.0.0\n"); await chmod(executable, 0o700);
      }
      const platform = detectPlatform(defaultHostEnvironment());
      platform.os = "linux"; platform.arch = "x64"; platform.homeDir = root; platform.pathEntries = [bin]; platform.paths.data = join(root, "data");
      const config = defaultMachineConfig(); config.providers = [];
      const result = await createDefaultSetupConfiguration({ platform, config });
      const observations = await result.additionalToolObservations(platform, result.config);
      for (const toolId of ["gitnexus", "chrome-devtools-mcp"]) {
        expect(observations.find(item => item.toolId === toolId)).toMatchObject({ status: "missing", required: true, resolvedPath: null });
        expect(result.launchRequirements.find(item => item.toolId === toolId)?.executable).toContain(join(root, "data", "tools", toolId));
      }
      const operator = defaultMachineConfig(); operator.providers = [];
      operator.toolPins = [{ schemaVersion: 3, toolId: "gitnexus", installerId: "operator-gitnexus", method: "npm", version: "9.0.0",
        source: "https://example.org/custom.tgz", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false }];
      const custom = await createDefaultSetupConfiguration({ platform, config: operator });
      expect((await custom.additionalToolObservations(platform, custom.config)).some(item => item.toolId === "gitnexus")).toBe(false);
      expect(custom.launchRequirements.some(item => item.toolId === "gitnexus")).toBe(false);
      expect(custom.config.toolPins.find(pin => pin.toolId === "gitnexus")).toEqual(operator.toolPins[0]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
