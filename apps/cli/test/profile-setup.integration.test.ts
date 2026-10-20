import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSetupPlan,
  defaultMachineConfig,
  ToolInstallerRegistry,
  type CommandRunner,
  type PlatformProfile,
  type SetupComponent,
  type SetupContext
} from "@bflow/machine-setup";
import { ProfileSetupComponent } from "../src/profile-setup.js";

const helperPath = path.resolve(import.meta.dirname, "../isolation/lib/profile_sync.py");
let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function pythonRunner(): CommandRunner {
  return {
    run: async (argv, options) => {
      const result = spawnSync(argv[0]!, argv.slice(1), {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: options?.timeoutMs ?? 120_000
      });
      return {
        exitCode: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
        timedOut: result.error?.code === "ETIMEDOUT"
      };
    }
  };
}

function testPlatform(root: string): PlatformProfile {
  return {
    os: "linux", arch: process.arch, supportStatus: "supported", shell: "bash", shellPath: "/bin/bash",
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    isRoot: false, elevationAvailable: false, homeDir: root, hostname: "profile-sync-test", machineId: "m-profile-sync-test",
    paths: { config: path.join(root, "machine-config"), data: path.join(root, "machine-data"),
      state: path.join(root, "machine-state"), managedBin: path.join(root, "machine-bin") },
    pathEntries: []
  };
}

