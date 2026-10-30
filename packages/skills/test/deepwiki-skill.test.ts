import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASELINE_COMMANDS, RoleSkillBindingsSchema, loadSkillCatalog, readBundle, resolveRoleSkillSelections } from "../src/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const library = join(root, "skills");
const ROLES = ["specifier", "architect", "planner", "developer", "reviewer", "qa"] as const;

/** Historical records are left exactly as they were written; only current documentation is checked. */
const HISTORICAL_DIRECTORIES = ["docs/audits", "docs/superpowers", "docs/main-updates", "docs/acceptance"];
const isHistorical = (path: string) => HISTORICAL_DIRECTORIES.some(directory => path === directory || path.startsWith(`${directory}/`)) ||
  /^docs\/main-updates-[^/]*\.md$/.test(path) || /AUDIT/.test(path);

async function currentDocuments(): Promise<string[]> {
  const found = ["README.md", "skills/README.md", "apps/cli/README.md", "apps/cli/COMMAND_REFERENCE.md", "apps/cli/docs/command-reference.md",
    "apps/web/PROJECT-MANAGEMENT.md", "packages/docs-retrieval/README.md"];
  for (const entry of await readdir(join(root, "docs"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    found.push(relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"));
  }
  return found.filter(path => existsSync(join(root, path)) && !isHistorical(path));
}

describe("DeepWiki integration", () => {
  it("skill catalog pins and role bindings are consistent", async () => {
    expect(existsSync(join(library, "tooling/use-deepwiki/SKILL.md"))).toBe(true);
    expect(existsSync(join(library, "tooling/use-deepwiki/skill.json"))).toBe(true);
    expect(existsSync(join(library, "tooling/use-deepwiki/worked-example.md"))).toBe(true);

    const catalog = await loadSkillCatalog(library, { source: "builtin", supportedCommands: BASELINE_COMMANDS });
    const ids = catalog.map(entry => entry.definition.skillId);
    expect(ids).toContain("use-deepwiki");
    expect(ids).not.toContain("use-context7");
    const skill = catalog.find(entry => entry.definition.skillId === "use-deepwiki")!;
    expect([...skill.definition.allowedRoles].sort()).toEqual([...ROLES].sort());
    const text = await readFile(join(library, "tooling/use-deepwiki/SKILL.md"), "utf8");
    for (const required of ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure", "https://mcp.deepwiki.com/mcp", "owner/repo", "bflow docs"])
      expect(text).toContain(required);
    expect(text).not.toMatch(/ask_question\b/);
    expect(text).not.toMatch(/API key|resolve-library-id|query-docs/i);
    // The skill only documents commands the CLI supports.
    expect([...BASELINE_COMMANDS]).toEqual(expect.arrayContaining(["docs ask", "docs structure", "docs contents", "docs status"]));
    expect([...BASELINE_COMMANDS]).not.toContain("docs lookup");
    expect([...BASELINE_COMMANDS]).not.toContain("docs search");

    const bindingsText = (await readBundle(library))["roles/bindings.json"]!;
    expect(bindingsText).not.toMatch(/context7/i);
    const parsed = RoleSkillBindingsSchema.parse(JSON.parse(bindingsText));
    for (const role of ROLES) {
      const withGrant = resolveRoleSkillSelections({ bindings: parsed.bindings, conditionalBindings: parsed.conditionalBindings, role,
        catalog: catalog.map(entry => entry.definition), grantedToolIds: ["deepwiki"] });
      const selected = withGrant.find(selection => selection.skill.skillId === "use-deepwiki");
      expect(selected, role).toBeDefined();
      // The pin carried into a launch is the catalog's own identity, digest included.
      expect(selected!.skill).toEqual({ skillId: "use-deepwiki", version: skill.definition.version, digest: skill.definition.digest });
      expect(selected!.skill.digest).toMatch(/^[a-f0-9]{64}$/);
      const withoutGrant = resolveRoleSkillSelections({ bindings: parsed.bindings, conditionalBindings: parsed.conditionalBindings, role,
        catalog: catalog.map(entry => entry.definition), grantedToolIds: [] });
      expect(withoutGrant.map(selection => selection.skill.skillId), role).not.toContain("use-deepwiki");
    }
    // Every role that could use the legacy skill is bound to the replacement, and the condition names the DeepWiki tool.
    const bound = Object.entries(parsed.conditionalBindings).filter(([, entries]) => entries.some(entry => entry.skillId === "use-deepwiki")).map(([role]) => role).sort();
    expect(bound).toEqual([...ROLES].sort());
    expect(Object.values(parsed.conditionalBindings).flat().filter(entry => entry.skillId === "use-deepwiki").every(entry => entry.toolId === "deepwiki")).toBe(true);
    for (const role of ROLES) expect(parsed.bindings[role], role).toContain("use-deepwiki");
  });

  it("current docs reference DeepWiki and Context7 only in migration history", async () => {
    const documents = await currentDocuments();
    expect(documents).toEqual(expect.arrayContaining(["README.md", "docs/setup-guide.md", "docs/shared-mcp-architecture.md", "apps/cli/README.md", "packages/docs-retrieval/README.md"]));
    for (const path of ["README.md", "docs/setup-guide.md", "docs/shared-mcp-architecture.md", "apps/cli/README.md", "packages/docs-retrieval/README.md", "skills/README.md"])
      expect(await readFile(join(root, path), "utf8"), path).toContain("DeepWiki");

    const stale: string[] = [];
    for (const path of documents) {
      (await readFile(join(root, path), "utf8")).split("\n").forEach((line, index) => {
        if (/context7/i.test(line) && !/migrat|legacy|history|historical|replac|formerly|previously|backup/i.test(line)) stale.push(`${path}:${index + 1}`);
        if (/\bask_question\b|resolve-library-id|query-docs/.test(line) && !/migrat|legacy|history|historical|replac|formerly|previously/i.test(line)) stale.push(`${path}:${index + 1}`);
      });
    }
    expect(stale).toEqual([]);

    // The historical audits stay exactly as they were written.
    const audits = join(root, "docs/audits");
    if (existsSync(audits)) expect((await readdir(audits)).length).toBeGreaterThan(0);
  });
});
