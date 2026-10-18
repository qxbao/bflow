import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveCodexHooks,
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
});
