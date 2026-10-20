import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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
      const env = { ...process.env, HOME: home, AI_ISOLATOR_HOME: resolve(home, "state"), PATH: process.env.PATH ?? "" };
      const help = spawnSync("bash", [enginePath, "--help"], { cwd: home, env, encoding: "utf8" });
      const version = spawnSync("bash", [enginePath, "--version"], { cwd: home, env, encoding: "utf8" });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("bflow iso codex");
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe("bflow iso 0.4.4");
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
      writeFileSync(resolve(bin, "python3"), `#!/usr/bin/env bash\nif [[ "$*" == *tomllib* ]]; then exit 1; fi\nif [[ "$1" == *mcp_sync.py ]]; then printf python3 >> "$AI_ISOLATOR_TEST_SELECTION"; fi\nexit 0\n`);
      writeFileSync(resolve(bin, "python"), `#!/usr/bin/env bash\nif [[ "$1" == *mcp_sync.py ]]; then printf python >> "$AI_ISOLATOR_TEST_SELECTION"; fi\nexec ${goodPython} "$@"\n`);
      writeFileSync(resolve(bin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
      for (const name of ["python3", "python", "codex"]) chmodSync(resolve(bin, name), 0o755);

      const env = {
        ...process.env,
        HOME: home,
        AI_ISOLATOR_HOME: resolve(home, "state"),
        AI_ISOLATOR_TEST_SELECTION: selected,
        PATH: `${bin}:/usr/bin:/bin`,
      };
      const result = spawnSync("/usr/bin/bash", [enginePath, "codex", "--name", "test", "--no-lb", "--no-login"], {
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
      const env = { ...process.env, HOME: home, AI_ISOLATOR_HOME: resolve(home, "state"), PATH: `${bin}:/usr/bin:/bin` };
      const result = spawnSync("/usr/bin/bash", [enginePath, "codex", "--name", "test", "--no-lb", "--no-login"], {
        cwd: home,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Codex MCP sync skipped");
      expect(result.stderr).toContain("Python 3.11+ with tomllib");
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
      const env = { ...process.env, HOME: home, AI_ISOLATOR_HOME: resolve(home, "state"), PATH: `${bin}:/usr/bin:/bin` };
      const create = spawnSync("/usr/bin/bash", [enginePath, "claude", "--name", "remove-me", "--no-login"], { cwd: home, env, encoding: "utf8" });
      const remove = spawnSync("/usr/bin/bash", [enginePath, "remove", "claude", "--name", "remove-me"], { cwd: home, env, encoding: "utf8" });
      const removeAgain = spawnSync("/usr/bin/bash", [enginePath, "remove", "claude", "--name", "remove-me"], { cwd: home, env, encoding: "utf8" });
      expect(create.status).toBe(0);
      expect(remove.status).toBe(0);
      expect(removeAgain.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clears inherited CLAUDE_CONFIG_DIR before launching Claude from a profile", () => {
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
        ...process.env,
        HOME: home,
        AI_ISOLATOR_HOME: resolve(home, "state"),
        CLAUDE_CONFIG_DIR: "/real/account/config",
        CLAUDE_TEST_LOG: log,
        PATH: `${bin}:/usr/bin:/bin`,
      };
      const result = spawnSync("/usr/bin/bash", [enginePath, "run", "claude", "--name", "isolated", "--", "--version"], {
        cwd: home,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const record = readFileSync(log, "utf8");
      expect(record).toContain(`HOME=${resolve(home, "state/profiles/claude--isolated/home")}`);
      expect(record).toContain("CLAUDE_CONFIG_DIR=unset");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
