import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { testPython } from "../../../tests/helpers/python-runtime.js";

const enginePath = resolve(import.meta.dirname, "../isolation/bin/ai-isolator");

describe("bundled isolation engine", () => {
  it("ships a self-contained executable with bflow iso branding", () => {
    expect(existsSync(enginePath)).toBe(true);
    const source = readFileSync(enginePath, "utf8");
    expect(source).toMatch(/^#!\/usr\/bin\/env bash/m);
    expect(source).toContain('APP_NAME="bflow iso"');
    expect(source).not.toContain("runtime.dispatch.shell.mcp_config");
  });

  it("runs help and version without an ai-sdlc checkout", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-engine-"));
    try {
      const futureBflowHome = resolve(home, "not-created-yet");
      const sentinelBin = resolve(home, "sentinel-bin");
      const executed = resolve(home, "help-command-executions");
      mkdirSync(sentinelBin);
      for (const command of ["login", "status", "unverified"]) {
        writeFileSync(resolve(sentinelBin, command), `#!/usr/bin/env bash\nprintf '%s\\n' '${command}' >> '${executed}'\n`);
        chmodSync(resolve(sentinelBin, command), 0o755);
      }
      const env = {
        ...process.env,
        HOME: home,
        AI_ISOLATOR_HOME: resolve(home, "state"),
        BFLOW_HOME: futureBflowHome,
        PATH: `${sentinelBin}:${process.env.PATH ?? ""}`,
      };
      const help = spawnSync("bash", [enginePath, "--help"], { cwd: home, env, encoding: "utf8" });
      const version = spawnSync("bash", [enginePath, "--version"], { cwd: home, env, encoding: "utf8" });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("bflow iso codex");
      expect(help.stderr).toBe("");
      expect(existsSync(executed)).toBe(false);
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe("bflow iso 0.4.4");
      expect(existsSync(resolve(home, "state"))).toBe(false);
      expect(existsSync(futureBflowHome)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("syncs shared MCP and hook trust while retaining profile-local config", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-mcp-"));
    try {
      const shared = resolve(home, "shared");
      const profile = resolve(home, "profile");
      mkdirSync(resolve(shared, ".codex"), { recursive: true });
      mkdirSync(resolve(profile, ".codex"), { recursive: true });
      const sharedHooks = resolve(shared, ".codex/hooks.json");
      const profileHooks = resolve(profile, ".codex/hooks.json");
      writeFileSync(resolve(shared, ".codex/config.toml"), [
        "model = \"shared-model\"",
        "[mcp_servers.shared]",
        "command = \"shared-tool\"",
        `[hooks.state."${sharedHooks}:PreToolUse:0:0"]`,
        "trusted_hash = \"abc123\"",
        "",
      ].join("\n"));
      writeFileSync(resolve(shared, ".codex/hooks.json"), "{}\n");
      writeFileSync(resolve(profile, ".codex/config.toml"), [
        "model = \"profile-model\"",
        "[mcp_servers.local]",
        "command = \"local-tool\"",
        "",
      ].join("\n"));

      const helper = resolve(enginePath, "../../lib/mcp_sync.py");
      const result = spawnSync("python3", [helper, profile, shared], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const config = readFileSync(resolve(profile, ".codex/config.toml"), "utf8");
      expect(config).toContain('model = "profile-model"');
      expect(config).toContain('[mcp_servers.shared]');
      expect(config).toContain('[mcp_servers.local]');
      expect(config).toContain(`[hooks.state."${profileHooks}:PreToolUse:0:0"]`);
      expect(config).toContain('trusted_hash = "abc123"');
      expect(existsSync(profileHooks)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves invalid TOML unchanged and refuses to overwrite a symlink target", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-mcp-safe-"));
    try {
      const shared = resolve(home, "shared");
      const profile = resolve(home, "profile");
      mkdirSync(resolve(shared, ".codex"), { recursive: true });
      mkdirSync(resolve(profile, ".codex"), { recursive: true });
      const source = resolve(shared, ".codex/config.toml");
      const target = resolve(profile, ".codex/config.toml");
      writeFileSync(source, "[mcp_servers.shared\ninvalid = true\n");
      writeFileSync(target, 'model = "preserve-me"\n');
      const helper = resolve(enginePath, "../../lib/mcp_sync.py");
      const invoke = () => spawnSync("python3", [helper, profile, shared], { encoding: "utf8" });
      expect(invoke().status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe('model = "preserve-me"\n');

      writeFileSync(source, '[mcp_servers.shared]\ncommand = "shared-tool"\n');
      writeFileSync(target, '[mcp_servers.broken\nmalformed = true\n');
      expect(invoke().status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe('[mcp_servers.broken\nmalformed = true\n');

      const sentinel = resolve(home, "sentinel.toml");
      writeFileSync(sentinel, 'model = "sentinel"\n');
      rmSync(target);
      symlinkSync(sentinel, target);
      expect(invoke().status).toBe(0);
      expect(readFileSync(sentinel, "utf8")).toBe('model = "sentinel"\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the engine syntactically valid Bash", () => {
    const result = spawnSync("bash", ["-n", enginePath], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("skips an older python3 without tomllib and selects a compatible Python", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-python-"));
    try {
      const bin = resolve(home, "bin");
      mkdirSync(bin);
      const goodPython = spawnSync("bash", ["-lc", "command -v python3"], { encoding: "utf8" }).stdout.trim();
      expect(goodPython).toBeTruthy();
      const selected = resolve(home, "selected-python");
      writeFileSync(resolve(bin, "python3"), `#!/usr/bin/env bash\nif [[ "$*" == *tomllib* ]]; then exit 1; fi\nif [[ "$1" == *profile_sync.py ]]; then printf python3 >> "$AI_ISOLATOR_TEST_SELECTION"; fi\nexit 0\n`);
      writeFileSync(resolve(bin, "python"), `#!/usr/bin/env bash\nif [[ "$1" == *profile_sync.py ]]; then printf python >> "$AI_ISOLATOR_TEST_SELECTION"; fi\nexec ${goodPython} "$@"\n`);
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      for (const name of ["python3", "python", "codex"]) chmodSync(resolve(bin, name), 0o755);

      const env = {
        ...process.env,
        HOME: home,
        AI_ISOLATOR_HOME: resolve(home, "state"),
        AI_ISOLATOR_TEST_SELECTION: selected,
        PATH: `${bin}:/usr/bin:/bin`,
      };
      const result = spawnSync("bash", [enginePath, "codex", "--name", "test", "--no-lb", "--no-login"], {
        cwd: home,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(readFileSync(selected, "utf8")).toBe("python");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("finds a compatible python3 later in PATH when the first is Apple's older system interpreter", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-python-path-"));
    try {
      const oldBin = resolve(home, "old"), goodBin = resolve(home, "good");
      mkdirSync(oldBin); mkdirSync(goodBin);
      writeFileSync(resolve(oldBin, "python3"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      symlinkSync(testPython, resolve(goodBin, "python3"));
      writeFileSync(resolve(oldBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = spawnSync("/bin/bash", [enginePath, "codex", "--name", "test", "--no-lb", "--no-login"], {
        cwd: home, env: { ...process.env, HOME: home, AI_ISOLATOR_HOME: resolve(home, "state"), AI_ISOLATOR_PY: "",
          PATH: `${oldBin}:${goodBin}:/usr/bin:/bin` }, encoding: "utf8"
      });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("warns once when shared Codex MCP config exists but no Python supports tomllib", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-python-missing-"));
    try {
      const bin = resolve(home, "bin");
      mkdirSync(bin);
      mkdirSync(resolve(home, ".codex"));
      writeFileSync(resolve(home, ".codex/config.toml"), '[mcp_servers.shared]\ncommand = "tool"\n');
      for (const name of ["python3", "python"]) {
        writeFileSync(resolve(bin, name), `#!/usr/bin/env bash\nif [[ "$*" == *tomllib* ]]; then exit 1; fi\nif [[ "$*" == *"import sys"* ]]; then exit 0; fi\nexit 1\n`);
        chmodSync(resolve(bin, name), 0o755);
      }
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(resolve(bin, "codex"), 0o755);
      // Every Python on PATH is now probed. Supply real shell utilities without accidentally
      // exposing a second compatible system Python behind this test's deliberately old interpreters.
      const utilities = resolve(home, "utilities"); mkdirSync(utilities);
      for (const name of ["bash", "uname", "dirname", "mkdir", "chmod", "find", "grep", "sed", "awk", "tr", "head", "sort", "basename", "cat", "date", "rm", "readlink", "cut"]) {
        const actual = [resolve("/usr/bin", name), resolve("/bin", name)].find(existsSync);
        if (actual) symlinkSync(actual, resolve(utilities, name));
      }
      const env = { ...process.env, HOME: home, AI_ISOLATOR_HOME: resolve(home, "state"), AI_ISOLATOR_PY: "", PATH: `${bin}:${utilities}` };
      const result = spawnSync("bash", [enginePath, "codex", "--name", "test", "--no-lb", "--no-login"], {
        cwd: home,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Python 3.11+ with tomllib is required");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns success when removing an existing profile without a shell alias", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-remove-"));
    try {
      const bin = resolve(home, "bin");
      mkdirSync(bin);
      writeFileSync(resolve(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(resolve(bin, "claude"), 0o755);
      const env = { ...process.env, AI_ISOLATOR_PY: testPython, HOME: home, AI_ISOLATOR_HOME: resolve(home, "state"), PATH: `${bin}:/usr/bin:/bin` };
      const create = spawnSync("bash", [enginePath, "claude", "--name", "remove-me", "--no-login"], { cwd: home, env, encoding: "utf8" });
      const remove = spawnSync("bash", [enginePath, "remove", "claude", "--name", "remove-me"], { cwd: home, env, encoding: "utf8" });
      const removeAgain = spawnSync("bash", [enginePath, "remove", "claude", "--name", "remove-me"], { cwd: home, env, encoding: "utf8" });
      expect(create.status).toBe(0);
      expect(remove.status).toBe(0);
      expect(removeAgain.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("binds Claude probes and launch to the profile config directory", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-claude-config-"));
    try {
      const bin = resolve(home, "bin");
      mkdirSync(bin);
      const log = resolve(home, "claude-launch.env");
      writeFileSync(resolve(bin, "claude"), `#!/usr/bin/env bash
if [[ "$1" == auth ]]; then exit 0; fi
printf 'HOME=%s\\nCLAUDE_CONFIG_DIR=%s\\n' "$HOME" "\${CLAUDE_CONFIG_DIR-unset}" > "$CLAUDE_TEST_LOG"
exit 0
`);
      chmodSync(resolve(bin, "claude"), 0o755);
      const env = {
        ...process.env, AI_ISOLATOR_PY: testPython,
        HOME: home,
        AI_ISOLATOR_HOME: resolve(home, "state"),
        CLAUDE_CONFIG_DIR: "/real/account/config",
        CLAUDE_TEST_LOG: log,
        PATH: `${bin}:/usr/bin:/bin`,
      };
      const result = spawnSync("bash", [enginePath, "run", "claude", "--name", "isolated", "--", "--version"], {
        cwd: home,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const record = readFileSync(log, "utf8");
      expect(record).toContain(`HOME=${resolve(home, "state/profiles/claude--isolated/home")}`);
      expect(record).toContain(`CLAUDE_CONFIG_DIR=${resolve(home, "state/profiles/claude--isolated/home/.claude")}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses BFLOW_HOME provider sources without moving the shared isolator profile store", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-bflow-home-"));
    try {
      const bflow = resolve(home, "bflow");
      const providers = resolve(bflow, "providers");
      const nativeCodex = resolve(providers, "codex");
      const bin = resolve(home, "bin");
      mkdirSync(nativeCodex, { recursive: true });
      mkdirSync(bin);
      writeFileSync(resolve(nativeCodex, "config.toml"), '[mcp_servers.native]\ncommand = "bflow-native-tool"\n');
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(resolve(bin, "codex"), 0o755);
      const env = {
        ...process.env, AI_ISOLATOR_PY: testPython,
        HOME: home,
        BFLOW_HOME: bflow,
        AI_ISOLATOR_HOME: "",
        AI_ISOLATOR_REAL_HOME: "",
        CODEX_HOME: resolve(home, "external-codex"),
        CLAUDE_CONFIG_DIR: resolve(home, "external-claude"),
        PATH: `${bin}:/usr/bin:/bin`,
      };
      const result = spawnSync("bash", [enginePath, "codex", "--name", "bflow", "--no-lb", "--no-login"], {
        cwd: home,
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const profileHome = resolve(home, ".local/share/ai-isolator/profiles/codex--bflow/home");
      const config = readFileSync(resolve(profileHome, ".codex/config.toml"), "utf8");
      expect(config).toContain("bflow-native-tool");
      expect(existsSync(resolve(bflow, "state/ai-isolator"))).toBe(false);
      expect(existsSync(resolve(home, ".local/share/ai-isolator/profiles/codex--explicit"))).toBe(false);

      const explicitState = resolve(home, "explicit-isolator");
      const explicit = spawnSync("bash", [enginePath, "codex", "--name", "explicit", "--no-lb", "--no-login"], {
        cwd: home,
        env: { ...env, AI_ISOLATOR_HOME: explicitState },
        encoding: "utf8",
      });
      expect(explicit.status, explicit.stderr).toBe(0);
      expect(existsSync(resolve(explicitState, "profiles/codex--explicit/home/.codex/config.toml"))).toBe(true);
      expect(existsSync(resolve(home, ".local/share/ai-isolator/profiles/codex--explicit"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses AI_ISOLATOR_REAL_HOME for the same profile store with BFLOW_HOME on or off", () => {
    const root = mkdtempSync(resolve(tmpdir(), "bflow-iso-shared-profile-root-"));
    try {
      const activeHome = resolve(root, "active-profile-home");
      const realHome = resolve(root, "real-home");
      const bflow = resolve(root, "bflow");
      const bin = resolve(root, "bin");
      mkdirSync(activeHome, { recursive: true });
      mkdirSync(resolve(realHome, ".codex"), { recursive: true });
      mkdirSync(resolve(bflow, "providers/codex"), { recursive: true });
      mkdirSync(bin);
      writeFileSync(resolve(realHome, ".codex/config.toml"), '[mcp_servers.native]\ncommand = "real-home-tool"\n');
      writeFileSync(resolve(bflow, "providers/codex/config.toml"), '[mcp_servers.native]\ncommand = "bflow-tool"\n');
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(resolve(bin, "codex"), 0o755);
      const sharedState = resolve(realHome, ".local/share/ai-isolator");
      const env = {
        ...process.env, AI_ISOLATOR_PY: testPython,
        HOME: activeHome,
        AI_ISOLATOR_REAL_HOME: realHome,
        AI_ISOLATOR_HOME: "",
        CODEX_HOME: "",
        CLAUDE_CONFIG_DIR: "",
        BFLOW_HOME: "",
        PATH: `${bin}:/usr/bin:/bin`,
      };

      const ordinary = spawnSync("bash", [enginePath, "codex", "--name", "shared", "--no-lb", "--no-login"], {
        cwd: activeHome, env, encoding: "utf8",
      });
      expect(ordinary.status, ordinary.stderr).toBe(0);
      const profileHome = resolve(sharedState, "profiles/codex--shared/home");
      expect(readFileSync(resolve(profileHome, ".codex/config.toml"), "utf8")).toContain("real-home-tool");

      const isolatedSource = spawnSync("bash", [enginePath, "codex", "--name", "shared", "--no-lb", "--no-login"], {
        cwd: activeHome, env: { ...env, BFLOW_HOME: bflow }, encoding: "utf8",
      });
      expect(isolatedSource.status, isolatedSource.stderr).toBe(0);
      expect(readFileSync(resolve(profileHome, ".codex/config.toml"), "utf8")).toContain("bflow-tool");
      expect(existsSync(resolve(activeHome, ".local/share/ai-isolator"))).toBe(false);
      expect(existsSync(resolve(bflow, "state/ai-isolator"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores inherited selectors pointing at the active parent profile when resolving native setup sources", () => {
    const root = mkdtempSync(resolve(tmpdir(), "bflow-iso-nested-native-sources-"));
    try {
      const activeHome = resolve(root, "active-home");
      const realHome = resolve(root, "real-home");
      const bin = resolve(root, "bin");
      mkdirSync(resolve(activeHome, ".codex"), { recursive: true });
      mkdirSync(resolve(activeHome, ".claude"), { recursive: true });
      mkdirSync(resolve(realHome, ".codex"), { recursive: true });
      mkdirSync(resolve(realHome, ".claude"), { recursive: true });
      mkdirSync(bin);
      writeFileSync(resolve(activeHome, ".codex/config.toml"), '[mcp_servers.parent-profile]\ncommand = "parent-codex"\n');
      writeFileSync(resolve(realHome, ".codex/config.toml"), '[mcp_servers.native]\ncommand = "real-codex"\n');
      writeFileSync(resolve(activeHome, ".claude/.claude.json"), '{"mcpServers":{"parent-profile":{"command":"parent-claude"}}}');
      writeFileSync(resolve(realHome, ".claude.json"), '{"mcpServers":{"native":{"command":"real-claude"}}}');
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(resolve(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(resolve(bin, "codex"), 0o755);
      chmodSync(resolve(bin, "claude"), 0o755);
      const state = resolve(root, "state");
      const env = {
        ...process.env, AI_ISOLATOR_PY: testPython,
        HOME: activeHome,
        AI_ISOLATOR: "1",
        AI_ISOLATOR_REAL_HOME: realHome,
        AI_ISOLATOR_HOME: state,
        CODEX_HOME: resolve(activeHome, ".codex"),
        CLAUDE_CONFIG_DIR: resolve(activeHome, ".claude"),
        BFLOW_HOME: "",
        PATH: `${bin}:/usr/bin:/bin`,
      };
      const codex = spawnSync("bash", [enginePath, "codex", "--name", "nested", "--no-lb", "--no-login"], {
        cwd: activeHome, env, encoding: "utf8",
      });
      expect(codex.status, codex.stderr).toBe(0);
      const codexConfig = readFileSync(resolve(state, "profiles/codex--nested/home/.codex/config.toml"), "utf8");
      expect(codexConfig).toContain("real-codex");
      expect(codexConfig).not.toContain("parent-codex");

      const claude = spawnSync("bash", [enginePath, "claude", "--name", "nested", "--no-login"], {
        cwd: activeHome, env, encoding: "utf8",
      });
      expect(claude.status, claude.stderr).toBe(0);
      const claudeConfig = readFileSync(resolve(state, "profiles/claude--nested/home/.claude.json"), "utf8");
      expect(claudeConfig).toContain("real-claude");
      expect(claudeConfig).not.toContain("parent-claude");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shares only native Codex hooks.json and remaps existing hook trust keys on profile init", () => {
    const home = mkdtempSync(resolve(tmpdir(), "bflow-iso-codex-hooks-"));
    try {
      const bin = resolve(home, "bin");
      mkdirSync(bin);
      const sourceHooks = resolve(home, ".codex/hooks.json");
      mkdirSync(resolve(home, ".codex"), { recursive: true });
      writeFileSync(sourceHooks, '{"hooks":[]}\n');
      writeFileSync(resolve(home, ".codex/config.toml"), [
        '[mcp_servers.native]',
        'command = "native-tool"',
        `[hooks.state."${sourceHooks}:PreToolUse:0:0"]`,
        'trusted_hash = "native-hook-trust"',
        "",
      ].join("\n"));
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(resolve(bin, "codex"), 0o755);
      const state = resolve(home, "state");
      const env = { ...process.env, AI_ISOLATOR_PY: testPython, HOME: home, AI_ISOLATOR_HOME: state, CODEX_HOME: "", BFLOW_HOME: "", PATH: `${bin}:/usr/bin:/bin` };
      const create = spawnSync("bash", [enginePath, "codex", "--name", "hooks", "--no-lb", "--no-login"], {
        cwd: home, env, encoding: "utf8",
      });
      expect(create.status, create.stderr).toBe(0);
      const profileHome = resolve(state, "profiles/codex--hooks/home");
      const profileHooks = resolve(profileHome, ".codex/hooks.json");
      expect(lstatSync(profileHooks).isSymbolicLink()).toBe(true);
      expect(readFileSync(profileHooks, "utf8")).toBe('{"hooks":[]}\n');
      const config = readFileSync(resolve(profileHome, ".codex/config.toml"), "utf8");
      expect(config).toContain('[mcp_servers.native]');
      expect(config).toContain(`${profileHooks}:PreToolUse:0:0`);
      expect(config).toContain('trusted_hash = "native-hook-trust"');

      const localHome = resolve(state, "profiles/codex--local/home");
      mkdirSync(resolve(localHome, ".codex"), { recursive: true });
      writeFileSync(resolve(state, "profiles/codex--local/profile.env"), "AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=local\n");
      writeFileSync(resolve(localHome, ".codex/hooks.json"), '{"local":"preserve"}\n');
      const existing = spawnSync("bash", [enginePath, "run", "codex", "--name", "local", "--no-lb", "--no-login"], {
        cwd: home, env, encoding: "utf8",
      });
      expect(existing.status, existing.stderr).toBe(0);
      const localHooks = resolve(localHome, ".codex/hooks.json");
      expect(lstatSync(localHooks).isSymbolicLink()).toBe(false);
      expect(readFileSync(localHooks, "utf8")).toBe('{"local":"preserve"}\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
