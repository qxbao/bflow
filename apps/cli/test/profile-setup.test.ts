import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandRunner, SetupContext } from "@bflow/machine-setup";
import { isPathWithin, ProfileSetupComponent, resolveProfileSetupOptions } from "../src/profile-setup.js";

const digest = "a".repeat(64);
const target = "/home/operator/.local/share/ai-isolator/profiles/codex--work/home";
const report = (valid = true, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, valid, desiredDigest: digest, stateDigest: valid ? digest : null,
  profileCount: 1, targets: [target], ownedPaths: [target + "/.codex/config.toml"], diagnostics: [], ...overrides
});

function fixture(mode: SetupContext["mode"] = "apply", responses: unknown[] = []) {
  const commands: string[][] = [];
  const runner: CommandRunner = { run: vi.fn(async argv => {
    commands.push([...argv]);
    if (argv[1] === "-c") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    const next = responses.shift() ?? report();
    return { exitCode: 0, stdout: JSON.stringify(next), stderr: "", timedOut: false };
  }) };
  const context = { mode, runner, now: () => new Date(),
    platform: { machineId: "machine", os: "linux" } } as SetupContext;
  return { commands, runner, context };
}

function component(expectedIdentity = "superpowers:7.0.0") {
  return new ProfileSetupComponent({
    helperPath: "/bflow/apps/cli/isolation/lib/profile_sync.py",
    sourceHome: "/home/operator",
    stateRoot: "/home/operator/.local/share/ai-isolator",
    sourceCodexHome: "/home/operator/.codex",
    sourceClaudeConfigDir: "/home/operator/.claude",
    sourceCodexSkills: "/home/operator/.codex/skills",
    expectedIdentity
  });
}

