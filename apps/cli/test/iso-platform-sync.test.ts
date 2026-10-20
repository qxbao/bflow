import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const helper = resolve(import.meta.dirname, "../isolation/lib/profile_sync.py");
const engine = resolve(import.meta.dirname, "../isolation/bin/ai-isolator");
const roots: string[] = [];

function sandbox() {
  const root = mkdtempSync(resolve(tmpdir(), "bflow-iso-platform-sync-"));
  roots.push(root);
  const sourceHome = resolve(root, "native");
  const stateRoot = resolve(root, "state");
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(resolve(stateRoot, "profiles"), { recursive: true });
  return { root, sourceHome, stateRoot };
}

function put(file: string, contents: string) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

function profile(s: ReturnType<typeof sandbox>, provider: string, name: string) {
  const root = resolve(s.stateRoot, "profiles", `${provider}--${name}`);
  mkdirSync(resolve(root, "home"), { recursive: true });
  put(resolve(root, "profile.env"), `AI_ISOLATOR_TOOL=${provider}\nAI_ISOLATOR_PROFILE=${name}\n`);
  return resolve(root, "home");
}

function invoke(s: ReturnType<typeof sandbox>, mode: "inspect" | "apply", provider?: string, profile?: string) {
  const args = [helper, mode, "--source-home", s.sourceHome, "--state-root", s.stateRoot];
  if (provider && profile) args.push("--provider", provider, "--profile", profile);
  return spawnSync("python3", args, {
    encoding: "utf8",
    env: { ...process.env, AI_ISOLATOR_REAL_HOME: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", BFLOW_HOME: "" },
  });
}

function resultOf(result: ReturnType<typeof spawnSync>) {
  expect(result.stdout).toBeTruthy();
  return JSON.parse(result.stdout) as {
    schemaVersion: number;
    valid: boolean;
    desiredDigest: string;
    stateDigest: string | null;
    profileCount: number;
    targets: string[];
    ownedPaths: string[];
    diagnostics: string[];
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native platform profile synchronization", () => {
  it.each([
    ["codex", "codex--work", ".codex/config.toml"],
    ["claude", "claude--work", ".claude.json"],
    ["agy", "agy--work", ".gemini/config/mcp_config.json"],
  ])("copies managed native capabilities into %s without replacing local profile state", (provider, key, configPath) => {
    const s = sandbox();
    const profileHome = profile(s, provider, "work");

    if (provider === "codex") {
      put(resolve(s.sourceHome, ".codex/config.toml"), [
        '[mcp_servers."native-tool"]',
        'command = "/usr/bin/true"',
        '[plugins."bflow-superpowers@bflow-superpowers"]',
        "enabled = true",
        '[marketplaces.bflow-superpowers]',
        'source_type = "local"',
        'source = "/managed/bflow-superpowers"',
        "",
      ].join("\n"));
      put(resolve(s.sourceHome, ".codex/skills/bflow/SKILL.md"), "native codex instructions\n");
      put(resolve(s.sourceHome, ".codex/skills/bflow/__pycache__/example.cpython-312.pyc"), "generated\n");
      put(resolve(s.sourceHome, ".codex/skills/bflow/generated.pyc"), "generated\n");
      put(resolve(s.sourceHome, ".codex/plugins/cache/bflow-superpowers/.codex-plugin/plugin.json"), '{"name":"bflow-superpowers"}\n');
      put(resolve(s.sourceHome, ".codex/plugins/cache/bflow-superpowers/skills/bflow/SKILL.md"), "plugin skill\n");
      put(resolve(profileHome, ".codex/config.toml"), 'model = "local-model"\n[mcp_servers.local]\ncommand = "local-tool"\n');
    } else if (provider === "claude") {
      const marketplace = resolve(s.sourceHome, "managed-marketplace");
      put(resolve(marketplace, ".claude-plugin/marketplace.json"), '{"name":"bflow-superpowers","plugins":[]}\n');
      put(resolve(s.sourceHome, ".claude.json"), JSON.stringify({
        mcpServers: { "native-tool": { command: "/usr/bin/true", env: { TOOL_TOKEN: "machine-tool-value" } } },
      }));
      put(resolve(s.sourceHome, ".claude/settings.json"), JSON.stringify({
        enabledPlugins: { "bflow-superpowers@bflow-superpowers": true },
        extraKnownMarketplaces: { "bflow-superpowers": { source: { source: "directory", path: marketplace } } },
      }));
      put(resolve(s.sourceHome, ".claude/skills/bflow/SKILL.md"), "native claude instructions\n");
      put(resolve(s.sourceHome, ".claude/plugins/cache/bflow-superpowers/.claude-plugin/plugin.json"), '{"name":"bflow-superpowers"}\n');
      const pluginVersion = resolve(s.sourceHome, ".claude/plugins/cache/bflow-superpowers/bflow-superpowers/7.0.0");
      put(resolve(pluginVersion, ".claude-plugin/plugin.json"), '{"name":"bflow-superpowers","version":"7.0.0"}\n');
      put(resolve(pluginVersion, "skills/bflow/SKILL.md"), "plugin instructions\n");
      put(resolve(s.sourceHome, ".claude/plugins/installed_plugins.json"), JSON.stringify({
        version: 2,
        plugins: { "bflow-superpowers@bflow-superpowers": [{
          scope: "user", installPath: pluginVersion, version: "7.0.0", installedAt: "fixture", lastUpdated: "fixture",
        }] },
      }));
      put(resolve(s.sourceHome, ".claude/plugins/known_marketplaces.json"), JSON.stringify({
        "bflow-superpowers": { source: { source: "directory", path: marketplace }, installLocation: marketplace, lastUpdated: "fixture" },
      }));
      put(resolve(profileHome, ".claude.json"), JSON.stringify({
        oauthAccount: { accountUuid: "must-stay-local" },
        model: "local-model",
        mcpServers: { local: { command: "local-tool" } },
      }));
      put(resolve(profileHome, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["local"] } }));
    } else {
      put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), JSON.stringify({
        mcpServers: { "native-tool": { command: "/usr/bin/true", disabled: false } },
      }));
      put(resolve(s.sourceHome, ".gemini/config/config.json"), JSON.stringify({
        plugins: { "bflow-superpowers": { enabled: true } },
      }));
      put(resolve(s.sourceHome, ".gemini/config/plugins/bflow-superpowers/.antigravity-plugin/plugin.json"),
        JSON.stringify({ name: "bflow-superpowers", version: "7.0.0", description: "managed", skills: ["bflow"] }));
      put(resolve(s.sourceHome, ".gemini/config/plugins/bflow-superpowers/skills/bflow/SKILL.md"), "native agy instructions\n");
      put(resolve(profileHome, ".gemini/config/mcp_config.json"), JSON.stringify({
        localSetting: true,
        mcpServers: { local: { command: "local-tool" } },
      }));
      put(resolve(profileHome, ".gemini/config/config.json"), JSON.stringify({
        localPreference: "preserve",
        plugins: { "local-plugin": { enabled: true } },
      }));
    }

    put(resolve(profileHome, "auth.json"), '{"refresh_token":"profile-secret"}\n');
    const applied = invoke(s, "apply", provider, "work");
    expect(applied.status, `${applied.stderr}${applied.stdout}`).toBe(0);
    const report = resultOf(applied);
    expect(report.valid).toBe(true);
    expect(report.stateDigest).toBe(report.desiredDigest);
    expect(report.profileCount).toBe(1);
    expect(report.targets).toEqual([profileHome]);
    expect(report.desiredDigest).toMatch(/^[a-f0-9]{64}$/);
    const config = readFileSync(resolve(profileHome, configPath), "utf8");
    expect(config).toContain("native-tool");
    expect(config).toContain("local-tool");
    expect(readFileSync(resolve(profileHome, "auth.json"), "utf8")).toContain("profile-secret");
    expect(applied.stdout).not.toContain("machine-tool-value");
    expect(applied.stdout).not.toContain("must-stay-local");
    expect(readdirSync(resolve(s.stateRoot, "profiles", key))).toContain("home");
    if (provider === "codex") {
      expect(existsSync(resolve(profileHome, ".codex/skills/bflow/__pycache__"))).toBe(false);
      expect(existsSync(resolve(profileHome, ".codex/skills/bflow/generated.pyc"))).toBe(false);
    }
    const receiptPath = resolve(s.stateRoot, "profiles", key, ".bflow-profile-sync.json");
    expect(readFileSync(receiptPath).length).toBeGreaterThan(0);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    if (provider === "agy") {
      const state = JSON.parse(readFileSync(resolve(profileHome, ".gemini/config/config.json"), "utf8"));
      expect(state.localPreference).toBe("preserve");
      expect(state.plugins["local-plugin"].enabled).toBe(true);
      expect(state.plugins["bflow-superpowers"].enabled).toBe(true);
    }
    if (provider === "claude") {
      const registry = JSON.parse(readFileSync(resolve(profileHome, ".claude/plugins/installed_plugins.json"), "utf8"));
      expect(registry.version).toBe(2);
      expect(registry.plugins["bflow-superpowers@bflow-superpowers"][0].installPath)
        .toBe(resolve(profileHome, ".claude/plugins/cache/bflow-superpowers/bflow-superpowers/7.0.0"));
      expect(existsSync(resolve(profileHome, ".claude/plugins/cache/bflow-superpowers/bflow-superpowers/7.0.0/.claude-plugin/plugin.json"))).toBe(true);
      const known = JSON.parse(readFileSync(resolve(profileHome, ".claude/plugins/known_marketplaces.json"), "utf8"));
      expect(known["bflow-superpowers"].installLocation).toBe(resolve(s.sourceHome, "managed-marketplace"));
      expect(existsSync(resolve(known["bflow-superpowers"].installLocation, ".claude-plugin/marketplace.json"))).toBe(true);
    }

    const again = resultOf(invoke(s, "apply", provider, "work"));
    expect(again.valid).toBe(true);
    expect(again.ownedPaths).toEqual([]);
  });

  it("reports drift read-only, repairs managed files, and preserves unrelated edits", () => {
    const s = sandbox();
    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), '{"mcpServers":{"native":{"command":"one"}}}');
    const home = profile(s, "agy", "default");
    const target = resolve(home, ".gemini/config/mcp_config.json");
    const before = invoke(s, "inspect", "agy", "default");
    expect(before.status).toBe(0);
    expect(resultOf(before).valid).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(resolve(s.stateRoot, "profiles/agy--default/.bflow-profile-sync.json"))).toBe(false);
    expect(existsSync(resolve(import.meta.dirname, "../isolation/lib/__pycache__"))).toBe(false);
    expect(invoke(s, "apply", "agy", "default").status).toBe(0);

    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), '{"mcpServers":{"native":{"command":"two"}}}');
    expect(resultOf(invoke(s, "inspect", "agy", "default")).valid).toBe(false);
    expect(readFileSync(target, "utf8")).toContain('"one"');
    const repaired = invoke(s, "apply", "agy", "default");
    expect(repaired.status).toBe(0);
    expect(readFileSync(target, "utf8")).toContain('"two"');
  });

  it("uses an explicit Claude config directory for source MCP while keeping the profile target HOME-native", () => {
    const s = sandbox();
    const configDir = resolve(s.root, "native-claude-config");
    put(resolve(configDir, ".claude.json"), '{"mcpServers":{"override-source":{"command":"claude-tool"}}}');
    put(resolve(s.sourceHome, ".claude.json"), '{"mcpServers":{"wrong-home-source":{"command":"wrong-tool"}}}');
    const home = profile(s, "claude", "override");
    put(resolve(home, ".claude.json"), JSON.stringify({
      oauthAccount: { accountUuid: "home-account" },
      model: "home-model",
      mcpServers: { localHome: { command: "home-local" } },
    }));
    put(resolve(home, ".claude/.claude.json"), JSON.stringify({
      oauthAccount: { accountUuid: "config-account" },
      model: "config-model",
      mcpServers: { localConfig: { command: "config-local" } },
    }));
    const result = spawnSync("python3", [
      helper, "apply", "--source-home", s.sourceHome, "--state-root", s.stateRoot,
      "--source-claude-config-dir", configDir, "--provider", "claude", "--profile", "override",
    ], {
      encoding: "utf8",
      env: { ...process.env, AI_ISOLATOR_REAL_HOME: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", BFLOW_HOME: "" },
    });
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    const config = JSON.parse(readFileSync(resolve(home, ".claude.json"), "utf8"));
    expect(config.mcpServers["override-source"].command).toBe("claude-tool");
    expect(config.mcpServers["wrong-home-source"]).toBeUndefined();
    expect(config.mcpServers.localHome.command).toBe("home-local");
    const selectedConfig = JSON.parse(readFileSync(resolve(home, ".claude/.claude.json"), "utf8"));
    expect(selectedConfig.mcpServers["override-source"].command).toBe("claude-tool");
    expect(selectedConfig.mcpServers.localConfig.command).toBe("config-local");
    expect(selectedConfig.oauthAccount.accountUuid).toBe("config-account");
    expect(selectedConfig.model).toBe("config-model");
    expect(result.stdout).not.toContain("home-account");
    expect(result.stdout).not.toContain("config-account");
    const second = resultOf(spawnSync("python3", [
      helper, "apply", "--source-home", s.sourceHome, "--state-root", s.stateRoot,
      "--source-claude-config-dir", configDir, "--provider", "claude", "--profile", "override",
    ], {
      encoding: "utf8",
      env: { ...process.env, AI_ISOLATOR_REAL_HOME: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", BFLOW_HOME: "" },
    }));
    expect(second.valid).toBe(true);
    expect(second.ownedPaths).toEqual([]);
  });

  it("handles the default state root nested under the source HOME", () => {
    const s = sandbox();
    s.stateRoot = resolve(s.sourceHome, ".local/share/ai-isolator");
    mkdirSync(resolve(s.stateRoot, "profiles"), { recursive: true });
    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), '{"mcpServers":{"native":{"command":"tool"}}}');
    const home = profile(s, "agy", "default");
    const first = invoke(s, "apply", "agy", "default");
    expect(first.status, first.stdout).toBe(0);
    expect(resultOf(first).targets).toEqual([home]);
    const second = resultOf(invoke(s, "apply", "agy", "default"));
    expect(second.valid).toBe(true);
    expect(second.ownedPaths).toEqual([]);
  });

  it("refuses to overwrite a profile-local edit to a previously synchronized MCP entry", () => {
    const s = sandbox();
    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), JSON.stringify({
      mcpServers: {
        native: {
          command: "native-tool",
          url: "http://127.0.0.1:4100",
          args: ["--safe"],
          headers: { "x-fixture": "source-header" },
          env: { FIXTURE_TOKEN: "source-token" },
        },
      },
    }));
    const home = profile(s, "agy", "work");
    const target = resolve(home, ".gemini/config/mcp_config.json");
    expect(invoke(s, "apply", "agy", "work").status).toBe(0);
    put(target, JSON.stringify({
      mcpServers: {
        native: {
          command: "profile-edited",
          url: "http://127.0.0.1:4200",
          args: ["--edited"],
          headers: { "x-fixture": "profile-header" },
          env: { FIXTURE_TOKEN: "profile-token" },
        },
      },
    }));

    const apply = invoke(s, "apply", "agy", "work");
    expect(apply.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toContain("profile-token");
    expect(resultOf(apply).diagnostics.join(" ")).toContain("changed locally");
    expect(apply.stdout).not.toContain("source-token");
  });

  it("removes only unchanged previously owned MCP entries when native entries disappear", () => {
    const s = sandbox();
    const nativeConfig = resolve(s.sourceHome, ".gemini/config/mcp_config.json");
    put(nativeConfig, '{"mcpServers":{"managed":{"command":"native-tool"}}}');
    const home = profile(s, "agy", "work");
    const target = resolve(home, ".gemini/config/mcp_config.json");
    expect(invoke(s, "apply", "agy", "work").status).toBe(0);
    put(target, '{"mcpServers":{"managed":{"command":"native-tool"},"local":{"command":"local-tool"}}}');

    put(nativeConfig, '{"mcpServers":{}}');
    const repaired = invoke(s, "apply", "agy", "work");
    expect(repaired.status, repaired.stdout).toBe(0);
    const config = JSON.parse(readFileSync(target, "utf8"));
    expect(config.mcpServers.managed).toBeUndefined();
    expect(config.mcpServers.local.command).toBe("local-tool");
  });

  it("keeps Agy Bflow plugin disabled state in sync without replacing other settings", () => {
    const s = sandbox();
    const sourcePlugin = resolve(s.sourceHome, ".gemini/config/plugins/bflow-superpowers");
    put(resolve(sourcePlugin, ".antigravity-plugin/plugin.json"), '{"name":"bflow-superpowers","skills":"./skills/"}');
    put(resolve(sourcePlugin, "skills/demo/SKILL.md"), "skill\n");
    const sourceState = resolve(s.sourceHome, ".gemini/config/config.json");
    put(sourceState, '{"plugins":{"bflow-superpowers":{"enabled":false}}}');
    const home = profile(s, "agy", "disabled");
    const targetState = resolve(home, ".gemini/config/config.json");
    put(targetState, '{"localPreference":"keep","plugins":{"other":{"enabled":true}}}');

    expect(invoke(s, "apply", "agy", "disabled").status).toBe(0);
    let result = JSON.parse(readFileSync(targetState, "utf8"));
    expect(result.plugins["bflow-superpowers"].enabled).toBe(false);
    expect(result.plugins.other.enabled).toBe(true);
    expect(result.localPreference).toBe("keep");

    put(sourceState, '{"plugins":{"bflow-superpowers":{"enabled":true}}}');
    expect(invoke(s, "apply", "agy", "disabled").status).toBe(0);
    result = JSON.parse(readFileSync(targetState, "utf8"));
    expect(result.plugins["bflow-superpowers"].enabled).toBe(true);
    put(targetState, JSON.stringify({ ...result, plugins: { ...result.plugins, "bflow-superpowers": { enabled: false } } }));
    const conflict = invoke(s, "apply", "agy", "disabled");
    expect(conflict.status).not.toBe(0);
    expect(JSON.parse(readFileSync(targetState, "utf8")).plugins["bflow-superpowers"].enabled).toBe(false);
  });

  it("blocks enabled Claude or Agy plugin metadata when verified native assets are missing", () => {
    const s = sandbox();
    const codexHome = profile(s, "codex", "broken");
    put(resolve(s.sourceHome, ".codex/config.toml"), '[plugins."bflow-superpowers@bflow-superpowers"]\nenabled = true\n');
    const codexResult = invoke(s, "apply", "codex", "broken");
    expect(codexResult.status).not.toBe(0);
    expect(resultOf(codexResult).diagnostics.join(" ")).toContain("native manifest");
    expect(existsSync(resolve(codexHome, ".codex/config.toml"))).toBe(false);

    const claudeHome = profile(s, "claude", "broken");
    const marketplace = resolve(s.sourceHome, "marketplace");
    put(resolve(marketplace, ".claude-plugin/marketplace.json"), '{"name":"bflow-superpowers"}');
    put(resolve(s.sourceHome, ".claude/settings.json"), JSON.stringify({
      enabledPlugins: { "bflow-superpowers@bflow-superpowers": true },
      extraKnownMarketplaces: { "bflow-superpowers": { source: { source: "directory", path: marketplace } } },
    }));
    put(resolve(s.sourceHome, ".claude/plugins/installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "bflow-superpowers@bflow-superpowers": [] },
    }));
    const claudeResult = invoke(s, "apply", "claude", "broken");
    expect(claudeResult.status).not.toBe(0);
    expect(resultOf(claudeResult).diagnostics.join(" ")).toContain("installed registry entry");
    expect(existsSync(resolve(claudeHome, ".claude/settings.json"))).toBe(false);

    const agyHome = profile(s, "agy", "broken");
    put(resolve(s.sourceHome, ".gemini/config/config.json"), '{"plugins":{"bflow-superpowers":{"enabled":true}}}');
    const agyResult = invoke(s, "apply", "agy", "broken");
    expect(agyResult.status).not.toBe(0);
    expect(resultOf(agyResult).diagnostics.join(" ")).toContain("manifest or skills");
    expect(existsSync(resolve(agyHome, ".gemini/config/config.json"))).toBe(false);
  });

  it("rejects malformed sources, profile target symlinks, and unsafe source symlinks as JSON errors", () => {
    const s = sandbox();
    const home = profile(s, "agy", "work");
    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), "{");
    const malformed = invoke(s, "apply", "agy", "work");
    expect(malformed.status).not.toBe(0);
    expect(resultOf(malformed).valid).toBe(false);

    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), '{"mcpServers":{"tool":{"command":"x"}}}');
    const outside = resolve(s.root, "outside.json");
    put(outside, '{"preserve":true}');
    mkdirSync(resolve(home, ".gemini/config"), { recursive: true });
    symlinkSync(outside, resolve(home, ".gemini/config/mcp_config.json"));
    expect(invoke(s, "apply", "agy", "work").status).not.toBe(0);
    expect(readFileSync(outside, "utf8")).toBe('{"preserve":true}');
  });

  it("rejects symlinked profile roots and source assets that escape trusted native roots", () => {
    const s = sandbox();
    const outside = resolve(s.root, "outside");
    mkdirSync(outside);
    const profiles = resolve(s.stateRoot, "profiles");
    symlinkSync(outside, resolve(profiles, "agy--outside"));
    const badProfile = invoke(s, "inspect");
    expect(badProfile.status).not.toBe(0);
    expect(resultOf(badProfile).diagnostics.join(" ")).toContain("real directories");

    rmSync(resolve(profiles, "agy--outside"));
    profile(s, "agy", "safe");
    const sourcePlugin = resolve(s.sourceHome, ".gemini/config/plugins/bflow-superpowers");
    mkdirSync(sourcePlugin, { recursive: true });
    const outsideFile = resolve(s.root, "outside-skill.md");
    put(outsideFile, "untrusted link\n");
    symlinkSync(outsideFile, resolve(sourcePlugin, "SKILL.md"));
    const apply = invoke(s, "apply", "agy", "safe");
    expect(apply.status).not.toBe(0);
    expect(resultOf(apply).diagnostics.join(" ")).toContain("escapes its trusted source root");
  });

  it("rejects a profile home symlink into another profile before touching its sentinel", () => {
    const s = sandbox();
    const linkedHome = profile(s, "agy", "linked");
    const otherHome = profile(s, "agy", "other");
    const sentinel = resolve(otherHome, "sentinel");
    put(sentinel, "must remain unchanged");
    rmSync(linkedHome, { recursive: true });
    symlinkSync(otherHome, linkedHome);

    const result = invoke(s, "apply");
    expect(result.status).not.toBe(0);
    expect(resultOf(result).diagnostics.join(" ")).toContain("real directories");
    expect(readFileSync(sentinel, "utf8")).toBe("must remain unchanged");
  });

  it("rejects symlinked state/profile roots instead of treating dangling roots as no profiles", () => {
    const s = sandbox();
    const external = resolve(s.root, "external-state");
    mkdirSync(external);
    put(resolve(external, "sentinel"), "preserve");
    rmSync(s.stateRoot, { recursive: true, force: true });
    symlinkSync(external, s.stateRoot);
    const stateLink = invoke(s, "inspect");
    expect(stateLink.status).not.toBe(0);
    expect(resultOf(stateLink).diagnostics.join(" ")).toContain("state root");
    expect(readFileSync(resolve(external, "sentinel"), "utf8")).toBe("preserve");

    rmSync(s.stateRoot);
    mkdirSync(s.stateRoot);
    const missingTarget = resolve(s.root, "not-created");
    symlinkSync(missingTarget, resolve(s.stateRoot, "profiles"));
    const profileLink = invoke(s, "inspect");
    expect(profileLink.status).not.toBe(0);
    expect(resultOf(profileLink).diagnostics.join(" ")).toContain("profile directory");
  });

  it("initializes later provider profiles through the same synchronizer", () => {
    const s = sandbox();
    const bin = resolve(s.root, "bin");
    mkdirSync(bin);
    const fakeAgy = resolve(bin, "agy");
    put(fakeAgy, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeAgy, 0o755);
    put(resolve(s.sourceHome, ".gemini/config/mcp_config.json"), '{"mcpServers":{"native":{"command":"x"}}}');
    const result = spawnSync("/usr/bin/bash", [engine, "agy", "--name", "later", "--no-login"], {
      cwd: s.root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: s.sourceHome,
        AI_ISOLATOR_HOME: s.stateRoot,
        AI_ISOLATOR_REAL_HOME: "",
        CODEX_HOME: "",
        CLAUDE_CONFIG_DIR: "",
        BFLOW_HOME: "",
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const target = resolve(s.stateRoot, "profiles/agy--later/home/.gemini/config/mcp_config.json");
    expect(readFileSync(target, "utf8")).toContain('"native"');
  });
});
