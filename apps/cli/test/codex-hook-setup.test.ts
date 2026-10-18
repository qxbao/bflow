import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCodexHooks, type CodexHookTrustOptions } from "@bflow/agent-providers";
import { executeCodexHookSetup, runCli } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bflow-hook-setup-"));
  roots.push(root);
  const isolatedRoot = join(root, "isolated");
  const home = join(isolatedRoot, "providers", "codex");
  const baseHome = join(isolatedRoot, "providers", "home");
  const state = join(isolatedRoot, "state");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(baseHome, { recursive: true, mode: 0o700 });
  const script = join(home, "hooks", "approved.sh");
  await mkdir(join(home, "hooks"), { mode: 0o700 });
  await writeFile(script, "#!/bin/sh\nprintf 'reviewed hook\\n'\n", { mode: 0o600 });
  const config = join(home, "hooks.json");
  await writeFile(config, JSON.stringify({ hooks: {
    SessionStart: [{ matcher: { role: "developer" }, hooks: [{ type: "command", command: script }] }]
  } }), { mode: 0o600 });
  const store = join(state, "codex-hook-approvals.json");
  const trust: CodexHookTrustOptions = {
    codexHomeDirectory: home,
    approvalStorePath: store,
    environment: { HOME: baseHome, CODEX_HOME: home, XDG_STATE_HOME: state, PATH: "/usr/bin:/bin",
      ...(process.env["ORCA_AGENT_HOOK_ROOT"] !== undefined ? { ORCA_AGENT_HOOK_ROOT: process.env["ORCA_AGENT_HOOK_ROOT"] } : {}),
      ...(process.env["ORCA_AGENT_HOOK_ENDPOINT"] !== undefined ? { ORCA_AGENT_HOOK_ENDPOINT: process.env["ORCA_AGENT_HOOK_ENDPOINT"] } : {}) }
  };
  const context = {
    cwd: root,
    setup: {
      isolatedRoot,
      // If hook mode falls through to normal setup, this makes the test fail immediately.
      machineSetup: { run: async () => { throw new Error("normal setup must not run in hook-only mode"); } }
    }
  };
  return { root, isolatedRoot, home, state, script, config, store, trust, context };
}