describe("ProfileSetupComponent", () => {
  it("invokes inspect with trusted absolute source and state paths and exposes concrete targets", async () => {
    const { commands, context } = fixture("check", [report()]);
    const setup = component();
    const desired = await setup.desired(context);
    expect(commands[1]).toEqual(expect.arrayContaining([
      "inspect", "--source-home", "/home/operator", "--state-root", "/home/operator/.local/share/ai-isolator",
      "--source-codex-home", "/home/operator/.codex",
      "--source-claude-config-dir", "/home/operator/.claude",
      "--source-codex-skills", "/home/operator/.codex/skills"
    ]));
    expect(desired.targets).toEqual([target]);
    expect(desired.machineWide).toBe(true);
  });

  it("omits the Claude config override unless one was explicitly selected", async () => {
    const { commands, context } = fixture("check", [report()]);
    await new ProfileSetupComponent({
      helperPath: "/bflow/apps/cli/isolation/lib/profile_sync.py",
      sourceHome: "/home/operator", stateRoot: "/home/operator/.local/share/ai-isolator",
      expectedIdentity: "pin"
    }).desired(context);
    expect(commands.find(command => command[1]?.endsWith("profile_sync.py")))
      .not.toContain("--source-claude-config-dir");
  });

  it("resolves native and BFLOW_HOME sources without crossing account boundaries", () => {
    const base = {
      helperPath: "/bundle/profile_sync.py",
      homeDirectory: "/home/isolated-profile",
      expectedIdentity: "pin"
    };
    const native = resolveProfileSetupOptions({
      ...base,
      environment: { AI_ISOLATOR_REAL_HOME: "/home/real" }
    });
    expect(native.sourceHome).toBe("/home/real");
    expect(native.sourceClaudeConfigDir).toBeUndefined();

    const explicit = resolveProfileSetupOptions({
      ...base,
      environment: { CLAUDE_CONFIG_DIR: "/config/claude" }
    });
    expect(explicit.sourceClaudeConfigDir).toBe("/config/claude");

    const isolated = resolveProfileSetupOptions({
      ...base,
      isolatedRoot: "/machine/bflow",
      environment: {
        HOME: "/home/real",
        AI_ISOLATOR_REAL_HOME: "/home/real",
        CODEX_HOME: "/home/real/.codex",
        CLAUDE_CONFIG_DIR: "/home/real/.claude"
      }
    });
    expect(isolated.sourceHome).toBe("/machine/bflow/providers/home");
    expect(isolated.stateRoot).toBe("/home/real/.local/share/ai-isolator");
    expect(isolated.sourceCodexHome).toBe("/machine/bflow/providers/codex");
    expect(isolated.sourceClaudeConfigDir).toBe("/machine/bflow/providers/claude");
    expect(isolated.expectedIdentity).toContain("/home/real/.local/share/ai-isolator");
    expect(isolated.expectedIdentity).toContain("/machine/bflow/providers/codex");
    expect(isolated.expectedIdentity).toContain("/machine/bflow/providers/claude");
  });

  it("uses the explicit shared profile root even when BFLOW_HOME is set", () => {
    const options = resolveProfileSetupOptions({
      helperPath: "/bundle/profile_sync.py",
      homeDirectory: "/home/real",
      isolatedRoot: "/machine/bflow",
      environment: {
        AI_ISOLATOR_HOME: "/shared/custom-profiles",
        CODEX_HOME: "/home/real/.codex",
        CLAUDE_CONFIG_DIR: "/home/real/.claude"
      },
      expectedIdentity: "pin"
    });
    expect(options.stateRoot).toBe("/shared/custom-profiles");
    expect(options.sourceHome).toBe("/machine/bflow/providers/home");
    expect(options.sourceCodexHome).toBe("/machine/bflow/providers/codex");
    expect(options.sourceClaudeConfigDir).toBe("/machine/bflow/providers/claude");
  });

  it("converges explicitly when there are no existing profiles", async () => {
    const empty = report(true, { profileCount: 0, targets: [], stateDigest: null, ownedPaths: [] });
    const desiredContext = fixture("check", [empty]);
    const observeContext = fixture("check", [empty]);
    const setup = component();
    const desired = await setup.desired(desiredContext.context);
    const observed = await setup.observe(observeContext.context);
    expect(desired.targets).toEqual([]);
    expect(observed.valid).toBe(true);
    expect(observed.stateDigest).toBe(desired.digest);
  });

  it("accepts an explicit no-profile apply without inventing profile directories", async () => {
    const empty = report(true, { profileCount: 0, targets: [], stateDigest: null, ownedPaths: [] });
    const { commands, context } = fixture("apply", [empty, empty]);
    expect(await component().apply(context)).toEqual({ ownedPaths: [], diagnostics: [] });
    expect(commands.filter(command => command[1]?.endsWith("profile_sync.py")).map(command => command[2]))
      .toEqual(["apply", "inspect"]);
  });

  it("rejects helper paths outside the selected profile tree", async () => {
    const { context } = fixture("check", [report(true, { targets: ["/home/operator/.ssh"] })]);
    const observed = await component().observe(context);
    expect(observed.valid).toBe(false);
    expect(observed.diagnostics[0]).toContain("out-of-scope");
  });

  it("allows only the exact private receipt sibling as an owned path", async () => {
    const receipt = target.replace(/[/\\]home$/, "/.bflow-profile-sync.json");
    const owned = [target + "/.codex/config.toml", receipt];
    const { commands, context } = fixture("apply", [report(true, { ownedPaths: owned }), report(true, { ownedPaths: owned })]);
    const result = await component().apply(context);
    expect(result.ownedPaths).toEqual(owned);
    expect(result.diagnostics).toEqual([]);
    expect(commands.filter(command => command[1]?.endsWith("profile_sync.py")).map(command => command[2]))
      .toEqual(["apply", "inspect"]);
  });

  it("rejects arbitrary profile-root sibling writes such as profile.env", async () => {
    const profileEnv = target.replace(/[/\\]home$/, "/profile.env");
    const { context } = fixture("check", [report(true, { ownedPaths: [profileEnv] })]);
    const observed = await component().observe(context);
    expect(observed.valid).toBe(false);
    expect(observed.diagnostics[0]).toContain("out-of-scope");
  });

  it("rejects cross-drive Windows relative paths", () => {
    expect(isPathWithin("C:\\ai-isolator\\profiles", "D:\\outside\\home", win32)).toBe(false);
    expect(isPathWithin("C:\\ai-isolator\\profiles", "C:\\ai-isolator\\profiles\\codex--work\\home", win32)).toBe(true);
  });

  it("treats reported drift and malformed helper output as unsatisfied", async () => {
    const drift = fixture("check", [report(false)]);
    expect((await component().observe(drift.context)).valid).toBe(false);

    const malformedRunner: CommandRunner = { run: vi.fn(async argv => argv[1] === "-c"
      ? { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      : { exitCode: 0, stdout: '{"valid":true}', stderr: "", timedOut: false }) };
    const invalid = await component().observe({ ...drift.context, runner: malformedRunner });
    expect(invalid.valid).toBe(false);
    expect(invalid.stateDigest).toBeNull();
    expect(invalid.diagnostics[0]).toContain("invalid inspect report");
  });

  it("applies through the helper and requires a successful read-back", async () => {
    const { commands, context } = fixture("apply", [report(), report(), report()]);
    const result = await component().apply(context);
    expect(commands.filter(command => command[1]?.endsWith("profile_sync.py")).map(command => command[2]))
      .toEqual(["apply", "inspect"]);
    expect(result.ownedPaths).toEqual([target + "/.codex/config.toml"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("never runs the helper apply command in check or dry-run mode", async () => {
    for (const mode of ["check", "dry_run"] as const) {
      const { commands, context } = fixture(mode);
      expect((await component().apply(context)).ownedPaths).toEqual([]);
      expect(commands).toEqual([]);
    }
  });

  it("binds the stable setup desired digest to the pinned plugin identity", async () => {
    const first = fixture("check", [report()]);
    const second = fixture("check", [report()]);
    const [a, b] = await Promise.all([
      component("superpowers:7.0.0").desired(first.context),
      component("superpowers:7.1.0").desired(second.context)
    ]);
    expect(a.digest).not.toBe(b.digest);
  });

  it("binds the plan identity to trusted roots without reading configuration contents", async () => {
    const make = (stateRoot: string) => new ProfileSetupComponent({
      helperPath: "/bflow/apps/cli/isolation/lib/profile_sync.py",
      sourceHome: "/home/operator",
      stateRoot,
      expectedIdentity: "superpowers:7.0.0"
    });
    const left = fixture("check", [report()]);
    const right = fixture("check", [report()]);
    expect((await make("/home/operator/.local/share/ai-isolator").desired(left.context)).digest)
      .not.toBe((await make("/machine/isolator").desired(right.context)).digest);
  });

  it("keeps the plan digest stable as source assets appear earlier in the approved plan", async () => {
    const first = fixture("check", [report(true, { desiredDigest: "b".repeat(64), stateDigest: "b".repeat(64) })]);
    const second = fixture("check", [report(true, { desiredDigest: "c".repeat(64), stateDigest: "c".repeat(64) })]);
    const [beforeInstall, afterInstall] = await Promise.all([
      component().desired(first.context), component().desired(second.context)
    ]);
    expect(beforeInstall.targets).toEqual(afterInstall.targets);
    expect(beforeInstall.digest).toBe(afterInstall.digest);
  });

  it("is an independently named, reviewable setup-plan component", () => {
    const setup = component();
    expect(setup).toMatchObject({ componentId: "isolator-profiles", action: "configure", rollback: "manual" });
  });
});
