import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveCodexHooks,
  trustAllCodexHooks,
  revokeAllCodexHookTrust,
  codexHookPolicyPath,
  defaultCodexHookApprovalPath,
  inspectCodexHooks,
  type CodexHookTrustOptions
} from "../src/codex-hook-trust.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(): Promise<{ root: string; home: string; store: string; options: CodexHookTrustOptions }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-codex-hooks-")));
  roots.push(root);
  const home = join(root, "codex-home");
  await mkdir(home, { mode: 0o700 });
  const store = join(root, "machine-state", "bflow", "codex-hook-approvals.json");
  return { root, home, store, options: { codexHomeDirectory: home, approvalStorePath: store, environment: { HOME: root, PATH: "/usr/bin:/bin" } } };
}

async function writeHook(home: string, script: string): Promise<string> {
  const hookPath = join(home, "hook.sh");
  await writeFile(hookPath, script, { mode: 0o700 });
  await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: { role: "developer" }, hooks: [{ type: "command", command: hookPath }] }]
  } }), { mode: 0o600 });
  return hookPath;
}

const ORCA_COMMAND = `: orca-agent-hook-form=1; if [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f "\${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "\${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_PORT-}" ] && [ -f "\${HOME-}/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "\${HOME-}/.orca/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`;

const ORCA_SCRIPT_PATH = new URL("./fixtures/orca-codex-hook.sh", import.meta.url);

async function writeOrcaHook(home: string): Promise<void> {
  await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "codex", hooks: [{ type: "command", command: ORCA_COMMAND }] }]
  } }), { mode: 0o600 });
}

