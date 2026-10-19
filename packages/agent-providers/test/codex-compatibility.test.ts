import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveCodexHooks, inspectCodexHooks, type CodexHookTrustOptions } from "../src/codex-hook-trust.js";
import { parseCodexTomlHooks } from "../src/codex-hook-toml.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-codex-compat-")));
  roots.push(root);
  const home = join(root, "codex");
  await mkdir(home, { mode: 0o700 });
  const options: CodexHookTrustOptions = { codexHomeDirectory: home, approvalStorePath: join(root, "state", "approvals.json"),
    environment: { HOME: root, PATH: "/usr/bin:/bin" } };
  const hook = async (command: string) => writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command }] }]
  } }), { mode: 0o600 });
  return { root, home, options, hook };
}

describe("installed Codex compatibility", () => {
  async function pluginFixture(id: string, declaration: unknown) {
    const fixtureValue = await fixture();
    const [name, marketplace] = id.split("@");
    const plugin = join(fixtureValue.home, "plugins/cache", marketplace!, name!, "1.0.0");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
    await writeFile(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name, hooks: declaration }), { mode: 0o600 });
    const config = `[plugins.${JSON.stringify(id)}]\nenabled=true\n`;
    await writeFile(join(fixtureValue.home, "config.toml"), config, { mode: 0o600 });
    return { ...fixtureValue, plugin, config };
  }

  it("accepts an empty inline plugin hook declaration without reading fallback hooks", async () => {
    const { plugin, options } = await pluginFixture("empty@local", {});
    await mkdir(join(plugin, "hooks"), { mode: 0o700 });
    await writeFile(join(plugin, "hooks/hooks.json"), "malformed fallback", { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("none");
    expect(review.unsupportedReasons).toEqual([]);
    expect(review.sources.some(source => source.kind === "plugin_manifest")).toBe(true);
  });

  it.each([null, { unexpected: true }, { hooks: null }, [[{}]]])("rejects malformed inline plugin hooks %j", async declaration => {
    const { options } = await pluginFixture("malformed@local", declaration);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("still rejects a global hooks.json with no hooks object", async () => {
    const { home, options } = await fixture();
    await writeFile(join(home, "hooks.json"), "{}", { mode: 0o600 });
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it.each(["claude-mem@claude-mem-local", "claude-mem@thedotmack"])("excludes %s only under the managed child disable policy", async id => {
    const { home, plugin, options, config } = await pluginFixture(id, { hooks: {
      Stop: [{ hooks: [{ type: "command", command: "$(touch /tmp/must-never-execute)" }] }]
    } });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("none");
    expect(review.diagnostics.join(" ")).toContain(`plugins.${id}.enabled=false`);
    expect(review.sources.some(source => source.path.startsWith(plugin))).toBe(false);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
    await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: "$(touch /tmp/must-never-execute)" }] }]
    } }), { mode: 0o600 });
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("keeps dynamic hooks blocked for the same plugin name in another marketplace", async () => {
    const { options } = await pluginFixture("claude-mem@unrelated", { hooks: {
      Stop: [{ hooks: [{ type: "command", command: "$(touch /tmp/must-never-execute)" }] }]
    } });
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("requires execute permission for a direct script while allowing explicit shell reads", async () => {
    const { home, options, hook } = await fixture();
    const script = join(home, "readable.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    await hook(`'${script}'`);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    await hook(`bash '${script}'`);
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
  });
  it.each(["sh", "bash"])("pins the actual interpreter for direct .%s scripts and rejects env shebangs", async (extension) => {
    const { home, options, hook } = await fixture();
    const script = join(home, `direct.${extension}`);
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await hook(`'${script}' literal-argument`);
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies.map(dep => dep.requestedPath)).toContain("/bin/sh");
    await writeFile(script, "#!/usr/bin/env bash\nexit 0\n");
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it.each(['. "$DYNAMIC_SOURCE"', 'eval "$RUNTIME_CODE"'])("checks extensionless explicit shell scripts for %s", async (body) => {
    const { home, options, hook } = await fixture();
    const script = join(home, "extensionless");
    await writeFile(script, `#!/bin/sh\n${body}\n`, { mode: 0o600 });
    await hook(`bash '${script}'`);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("pins a script passed to Bash installed outside the system bin directories", async () => {
    const { root, home, options, hook } = await fixture();
    const bin = join(root, "custom-bin");
    await mkdir(bin, { mode: 0o700 });
    const bash = join(bin, "bash");
    const script = join(home, "task-script");
    await writeFile(bash, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(script, "exit 0\n", { mode: 0o600 });
    await hook(`'${bash}' '${script}'`);
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies.map(dep => dep.requestedPath)).toContain(script);
    await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "test-operator" });
    await writeFile(script, "exit 1\n");
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
  });

  it("does not copy command argument credentials into hook failure reasons", async () => {
    const { options, hook } = await fixture();
    await hook('relative-tool --password "synthetic-private-value"');
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("unsupported");
    expect(review.unsupportedReasons.join(" ")).not.toContain("synthetic-private-value");
    expect(review.hooks[0]?.command).toContain("synthetic-private-value");
  });

  it("accepts plugin-scoped native trust metadata without making it executable or approved", () => {
    expect(parseCodexTomlHooks('[hooks.state."example-plugin@example-marketplace:hooks/codex-hooks.json:pre_tool_use:0:0"]\nenabled=true\ntrusted_hash="abc"')).toEqual({});
    expect(() => parseCodexTomlHooks('[hooks.state."mem@local:../escape.json:Stop:0:0"]\nenabled=true')).toThrow();
  });

  it("pins a direct executable, literal arguments and its absolute shebang interpreter", async () => {
    const { home, options, hook } = await fixture();
    const script = join(home, "graphify");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await hook(`'${script}' hook-check`);
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies.map(dep => dep.requestedPath)).toEqual(expect.arrayContaining([script, "/bin/sh"]));
    await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "test-operator" });
    await hook(`'${script}' other-command`);
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
    await chmod(script, 0o777);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("refuses ambiguous shebang resolution and shell controls for direct commands", async () => {
    const { home, options, hook } = await fixture();
    const script = join(home, "dynamic");
    await writeFile(script, "#!/usr/bin/env python3\nprint('no execution')\n", { mode: 0o700 });
    await hook(`${script} hook-check`);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    await hook(`${script} hook-check; touch /tmp/never-run`);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("rejects unquoted tilde expansion instead of approving it as a literal argument", async () => {
    const { home, options, hook } = await fixture();
    const script = join(home, "tool");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await hook(`${script} ~/dynamic-target`);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("pins the actual shell word when double quotes preserve a backslash", async () => {
    const { home, options, hook } = await fixture();
    const actual = join(home, "\\hook.sh");
    await writeFile(actual, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    await writeFile(join(home, "hook.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o600 });
    await hook(`bash "${home}/\\hook.sh"`);
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies.map(dep => dep.requestedPath)).toContain(actual);
  });

  it("inventories enabled plugin hooks and invalidates their approvals on source drift", async () => {
    const { home, options } = await fixture();
    const plugin = join(home, "plugins/cache/local/memory/1.0.0");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
    await mkdir(join(plugin, "hooks"), { mode: 0o700 });
    const script = join(plugin, "hook.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "memory", hooks: "./hooks/custom.json" }), { mode: 0o600 });
    const source = join(plugin, "hooks/custom.json");
    await writeFile(source, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: script }] }] } }), { mode: 0o600 });
    await writeFile(join(home, "config.toml"), '[plugins."memory@local"]\nenabled=true\n', { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.sources).toContainEqual(expect.objectContaining({ path: source, exists: true }));
    await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "test-operator" });
    await writeFile(script, "#!/bin/sh\nexit 1\n");
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
    const bytes = await readFile(source);
    await writeFile(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "memory", hooks: "../outside.json" }));
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    expect(await readFile(source)).toEqual(bytes);
  });

  it("fails closed when an enabled plugin cannot be resolved instead of silently dropping its hooks", async () => {
    const { home, options } = await fixture();
    await writeFile(join(home, "config.toml"), '[plugins."missing@local"]\nenabled=true\n', { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("unsupported");
    expect(review.unsupportedReasons.join(" ")).toContain("missing@local");
  });

  it.each(["ambiguous", "symlink", "dynamic"])("keeps %s plugin hooks blocked before approval", async (failure) => {
    const { home, options } = await fixture();
    const plugin = join(home, "plugins/cache/local/memory/1.0.0");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
    await mkdir(join(plugin, "hooks"), { mode: 0o700 });
    await writeFile(join(plugin, ".codex-plugin/plugin.json"), '{"name":"memory"}', { mode: 0o600 });
    const source = join(plugin, "hooks/hooks.json");
    const content = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "$(touch /tmp/must-never-execute)" }] }] } });
    if (failure === "symlink") {
      const outside = join(home, "outside.json");
      await writeFile(outside, content, { mode: 0o600 });
      await symlink(outside, source);
    } else await writeFile(source, content, { mode: 0o600 });
    if (failure === "ambiguous") await mkdir(join(home, "plugins/cache/local/memory/2.0.0"), { mode: 0o700 });
    await writeFile(join(home, "config.toml"), '[plugins."memory@local"]\nenabled=true\n', { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("unsupported");
    await expect(approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "test-operator" })).rejects.toThrow();
  });
});
