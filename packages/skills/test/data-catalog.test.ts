import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_ROLES } from "@bflow/contracts";
import {
  BASELINE_COMMANDS, bindRoleSkills, bundleDigest, loadSkillCatalog, readBundle,
  RoleSkillBindingsSchema, SkillFileStore, SkillManager,
} from "../src/index.js";

const library = fileURLToPath(new URL("../../../skills", import.meta.url));
const dataSkills = ["data-pipeline", "data-contract", "dbt-verification"];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const load = () => loadSkillCatalog(library, { source: "builtin", supportedCommands: BASELINE_COMMANDS });

describe("optional data verification catalog", () => {
  it("makes data instructions selectable through exact existing-role pins without changing defaults or tool authority", async () => {
    const catalog = await load();
    const defaults = RoleSkillBindingsSchema.parse(JSON.parse((await readBundle(library))["roles/bindings.json"]!));
    const definitions = catalog.map(entry => entry.definition);
    for (const id of dataSkills) {
      const entry = catalog.find(candidate => candidate.definition.skillId === id);
      expect(entry, `Missing task-specific data skill ${id}`).toBeDefined();
      const definition = entry!.definition;
      expect(definition.version).toBe("1.0.0");
      expect(definition.instructionOnly).toBe(true);
      expect(definition.requiredToolIds).toEqual([]);
      expect(definition.requiredCapabilityIds).toEqual([]);
      expect(definition.dependencies).toEqual([]);
      expect(definition.allowedRoles.every(role => AGENT_ROLES.includes(role))).toBe(true);
      expect(definition.allowedRoles).not.toContain("conversation");
      expect(definition.supportedProviders).toEqual(["claude", "codex", "agy"]);
      expect(bundleDigest(entry!.files)).toBe(definition.digest);
      expect(entry!.files["worked-example.md"]).toBeDefined();
      const selections = bindRoleSkills({ qa: [id] }, "qa", definitions);
      expect(selections).toEqual([{ skill: { skillId: id, version: "1.0.0", digest: definition.digest }, required: true }]);
      expect(() => bindRoleSkills({ conversation: [id] }, "conversation", definitions)).toThrow(/Role skill forbidden/);
      for (const role of AGENT_ROLES) expect(defaults.bindings[role]).not.toContain(id);
    }
  });

  it("publishes exact reviewed data resources across all providers and rejects modified example bytes under the approved pin", async () => {
    const entries = (await load()).filter(entry => dataSkills.includes(entry.definition.skillId));
    expect(entries).toHaveLength(3);
    const root = await realpath(await mkdtemp(join(tmpdir(), "data-skills-")));
    roots.push(root);
    const manager = new SkillManager({ store: new SkillFileStore(join(root, "store")), supportedCommands: BASELINE_COMMANDS,
      approvedBuiltinDigests: entries.map(entry => entry.definition.digest) });
    for (const entry of entries) {
      await manager.installBundle(entry.files, { source: "builtin", expectedDigest: entry.definition.digest });
      await expect(manager.installBundle({ ...entry.files, "worked-example.md": entry.files["worked-example.md"] + "\nChanged threshold without review.\n" },
        { source: "builtin", expectedDigest: entry.definition.digest })).rejects.toThrow(/digest does not match approved pin/);
    }
    for (const provider of ["claude", "codex", "agy"] as const) {
      const { manifest, rendered } = await manager.sync({ manifestId: `data-${provider}`, environmentId: "data-fixture",
        scope: { kind: "session", machineId: "machine-fixture", repositoryId: "repo-fixture", workspaceRoot: "/fixture", sessionId: "data" },
        role: "qa", provider, selections: bindRoleSkills({ qa: dataSkills }, "qa", entries.map(entry => entry.definition)),
        capabilityIds: [], toolIds: [] });
      expect(manifest.skills.map(skill => skill.skillId).sort()).toEqual([...dataSkills].sort());
      expect(manifest.bindings.every(binding => binding.role === "qa" && binding.provider === provider)).toBe(true);
      for (const entry of entries) {
        const published = rendered.references.find(reference => reference.name === entry.definition.skillId)!;
        expect(published.digest).toBe(entry.definition.digest);
        const resources = await readBundle(published.entrypoint.slice(0, -"/SKILL.md".length));
        expect(resources["worked-example.md"]).toBe(entry.files["worked-example.md"]);
        expect(await readFile(published.entrypoint, "utf8")).toBe(entry.files["SKILL.md"]);
      }
    }
  });
});
