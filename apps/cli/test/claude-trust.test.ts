import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { claudeConfigFile, claudeConfigFiles, ensureClaudeWorkspaceTrust } from "../src/claude-trust.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bflow-claude-trust-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, any>;

it("creates the file and trusts only the repository root", async () => {
  const file = join(dir, ".claude.json");
  expect(await ensureClaudeWorkspaceTrust("/repo", file)).toBe("trusted");
  expect((await read(file)).projects["/repo"].hasTrustDialogAccepted).toBe(true);
});

it("preserves other settings and project fields, and is idempotent", async () => {
  const file = join(dir, ".claude.json");
  await writeFile(file, JSON.stringify({ userID: "u", projects: { "/repo": { allowedTools: ["x"] }, "/other": { hasTrustDialogAccepted: false } } }));
  expect(await ensureClaudeWorkspaceTrust("/repo", file)).toBe("trusted");
  const after = await read(file);
  expect(after.userID).toBe("u");
  expect(after.projects["/repo"]).toEqual({ allowedTools: ["x"], hasTrustDialogAccepted: true });
  expect(after.projects["/other"].hasTrustDialogAccepted).toBe(false);
  expect(await ensureClaudeWorkspaceTrust("/repo", file)).toBe("already_trusted");
});

it("never overwrites a file it cannot parse", async () => {
  const file = join(dir, ".claude.json");
  await writeFile(file, "{not json");
  expect(await ensureClaudeWorkspaceTrust("/repo", file)).toBe("skipped");
  expect(await readFile(file, "utf8")).toBe("{not json");
});

it("honours CLAUDE_CONFIG_DIR and includes ~/.claude/.claude.json when ~/.claude exists", async () => {
  expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe("/c/.claude.json");
  expect(claudeConfigFile({}, "/h")).toBe("/h/.claude.json");
  await mkdir(join(dir, ".claude"), { recursive: true });
  const files = await claudeConfigFiles({ ORCA_CLAUDE_CONFIG_DIR: join(dir, ".orca-claude") }, dir);
  expect(files).toContain(join(dir, ".claude.json"));
  expect(files).toContain(join(dir, ".claude", ".claude.json"));
  expect(files).toContain(join(dir, ".orca-claude", ".claude.json"));
});