describe("Codex hook-only setup", () => {
  it("reports an empty hook inventory without prompting or creating approval state", async () => {
    const f = await fixture();
    await writeFile(f.config, JSON.stringify({ hooks: {} }), { mode: 0o600 });
    const confirm = vi.fn(async (_review: string) => true);
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--json"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.outcome).toBe("no_hooks");
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shows a structured read-only plan bound to the isolated Codex home", async () => {
    const f = await fixture();
    const before = await readFile(f.config, "utf8");
    const result = await runCli(["setup", "--codex-hooks", "--plan", "--json"], f.context);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.data).toMatchObject({ codexHooks: true, mode: "dry_run", outcome: "approval_required" });
    expect(envelope.data.review).toMatchObject({
      status: "approval_required", codexHomeDirectory: resolve(f.home), approvalStorePath: resolve(f.store),
      hooks: [expect.objectContaining({ event: "SessionStart", command: f.script })]
    });
    expect(envelope.data.review.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(f.config, "utf8")).toBe(before);
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write approval state for --check", async () => {
    const f = await fixture();
    const result = await runCli(["setup", "--codex-hooks", "--check", "--json"], f.context);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.outcome).toBe("approval_required");
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("formats a readable inventory and approval boundary for human output", async () => {
    const f = await fixture();
    const result = await runCli(["setup", "--codex-hooks", "--plan"], f.context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex global hook review");
    expect(result.stdout).toContain("SessionStart");
    expect(result.stdout).toContain("Snapshot digest:");
    expect(result.stdout).toContain("Approval covers only this inspected Codex hook snapshot");
  });

  it("redacts command-line credentials from human and JSON hook inventories", async () => {
    const f = await fixture();
    const raw = JSON.parse(await readFile(f.config, "utf8"));
    raw.hooks.SessionStart[0].hooks[0].command = "/usr/bin/true --api-key=sk-proj-0123456789abcdef";
    await writeFile(f.config, JSON.stringify(raw), { mode: 0o600 });
    const json = await runCli(["setup", "--codex-hooks", "--plan", "--json"], f.context);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).not.toContain("sk-proj-0123456789abcdef");
    expect(json.stdout).toContain("[REDACTED]");

    const human = await runCli(["setup", "--codex-hooks", "--plan"], f.context);
    expect(human.stdout).not.toContain("sk-proj-0123456789abcdef");
    expect(human.stdout).toContain("[REDACTED]");
  });

  it("requires the current digest for non-interactive --yes and leaves a wrong digest unapproved", async () => {
    const f = await fixture();
    const originalConfig = await readFile(f.config, "utf8");
    const review = await inspectCodexHooks(f.trust);
    const wrong = await runCli(["setup", "--codex-hooks", "--apply", "--yes", "--hook-digest", "0".repeat(64), "--json"], f.context);
    expect(wrong.exitCode).toBe(1);
    expect(JSON.parse(wrong.stdout).data.outcome).toBe("digest_mismatch");
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });

    const approved = await runCli(["setup", "--codex-hooks", "--apply", "--yes", "--hook-digest", review.digest, "--json"], f.context);
    expect(approved.exitCode, approved.stdout + approved.stderr).toBe(0);
    expect(JSON.parse(approved.stdout).data.outcome).toBe("approved");
    expect((await inspectCodexHooks(f.trust)).status).toBe("approved");
    expect((await stat(f.store)).mode & 0o777).toBe(0o600);
    expect(await readFile(f.config, "utf8")).toBe(originalConfig);
  });

  it("returns the digest for a non-interactive apply without approving", async () => {
    const f = await fixture();
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--json"], f.context);
    expect(result.exitCode).toBe(1);
    const data = JSON.parse(result.stdout).data;
    expect(data.outcome).toBe("approval_required");
    expect(data.review.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start an interactive approval prompt in JSON mode", async () => {
    const f = await fixture();
    const confirm = vi.fn(async (_review: string) => true);
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--json"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.outcome).toBe("approval_required");
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cannot turn a direct yes-only hook request into approval", async () => {
    const f = await fixture();
    const confirm = vi.fn(async (_review: string) => true);
    const result = await executeCodexHookSetup({ command: "setup", mode: "apply", yes: true, codexHooks: true, json: false, help: false }, {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.outcome).toBe("approval_required");
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shows the complete sanitized review before an interactive approval callback", async () => {
    const f = await fixture();
    const confirm = vi.fn(async (_review: string) => true);
    const result = await runCli(["setup", "--codex-hooks", "--apply"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(confirm).toHaveBeenCalledOnce();
    const reviewText = confirm.mock.calls[0]?.[0] ?? "";
    expect(reviewText).toContain("SessionStart");
    expect(reviewText).toContain(f.script);
    expect(reviewText).toContain("SHA-256 ");
    expect(reviewText).toContain("Snapshot digest");
    expect(reviewText).toContain("does not grant Bflow permissions");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Result: approved");
    expect((await inspectCodexHooks(f.trust)).status).toBe("approved");
  });

  it("leaves the approval store unchanged when an operator declines", async () => {
    const f = await fixture();
    const confirm = vi.fn(async (_review: string) => false);
    const result = await runCli(["setup", "--codex-hooks", "--apply"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Result: approval_declined");
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not print token contents from dependency scripts during interactive review", async () => {
    const f = await fixture();
    await writeFile(f.script, "#!/bin/sh\n# token=sk-proj-this-must-not-leak\nprintf 'reviewed\\n'\n", { mode: 0o600 });
    const confirm = vi.fn(async (_review: string) => false);
    const result = await runCli(["setup", "--codex-hooks", "--apply"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.exitCode).toBe(1);
    expect(confirm.mock.calls[0]?.[0]).not.toContain("sk-proj-this-must-not-leak");
    expect(confirm.mock.calls[0]?.[0]).not.toContain("reviewed");
  });

  it("rechecks the exact snapshot after the operator decision and rejects drift", async () => {
    const f = await fixture();
    const confirm = vi.fn(async (_review: string) => {
      await writeFile(f.script, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      return true;
    });
    const result = await runCli(["setup", "--codex-hooks", "--apply"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Result: stale_review");
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("displays unsupported dynamic hooks without prompting or writing approval", async () => {
    const f = await fixture();
    await writeFile(f.script, "#!/bin/sh\n. \"$ORCA_AGENT_HOOK_ENDPOINT\"\n", { mode: 0o600 });
    const confirm = vi.fn(async (_review: string) => true);
    const result = await runCli(["setup", "--codex-hooks", "--apply"], {
      ...f.context,
      setup: { ...f.context.setup, confirm }
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Result: unsupported");
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
