import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { treeDigest } from "../src/files.js";
import { ManagedToolInstaller, type ManagedToolPin } from "../src/installer.js";

it("stages a verified Herdr binary, rejects corrupt downloads and reconciles without a second download", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-default-binary-"));
  try {
    const bytes = "verified native executable";
    const pin: ManagedToolPin = { toolId: "herdr", installerId: "test-default", version: "0.9.5",
      source: "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64",
      integrity: createHash("sha256").update(bytes).digest("hex"), license: "MIT", recipe: { kind: "binary", executable: "herdr" } };
    let corrupt = true, downloads = 0;
    const installer = new ManagedToolInstaller({ managedRoot: join(root, "tools"), pins: [pin], host: {
      async download(_url, target) { downloads++; await writeFile(target, corrupt ? "corrupt" : bytes); },
      async run(executable, args) {
        expect(await readFile(executable, "utf8")).toBe(bytes);
        expect(args).toEqual(["--version"]);
        return { exitCode: 0, stdout: "herdr 0.9.5", stderr: "" };
      }
    } });
    const plan = await installer.plan({ schemaVersion: 3, toolId: "herdr", installerId: pin.installerId,
      version: pin.version, source: pin.source, integrity: pin.integrity, destination: join(root, "tools", "herdr"),
      scope: { kind: "machine", machineId: "machine" }, idempotencyKey: "install-herdr" });
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const request = { schemaVersion: 3 as const, planId: "plan", planDigest: "a".repeat(64), step: plan.value, approvalReceiptId: "approved" };
    const beforeMissing = await readdir(root, { recursive: true });
    const missing = await installer.inspect(request.step.toolInstall!);
    expect(missing.ok && missing.value.status).toBe("blocked");
    expect(missing.ok && missing.value.diagnostics).toContain("Tool is not installed");
    expect(await readdir(root, { recursive: true })).toEqual(beforeMissing);
    const bad = await installer.apply(request); expect(bad.ok && bad.value.status).toBe("failed");
    corrupt = false;
    const good = await installer.apply(request); expect(good.ok && good.value.status).toBe("applied");
    const beforeInstalled = await readdir(root, { recursive: true });
    const beforeContents = await treeDigest(root);
    const inspected = await installer.inspect(request.step.toolInstall!);
    expect(inspected.ok && inspected.value.status).toBe("already_satisfied");
    expect(await readdir(root, { recursive: true })).toEqual(beforeInstalled);
    expect(await treeDigest(root)).toBe(beforeContents);
    const again = await installer.apply(request); expect(again.ok && again.value.status).toBe("already_satisfied");
    expect(downloads).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