describe("Codex hook approval inventory", () => {
  async function sharedProfile() {
    const native = await setup();
    const profileRoot = join(native.root, "profiles", "codex--personal");
    const profileHome = join(profileRoot, "home");
    const codexHome = join(profileHome, ".codex");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await chmod(profileRoot, 0o700);
    await chmod(profileHome, 0o700);
    await chmod(codexHome, 0o775);
    await writeFile(join(native.home, "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo $(already-approved-native-hook)" }] }]
    } }), { mode: 0o664 });
    await chmod(join(native.home, "hooks.json"), 0o664);
    await symlink(join(native.home, "hooks.json"), join(codexHome, "hooks.json"));
    await trustAllCodexHooks({ ...native.options, approvedBy: "fixture-operator" });
    const options = { ...native.options, codexHomeDirectory: codexHome,
      isolatorHomeDirectory: profileHome, sharedNativeCodexHomeDirectory: native.home };
    return { ...native, profileRoot, profileHome, codexHome, profileOptions: options };
  }

  it("uses existing native approval for only the linked source in a private isolated home", async () => {
    const f = await sharedProfile();
    const first = await inspectCodexHooks(f.profileOptions);
    expect(first.status, first.unsupportedReasons.join("; ")).toBe("approved");
    expect(first.approvalMode).toBeUndefined();
    expect(first.diagnostics.join(" ")).toContain("shared native hooks");
    const policyBefore = await readFile(codexHookPolicyPath(f.store), "utf8");
    await writeFile(join(f.codexHome, "config.toml"), '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "/usr/bin/true" }] }]\n', { mode: 0o600 });
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("approval_required");
    expect(await readFile(codexHookPolicyPath(f.store), "utf8")).toBe(policyBefore);
  });

  it("reuses native plugin authority only while enabled plugin contents match exactly", async () => {
    const f = await sharedProfile();
    const id = "fixture@fixture";
    await writeFile(join(f.home, "config.toml"), `[plugins."${id}"]\nenabled = true\n`, { mode: 0o600 });
    await writeFile(join(f.codexHome, "config.toml"), `[plugins."${id}"]\nenabled = true\n`, { mode: 0o600 });
    for (const home of [f.home, f.codexHome]) {
      const plugin = join(home, "plugins/cache/fixture/fixture/1");
      await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
      await mkdir(join(plugin, "hooks"), { recursive: true, mode: 0o700 });
      await writeFile(join(plugin, ".codex-plugin/plugin.json"), '{"name":"fixture","hooks":"./hooks/hooks.json"}', { mode: 0o600 });
      await writeFile(join(plugin, "hooks/hooks.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo $(approved-native-plugin)"}]}]}}', { mode: 0o600 });
    }
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("approved");
    await writeFile(join(f.codexHome, "plugins/cache/fixture/fixture/1/hooks/hooks.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/usr/bin/true"}]}]}}');
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("approval_required");
  });

  it("does not require hook approval for a profile-only instruction plugin with empty hooks", async () => {
    const f = await sharedProfile();
    const plugin = join(f.codexHome, "plugins/cache/local/instructions/1");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
    await chmod(plugin, 0o775);
    const manifest = join(plugin, ".codex-plugin/plugin.json");
    await writeFile(manifest, '{"name":"instructions","hooks":{}}', { mode: 0o664 });
    await chmod(manifest, 0o664);
    await writeFile(join(f.codexHome, "config.toml"), '[plugins."instructions@local"]\nenabled = true\n', { mode: 0o600 });
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("approved");
    await writeFile(manifest, '{"name":"instructions","hooks":{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo $(unapproved-local-code)"}]}]}}}');
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("unsupported");
  });

  it("revokes linked native source authority and rejects a retargeted hook link", async () => {
    const f = await sharedProfile();
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("approved");
    await revokeAllCodexHookTrust(f.options);
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("unsupported");
    await trustAllCodexHooks({ ...f.options, approvedBy: "fixture-operator" });
    const unrelated = join(f.root, "unrelated-hooks.json");
    await writeFile(unrelated, '{"hooks":{}}', { mode: 0o600 });
    await rm(join(f.codexHome, "hooks.json"));
    await symlink(unrelated, join(f.codexHome, "hooks.json"));
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("unsupported");
  });

  it("does not inspect an unrelated native home when the profile has its own hooks file", async () => {
    const f = await sharedProfile();
    await rm(join(f.codexHome, "hooks.json"));
    await writeFile(join(f.codexHome, "hooks.json"), '{"hooks":{}}', { mode: 0o600 });
    await chmod(f.home, 0o775);
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("none");
  });

  it("keeps the isolated profile root private even when descendants are permitted", async () => {
    const f = await sharedProfile();
    await chmod(f.profileRoot, 0o775);
    expect((await inspectCodexHooks(f.profileOptions)).status).toBe("unsupported");
  });

  it("reports no hooks without creating approval state", async () => {
    const { home, store, options } = await setup();
    const review = await inspectCodexHooks(options);
    expect(review).toMatchObject({ status: "none", codexHomeDirectory: resolve(home), approvalStorePath: store, hooks: [] });
    await expect(readFile(store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds event, matcher, command and script bytes to one exact approved digest", async () => {
    const { home, store, options } = await setup();
    const hookPath = await writeHook(home, "#!/bin/sh\nprintf 'reviewed\\n'\n");
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks).toEqual([expect.objectContaining({
      event: "SessionStart", matcher: { role: "developer" }, command: hookPath,
      dependencies: expect.arrayContaining([expect.objectContaining({ requestedPath: hookPath, resolvedPath: hookPath, exists: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })])
    })]);
    const approval = await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "operator" });
    expect(approval).toMatchObject({ codexHomeDirectory: resolve(home), approvalStorePath: store, digest: review.digest, approvedBy: "operator" });
    expect((await inspectCodexHooks(options)).status).toBe("approved");
    const bytes = await readFile(store);
    expect(bytes.toString()).not.toContain("printf");
  });

  it("refuses a stale expected digest without changing the receipt store", async () => {
    const { home, store, options } = await setup();
    await writeHook(home, "#!/bin/sh\nexit 0\n");
    const review = await inspectCodexHooks(options);
    await expect(approveCodexHooks(review, { ...options, expectedDigest: "0".repeat(64), approvedBy: "operator" }))
      .rejects.toThrow(/digest changed|does not match/i);
    await expect(readFile(store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates approval when hook configuration or a referenced file changes", async () => {
    const { home, options } = await setup();
    const hookPath = await writeHook(home, "#!/bin/sh\nexit 0\n");
    const review = await inspectCodexHooks(options);
    await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "operator" });
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    expect((await inspectCodexHooks(options)).status).toBe("approval_required");
    await writeHook(home, "#!/bin/sh\nexit 3\n");
    expect((await inspectCodexHooks(options)).digest).not.toBe(review.digest);
  });

  it("fails closed on dynamic shell syntax and never evaluates it", async () => {
    const { home, options } = await setup();
    const hookPath = await writeHook(home, "#!/bin/sh\n. \"$ORCA_AGENT_HOOK_ENDPOINT\"\n");
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("unsupported");
    expect(review.unsupportedReasons.join(" ")).toMatch(/dynamic|source|endpoint/i);
    expect(await readFile(hookPath, "utf8")).toContain("ORCA_AGENT_HOOK_ENDPOINT");
  });

  it("rejects command substitutions and shell controls even inside double quotes", async () => {
    const { home, options } = await setup();
    const path = join(home, "hook.sh");
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `bash \"${path};$(touch /tmp/no)\"` }] }]
    } }), { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("unsupported");
    expect(review.unsupportedReasons.join(" ")).toMatch(/expansion|metacharacter/i);
  });

  it("pins absent Orca wrapper candidates so adding a fallback invalidates review", async () => {
    const { root, home, options } = await setup();
    await writeOrcaHook(home);
    const env = { ...options.environment, ORCA_AGENT_HOOK_ROOT: join(root, "orca-root") };
    const candidate = join(root, "orca-root", "agent-hooks", "codex-hook.sh");
    await mkdir(join(root, "orca-root", "agent-hooks"), { recursive: true, mode: 0o700 });
    await writeFile(candidate, await readFile(ORCA_SCRIPT_PATH), { mode: 0o755 });
    const first = await inspectCodexHooks({ ...options, environment: env });
    expect(first.sources.some(source => source.exists === true && source.path === candidate)).toBe(true);
    expect(first.hooks[0]?.dependencies.some(dependency => dependency.exists === true && dependency.requestedPath === candidate)).toBe(true);
    expect(first.hooks[0]?.dependencies.some(dependency => dependency.exists === false && dependency.requestedPath.endsWith(".orca/agent-hooks/codex-hook.sh"))).toBe(true);
    await approveCodexHooks(first, { ...options, environment: env, expectedDigest: first.digest, approvedBy: "operator" });
    const fallback = join(root, ".orca", "agent-hooks", "codex-hook.sh");
    await mkdir(join(root, ".orca", "agent-hooks"), { recursive: true, mode: 0o700 });
    await writeFile(fallback, await readFile(ORCA_SCRIPT_PATH), { mode: 0o755 });
    expect((await inspectCodexHooks({ ...options, environment: env })).digest).not.toBe(first.digest);
  });

  it("pins the actual Herdr shell invocation while allowing literal script-body expansions", async () => {
    const { home, options } = await setup();
    const script = join(home, "herdr-agent-state.sh");
    await writeFile(script, "#!/bin/sh\naction=\"${1:-}\"\ncase \"$action\" in session) ;; esac\n", { mode: 0o755 });
    await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `bash '${script}' session` }] }]
    } }), { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.dependencies).toContainEqual(expect.objectContaining({ requestedPath: script, exists: true }));
  });

  it("supports absolute Bun or Node plus an absolute CLI script and literal arguments in TOML hooks", async () => {
    const { root, home, options } = await setup();
    const runtime = join(root, "bun");
    const cli = join(root, "cli.js");
    await writeFile(runtime, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(cli, "console.log('pinned');\n", { mode: 0o600 });
    await writeFile(join(home, "config.toml"), `[hooks]\nInterrupt = [{ hooks = [{ type = "command", command = "${runtime} ${cli} hook interrupt" }] }]\n`, { mode: 0o600 });
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("approval_required");
    expect(review.hooks[0]?.command).toBe(`${runtime} ${cli} hook interrupt`);
    expect(review.hooks[0]?.dependencies.map(dep => dep.requestedPath)).toEqual([runtime, cli]);
  });

  it("excludes native hooks.state metadata but fails malformed or unsafe state closed", async () => {
    const { home, options } = await setup();
    await writeFile(join(home, "config.toml"), '[hooks.state."/home/user/.codex/hooks.json:SessionStart:0:0"]\nenabled = true\n', { mode: 0o600 });
    expect((await inspectCodexHooks(options)).status).toBe("none");
    await writeFile(join(home, "config.toml"), '[hooks.state."bad-key"]\nenabled = true\n', { mode: 0o600 });
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("rejects symlinked approval state and a mismatched Codex home", async () => {
    const { root, home, store, options } = await setup();
    await writeHook(home, "#!/bin/sh\nexit 0\n");
    const review = await inspectCodexHooks(options);
    const foreignHome = join(root, "foreign-home");
    await mkdir(foreignHome, { mode: 0o700 });
    await expect(approveCodexHooks(review, { ...options, codexHomeDirectory: foreignHome, expectedDigest: review.digest, approvedBy: "operator" }))
      .rejects.toThrow(/home/i);
    const target = join(root, "target.json");
    await writeFile(target, "{}");
    await mkdir(dirname(store), { recursive: true, mode: 0o700 });
    await symlink(target, store);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("fails closed on malformed or non-private approval state and leaves it unchanged", async () => {
    const { home, store, root, options } = await setup();
    await writeHook(home, "#!/bin/sh\nexit 0\n");
    const review = await inspectCodexHooks(options);
    await mkdir(join(root, "machine-state/bflow"), { recursive: true, mode: 0o700 });
    await writeFile(store, "{ broken", { mode: 0o600 });
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    await writeFile(store, JSON.stringify({ schemaVersion: 1, approvals: [] }), { mode: 0o644 });
    await chmod(store, 0o644);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    await chmod(store, 0o600);
    await chmod(join(root, "machine-state/bflow"), 0o777);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    expect(review.status).toBe("approval_required");
  });

  it("keeps approvals scoped to the exact Codex home when a machine store is shared", async () => {
    const { root, home, options } = await setup();
    await writeHook(home, "#!/bin/sh\nexit 0\n");
    const first = await inspectCodexHooks(options);
    await approveCodexHooks(first, { ...options, expectedDigest: first.digest, approvedBy: "operator" });
    const secondHome = join(root, "codex-home-2");
    await mkdir(secondHome, { mode: 0o700 });
    await writeHook(secondHome, "#!/bin/sh\nexit 0\n");
    const secondOptions = { ...options, codexHomeDirectory: secondHome };
    expect((await inspectCodexHooks(secondOptions)).status).toBe("approval_required");
    const second = await inspectCodexHooks(secondOptions);
    await approveCodexHooks(second, { ...secondOptions, expectedDigest: second.digest, approvedBy: "operator" });
    expect((await inspectCodexHooks(options)).status).toBe("approved");
    expect((await inspectCodexHooks(secondOptions)).status).toBe("approved");
  });

  it("allows a missing Codex home when no hooks are configured", async () => {
    const { root } = await setup();
    const options = { codexHomeDirectory: join(root, "not-created"), approvalStorePath: join(root, "state/bflow/codex-hook-approvals.json"),
      environment: { HOME: root } };
    const review = await inspectCodexHooks(options);
    expect(review.status).toBe("none");
  });

  it("resolves the default private receipt path under the selected Codex home", async () => {
    const { root } = await setup();
    expect(defaultCodexHookApprovalPath({ HOME: root })).toBe(join(root, ".local/state/bflow/codex-hook-approvals.json"));
  });
  it("trusts all current/future hook sources explicitly, including unreadable inventory and unsafe permissions", async () => {
    const { home, store, options } = await setup();
    const hooks = join(home, "hooks.json");
    await writeFile(hooks, '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$(unsupported dynamic command)"}]}]}}', { mode: 0o777 });
    await chmod(hooks, 0o777);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    const before = await readFile(hooks, "utf8");
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    const first = await inspectCodexHooks(options);
    expect(first).toMatchObject({ status: "approved", approvalMode: "trust_all", hooks: [], sources: [] });
    expect(first.diagnostics.join(" ")).toMatch(/inspection.*skipped/i);
    expect(await readFile(hooks, "utf8")).toBe(before);
    await expect((await import("node:fs/promises")).stat(codexHookPolicyPath(store)).then(s => s.mode & 0o777)).resolves.toBe(0o600);
    await writeFile(hooks, "malformed future hook source");
    await writeFile(join(home, "config.toml"), '[plugins."future@uninspectable"]\nenabled=true\n', { mode: 0o777 });
    expect(await inspectCodexHooks(options)).toMatchObject({ status: "approved", approvalMode: "trust_all", digest: first.digest });
    await revokeAllCodexHookTrust(options);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("does not extend all-hook trust to another Codex home or approval store", async () => {
    const { root, home, options } = await setup();
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    const other = join(root, "other-codex"); await mkdir(other, { mode: 0o700 });
    await writeHook(other, "#!/bin/sh\nexit 0\n");
    expect((await inspectCodexHooks({ ...options, codexHomeDirectory: other })).status).toBe("approval_required");
    await writeHook(home, "#!/bin/sh\nexit 0\n");
    expect((await inspectCodexHooks({ ...options, approvalStorePath: join(root, "separate/bflow/store.json") })).status).toBe("approval_required");
  });

  it("keeps the trust policy private and fails closed if its receipt becomes writable by others", async () => {
    const { store, options } = await setup();
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    await chmod(codexHookPolicyPath(store), 0o666);
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
  });

  it("revokes broad policy without deleting exact snapshot approvals", async () => {
    const { home, store, options } = await setup();
    await writeHook(home, "#!/bin/sh\nexit 0\n");
    const review = await inspectCodexHooks(options);
    await approveCodexHooks(review, { ...options, expectedDigest: review.digest, approvedBy: "operator" });
    const snapshot = await readFile(store, "utf8");
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    await revokeAllCodexHookTrust(options);
    expect((await inspectCodexHooks(options)).status).toBe("approved");
    expect((await inspectCodexHooks(options)).approvalMode).toBeUndefined();
    expect(await readFile(store, "utf8")).toBe(snapshot);
  });

  it.each(["malformed", "unknown version", "foreign store", "symlink"])("rejects an invalid all-hook policy receipt: %s", async failure => {
    const { root, store, options } = await setup();
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    const path = codexHookPolicyPath(store), original = JSON.parse(await readFile(path, "utf8"));
    if (failure === "malformed") await writeFile(path, "{broken");
    else if (failure === "unknown version") await writeFile(path, JSON.stringify({ ...original, schemaVersion: 99 }));
    else if (failure === "foreign store") await writeFile(path, JSON.stringify({ ...original,
      policies: original.policies.map((policy: object) => ({ ...policy, approvalStorePath: join(root, "foreign.json") })) }));
    else {
      const target = join(root, "policy-target.json"); await writeFile(target, JSON.stringify(original), { mode: 0o600 });
      await (await import("node:fs/promises")).unlink(path); await symlink(target, path);
    }
    expect((await inspectCodexHooks(options)).status).toBe("unsupported");
    if (failure !== "symlink") await expect(revokeAllCodexHookTrust(options)).rejects.toThrow(`${path} is invalid`);
    if (failure === "malformed") await expect(revokeAllCodexHookTrust(options)).rejects.toThrow(/remove it manually/);
  });

  it("warns about lax hook permissions under trust_all without changing status or digest", async () => {
    const { home, options } = await setup();
    const hooks = join(home, "hooks.json");
    await writeFile(hooks, JSON.stringify({ hooks: {} }), { mode: 0o600 });
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    const strict = await inspectCodexHooks(options);
    expect(strict.diagnostics.some(item => item.startsWith("Warning:"))).toBe(false);
    await chmod(hooks, 0o777);
    const lax = await inspectCodexHooks(options);
    expect(lax).toMatchObject({ status: "approved", approvalMode: "trust_all", digest: strict.digest });
    expect(lax.diagnostics).toContainEqual(expect.stringMatching(/^Warning: hooks\.json is group\/world-writable/));
    expect(lax.diagnostics.join(" ")).toMatch(/inspection is skipped/);
    await chmod(home, 0o777);
    const laxHome = await inspectCodexHooks(options);
    expect(laxHome.diagnostics).toContainEqual(expect.stringMatching(/^Warning: Codex home /));
    expect(laxHome).toMatchObject({ status: "approved", digest: strict.digest });
    await chmod(home, 0o700);
  });

  it("explains a missing util-linux flock without writing policy state", async () => {
    const { root, store, options } = await setup();
    const empty = join(root, "empty-path"); await mkdir(empty, { mode: 0o700 });
    const path = process.env["PATH"];
    process.env["PATH"] = empty;
    try {
      await expect(trustAllCodexHooks({ ...options, approvedBy: "operator" }))
        .rejects.toThrow("Hook policy updates require the util-linux 'flock' command (Linux); install it and retry.");
    } finally { if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path; }
    await expect(readFile(codexHookPolicyPath(store))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing all-hook grant idempotent so prepared policy digests remain stable", async () => {
    const { options } = await setup();
    const first = await trustAllCodexHooks({ ...options, approvedBy: "first-operator" });
    const before = await inspectCodexHooks(options);
    expect(await trustAllCodexHooks({ ...options, approvedBy: "second-operator" })).toEqual(first);
    expect((await inspectCodexHooks(options)).digest).toBe(before.digest);
  });

  it("refuses to place policy under the resolved provider home through a home symlink", async () => {
    const { root, options } = await setup();
    const link = join(root, "home-link"); await symlink(root, link);
    await expect(trustAllCodexHooks({ ...options, codexHomeDirectory: link, approvedBy: "operator" })).rejects.toThrow(/outside/i);
  });

  it("does not restore a revoked home when another home's grant overlaps the revocation", async () => {
    const { root, home, options } = await setup();
    await trustAllCodexHooks({ ...options, approvedBy: "operator" });
    const other = join(root, "other-home"); await mkdir(other, { mode: 0o700 });
    let atWrite!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { atWrite = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const open = fsPromises.open;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (...values) => {
          if (String(values[0]).includes(other)) { atWrite(); await gate; }
          return write(...values);
        };
      }
      return file;
    });
    syncBuiltinESMExports();
    let granting: Promise<unknown> | undefined, revoking: Promise<unknown> | undefined;
    try {
      granting = trustAllCodexHooks({ ...options, codexHomeDirectory: other, approvedBy: "operator" });
      await paused;
      revoking = revokeAllCodexHookTrust(options);
      await Promise.race([revoking, new Promise(resolve => setTimeout(resolve, 100))]);
      release(); await Promise.all([granting, revoking]);
      expect((await inspectCodexHooks({ ...options, codexHomeDirectory: home })).approvalMode).toBeUndefined();
      expect((await inspectCodexHooks({ ...options, codexHomeDirectory: other })).approvalMode).toBe("trust_all");
    } finally {
      release(); await Promise.allSettled([granting, revoking].filter(Boolean));
      spy.mockRestore(); syncBuiltinESMExports();
    }
  });

});
