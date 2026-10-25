import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedCodexHookEnvironment, inspectCodexHooks, type CodexHookTrustOptions } from "@bflow/agent-providers";
import { executeCodexHookSetup, runCli } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-hook-setup-")));
  roots.push(root);
  const isolatedRoot = join(root, "isolated");
  const home = join(isolatedRoot, "providers", "codex");
  const baseHome = join(isolatedRoot, "providers", "home");
  const state = join(isolatedRoot, "state");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(baseHome, { recursive: true, mode: 0o700 });
  const script = join(home, "hooks", "approved.sh");
  await mkdir(join(home, "hooks"), { mode: 0o700 });
  await writeFile(script, "#!/bin/sh\nprintf 'reviewed hook\\n'\n", { mode: 0o700 });
  const config = join(home, "hooks.json");
  await writeFile(config, JSON.stringify({ hooks: {
    SessionStart: [{ matcher: { role: "developer" }, hooks: [{ type: "command", command: script }] }]
  } }), { mode: 0o600 });
  const store = join(state, "codex-hook-approvals.json");
  const trust: CodexHookTrustOptions = {
    codexHomeDirectory: home,
    approvalStorePath: store,
    environment: { ...createManagedCodexHookEnvironment(process.env, baseHome), CODEX_HOME: home, XDG_STATE_HOME: state }
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
    expect(result.stdout).toContain("Đánh giá Codex global hooks");
    expect(result.stdout).toContain("SessionStart");
    expect(result.stdout).toContain("Mã băm bản chụp (Snapshot digest):");
    expect(result.stdout).toContain("Phê duyệt này chỉ áp dụng cho bản chụp (snapshot) Codex hook đã kiểm tra");
  });

  it("keeps approved results concise while preserving the receipt and exact scope", async () => {
    const f = await fixture();
    const review = await inspectCodexHooks(f.trust);
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--yes", "--hook-digest", review.digest], f.context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Đã phê duyệt");
    expect(result.stdout).toContain("Phạm vi: Chỉ bản chụp (snapshot) Codex hook đã kiểm tra");
    expect(result.stdout).toContain(f.store);
    expect(result.stdout).not.toContain("Nguồn cấu hình (");
    expect(result.stdout).not.toContain("Mã băm hook (Hook digest):");
    const plan = await runCli(["setup", "--codex-hooks", "--plan"], f.context);
    expect(plan.stdout).toContain("Mã băm bản chụp (Snapshot digest): " + review.digest);
    expect(plan.stdout).toContain("Bộ lọc (Matcher):");
    expect(plan.stdout).toContain("Phụ thuộc cục bộ đã ghim");
  });

  it("provides a copyable exact-snapshot approval command alongside the full review", async () => {
    const f = await fixture();
    const review = await inspectCodexHooks(f.trust);
    const result = await runCli(["setup", "--codex-hooks", "--plan"], f.context);
    expect(result.stdout).toContain("bflow setup --codex-hooks --apply --yes --hook-digest " + review.digest);
    expect(result.stdout).toContain(f.script);
  });

  it("suspends animation around the existing exact hook approval preview and resumes after it", async () => {
    const f = await fixture();
    const chunks: string[] = [], progress: string[] = [], previews: string[] = [];
    const result = await runCli(["setup", "--codex-hooks", "--apply"], { ...f.context,
      io: { stdout: () => {}, stderr: text => previews.push(text), progress: text => progress.push(text), stderrRaw: chunk => chunks.push(chunk) },
      presentation: { interactive: true }, setup: { ...f.context.setup, confirm: async review => {
        expect(review).toContain("Mã băm bản chụp (Snapshot digest):");
        expect(review).toContain("Lệnh (Command): " + f.script);
        expect(previews).toEqual([review]);
        expect(progress.at(-1)).toContain("Đang chờ xác nhận của bạn");
        const count = chunks.length;
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(chunks).toHaveLength(count);
        return true;
      } } });
    expect(result.exitCode).toBe(0);
    expect(progress.at(-1)).toContain("Saving approval for the reviewed hook snapshot");
    expect(chunks.at(-1)).toBe("\r\x1b[2K");
    expect(result.stdout).not.toContain("Nguồn cấu hình (");
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
    expect(reviewText).toContain("không cấp quyền Bflow");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex global hooks: Đã phê duyệt");
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
    expect(result.stdout).toContain("Kết quả: Từ chối phê duyệt");
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
    expect(result.stdout).toContain("Kết quả: Bản chụp đã thay đổi (stale review)");
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
    expect(result.stdout).toContain("Kết quả: Không hỗ trợ");
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(f.store)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("explicitly trusts all hooks despite unsupported inspection and keeps later changes nonblocking", async () => {
    const f = await fixture();
    await writeFile(f.config, "malformed hooks JSON");
    const before = await readFile(f.config, "utf8");
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--trust-all", "--yes", "--json"], f.context);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.review).toMatchObject({ status: "approved", approvalMode: "trust_all" });
    await writeFile(f.config, "different future malformed config");
    const checked = await runCli(["setup", "--codex-hooks", "--check", "--json"], f.context);
    expect(checked.exitCode, checked.stdout).toBe(0);
    expect(JSON.parse(checked.stdout).data.review.approvalMode).toBe("trust_all");
    expect(before).toBe("malformed hooks JSON");
    const revoked = await runCli(["setup", "--codex-hooks", "--apply", "--revoke-trust-all", "--json"], f.context);
    expect(revoked.exitCode, revoked.stdout).toBe(0);
    expect(JSON.parse(revoked.stdout).data.outcome).toBe("trust_revoked");
    expect((await inspectCodexHooks(f.trust)).status).toBe("unsupported");
  });

  it("prints nonblocking lax-permission warnings in human --check output under trust_all", async () => {
    const f = await fixture();
    const granted = await runCli(["setup", "--codex-hooks", "--apply", "--trust-all", "--yes", "--json"], f.context);
    expect(granted.exitCode, granted.stdout + granted.stderr).toBe(0);
    const strict = await runCli(["setup", "--codex-hooks", "--check"], f.context);
    expect(strict.stdout).not.toContain("Cảnh báo:");
    await chmod(f.config, 0o777);
    const checked = await runCli(["setup", "--codex-hooks", "--check"], f.context);
    expect(checked.exitCode, checked.stdout + checked.stderr).toBe(0);
    expect(checked.stdout).toContain("Phạm vi: Toàn bộ global hooks hiện tại và tương lai");
    expect(checked.stdout).toMatch(/^Cảnh báo: hooks\.json is group\/world-writable or not owned by the current user/m);
    expect(checked.stdout).toContain("Codex global hooks: Đã phê duyệt trước đó");
  });

  it("does not grant all-hook trust from a noninteractive request without --yes", async () => {
    const f = await fixture();
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--trust-all", "--json"], f.context);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.outcome).toBe("approval_required");
    expect((await inspectCodexHooks(f.trust)).status).toBe("approval_required");
  });

  it.each([true, false])("shows the full scope when asking for interactive all-hook trust (approve=%s)", async approve => {
    const f = await fixture();
    await writeFile(f.config, "uninspectable hooks");
    const confirm = vi.fn(async (_question: string) => approve);
    const result = await runCli(["setup", "--codex-hooks", "--apply", "--trust-all"], {
      ...f.context, setup: { ...f.context.setup, confirm }
    });
    expect(confirm.mock.calls[0]?.[0]).toContain("TOÀN BỘ global hooks hiện tại và tương lai");
    expect(result.exitCode).toBe(approve ? 0 : 1);
    expect(result.stdout).toContain(approve ? "Phạm vi: Toàn bộ global hooks hiện tại và tương lai" : "Từ chối phê duyệt");
    expect((await inspectCodexHooks(f.trust)).status).toBe(approve ? "approved" : "unsupported");
  });

});
