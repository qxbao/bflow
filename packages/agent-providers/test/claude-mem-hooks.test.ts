import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveCodexHooks, createManagedCodexHookEnvironment, inspectCodexHooks } from "../src/codex-hook-trust.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-memory-hooks-")));
  roots.push(root);
  const home = join(root, ".codex");
  const plugin = join(home, "plugins/cache/claude-mem-local/claude-mem/14.0.1");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
  await mkdir(join(plugin, "hooks"), { mode: 0o700 });
  await mkdir(join(plugin, "scripts"), { mode: 0o700 });
  await writeFile(join(plugin, ".codex-plugin/plugin.json"), '{"name":"claude-mem","hooks":"./hooks/codex-hooks.json"}', { mode: 0o600 });
  const hookSource = join(plugin, "hooks/codex-hooks.json");
  await writeFile(hookSource, await readFile(new URL("./fixtures/claude-mem-codex-hooks.json", import.meta.url)), { mode: 0o600 });
  await writeFile(join(home, "config.toml"), '[plugins."claude-mem@claude-mem-local"]\nenabled=true\n', { mode: 0o600 });
  for (const script of ["bun-runner.js", "worker-service.cjs"])
    await writeFile(join(plugin, "scripts", script), "throw new Error('inspection must never execute hook code');\n", { mode: 0o600 });
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  for (const name of ["node", "bun"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 91\n", { mode: 0o700 });
  const options = { codexHomeDirectory: home, approvalStorePath: join(root, "state/bflow/codex-hook-approvals.json"),
    environment: { HOME: root, PATH: `${bin}:/usr/bin:/bin` } };
  return { root, home, plugin, bin, options, hookSource };
}

describe("reviewed claude-mem shell hooks", () => {
  it("inventories all six installed hook commands and pins their scripts and Node/Bun without executing them", async () => {
    const { plugin, bin, options } = await fixture();
    // Match the real bundled worker's size, which exceeds the generic 2 MiB
    // script limit; inspection must remain bounded without rejecting this bundle.
    await writeFile(join(plugin, "scripts/worker-service.cjs"), "//" + "x".repeat(4 * 1024 * 1024));
    const review = await inspectCodexHooks(options);
    expect(review.unsupportedReasons).toEqual([]);
    expect(review.status).toBe("approval_required");
    expect(review.hooks).toHaveLength(6);
    for (const hook of review.hooks) expect(hook.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedPath: join(plugin, "scripts/bun-runner.js"), exists: true }),
      expect.objectContaining({ requestedPath: join(plugin, "scripts/worker-service.cjs"), exists: true }),
      expect.objectContaining({ requestedPath: join(bin, "node"), exists: true }),
      expect.objectContaining({ requestedPath: join(bin, "bun"), exists: true })
    ]));
    await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "operator" });
    expect((await inspectCodexHooks(options)).status).toBe("approved");
    await writeFile(join(plugin, "scripts/worker-service.cjs"), "throw new Error('changed');\n");
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
  });

  it("invalidates approval when a new fallback installation becomes selectable", async () => {
    const { root, options } = await fixture();
    const first = await inspectCodexHooks(options);
    await approveCodexHooks(first, { ...options, expectedDigest: first.digest, approvedBy: "operator" });
    const fallback = join(root, ".claude/plugins/cache/thedotmack/claude-mem/15.0.0/scripts");
    await mkdir(fallback, { recursive: true, mode: 0o700 });
    await writeFile(join(fallback, "bun-runner.js"), "// fallback runner\n", { mode: 0o600 });
    await writeFile(join(fallback, "worker-service.cjs"), "// fallback worker\n", { mode: 0o600 });
    const changed = await inspectCodexHooks(options);
    expect(changed.status).toBe("approval_required");
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.hooks[0]?.dependencies).toContainEqual(expect.objectContaining({ requestedPath: join(fallback, "worker-service.cjs"), exists: true }));
  });

  it.each(["changed command", "symlinked script", "relative selector", "trimmed Bun selector", "empty PATH"])("keeps %s unsupported", async failure => {
    const { root, plugin, options, hookSource } = await fixture();
    if (failure === "changed command") await writeFile(hookSource, (await readFile(hookSource, "utf8")).replace("hook codex context", "hook codex context; touch /tmp/must-never-execute"));
    if (failure === "symlinked script") {
      const script = join(plugin, "scripts/worker-service.cjs");
      await rm(script);
      await writeFile(join(root, "outside.cjs"), "// outside\n", { mode: 0o600 });
      await symlink(join(root, "outside.cjs"), script);
    }
    const environment = { ...options.environment,
      ...(failure === "relative selector" ? { CLAUDE_PLUGIN_ROOT: "relative-plugin" } : {}),
      ...(failure === "trimmed Bun selector" ? { BUN: join(root, "bun ") } : {}),
      ...(failure === "empty PATH" ? { PATH: "" } : {}) };
    const review = await inspectCodexHooks({ ...options, environment });
    expect(review.status).toBe("unsupported");
    await expect(approveCodexHooks(review, { ...options, environment, expectedDigest: review.digest, approvedBy: "operator" })).rejects.toThrow();
  });

  it("pins explicit selector roots and runtime changes into the approved snapshot", async () => {
    const { root, plugin, bin, options } = await fixture();
    const environment = { ...options.environment, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_CONFIG_DIR: join(root, "claude-config") };
    const first = await inspectCodexHooks({ ...options, environment });
    expect(first.status).toBe("approval_required");
    await approveCodexHooks(first, { ...options, environment, expectedDigest: first.digest, approvedBy: "operator" });
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
    await writeFile(join(bin, "bun"), "#!/bin/sh\nexit 92\n");
    expect((await inspectCodexHooks({ ...options, environment })).status).toBe("approval_required");
    expect(createManagedCodexHookEnvironment(environment, root)).toMatchObject({ CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR });
  });

  it.each(["oversized worker", "symlinked fallback", "too many fallbacks"])("rejects %s without approving an incomplete inventory", async failure => {
    const { root, plugin, options } = await fixture();
    if (failure === "oversized worker") await writeFile(join(plugin, "scripts/worker-service.cjs"), Buffer.alloc(8 * 1024 * 1024 + 1));
    else {
      const cache = join(root, ".claude/plugins/cache/thedotmack/claude-mem");
      await mkdir(cache, { recursive: true, mode: 0o700 });
      if (failure === "symlinked fallback") await symlink(plugin, join(cache, "15.0.0"));
      else for (let index = 0; index < 16; index++) await mkdir(join(cache, `${index}.0.0`), { mode: 0o700 });
    }
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("unsupported");
    await expect(approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "operator" })).rejects.toThrow();
  });

  it("pins the Node executable selected by physical symlink/.. PATH traversal", async () => {
    const { root, options } = await fixture();
    const actual = join(root, "actual");
    await mkdir(join(actual, "child"), { recursive: true, mode: 0o700 });
    await symlink(join(actual, "child"), join(root, "link"));
    await writeFile(join(actual, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await writeFile(join(root, "node"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    const review = await inspectCodexHooks({ ...options, environment: { ...options.environment, PATH: `${root}/link/..:${options.environment.PATH}` } });
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies).toContainEqual(expect.objectContaining({ resolvedPath: join(actual, "node") }));
  });

  it("skips a dangling Bun override like the real runner's existsSync lookup", async () => {
    const { root, bin, options } = await fixture();
    await rm(join(bin, "bun"));
    const bun = join(root, "selected-bun");
    await writeFile(bun, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const dangling = join(root, "dangling-bun");
    await symlink(join(root, "missing"), dangling);
    const review = await inspectCodexHooks({ ...options, environment: {
      ...options.environment, PATH: `${bin}:/usr/bin:/bin`, BUN: dangling, BUN_PATH: bun
    } });
    expect(review.unsupportedReasons).toEqual([]);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies).toContainEqual(expect.objectContaining({ resolvedPath: bun }));
  });

  it.each(["CLAUDE_CONFIG_DIR", "HOME"])("rejects %s with parent traversal before lexical joining can pin the wrong root", async key => {
    const { root, options } = await fixture();
    const review = await inspectCodexHooks({ ...options, environment: { ...options.environment, [key]: `${root}/absent/../redirect` } });
    expect(review.status).toBe("unsupported");
    await expect(approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "operator" })).rejects.toThrow();
  });
});
