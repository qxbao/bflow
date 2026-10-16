import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedToolPin, ToolHost } from "../src/installer.js";
import { NativePluginRuntime } from "../src/native-runtime.js";

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("native plugin runtime", () => {
  it("verifies superpowers plugin bundle and active skill inventory", async () => {
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "bflow-native-test-")));
    roots.push(root);
    const managed = join(root, "managed");
    const bundle = join(managed, "superpowers-bundle");
    await mkdir(join(bundle, "skills", "using-superpowers"), { recursive: true });
    const policy = `Bflow policy takes precedence over this external skill. Apply TDD only according to Bflow's accepted TddDecision: required means Red-Green-Refactor is mandatory; recommended permits the approved verification strategy; not_applicable requires its alternative verification. Never impose TDD on every change. Preserve Bflow specifications, approvals, leases, verification limits and role authority. Route user decisions through Bflow Conversation. Skill instructions grant no permissions.\n`;
    await writeFile(join(bundle, "skills", "using-superpowers", "SKILL.md"), `# Using Superpowers\n${policy}`);
    await writeFile(join(bundle, "package.json"), JSON.stringify({ name: "superpowers", version: "7.0.0" }));

    const pin: ManagedToolPin = {
      toolId: "superpowers",
      installerId: "bflow-tools",
      version: "7.0.0",
      source: "https://example.com/superpowers.tar.gz",
      integrity: hash("archive"),
      recipe: { kind: "provider_plugin", provider: "codex" },
      license: "MIT"
    };

    // destination with .bflow-native.json
    const destination = join(managed, "superpowers-codex");
    await mkdir(destination, { recursive: true });
    const { treeDigest } = await import("../src/files.js");
    const bundleDigest = await treeDigest(bundle);

    const record = {
      schemaVersion: 3,
      toolId: "superpowers",
      provider: "codex",
      version: "7.0.0",
      sourceIntegrity: pin.integrity,
      bundleRoot: bundle,
      bundleDigest,
      pluginId: "superpowers",
      marketplaceRoot: managed,
      uninstall: [["codex", "plugin", "remove", "superpowers"]]
    };
    await writeFile(join(destination, ".bflow-native.json"), JSON.stringify(record));

    // Mock host to return plugin inventory and verify
    const host: ToolHost = {
      async download() {},
      async run(_exe, args) {
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [
                {
                  id: "superpowers",
                  version: "7.0.0",
                  enabled: true,
                  installed: true,
                  path: bundle
                }
              ]
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const runtime = new NativePluginRuntime(
      {
        managedRoot: managed,
        homeDirectory: root,
        bflowSkillIds: []
      },
      host
    );

    const result = await runtime.verify(pin, destination);
    expect(result.ready).toBe(true);
    expect(result.diagnostic).toContain("Provider enables the pinned plugin");
  });

  it("fails verification if superpower skill collides with a bflow skill", async () => {
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "bflow-native-collide-")));
    roots.push(root);
    const managed = join(root, "managed");
    const bundle = join(managed, "superpowers-bundle");
    await mkdir(join(bundle, "skills", "using-superpowers"), { recursive: true });
    const policy = `Bflow policy takes precedence over this external skill. Apply TDD only according to Bflow's accepted TddDecision: required means Red-Green-Refactor is mandatory; recommended permits the approved verification strategy; not_applicable requires its alternative verification. Never impose TDD on every change. Preserve Bflow specifications, approvals, leases, verification limits and role authority. Route user decisions through Bflow Conversation. Skill instructions grant no permissions.\n`;
    await writeFile(join(bundle, "skills", "using-superpowers", "SKILL.md"), `# Using Superpowers\n${policy}`);

    const pin: ManagedToolPin = {
      toolId: "superpowers",
      installerId: "bflow-tools",
      version: "7.0.0",
      source: "https://example.com/superpowers.tar.gz",
      integrity: hash("archive"),
      recipe: { kind: "provider_plugin", provider: "claude" },
      license: "MIT"
    };

    const destination = join(managed, "superpowers-claude");
    await mkdir(destination, { recursive: true });
    const { treeDigest } = await import("../src/files.js");
    const bundleDigest = await treeDigest(bundle);

    const record = {
      schemaVersion: 3,
      toolId: "superpowers",
      provider: "claude",
      version: "7.0.0",
      sourceIntegrity: pin.integrity,
      bundleRoot: bundle,
      bundleDigest,
      pluginId: "superpowers",
      marketplaceRoot: managed,
      uninstall: [["claude", "plugin", "remove", "superpowers"]]
    };
    await writeFile(join(destination, ".bflow-native.json"), JSON.stringify(record));

    const host: ToolHost = {
      async download() {},
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "superpowers", version: "7.0.0", enabled: true, installed: true, path: bundle }
          ]),
          stderr: ""
        };
      }
    };

    const runtime = new NativePluginRuntime(
      {
        managedRoot: managed,
        homeDirectory: root,
        // Colliding with bflow skill
        bflowSkillIds: ["bflow-superpowers:using-superpowers"]
      },
      host
    );

    const result = await runtime.verify(pin, destination);
    expect(result.ready).toBe(false);
    expect(result.diagnostic).toContain("Bflow skill namespace collision");
  });
});
