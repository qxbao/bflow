import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSosRoleConfig } from "@bflow/runtime";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "../src/config-format.js";
import {
  defaultEnvironmentConfig,
  EnvironmentConfigEnvironmentSchema,
  EnvironmentRoleConfigSchema
} from "../src/environment-config.js";

describe("configuration YAML format", () => {
  it("parses ordinary YAML with comments and renders editable roles before policy and storage", () => {
    const value = parseConfigYaml("# user choice\nenvironment:\n  roles:\n    - role: conversation\n      cli: codex\n      model: gpt-example\n  verification:\n    maxIterations: 3\nstorage:\n  runStorePath: .bflow/runs.db\n");
    const rendered = renderEnvironmentConfigYaml(value);
    expect(rendered).toContain("# effort is optional");
    expect(rendered.indexOf("roles:")).toBeLessThan(rendered.indexOf("verification:"));
    expect(rendered.indexOf("environment:")).toBeLessThan(rendered.indexOf("storage:"));
    expect(parseConfigYaml(rendered)).toEqual(value);
  });

  it("validates optional model and provider-neutral effort while rejecting Agy effort", () => {
    expect(EnvironmentRoleConfigSchema.parse({ role: "coordinator", cli: "codex", model: "gpt-model", effort: "xhigh" }))
      .toMatchObject({ model: "gpt-model", effort: "xhigh" });
    expect(EnvironmentRoleConfigSchema.parse({ role: "coordinator", cli: "codex", "profile-name": "lead" }))
      .toMatchObject({ "profile-name": "lead" });
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "codex", profileName: "lead" }).success).toBe(false);
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "agy", effort: "high" }).success).toBe(false);
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "claude", effort: "invalid" }).success).toBe(false);
  });

  it.each(["", "  ", "../outside", "profile/name", "profile\\name", "profile\u0000name", "profile\u0085name"])(
    "rejects unsafe profile names (%j)", profileName => {
      expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "codex", "profile-name": profileName }).success).toBe(false);
    }
  );

  it.each([" work", "work ", "\twork", "work\n", "work\u007f"])(
    "rejects profile names with whitespace or control characters (%j)", profileName => {
      expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "codex", "profile-name": profileName }).success).toBe(false);
    }
  );

  it("accepts a long safe ASCII profile name without trimming or an arbitrary length cap", () => {
    const profileName = "p".repeat(256);
    expect(EnvironmentRoleConfigSchema.parse({ role: "coordinator", cli: "codex", "profile-name": profileName })["profile-name"]).toBe(profileName);
  });

  it("accepts strict provider profile defaults without changing the no-profile configuration", () => {
    const environment = {
      repositoryId: "repo-id",
      workspaceRoot: "/workspace",
      sessionName: "bf-session",
      herdrBinary: "herdr",
      roles: [
        { role: "conversation", cli: "claude" },
        { role: "coordinator", cli: "codex", model: "gpt-model", effort: "high", "profile-name": "lead" }
      ],
      defaults: {
        codex: { "profile-name": "work" },
        claude: { "profile-name": "personal" },
        agy: { "profile-name": "work" }
      },
      sdd: { minimumLevel: "lightweight", approvalRequired: true },
      tdd: { policy: "conditional" },
      verification: { maxIterations: 3, onExhausted: "require_human" },
      concurrency: { maxConcurrency: 2 },
      startupTimeoutMs: 300_000,
      shutdownTimeoutMs: 30_000
    };

    const parsed = EnvironmentConfigEnvironmentSchema.parse(environment);
    expect(parsed.defaults).toEqual(environment.defaults);
    expect(parsed.fastPath).toEqual({ mode: "auto" });
    expect(parsed.roles[1]).toMatchObject({ model: "gpt-model", effort: "high", "profile-name": "lead" });
    expect(EnvironmentConfigEnvironmentSchema.parse({ ...environment, defaults: undefined }).defaults).toBeUndefined();
    expect(EnvironmentConfigEnvironmentSchema.safeParse({ ...environment, defaults: { gemini: { "profile-name": "work" } } }).success).toBe(false);
    expect(EnvironmentConfigEnvironmentSchema.safeParse({ ...environment, defaults: { codex: { "profile-name": "work", model: "unsafe-extra" } } }).success).toBe(false);
    expect(EnvironmentConfigEnvironmentSchema.safeParse({ ...environment, defaults: { codex: { "profile-name": "../outside" } } }).success).toBe(false);
    expect(EnvironmentConfigEnvironmentSchema.safeParse({ ...environment, defaults: { codex: { "profile-name": 42 } } }).success).toBe(false);
    expect(EnvironmentConfigEnvironmentSchema.safeParse({ ...environment, unexpected: true }).success).toBe(false);
  });

  it("renders runnable provider defaults and role profile overrides as comments and round-trips YAML", () => {
    const value = {
      environment: {
        defaults: {
          codex: { "profile-name": "work" },
          claude: { "profile-name": "personal" },
          agy: { "profile-name": "work" }
        },
        roles: [{ role: "coordinator", cli: "codex", "profile-name": "lead", model: "gpt-model", effort: "high" }]
      }
    };
    const rendered = renderEnvironmentConfigYaml(value);
    expect(rendered).toContain("#   codex:");
    expect(rendered).toContain("#     profile-name: work");
    expect(rendered).toContain("#   profile-name: lead");
    expect(rendered).toContain("Missing profiles");
    expect(parseConfigYaml(rendered)).toEqual(value);
  });

  it("does not alter values containing config key text when inserting comments", () => {
    const value = { environment: { roles: [{ role: "developer", cli: "codex", model: "literal projectName: value" }], sdd: { minimumLevel: "lightweight", approvalRequired: true } }, projectName: "projectName: stays data" };
    expect(parseConfigYaml(renderEnvironmentConfigYaml(value))).toEqual(value);
  });

  it("populates all default values in defaultEnvironmentConfig and documents enums clearly in rendered YAML", () => {
    const repository = {
      id: "repo-1234567890abcdef12345678",
      root: "/workspace/demo",
      sessionName: "bf-1234567890abcdef1234"
    };
    const config = defaultEnvironmentConfig(repository, "full-defaults", new Date("2026-10-18T00:00:00.000Z"), "agy");
    expect(config.environment).toMatchObject({
      defaults: { codex: {}, claude: {}, agy: {} },
      sdd: { minimumLevel: "lightweight", approvalRequired: true },
      tdd: { policy: "conditional" },
      verification: { maxIterations: 3, onExhausted: "require_human" },
      fastPath: { mode: "auto" },
      concurrency: { maxConcurrency: 2 },
      startupTimeoutMs: 300_000,
      shutdownTimeoutMs: 30_000,
      allowProviderFallback: false,
      permissions: {
        mode: "workspace_auto",
        isolation: "provider_policy",
        trustedWorkspace: true
      },
      tools: {
        rtk: { enabled: true, required: false },
        gitnexus: { enabled: true, required: false },
        mempalace: { enabled: true, required: false },
        "chrome-devtools-mcp": { enabled: true, required: false }
      },
      context7: {
        enabled: true,
        required: false,
        cache: {
          enabled: false,
          ttlSeconds: 3_600,
          allowAuthenticated: false
        }
      },
      skills: {
        required: false,
        requiredSkills: []
      }
    });
    const rendered = renderEnvironmentConfigYaml(config);
    expect(rendered).toContain("enum: `codex` | `claude` | `agy`");
    expect(rendered).toContain("enum: `minimal` | `low` | `medium` | `high` | `xhigh` | `max`");
    expect(rendered).toContain("enum: `restricted` | `workspace_auto` | `unattended_isolated`");
    expect(rendered).toContain("enum: `provider_policy` | `os_sandbox` | `container`");
    expect(rendered).toContain("enum: `lightweight` | `full`");
    expect(rendered).toContain("regressionScope: affected | full | mapped_only");
    expect(rendered).toContain("reviewTimeoutMs : (integer ms: `60000..3600000`, mặc định: `900000`)");
    expect(rendered).toContain("bflow init --update");
    expect(parseConfigYaml(rendered)).toEqual(config);
  });

  it("renders fastPath banner in Vietnamese", () => {
    const repository = {
      id: "repo-1234567890abcdef12345678",
      root: "/workspace/demo",
      sessionName: "bf-1234567890abcdef1234"
    };
    const config = defaultEnvironmentConfig(repository, "fastpath-banner", new Date("2026-10-18T00:00:00.000Z"), "codex");
    const rendered = renderEnvironmentConfigYaml(config);
    expect(rendered).toContain("# Fast-path: thay đổi nhỏ (trivial) chạy ít bước hơn và tự duyệt design; bạn vẫn duyệt bàn giao. mode: auto | off (mặc định: auto).");
    expect(rendered.indexOf("verification:")).toBeLessThan(rendered.indexOf("fastPath:"));
    expect(rendered.indexOf("fastPath:")).toBeLessThan(rendered.indexOf("concurrency:"));
    expect(parseConfigYaml(rendered)).toEqual(config);
  });

  it("generates an optional sos rescue role and validates its supported fields", () => {
    const repository = { id: "repo-1234567890abcdef1234", root: "/workspace/demo", sessionName: "bf-1234567890abcdef1234" };
    const config = defaultEnvironmentConfig(repository, "sos-defaults", new Date("2026-10-18T00:00:00.000Z"), "claude");
    expect(config.environment.roles).toContainEqual({ role: "sos", cli: "claude", required: false });
    expect(config.environment.roles.find(role => role.role === "developer")?.required).toBe(false);
    expect(config.environment.roles.filter(role => role.role !== "developer" && role.role !== "sos").every(role => role.required === true)).toBe(true);
    expect(renderEnvironmentConfigYaml(config)).toContain("#   - sos          : Emergency rescue agent");
    expect(EnvironmentRoleConfigSchema.parse({ role: "sos", cli: "codex", model: "gpt-model", effort: "high", "profile-name": "rescue", fallbackCli: "claude", required: false }))
      .toMatchObject({ role: "sos", model: "gpt-model", effort: "high", "profile-name": "rescue", fallbackCli: "claude" });
    const specialistProfile = { profileId: "rescue", version: "1.0.0", digest: "a".repeat(64) };
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "reviewer", cli: "codex", specialistProfile }).success).toBe(true);
    const rejected = EnvironmentRoleConfigSchema.safeParse({ role: "sos", cli: "codex", specialistProfile });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues).toContainEqual(expect.objectContaining({ path: ["specialistProfile"], message: "The sos role cannot select a specialist profile." }));
    const failover = { schemaVersion: 3, policyVersion: "v1", role: "coordinator", candidates: [], maxSwitches: 0, cooldownMs: 0, maxRetries: 0 };
    const withFailover = EnvironmentRoleConfigSchema.safeParse({ role: "sos", cli: "codex", model: "m", "profile-name": "p", failover });
    expect(withFailover.success).toBe(false);
    expect(withFailover.error?.issues).toContainEqual(expect.objectContaining({ path: ["failover"], message: "The sos role does not support failover." }));
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "rescue", cli: "codex" }).success).toBe(false);
  });

  it("lets the dependency-free Runtime reader resolve role: sos from the rendered config", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-sos-config-"));
    try {
      const repository = { id: "repo-1234567890abcdef1234", root, sessionName: "bf-1234567890abcdef1234" };
      const config = defaultEnvironmentConfig(repository, "sos-render", new Date("2026-10-18T00:00:00.000Z"), "codex");
      await mkdir(join(root, ".bflow"));
      await writeFile(join(root, ".bflow/config.yml"), renderEnvironmentConfigYaml(config));
      expect(await resolveSosRoleConfig(root, "claude")).toMatchObject({ provider: "codex", source: "config" });
      const customized = { ...config, environment: { ...config.environment,
        defaults: { ...config.environment.defaults, claude: { "profile-name": "personal" } },
        roles: config.environment.roles.map(role => role.role === "sos"
          ? { role: "sos" as const, cli: "claude", model: "claude-model", effort: "max" as const, fallbackCli: "codex" as const, required: false } : role) } };
      await writeFile(join(root, ".bflow/config.yml"), renderEnvironmentConfigYaml(customized));
      expect(await resolveSosRoleConfig(root, "codex")).toEqual({ provider: "claude", model: "claude-model", effort: "max", profileName: "personal",
        fallbackCli: "codex", source: "config", configPath: join(root, ".bflow/config.yml") });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["duplicate keys", "name: one\nname: two\n"],
    ["multiple documents", "name: one\n---\nname: two\n"],
    ["explicit tags", "name: !!str one\n"],
    ["non-string keys", "1: value\n"],
    ["merge keys", "base: &base {x: 1}\ncopy: {<<: *base}\n"],
    ["cyclic aliases", "value: &value [*value]\n"],
    ["too many aliases", "base: &base {x: 1}\nitems: [" + Array.from({ length: 33 }, () => "*base").join(", ") + "]\n"]
  ])("rejects %s", (_name, input) => {
    expect(() => parseConfigYaml(input)).toThrow();
  });
});
