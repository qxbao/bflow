import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedToolInstaller, type ManagedToolPin } from "../src/installer.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

type Registered = boolean | null | "absent";

async function fixture(registered: Registered) {
  const root = await mkdtemp(join(tmpdir(), "bflow-native-recovery-")); roots.push(root);
  const pin: ManagedToolPin = { toolId: "superpowers", installerId: "bflow-tools", version: "6.4.2",
    source: "https://github.com/obra/superpowers/archive/refs/tags/v6.4.2.tar.gz", integrity: hash("plugin"),
    recipe: { kind: "provider_plugin", provider: "agy" }, license: "MIT" };
  let active = false;
  let failActivation = true;
  let activations = 0;
  const adapter = { async verify() { return { ready: active, diagnostic: active ? "skill active" : "record missing" }; },
    async activate() {
      activations++;
      if (failActivation) return { success: false, diagnostic: "Agy rejected the local plugin manifest" };
      active = true; return { success: true, diagnostic: "installed" };
    },
    ...(registered === "absent" ? {} : { async registered() { return registered; } }) };
  const installer = new ManagedToolInstaller({ managedRoot: join(root, "managed"), pins: [pin],
    host: { async download(_source, target) { await writeFile(target, "plugin"); },
      async run() { throw new Error("native adapter owns provider commands"); } },
    providerPlugin: adapter });
  const destination = join(root, "managed", "superpowers-agy");
  const request = { schemaVersion: 3 as const, toolId: pin.toolId, installerId: pin.installerId, version: pin.version,
    source: pin.source, integrity: pin.integrity, scope: { kind: "machine" as const, machineId: "m" }, destination,
    idempotencyKey: "install-superpowers-agy" };
  const planned = await installer.plan(request);
  if (!planned.ok) throw new Error(planned.error.message);
  const apply = { schemaVersion: 3 as const, planId: "p", planDigest: hash("plan"), step: planned.value, approvalReceiptId: "approved" };
  const siblings = async () => (await readdir(join(root, "managed"))).sort();
  return { installer, apply, request, destination, siblings, activationsMade: () => activations,
    fixActivation: () => { failActivation = false; } };
}

