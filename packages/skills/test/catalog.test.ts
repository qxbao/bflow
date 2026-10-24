import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_ROLES } from "@bflow/contracts";
import {
  SkillManager,
  SkillFileStore,
  loadSkillCatalog,
  bindRoleSkills,
  resolveRoleSkillSelections,
  RoleSkillBindingsSchema,
  readBundle,
  BASELINE_COMMANDS,
} from "../src/index.js";
import { files } from "./fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const shared = [
  "using-bflow",
  "inspect-repository",
  "understand-task",
  "specification-driven-development",
  "conditional-tdd",
  "implement-task",
  "run-verification",
  "analyze-failure",
  "review-code",
  "fix-review-findings",
  "use-git-worktree",
  "integrate-changes",
  "use-gitnexus",
  "use-rtk",
  "use-mempalace",
  "use-context7",
  "browser-inspection",
  "mcp-tool-discovery",
  "report-task-result",
  "escalate-blocker",
  "recover-execution",
];
describe("canonical role catalog", () => {
  it("selects tool skills only when the matching host grant exists", async () => {
    const library = fileURLToPath(new URL("../../../skills", import.meta.url));
    const catalog = await loadSkillCatalog(library, {
      source: "builtin",
      supportedCommands: BASELINE_COMMANDS,
    });
    const raw = JSON.parse((await readBundle(library))["roles/bindings.json"]!);
    const parsed = RoleSkillBindingsSchema.parse(raw);
    const common = {
      bindings: parsed.bindings,
      conditionalBindings: parsed.conditionalBindings,
      role: "developer" as const,
      catalog: catalog.map((entry) => entry.definition),
    };

    const withoutGrant = resolveRoleSkillSelections({ ...common, grantedToolIds: [] });
    expect(withoutGrant.map((selection) => selection.skill.skillId)).not.toContain("use-mempalace");

    const withGrant = resolveRoleSkillSelections({ ...common, grantedToolIds: ["mempalace"] });
    expect(withGrant.map((selection) => selection.skill.skillId)).toContain("use-mempalace");
    expect(() => resolveRoleSkillSelections({ ...common, conditionalBindings: { developer: [
      { toolId: "mempalace", skillId: "missing-pin", required: false }
    ] }, grantedToolIds: [] })).toThrow(/Missing or forbidden conditional skill pin/);
  });
  it("ships all shared skills and resolves all ten roles identically across three providers", async () => {
    const library = fileURLToPath(new URL("../../../skills", import.meta.url));
    const loaded = await loadSkillCatalog(library, {
      source: "builtin",
      supportedCommands: BASELINE_COMMANDS,
    });
    expect(loaded).toHaveLength(33);
    expect(loaded.map((s) => s.definition.skillId)).toEqual(
      expect.arrayContaining(shared),
    );
    const bindings = RoleSkillBindingsSchema.parse(
      JSON.parse((await readBundle(library))["roles/bindings.json"]!),
    );
    expect(Object.keys(bindings.bindings).sort()).toEqual(
      [...AGENT_ROLES].sort(),
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-catalog-")));
    roots.push(root);
    const manager = new SkillManager({
      store: new SkillFileStore(join(root, "store")),
      supportedCommands: BASELINE_COMMANDS,
      approvedBuiltinDigests: loaded.map((s) => s.definition.digest),
    });
    for (const s of loaded)
      await manager.installBundle(s.files, {
        source: "builtin",
        expectedDigest: s.definition.digest,
      });
    for (const role of AGENT_ROLES) {
      let prior: string[] | undefined;
      for (const provider of ["claude", "codex", "agy"] as const) {
        const selections = bindRoleSkills(
          bindings.bindings,
          role,
          loaded.map((s) => s.definition),
        );
        const { manifest, rendered } = await manager.sync({
          manifestId: `${role}-${provider}`,
          environmentId: "env",
          scope: {
            kind: "session",
            machineId: "m",
            repositoryId: "r",
            workspaceRoot: "/repo",
            sessionId: "s",
          },
          role,
          provider,
          selections,
          capabilityIds: [],
          toolIds: ["rtk", "gitnexus", "mempalace", "browser"],
        });
        const ids = manifest.skills.map((s) => s.skillId);
        if (prior) expect(ids).toEqual(prior);
        prior = ids;
        expect(ids).toEqual(expect.arrayContaining(bindings.bindings[role]!));
        expect(rendered.references).toHaveLength(selections.length);
        // The actual role/provider reference must publish the reviewed NFR resource,
        // not only advertise a skill name in its manifest.
        if (role === "specifier") {
          for (const [name, resource] of [
            ["requirements-analysis", "nfr-clarification.md"],
            ["specification-driven-development", "nfr-examples.md"],
          ] as const) {
            const reference = rendered.references.find((entry) => entry.name === name)!;
            const published = await readBundle(dirname(reference.entrypoint));
            const canonical = loaded.find((entry) => entry.definition.skillId === name)!;
            expect(canonical.definition.version).toBe("1.0.1");
            expect(published[resource]).toBeDefined();
            expect(published[resource]).toBe(canonical.files[resource]);
            expect(reference.digest).toBe(canonical.definition.digest);
          }
        }
        expect(rendered.instructionText).not.toContain("## Procedure");
        expect(rendered.instructionText).toContain("Bflow Conditional TDD");
        if (role !== "conversation")
          expect(rendered.instructionText).toContain(
            "disable native direct questions",
          );
      }
    }
  }, 60000);
  it("rejects duplicate names, unknown references and forbidden role binding", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "skills-duplicate-")));
    roots.push(root);
    for (const sub of ["first", "second"]) {
      await mkdir(join(root, sub));
      for (const [p, c] of Object.entries(files()))
        await writeFile(join(root, sub, p), c);
    }
    await expect(
      loadSkillCatalog(root, {
        source: "builtin",
        supportedCommands: ["status"],
      }),
    ).rejects.toThrow(/Duplicate skill name/);
    const catalog = await loadSkillCatalog(
      fileURLToPath(new URL("../../../skills", import.meta.url)),
      { source: "builtin", supportedCommands: BASELINE_COMMANDS },
    );
    expect(() =>
      bindRoleSkills(
        { developer: ["absent"] },
        "developer",
        catalog.map((s) => s.definition),
      ),
    ).toThrow(/Missing/);
    expect(() =>
      bindRoleSkills(
        { conversation: ["implement-task"] },
        "conversation",
        catalog.map((s) => s.definition),
      ),
    ).toThrow(/forbidden/);
  });
});