describe("approved setup plan with the bundled profile synchronizer", () => {
  it("applies source assets created by an earlier approved step, converges, and preserves profile-local state", async () => {
    expect(existsSync(helperPath), `required helper dependency is missing: ${helperPath}`).toBe(true);
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "bflow-profile-plan-"));
    const sourceHome = path.join(tempRoot, "native");
    const codexHome = path.join(sourceHome, ".codex");
    const stateRoot = path.join(tempRoot, "shared-ai-isolator");
    const profileRoot = path.join(stateRoot, "profiles", "codex--work");
    const profileHome = path.join(profileRoot, "home");
    const runner = pythonRunner();
    const nativePaths = [
      path.join(codexHome, "config.toml"),
      path.join(codexHome, "skills", "native-skill", "SKILL.md"),
      path.join(codexHome, "plugins", "cache", "bflow-superpowers", "bflow-superpowers", "7.0.0",
        ".codex-plugin", "plugin.json"),
      path.join(codexHome, "plugins", "cache", "bflow-superpowers", "bflow-superpowers", "7.0.0",
        "skills", "using-superpowers", "SKILL.md")
    ];
    const targetConfig = path.join(profileHome, ".codex", "config.toml");
    const authPath = path.join(profileHome, ".codex", "auth.json");
    const localSkill = path.join(profileHome, ".codex", "skills", "local-skill", "SKILL.md");
    const profileEnv = path.join(profileRoot, "profile.env");
    const receiptPath = path.join(profileRoot, ".bflow-profile-sync.json");
    const authBytes = JSON.stringify({ auth_mode: "fixture", tokens: { access_token: "TEST_PROFILE_TOKEN" } }, null, 2) + "\n";
    const envBytes = "AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=work\nTEST_PROFILE_PRIVATE_ENV=preserve\n";
    const initialConfig = 'model = "profile-model"\n\n[mcp_servers.local]\ncommand = "/usr/bin/true"\n';

    await mkdir(path.join(profileHome, ".codex", "skills", "local-skill"), { recursive: true });
    await writeFile(targetConfig, initialConfig);
    await writeFile(authPath, authBytes);
    await writeFile(localSkill, "local profile skill\n");
    await writeFile(profileEnv, envBytes);

    const nativeSourceStep: SetupComponent = {
      componentId: "path",
      action: "configure",
      rollback: "manual",
      observe: async () => ({ stateDigest: null, valid: false, diagnostics: ["fake approved native source installation pending"] }),
      desired: async () => ({
        digest: createHash("sha256").update("fake-native-source-pin").digest("hex"),
        summary: "Install pinned fake native Codex source assets",
        targets: [sourceHome], machineWide: true, repairNeeded: false
      }),
      apply: async () => {
        const assetRoot = path.join(codexHome, "plugins", "cache", "bflow-superpowers", "bflow-superpowers", "7.0.0");
        await mkdir(path.join(codexHome, "skills", "native-skill"), { recursive: true });
        await mkdir(path.join(assetRoot, ".codex-plugin"), { recursive: true });
        await mkdir(path.join(assetRoot, "skills", "using-superpowers"), { recursive: true });
        const sourceConfig = [
          "[mcp_servers.shared]",
          'command = "/usr/bin/true"',
          "",
          '[plugins."bflow-superpowers@bflow-superpowers"]',
          "enabled = true",
          "",
          "[marketplaces.bflow-superpowers]",
          'source_type = "local"',
          'source = "/machine/managed/bflow-superpowers"',
          ""
        ].join("\n");
        const writes: Array<[string, string]> = [
          [path.join(codexHome, "config.toml"), sourceConfig],
          [path.join(codexHome, "skills", "native-skill", "SKILL.md"), "native approved instruction\n"],
          [path.join(assetRoot, ".codex-plugin", "plugin.json"),
            JSON.stringify({ name: "bflow-superpowers", version: "7.0.0", description: "fixture" }) + "\n"],
          [path.join(assetRoot, "skills", "using-superpowers", "SKILL.md"), "managed Bflow instruction\n"]
        ];
        for (const [file, contents] of writes) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, contents);
        }
        return { ownedPaths: nativePaths, diagnostics: [] };
      }
    };
    const profileSetup = new ProfileSetupComponent({
      helperPath,
      sourceHome,
      stateRoot,
      sourceCodexHome: codexHome,
      expectedIdentity: "fake-native-superpowers-pin:7.0.0"
    });
    const platform = testPlatform(tempRoot);
    const now = () => new Date("2026-10-20T00:00:00.000Z");
    const components = [nativeSourceStep, profileSetup];
    const planned = await buildSetupPlan({
      platform, runner, observations: [], config: defaultMachineConfig(), components,
      registry: new ToolInstallerRegistry(), mode: "apply", previousRevision: 0, now
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error.message);
    const nativePlanStep = planned.value.plan.steps.find(step => step.componentId === "path");
    const syncPlanStep = planned.value.plan.steps.find(step => step.componentId === "isolator-profiles");
    expect(nativePlanStep?.requiresApproval).toBe(true);
    expect(syncPlanStep?.dependsOn).toContain(nativePlanStep?.stepId);
    expect(planned.value.preview.steps.find(step => step.componentId === "isolator-profiles")?.targets).toEqual([profileHome]);

    const applyContext: SetupContext = { platform, runner, mode: "apply", now };
    const checkContext: SetupContext = { platform, runner, mode: "check", now };
    const dryRunContext: SetupContext = { platform, runner, mode: "dry_run", now };

    const preSourceObservation = await profileSetup.observe(checkContext);
    expect(preSourceObservation.valid).toBe(false);
    await nativeSourceStep.apply(applyContext);

    const stableDesired = await profileSetup.desired(applyContext);
    expect(stableDesired.targets).toEqual([profileHome]);
    const beforeCheckConfig = await readFile(targetConfig, "utf8");
    const beforeCheckAuth = await readFile(authPath, "utf8");
    const check = await profileSetup.observe(checkContext);
    expect(check.valid).toBe(false);
    await profileSetup.apply(dryRunContext);
    expect(await readFile(targetConfig, "utf8")).toBe(beforeCheckConfig);
    expect(await readFile(authPath, "utf8")).toBe(beforeCheckAuth);
    await expect(readFile(receiptPath)).rejects.toThrow();

    const applied = await profileSetup.apply(applyContext);
    expect(applied.diagnostics).toEqual([]);
    expect(applied.ownedPaths).toContain(receiptPath);
    const converged = await profileSetup.observe(checkContext);
    expect(converged.valid).toBe(true);
    expect(converged.stateDigest).toBe(stableDesired.digest);

    const mergedConfig = await readFile(targetConfig, "utf8");
    expect(mergedConfig).toContain('model = "profile-model"');
    expect(mergedConfig).toContain("[mcp_servers.local]");
    expect(mergedConfig).toContain("[mcp_servers.shared]");
    expect(await readFile(authPath, "utf8")).toBe(authBytes);
    expect(await readFile(profileEnv, "utf8")).toBe(envBytes);
    expect(await readFile(localSkill, "utf8")).toBe("local profile skill\n");
    expect(await readFile(path.join(profileHome, ".codex", "skills", "native-skill", "SKILL.md"), "utf8"))
      .toBe("native approved instruction\n");
    expect(await readFile(path.join(profileHome, ".codex", "plugins", "cache", "bflow-superpowers",
      "bflow-superpowers", "7.0.0", "skills", "using-superpowers", "SKILL.md"), "utf8"))
      .toBe("managed Bflow instruction\n");
    const publicReceipt = await readFile(receiptPath, "utf8");
    expect(publicReceipt).not.toContain("TEST_PROFILE_TOKEN");
    expect(publicReceipt).not.toContain("tokens");
  });
});
