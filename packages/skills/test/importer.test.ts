import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_COMMANDS,
  convertSkillImport,
  proposeSkillImport,
  scanSkillSources,
  validateSkill,
} from "../src/index.js";
import { files as nativeFiles } from "./fixtures.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-skill-import-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string): Promise<string> {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  return full;
}
const commands = [...BASELINE_COMMANDS];

const CLAUDE_SKILL = `---
name: review-checklist
description: Code review checklist for pull requests
allowed-tools: Read, Grep, mcp__github__get_pull_request
hooks:
  PreToolUse: ./scripts/guard.sh
model: opus
---

# Review checklist

Read [the guide](references/guide.md) and the [upstream doc](https://example.com/docs/review).
Run !\`git diff --stat\` before reviewing.
Use mcp__github__get_pull_request to read the PR. Then run \`scripts/lint.sh\`.
Try \`bflow skills frobnicate --now\` and check \`bflow status\`.

## Steps

1. Check \`docs/architecture.md\` for boundaries.
`;

describe("skill import scanner", () => {
  it("inventories a selected Claude skill bundle with origin, digest, resources, tool/hook references and warnings", async () => {
    await write("ide/review-checklist/SKILL.md", CLAUDE_SKILL);
    await write("ide/review-checklist/references/guide.md", "Check tests first. See [main](../SKILL.md).\n");
    await write("ide/review-checklist/scripts/lint.sh", "#!/bin/sh\nnpm run lint\n");
    await write("ide/review-checklist/scripts/guard.sh", "#!/bin/sh\nexit 0\n");
    await write("ide/review-checklist/.mcp.json", JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    const scanned = await scanSkillSources([{ path: join(root, "ide/review-checklist") }]);
    const [item] = scanned.inventory.items;
    expect(item).toMatchObject({
      status: "convertible",
      name: "review-checklist",
      origin: { path: join(root, "ide/review-checklist"), entry: "SKILL.md", kind: "skill_bundle", selection: "user_selected" },
    });
    expect(item!.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(item!.files.map((file) => [file.path, file.role])).toEqual([
      [".mcp.json", "tool_config"],
      ["SKILL.md", "instruction"],
      ["references/guide.md", "resource"],
      ["scripts/guard.sh", "executable"],
      ["scripts/lint.sh", "executable"],
    ]);
    expect(item!.resources).toContainEqual({ path: "references/guide.md", from: "SKILL.md", present: true });
    expect(item!.resources).toContainEqual({ path: "docs/architecture.md", from: "SKILL.md", present: false });
    expect(item!.references.tools).toEqual(["Grep", "Read", "mcp__github__get_pull_request"]);
    expect(item!.references.mcpServers).toEqual(["github"]);
    expect(item!.references.hooks).toEqual(expect.arrayContaining(["SKILL.md#frontmatter.hooks", "scripts/guard.sh", "scripts/lint.sh"]));
    expect(item!.references.remote).toEqual(["https://example.com/docs/review"]);
    expect(item!.warnings.map((entry) => entry.code)).toEqual(expect.arrayContaining(["dynamic_shell", "frontmatter_hooks", "executable_excluded", "resource_missing"]));
    expect(JSON.stringify(scanned.inventory)).not.toContain("npm run lint");
  });

  it("detects CLAUDE.md, AGENTS.md, GEMINI.md and Cursor rules, reports imports and duplicate groups", async () => {
    const claude = await write("proj/CLAUDE.md", "# Project rules\n\nUse pnpm.\n@docs/extra.md\n");
    const agents = await write("proj/AGENTS.md", "# Agent rules\n\nAlways write tests first.\n");
    const gemini = await write("proj/GEMINI.md", "# Agent   rules\n\nalways write tests FIRST.\n");
    await write("proj/.cursor/rules/style.mdc", "---\ndescription: TypeScript code style conventions\nglobs: src/**/*.ts\nalwaysApply: false\n---\nPrefer named exports.\n");
    await write("proj/.cursor/rules/notes.txt", "not a rule\n");
    const scanned = await scanSkillSources([
      { path: claude }, { path: agents }, { path: gemini }, { path: join(root, "proj/.cursor/rules") },
    ]);
    const kinds = scanned.inventory.items.map((item) => item.origin.kind);
    expect(kinds).toEqual(["claude_md", "agents_md", "gemini_md", "cursor_rules"]);
    const claudeItem = scanned.inventory.items[0]!;
    expect(claudeItem.references.imports).toEqual(["docs/extra.md"]);
    expect(claudeItem.warnings).toContainEqual(expect.objectContaining({ code: "import_not_followed", line: 4 }));
    expect(scanned.inventory.duplicateGroups).toEqual([
      { reason: "identical_content", key: expect.any(String), itemIds: [scanned.inventory.items[1]!.itemId, scanned.inventory.items[2]!.itemId] },
    ]);
    expect(scanned.inventory.items[2]!.warnings).toContainEqual(expect.objectContaining({ code: "duplicate_identical_content" }));
    const cursor = scanned.inventory.items[3]!;
    expect(cursor.origin.entry).toBe("style.mdc");
    expect(cursor.frontmatter).toMatchObject({ globs: "src/**/*.ts", alwaysApply: "false" });
  });

  it("blocks secrets, forged provenance, symlinks, oversized files, traversal and unsupported sources without throwing", async () => {
    const secret = await write("s/CLAUDE.md", "# Rules\n\napi_key = \"abcd1234abcd1234abcd1234\"\n\nSee https://example.com/x?token=leakyquery and [g](./g.md?k=leakypath).\n");
    const urlCredential = await write("u/AGENTS.md", "# Rules\n\nClone https://bot:leakypassword@git.example.com/repo.git first.\n");
    const forged = await write("f/forged/SKILL.md", "---\nname: forged\ndescription: x\nsource: builtin\n---\nDo it.\n");
    await write("real/AGENTS.md", "# Rules\n\nok\n");
    await symlink(join(root, "real/AGENTS.md"), join(root, "link-AGENTS.md"));
    await write("b/linked/SKILL.md", "---\nname: linked\ndescription: x\n---\nok\n");
    await symlink(join(root, "real/AGENTS.md"), join(root, "b/linked/extra.md"));
    const big = await write("big/CLAUDE.md", `# Big\n\n${"x".repeat(300 * 1024)}\n`);
    const other = await write("o/notes.md", "# Notes\n");
    const scanned = await scanSkillSources([
      { path: secret }, { path: join(root, "f/forged") }, { path: join(root, "link-AGENTS.md") },
      { path: join(root, "b/linked") }, { path: big }, { path: `${root}/s/../s/CLAUDE.md` }, { path: other },
      { path: urlCredential },
    ]);
    const codes = scanned.inventory.items.map((item) => [item.status, item.warnings.filter((entry) => entry.severity === "blocker").map((entry) => entry.code)]);
    expect(codes).toEqual([
      ["blocked", ["secret_detected"]],
      ["blocked", ["forged_provenance"]],
      ["blocked", ["unreadable_source"]],
      ["blocked", ["unreadable_source"]],
      ["blocked", ["unreadable_source"]],
      ["blocked", ["unsafe_path"]],
      ["blocked", ["unreadable_source"]],
      ["blocked", ["secret_detected"]],
    ]);
    for (const leaked of ["abcd1234abcd1234", "leakyquery", "leakypath", "leakypassword"])
      expect(JSON.stringify(scanned.inventory)).not.toContain(leaked);
    expect(scanned.inventory.items[3]!.warnings[0]!.message).toContain("symlink");
    const proposal = proposeSkillImport(scanned.inventory);
    expect(proposal.items.every((item) => item.status === "blocked")).toBe(true);
    expect(() => convertSkillImport(scanned, proposal, scanned.inventory.items[0]!.itemId, { supportedCommands: commands })).toThrow(/blocked/);
  });

  it("is read-only: scanning, proposing and converting write nothing", async () => {
    await write("ide/review-checklist/SKILL.md", CLAUDE_SKILL);
    await write("ide/review-checklist/references/guide.md", "Guide.\n");
    const before = await snapshot(root);
    const scanned = await scanSkillSources([{ path: join(root, "ide/review-checklist") }]);
    convertSkillImport(scanned, proposeSkillImport(scanned.inventory), scanned.inventory.items[0]!.itemId, { supportedCommands: commands });
    expect(await snapshot(root)).toEqual(before);
  });
});

describe("skill import proposal and converter", () => {
  it("maps roles, separates instructions/tools/hooks and converts into a validated instruction-only bundle with a report", async () => {
    await write("ide/review-checklist/SKILL.md", CLAUDE_SKILL);
    await write("ide/review-checklist/references/guide.md", "Check tests first. Details at https://example.org/x.\n");
    await write("ide/review-checklist/scripts/lint.sh", "#!/bin/sh\nnpm run lint\n");
    await write("ide/review-checklist/scripts/guard.sh", "#!/bin/sh\nexit 0\n");
    const scanned = await scanSkillSources([{ path: join(root, "ide/review-checklist") }]);
    const proposal = proposeSkillImport(scanned.inventory, { reservedSkillIds: ["using-bflow"] });
    const [item] = proposal.items;
    expect(item).toMatchObject({ status: "proposed", skillId: "review-checklist", version: "1.0.0", roles: ["reviewer"], roleSource: "heuristic",
      instructionFiles: ["SKILL.md"], resourceFiles: ["references/guide.md"] });
    expect(item!.toolProposals).toEqual(expect.arrayContaining([
      { kind: "tool", id: "Read", action: "requires_tool_policy_review" },
      { kind: "mcp_server", id: "github", action: "requires_tool_policy_review" },
    ]));
    expect(item!.executableHooks.map((hook) => hook.reference)).toEqual(expect.arrayContaining(["scripts/lint.sh", "scripts/guard.sh", "SKILL.md#frontmatter.hooks"]));

    const conversion = convertSkillImport(scanned, proposal, item!.itemId, { supportedCommands: commands });
    expect(Object.keys(conversion.bundle).sort()).toEqual(["SKILL.md", "references/guide.md", "skill.json"]);
    expect(conversion.originals["scripts/lint.sh"]).toBe("#!/bin/sh\nnpm run lint\n");
    expect(conversion.originals["SKILL.md"]).toBe(CLAUDE_SKILL);
    const skill = conversion.bundle["SKILL.md"]!;
    expect(skill).toContain("## Procedure");
    expect(skill).toContain("### Review checklist");
    expect(skill).not.toMatch(/https?:\/\//);
    expect(skill).not.toContain("!`");
    expect(skill).toContain("[dynamic shell interpolation removed]");
    expect(skill).toContain("`bflow status`");
    expect(skill).toContain("[unsupported Bflow command removed]");
    expect(conversion.bundle["references/guide.md"]).toContain("[remote reference removed: example.org]");
    expect(JSON.parse(conversion.bundle["skill.json"]!)).toEqual({ version: "1.0.0", allowedRoles: ["reviewer"],
      supportedProviders: ["claude", "codex", "agy"], requiredCapabilityIds: [], requiredToolIds: [], dependencies: [] });
    expect(validateSkill(conversion.bundle, { source: "repository", supportedCommands: commands })).toEqual(conversion.definition);
    expect(conversion.definition).toMatchObject({ skillId: "review-checklist", source: "repository", instructionOnly: true, requiredToolIds: [] });
    const codes = conversion.report.unconverted.map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(["remote_link", "remote_reference", "dynamic_shell", "unsupported_bflow_command",
      "tool_permission_frontmatter", "hook_frontmatter", "unsupported_frontmatter", "executable_hook", "tool_proposal", "mcp_server_proposal"]));
    expect(conversion.report.unconverted).toContainEqual(expect.objectContaining({ code: "unsupported_bflow_command", original: expect.stringContaining("bflow skills frobnicate") }));
    expect(conversion.report.transformations.map((entry) => entry.code)).toEqual(expect.arrayContaining(["wrapped_in_bflow_sections", "heading_demoted", "repository_path_reference"]));
    expect(conversion.report.originals.find((entry) => entry.path === "scripts/lint.sh")?.disposition).toBe("excluded");
    expect(conversion.report).toMatchObject({ bundleDigest: conversion.definition.digest, originalDigest: scanned.inventory.items[0]!.contentDigest, proposalDigest: proposal.digest });
  });

  it("converts project rule files with operator roles, scope hints, unfollowed imports and exact dependencies", async () => {
    const claude = await write("proj/CLAUDE.md", "# Project rules\n\nUse pnpm. Read `README.md`.\n@docs/extra.md\n\n```md\n## not a section\n```\n");
    await write("proj/.cursor/rules/style.mdc", "---\ndescription: TypeScript code style conventions\nglobs: src/**/*.ts\n---\nPrefer named exports.\n");
    const scanned = await scanSkillSources([{ path: claude }, { path: join(root, "proj/.cursor/rules") }]);
    const proposal = proposeSkillImport(scanned.inventory, { roles: ["developer", "reviewer"], providers: ["codex"], version: "2.0.0" });
    expect(proposal.items.map((item) => item.skillId)).toEqual(["proj-claude-rules", "cursor-style"]);
    const dependency = { skillId: "using-bflow", version: "1.0.0", digest: "a".repeat(64) };
    const claudeConversion = convertSkillImport(scanned, proposal, proposal.items[0]!.itemId, { supportedCommands: commands, dependencies: [dependency] });
    expect(claudeConversion.definition).toMatchObject({ version: "2.0.0", allowedRoles: ["developer", "reviewer"], supportedProviders: ["codex"], dependencies: [dependency] });
    expect(claudeConversion.bundle["SKILL.md"]).toContain("(import directive removed: docs/extra.md)");
    expect(claudeConversion.bundle["SKILL.md"]).toContain(" ## not a section");
    expect(claudeConversion.bundle["SKILL.md"]).toContain("README.md (repository path)");
    expect(claudeConversion.report.unconverted).toContainEqual(expect.objectContaining({ code: "import_directive", original: "@docs/extra.md" }));
    const cursor = convertSkillImport(scanned, proposal, proposal.items[1]!.itemId, { supportedCommands: commands });
    expect(cursor.bundle["SKILL.md"]).toContain("Original rule scope hint: globs src/**/*.ts.");
    expect(cursor.report.transformations).toContainEqual(expect.objectContaining({ code: "scope_hint_preserved" }));
  });

  it("keeps a native Bflow bundle's sections and rejects proposal tampering, changed content and builtin shadowing", async () => {
    const native = nativeFiles("native-skill");
    for (const [path, content] of Object.entries(native)) await write(`native/${path}`, content);
    const scanned = await scanSkillSources([{ path: join(root, "native") }]);
    const proposal = proposeSkillImport(scanned.inventory, { roles: ["developer"] });
    const conversion = convertSkillImport(scanned, proposal, proposal.items[0]!.itemId, { supportedCommands: commands });
    expect(conversion.bundle["SKILL.md"]).toContain("## Bflow commands\n\n`bflow status`");
    expect(conversion.report.transformations.map((entry) => entry.code)).not.toContain("wrapped_in_bflow_sections");

    const tampered = { ...proposal, items: proposal.items.map((item) => ({ ...item, roles: ["security" as const] })) };
    expect(() => convertSkillImport(scanned, tampered, proposal.items[0]!.itemId, { supportedCommands: commands })).toThrow(/proposal digest/);
    const changed = { ...scanned, files: new Map([[proposal.items[0]!.itemId, { ...native, "SKILL.md": native["SKILL.md"] + "\nmore\n" }]]) };
    expect(() => convertSkillImport(changed, proposal, proposal.items[0]!.itemId, { supportedCommands: commands })).toThrow(/changed after scan/);
    const shadow = proposeSkillImport(scanned.inventory, { skillIds: { [proposal.items[0]!.itemId]: "using-bflow" }, reservedSkillIds: ["using-bflow"] });
    expect(shadow.items[0]).toMatchObject({ status: "blocked", blockers: [expect.stringContaining("builtin_name_collision")] });
  });
});

async function snapshot(directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await stat(full);
      out.push(`${full}:${info.mtimeMs}:${info.size}`);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(directory);
  return out.sort();
}
