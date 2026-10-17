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
    expect(result.inventory.find(item => item.toolId === "claude-mem")?.status).toBe("manual");
    expect(result.launchRequirements.map(item => item.toolId)).toEqual(["gitnexus", "chrome-devtools-mcp"]);
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
});
