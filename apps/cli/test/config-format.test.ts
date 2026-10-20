import { describe, expect, it } from "vitest";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "../src/config-format.js";
import { EnvironmentConfigEnvironmentSchema, EnvironmentRoleConfigSchema } from "../src/environment-config.js";

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
