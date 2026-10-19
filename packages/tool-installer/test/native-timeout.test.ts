import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedToolInstaller, type ManagedToolPin, type ToolHost } from "../src/installer.js";
import { OfficialProviderPluginAdapter } from "../src/provider-plugins.js";
import { treeDigest } from "../src/files.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(delivered = true) {
  const root = await mkdtemp(join(tmpdir(), "bflow-native-timeout-")); roots.push(root);
  const upstream = join(root, "upstream");
  await mkdir(join(upstream, ".claude-plugin"), { recursive: true });
  await mkdir(join(upstream, "skills", "using-superpowers"), { recursive: true });
  await writeFile(join(upstream, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers", version: "7.0.0", license: "MIT" }));
  await writeFile(join(upstream, "skills", "using-superpowers", "SKILL.md"), "---\nname: using-superpowers\ndescription: test\n---\n# Using\n");
  const archive = join(root, "plugin.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "upstream"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const pin: ManagedToolPin = { toolId: "superpowers", installerId: "test", version: "7.0.0", license: "MIT",
    source: "https://example.com/pinned.tgz", integrity: createHash("sha256").update(await readFile(archive)).digest("hex"),
    recipe: { kind: "provider_plugin", provider: "codex" } };
  const managed = join(root, "managed"), destination = join(managed, "codex");
  let active = false, bundle = "", stage = "", mutations = 0;
  const host: ToolHost = {
    async download(_source, target) { stage = dirname(target); await copyFile(archive, target); },
    async run(_binary, args) {
      if (args[1] === "list") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ installed: active ? [{
        pluginId: "bflow-superpowers@bflow-superpowers", version: pin.version, enabled: true, installed: true, path: bundle
      }] : [] }) };
      mutations++;
      const prepared = JSON.parse(await readFile(join(stage, ".bflow-native.json"), "utf8"));
      expect(prepared.sourceIntegrity).toBe(pin.integrity);
      if (args[1] === "marketplace" && args[2] === "add") bundle = join(args[3]!, "plugin");
      if (args[1] === "add") { active = delivered; throw new Error("Command timed out"); }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
  const installer = new ManagedToolInstaller({ managedRoot: managed, pins: [pin], host,
    providerPlugin: new OfficialProviderPluginAdapter({ host, configuration: { managedRoot: join(managed, ".native"), homeDirectory: root } }) });
  const planned = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId, version: pin.version,
    source: pin.source, integrity: pin.integrity, destination, scope: { kind: "machine", machineId: "m" }, idempotencyKey: "install" });
  if (!planned.ok) throw Error(planned.error.message);
  const apply = { schemaVersion: 3 as const, planId: "p", planDigest: "a".repeat(64), step: planned.value, approvalReceiptId: "approved" };
  return { installer, apply, managed, destination, stage: () => stage, mutations: () => mutations };
}

it("reconciles an installed native plugin after the add command timed out without replay or writes", async () => {
  const f = await fixture();
  const first = await f.installer.apply(f.apply);
  expect(first.ok && first.value.status).toBe("unknown");
  const before = await treeDigest(f.managed), mutations = f.mutations();
  const inspected = await f.installer.reconcile(f.apply);
  expect(inspected.ok && inspected.value.status, JSON.stringify(inspected)).toBe("already_satisfied");
  expect(await treeDigest(f.managed)).toBe(before);
  const again = await f.installer.apply(f.apply);
  expect(again.ok && again.value.status).toBe("already_satisfied");
  expect(f.mutations()).toBe(mutations);
});

it("does not treat prepared native metadata as evidence of installation", async () => {
  const f = await fixture(false);
  await f.installer.apply(f.apply);
  expect((await readdir(f.stage())).includes(".bflow-native.json")).toBe(true);
  const observed = await f.installer.reconcile(f.apply);
  expect(observed.ok && observed.value.status).toBe("blocked");
});

it("uses a verified existing installation when a legacy interrupted stage has no native record", async () => {
  const f = await fixture();
  await f.installer.apply(f.apply);
  await cp(f.stage(), f.destination, { recursive: true });
  await rm(join(f.stage(), ".bflow-native.json"));
  const before = await treeDigest(f.managed), mutations = f.mutations();
  const observed = await f.installer.reconcile(f.apply);
  expect(observed.ok && observed.value.status, JSON.stringify(observed)).toBe("already_satisfied");
  expect(await treeDigest(f.managed)).toBe(before);
  expect(f.mutations()).toBe(mutations);
});

it("retains unknown delivery for a legacy first installation without any native record", async () => {
  const f = await fixture();
  await f.installer.apply(f.apply);
  await rm(join(f.stage(), ".bflow-native.json"));
  const before = await treeDigest(f.managed), mutations = f.mutations();
  const observed = await f.installer.reconcile(f.apply);
  expect(observed.ok && observed.value.status).toBe("unknown");
  expect(await treeDigest(f.managed)).toBe(before);
  const again = await f.installer.apply(f.apply);
  expect(again.ok && again.value.status).toBe("unknown");
  expect(f.mutations()).toBe(mutations);
});
