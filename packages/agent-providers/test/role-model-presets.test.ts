import { describe, expect, it } from "vitest";
import { AGENT_ROLES } from "@bflow/contracts";
import {
  AGY_CONVERSATION_FALLBACK_REASON, PRESET_ROLES, ROLE_MODEL_PRESETS, RoleModelPresetSchema, presetAssignment, roleModelPreset
} from "../src/index.js";

describe("static role/model presets", () => {
  it("covers every governance role plus sos for each provider CLI", () => {
    expect(PRESET_ROLES).toEqual([...AGENT_ROLES, "sos"]);
    for (const provider of ["claude", "codex", "agy"] as const) {
      const preset = roleModelPreset(provider);
      expect(RoleModelPresetSchema.parse(preset)).toEqual(preset);
      expect(Object.keys(preset.roles).sort()).toEqual([...PRESET_ROLES].sort());
    }
  });

  it("assigns Claude Opus to reasoning roles and Sonnet to conversation and execution roles", () => {
    for (const role of ["coordinator", "planner", "architect", "specifier", "reviewer", "security", "sos"] as const)
      expect(presetAssignment("claude", role)).toEqual({ cli: "claude", model: "claude-opus-4-7" });
    for (const role of ["conversation", "developer", "tester", "qa"] as const)
      expect(presetAssignment("claude", role)).toEqual({ cli: "claude", model: "claude-sonnet-4-6" });
  });

  it("assigns Codex gpt-5.4 to all roles except testing roles, which use gpt-5.4-mini", () => {
    for (const role of PRESET_ROLES) {
      const expected = role === "tester" || role === "qa" ? "gpt-5.4-mini" : "gpt-5.4";
      expect(presetAssignment("codex", role)).toEqual({ cli: "codex", model: expected });
    }
  });

  it("keeps specialists on Agy's default model and routes the unsupported Conversation role to Claude", () => {
    for (const role of PRESET_ROLES.filter(role => role !== "conversation")) expect(presetAssignment("agy", role)).toEqual({ cli: "agy" });
    expect(presetAssignment("agy", "conversation")).toEqual({
      cli: "claude", model: "claude-sonnet-4-6", fallbackReason: AGY_CONVERSATION_FALLBACK_REASON });
  });

  it("is frozen and rejects unknown providers and roles at the boundary", () => {
    expect(Object.isFrozen(ROLE_MODEL_PRESETS)).toBe(true);
    expect(() => roleModelPreset("gemini" as never)).toThrow();
    expect(() => presetAssignment("claude", "analyst" as never)).toThrow();
  });
});
