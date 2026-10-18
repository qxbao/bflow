import { describe, expect, it } from "vitest";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "../src/config-format.js";
import { EnvironmentRoleConfigSchema } from "../src/environment-config.js";

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
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "agy", effort: "high" }).success).toBe(false);
    expect(EnvironmentRoleConfigSchema.safeParse({ role: "coordinator", cli: "claude", effort: "invalid" }).success).toBe(false);
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
