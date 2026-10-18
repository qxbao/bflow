import { describe, expect, it } from "vitest";
import { parseCodexTomlHooks } from "../src/codex-hook-toml.js";

describe("parseCodexTomlHooks", () => {
  it("excludes validated native hooks.state metadata", () => {
    const parsed = parseCodexTomlHooks(`
[auth]
api_key = "must-not-be-returned"
[hooks.state."/home/user/.codex/hooks.json:SessionStart:0:0"]
trusted_hash = "${"a".repeat(64)}"
enabled = true
`);
    expect(parsed).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain("must-not-be-returned");
  });

  it("returns executable hook event tables without unrelated credential fields", () => {
    const parsed = parseCodexTomlHooks(`
[auth]
api_key = "must-not-be-returned"
[mcp_servers.private]
bearer_token = "must-not-be-returned-either"
[hooks]
Interrupt = [{ hooks = [{ type = "command", command = "/absolute/bun /absolute/cli.js hook interrupt", timeout = 30 }] }]
`);
    expect(parsed).toEqual({
      Interrupt: [{ hooks: [{ type: "command", command: "/absolute/bun /absolute/cli.js hook interrupt", timeout: 30 }] }]
    });
    expect(JSON.stringify(parsed)).not.toContain("must-not-be-returned");
  });

  it("rejects malformed native hook state rather than dropping unknown metadata", () => {
    expect(() => parseCodexTomlHooks(`
[hooks.state."/home/user/.codex/hooks.json:SessionStart:0:0"]
unknown = "value"
`)).toThrow();
  });

  it("rejects unsafe table keys and malformed TOML", () => {
    expect(() => parseCodexTomlHooks('[hooks]\n"__proto__" = []')).toThrow();
    expect(() => parseCodexTomlHooks("[hooks\nInterrupt = []")).toThrow();
  });

  it("rejects hook event controls with an unknown shape", () => {
    expect(() => parseCodexTomlHooks('[hooks]\nInterrupt = "execute this"')).toThrow();
  });

  it("bounds TOML input size", () => {
    expect(() => parseCodexTomlHooks("#" + "x".repeat(256 * 1024))).toThrow(/size|limit/i);
  });
});
