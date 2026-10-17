import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ManagedToolInstaller } from "../src/installer.js";
import { defaultToolCatalog } from "../src/default-catalog.js";

describe("default pinned installer catalog", () => {
  it("plans installable defaults and reports native plugins separately", async () => {
    const catalog = defaultToolCatalog("linux", "x64");
    expect(catalog.pins.map(pin => pin.toolId).sort()).toEqual(["agy", "chrome-devtools-mcp", "claude", "codex", "gitnexus", "herdr", "rtk"]);
    expect(catalog.manual.map(item => item.toolId).sort()).toEqual(["claude-mem", "superpowers"]);
    const installer = new ManagedToolInstaller({ managedRoot: "/tmp/bflow-default-plan/tools", pins: catalog.pins });
    for (const pin of catalog.pins) {
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pin.integrity).toMatch(/^[0-9a-f]{64}$/);
      const plan = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
        version: pin.version, source: pin.source, integrity: pin.integrity,
        destination: join("/tmp/bflow-default-plan/tools", pin.toolId),
        scope: { kind: "machine", machineId: "machine" }, idempotencyKey: `default-${pin.toolId}` });
      expect(plan.ok, pin.toolId).toBe(true);
      if (plan.ok) expect(plan.value.requiresApproval).toBe(true);
    }
  });
  it("selects native archives by architecture and fails closed on unsupported systems", () => {
    const intel = defaultToolCatalog("linux", "x64");
    const arm = defaultToolCatalog("darwin", "arm64");
    expect(arm.pins.find(pin => pin.toolId === "rtk")?.source).toContain("aarch64-apple-darwin");
    expect(arm.pins.find(pin => pin.toolId === "herdr")?.source).toContain("macos-aarch64");
    expect(arm.manual.some(item => item.toolId === "agy")).toBe(true);
    expect(arm.pins.find(pin => pin.toolId === "rtk")?.integrity).not.toBe(intel.pins.find(pin => pin.toolId === "rtk")?.integrity);
    expect(defaultToolCatalog("win32", "x64").pins).toEqual([]);
    expect(defaultToolCatalog("linux", "riscv64").pins).toEqual([]);
  });
});