describe("interrupted native activation recovery", () => {
  it("discards an interrupted activation that left nothing registered, then installs", async () => {
    const f = await fixture(false);
    const first = await f.installer.apply(f.apply);
    expect(first.ok && first.value.status).toBe("unknown");
    expect((await f.siblings()).some(name => name.endsWith(".native-pending.json"))).toBe(true);
    expect((await f.siblings()).some(name => name.includes(".staging-"))).toBe(true);
    const inspected = await f.installer.inspect(f.request);
    expect(inspected.ok && inspected.value.status).toBe("blocked");
    expect(inspected.ok && inspected.value.diagnostics.join(" ")).toContain("nothing registered");
    f.fixActivation();
    const second = await f.installer.apply({ ...f.apply, planId: "p2" });
    expect(second.ok && second.value.status, JSON.stringify(second)).toBe("applied");
    const names = await f.siblings();
    expect(names.some(name => name.includes(".staging-"))).toBe(false);
    expect(names.some(name => name.endsWith(".native-pending.json"))).toBe(false);
    expect(names.some(name => name.includes(".native-pending.json.reviewed-"))).toBe(true);
    expect(f.activationsMade()).toBe(2);
  });

  it("keeps an interrupted activation unresolved when the plugin is registered with the provider", async () => {
    const f = await fixture(true);
    await f.installer.apply(f.apply);
    f.fixActivation();
    const again = await f.installer.apply({ ...f.apply, planId: "p2" });
    expect(again.ok && again.value.status).toBe("unknown");
    expect(f.activationsMade()).toBe(1);
    expect((await f.siblings()).some(name => name.endsWith(".native-pending.json"))).toBe(true);
  });

  it("keeps it unresolved when the provider inventory cannot be read", async () => {
    const f = await fixture(null);
    await f.installer.apply(f.apply);
    f.fixActivation();
    const again = await f.installer.apply({ ...f.apply, planId: "p2" });
    expect(again.ok && again.value.status).toBe("unknown");
    expect(f.activationsMade()).toBe(1);
  });

  it("never discards when the adapter cannot prove absence", async () => {
    const f = await fixture("absent");
    await f.installer.apply(f.apply);
    f.fixActivation();
    const again = await f.installer.apply({ ...f.apply, planId: "p2" });
    expect(again.ok && again.value.status).toBe("unknown");
    expect(f.activationsMade()).toBe(1);
    await expect(lstat(join(f.destination))).rejects.toThrow();
  });

  it("resolves a stale intent whose stage never recorded native metadata once the installed pin verifies", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-native-stale-")); roots.push(root);
    const pin: ManagedToolPin = { toolId: "superpowers", installerId: "bflow-tools", version: "6.4.2",
      source: "https://github.com/obra/superpowers/archive/refs/tags/v6.4.2.tar.gz", integrity: hash("plugin"),
      recipe: { kind: "provider_plugin", provider: "codex" }, license: "MIT" };
    let enabled = true, activations = 0;
    const recorded = async (path: string) => lstat(join(path, ".bflow-native.json")).then(() => true, () => false);
    const installer = new ManagedToolInstaller({ managedRoot: join(root, "managed"), pins: [pin],
      host: { async download(_source, target) { await writeFile(target, "plugin"); },
        async run() { throw new Error("native adapter owns provider commands"); } },
      providerPlugin: {
        async verify(_pin, path) {
          if (!(await recorded(path))) return { ready: false, diagnostic: `ENOENT ${path}/.bflow-native.json` };
          return enabled ? { ready: true, diagnostic: "cache verified" } : { ready: false, diagnostic: "plugin is not enabled" };
        },
        async activate(_pin, artifact) { activations++; await writeFile(join(dirname(artifact), ".bflow-native.json"), "{}");
          return { success: true, diagnostic: "installed" }; },
        async registered() { return true; } } });
    const destination = join(root, "managed", "superpowers-codex");
    const request = { schemaVersion: 3 as const, toolId: pin.toolId, installerId: pin.installerId, version: pin.version,
      source: pin.source, integrity: pin.integrity, scope: { kind: "machine" as const, machineId: "m" }, destination,
      idempotencyKey: "install-superpowers-codex" };
    const planned = await installer.plan(request);
    if (!planned.ok) throw new Error(planned.error.message);
    const apply = { schemaVersion: 3 as const, planId: "p", planDigest: hash("plan"), step: planned.value, approvalReceiptId: "approved" };
    expect((await installer.apply(apply)).ok).toBe(true);
    // A later activation was interrupted before it recorded anything: only its intent and downloaded artifact remain.
    const stage = `${destination}.staging-stale`;
    await mkdir(stage); await writeFile(join(stage, "artifact"), "plugin");
    await writeFile(`${destination}.native-pending.json`, JSON.stringify({ schemaVersion: 3,
      desiredStateDigest: planned.value.desiredStateDigest, stage, toolId: pin.toolId, installerId: pin.installerId }));

    enabled = false;
    const failing = await installer.inspect(request);
    expect(failing.ok && failing.value.status).toBe("unknown");
    expect(failing.ok && failing.value.diagnostics[0]).toBe("plugin is not enabled");

    enabled = true;
    const again = await installer.apply({ ...apply, planId: "p2" });
    expect(again.ok && again.value.status).toBe("already_satisfied");
    const names = (await readdir(join(root, "managed"))).sort();
    expect(names.some(name => name.endsWith(".native-pending.json"))).toBe(false);
    expect(names.some(name => name.includes(".native-pending.json.reviewed-"))).toBe(true);
    expect(names.some(name => name.includes(".staging-"))).toBe(false);
    expect(activations).toBe(1);
  });
});
