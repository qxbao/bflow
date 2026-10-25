import { describe, expect, it } from "vitest";
import { getHelpText } from "../src/help.js";
import { parseCliArgs } from "../src/parser.js";
import { CLI_COMMAND_REFERENCE, renderCommandReferenceMarkdown } from "../src/command-reference.js";

describe("explicit Codex hook setup command options", () => {
  it.each([
    ["--plan", "dry_run"],
    ["--check", "check"],
    ["--apply", "apply"]
  ] as const)("parses --codex-hooks %s as an isolated %s operation", (flag, mode) => {
    const result = parseCliArgs(["setup", "--codex-hooks", flag]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ command: "setup", codexHooks: true, mode });
  });

  it("requires the reviewed SHA-256 digest alongside --yes", () => {
    const digest = "a".repeat(64);
    const result = parseCliArgs(["setup", "--codex-hooks", "--apply", "--yes", "--hook-digest", digest]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ codexHooks: true, mode: "apply", yes: true, hookDigest: digest });
  });

  it.each([
    [["setup", "--codex-hooks"], "exactly one of --check, --plan, or --apply"],
    [["setup", "--codex-hooks", "--apply", "--yes"], "--hook-digest"],
    [["setup", "--codex-hooks", "--plan", "--hook-digest", "a".repeat(64)], "--hook-digest"],
    [["setup", "--hook-digest", "a".repeat(64)], "--codex-hooks"],
    [["setup", "--codex-hooks", "--apply", "--yes", "--hook-digest", "bad"], "64 hexadecimal"]
  ] as const)("rejects unsafe or incomplete arguments: %j", (args, message) => {
    const result = parseCliArgs(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it("leaves generic setup --yes unrelated to hook approval", () => {
    const result = parseCliArgs(["setup", "--yes"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ command: "setup", yes: true });
      expect(result.value).not.toHaveProperty("codexHooks", true);
    }
  });

  it("documents the isolated hook flow and its digest gate", () => {
    const help = getHelpText("setup");
    expect(help).toContain("--codex-hooks");
    expect(help).toContain("--hook-digest");
    expect(help).toContain("không bao giờ cài đặt công cụ hoặc dịch vụ");
    const reference = CLI_COMMAND_REFERENCE.find(entry => entry.command === "setup");
    expect(reference?.optionalFlags).toContain("--hook-digest <sha256>");
    expect(renderCommandReferenceMarkdown()).toContain("--codex-hooks (--check|--plan|--apply)");
  });
  it("accepts explicit all-hook trust without a snapshot digest", () => {
    const parsed = parseCliArgs(["setup", "--codex-hooks", "--apply", "--trust-all", "--yes"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toMatchObject({ trustAllHooks: true, yes: true });
  });
  it.each([
    ["setup", "--trust-all", "--yes"],
    ["setup", "--codex-hooks", "--plan", "--trust-all"],
    ["setup", "--codex-hooks", "--apply", "--trust-all", "--hook-digest", "a".repeat(64)],
    ["setup", "--codex-hooks", "--apply", "--trust-all", "--revoke-trust-all"]
  ].map(args => ({ args })))("rejects misplaced/conflicting all-hook policy flags: %j", ({ args }) => {
    expect(parseCliArgs(args).ok).toBe(false);
  });
  it.each([
    ["--trust-all", "'--trust-all' is valid only with 'setup --codex-hooks --apply'."],
    ["--revoke-trust-all", "'--revoke-trust-all' is valid only with 'setup --codex-hooks --apply'."]
  ] as const)("names the misplaced policy flag %s outside --apply", (flag, message) => {
    const result = parseCliArgs(["setup", "--codex-hooks", "--plan", flag]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe(message);
    const check = parseCliArgs(["setup", "--codex-hooks", "--check", flag, "--yes"]);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.message).toBe(message);
    const yesOnly = parseCliArgs(["setup", "--codex-hooks", "--plan", "--yes"]);
    if (!yesOnly.ok) expect(yesOnly.error.message).toBe("'--yes' and '--hook-digest' are valid only with 'setup --codex-hooks --apply'.");
    expect(yesOnly.ok).toBe(false);
  });

});
