import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NativeProvidersToolInstaller } from "../src/native-providers-installer.js";
import { treeDigest } from "../src/files.js";
import type { ManagedToolPin } from "../src/installer.js";
import { SUBSCRIPTION_LOGIN_REQUIRED } from "../src/memory-provider.js";

it("plans every selected provider, preserves uncertain native delivery and does not replay it", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-native-default-"));
  try {
    const pin: ManagedToolPin = { toolId: "superpowers", installerId: "native", version: "7.0.0",
      source: "https://github.com/obra/superpowers/archive/refs/tags/v7.0.0.tar.gz",
      integrity: createHash("sha256").update("archive").digest("hex"), license: "MIT", recipe: { kind: "provider_plugin", provider: "codex" } };
    const active = new Set<string>(); const calls: string[] = [];
    const installer = new NativeProvidersToolInstaller({ managedRoot: join(root, "tools"), pin, providers: ["claude", "codex"],
      host: { async download(_url, target) { await writeFile(target, "archive"); }, async run() { throw Error("adapter owns native route"); } },
      providerPlugin: { async verify(pin) { const provider = pin.recipe.kind === "provider_plugin" ? pin.recipe.provider : "";
        return { ready: active.has(provider), diagnostic: active.has(provider) ? "active exact plugin" : "plugin inactive" }; },
      async activate(pin) { const provider = pin.recipe.kind === "provider_plugin" ? pin.recipe.provider : "";
        calls.push(provider); if (provider === "claude") active.add(provider);
        return { success: provider === "claude", diagnostic: "native delivery uncertain" }; } } });
    const planned = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
      version: pin.version, source: pin.source, integrity: pin.integrity, destination: join(root, "tools", "superpowers"),
      scope: { kind: "machine", machineId: "machine" }, idempotencyKey: "native-install" });
    expect(planned.ok).toBe(true); if (!planned.ok) return;
    const request = { schemaVersion: 3 as const, planId: "plan", planDigest: "a".repeat(64), step: planned.value, approvalReceiptId: "approved" };
    const missing = await installer.inspect(planned.value.toolInstall!);
    expect(missing.ok && missing.value.status).toBe("blocked");
    expect(missing.ok && missing.value.diagnostics.join(" ")).toContain("not installed");
    const first = await installer.apply(request); expect(first.ok && first.value.status).toBe("unknown");
    expect(first.ok && first.value.diagnostics.join(" ")).toContain("codex");
    const repeated = await installer.apply(request); expect(repeated.ok && repeated.value.status).toBe("unknown");
    expect(calls).toEqual(["claude", "codex"]);
    const inspected = await installer.inspect(planned.value.toolInstall!);
    expect(inspected.ok && inspected.value.status).toBe("unknown");
    expect(calls).toEqual(["claude", "codex"]);
    const snapshot = await treeDigest(root);
    active.add("codex");
    const installed = await installer.inspect(planned.value.toolInstall!);
    expect(installed.ok && installed.value.status).toBe("already_satisfied");
    expect(await treeDigest(root)).toBe(snapshot);
    expect(calls).toEqual(["claude", "codex"]);
    const forged = await installer.apply({ ...request, step: { ...planned.value, desiredStateDigest: "b".repeat(64) } });
    expect(forged.ok).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("plans Claude-Mem without a subscription login as an owner action in error details, not a machine failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-native-memory-login-"));
  try {
    const pin: ManagedToolPin = { toolId: "claude-mem", installerId: "native-memory", version: "14.0.1",
      source: "https://registry.npmjs.org/claude-mem/-/claude-mem-14.0.1.tgz",
      integrity: createHash("sha256").update("archive").digest("hex"), license: "AGPL-3.0", recipe: { kind: "provider_plugin", provider: "claude" } };
    const home = join(root, "home"), dataDir = join(root, "memory");
    const installer = new NativeProvidersToolInstaller({ managedRoot: join(root, "tools"), pin, providers: ["claude"],
      configuration: { homeDirectory: home, memory: { dataDir, projectRoot: root, project: root } },
      host: { async download() { throw Error("no download"); }, async run() { return { exitCode: 1, stdout: "", stderr: "not logged in" }; } } });
    const planned = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
      version: pin.version, source: pin.source, integrity: pin.integrity, destination: join(root, "tools", "claude-mem"),
      scope: { kind: "machine", machineId: "machine" }, idempotencyKey: "claude-mem-login" });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.message).toContain("subscription login");
    expect(planned.error.details).toEqual({ ownerAction: SUBSCRIPTION_LOGIN_REQUIRED });
  } finally { await rm(root, { recursive: true, force: true }); }
});
