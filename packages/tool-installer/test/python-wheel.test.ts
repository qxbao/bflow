import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedToolInstaller, managedToolExecutable, managedToolMcpExecutable, type ManagedToolPin, type ToolHost } from "../src/installer.js";
import { defaultToolCatalog } from "../src/default-catalog.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const WHEEL = "mempalace-3.11.0-py3-none-any.whl";
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

const pinFor = (overrides: Partial<ManagedToolPin> = {}): ManagedToolPin => ({ toolId: "mempalace", installerId: "bflow-tools", version: "3.11.0",
  source: `https://files.pythonhosted.org/packages/8d/fb/24cde4c9f29472483a7f33441d6e154bf56f45c6840fcffdb69f94853859/${WHEEL}`,
  integrity: hash("wheel"), license: "MIT",
  recipe: { kind: "python_wheel", packageName: "mempalace", executable: "mempalace", mcpExecutable: "mempalace-mcp" }, ...overrides });

async function fixture(options: { uv?: boolean; uvBroken?: boolean; identity?: string; pipExit?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bflow-wheel-")); roots.push(root);
  const pin = pinFor();
  const calls: string[] = [];
  const host: ToolHost = {
    async download(_source, target) { await writeFile(target, "wheel"); },
    async run(executable, args) {
      calls.push(`${executable} ${args.join(" ")}`);
      if (executable === "uv" && args[0] === "--version") {
        if (options.uv === false) throw new Error("spawn uv ENOENT");
        return { exitCode: 0, stdout: "uv 0.13.1", stderr: "" };
      }
      if (executable === "uv" && options.uvBroken) return { exitCode: 2, stdout: "", stderr: "No interpreter found" };
      const venvTarget = executable === "uv" ? (args[0] === "venv" ? args[args.length - 1] : undefined)
        : (executable === "python3" && args[0] === "-m" && args[1] === "venv" ? args[2] : undefined);
      if (venvTarget) { await mkdir(join(venvTarget, "bin"), { recursive: true }); await writeFile(join(venvTarget, "bin", "python"), "py"); return { exitCode: 0, stdout: "", stderr: "" }; }
      if ((executable === "uv" && args[0] === "pip") || args.includes("pip"))
        return { exitCode: options.pipExit ?? 0, stdout: "", stderr: options.pipExit ? "simulated resolver failure" : "" };
      if (args[0] === "-c") return { exitCode: 0, stdout: options.identity ?? "mempalace 3.11.0 MIT\n", stderr: "" };
      if (args[0] === "--version") return { exitCode: 0, stdout: "MemPalace 3.11.0", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
  const destination = join(root, "managed", "mempalace");
  const installer = new ManagedToolInstaller({ managedRoot: join(root, "managed"), pins: [pin], host });
  const planned = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId, version: pin.version,
    source: pin.source, integrity: pin.integrity, scope: { kind: "machine", machineId: "m" }, destination, idempotencyKey: "install-mempalace" });
  if (!planned.ok) throw new Error(planned.error.message);
  const apply = { schemaVersion: 3 as const, planId: "p", planDigest: hash("plan"), step: planned.value, approvalReceiptId: "approved" };
  return { pin, destination, installer, apply, calls };
}

describe("MemPalace python wheel recipe", () => {
  it("installs the digest-verified wheel into a relocatable virtualenv with wrappers", async () => {
    const { installer, apply, destination, pin, calls } = await fixture();
    const result = await installer.apply(apply);
    expect(result.ok && result.value.status, JSON.stringify(result)).toBe("applied");
    expect(calls.some(call => call.startsWith("uv pip install --quiet --python"))).toBe(true);
    expect(calls.some(call => call.includes(WHEEL))).toBe(true);
    expect(managedToolExecutable(pin)).toBe(join("bin", "mempalace"));
    expect(managedToolMcpExecutable(pin)).toBe(join("bin", "mempalace-mcp"));
    for (const [name, module] of [["mempalace", "mempalace.cli"], ["mempalace-mcp", "mempalace.mcp_proxy"]] as const) {
      const wrapper = join(destination, "bin", name);
      expect((await stat(wrapper)).mode & 0o777).toBe(0o700);
      const text = await readFile(wrapper, "utf8");
      expect(text).toContain(`from ${module} import main`);
      expect(text).toContain('DIR=$(cd "$(dirname "$SELF")/.." && pwd -P)');
      expect(text).toContain('readlink "$SELF"');
      expect(text).not.toContain(destination);
    }
    expect((await lstat(join(destination, WHEEL))).isFile()).toBe(true);
    const again = await installer.reconcile(apply);
    expect(again.ok && again.value.status).toBe("already_satisfied");
  });

  it("falls back to python3 -m venv and pip when uv is unavailable", async () => {
    const { installer, apply, calls } = await fixture({ uv: false });
    const result = await installer.apply(apply);
    expect(result.ok && result.value.status, JSON.stringify(result)).toBe("applied");
    expect(calls.some(call => call.startsWith("python3 -m venv"))).toBe(true);
    expect(calls.some(call => call.includes("-m pip install"))).toBe(true);
  });

  it("falls back to python3 when uv is present but cannot create the environment", async () => {
    const { installer, apply, calls } = await fixture({ uvBroken: true });
    const result = await installer.apply(apply);
    expect(result.ok && result.value.status, JSON.stringify(result)).toBe("applied");
    expect(calls.some(call => call.startsWith("python3 -m venv"))).toBe(true);
  });

  it("fails without publishing an install when dependency resolution fails", async () => {
    const { installer, apply, destination } = await fixture({ pipExit: 1 });
    const result = await installer.apply(apply);
    expect(result.ok && result.value.status).toBe("failed");
    await expect(lstat(destination)).rejects.toThrow();
  });

  it("rejects an installed identity or license that differs from the reviewed pin", async () => {
    for (const identity of ["otherpkg 3.11.0 MIT\n", "mempalace 3.11.1 MIT\n", "mempalace 3.11.0 GPL-3.0\n"]) {
      const { installer, apply, destination } = await fixture({ identity });
      const result = await installer.apply(apply);
      expect(result.ok && result.value.status, identity).toBe("failed");
      await expect(lstat(destination)).rejects.toThrow();
    }
  });

  it("only accepts the official PyPI wheel and reserves the recipe for MemPalace", () => {
    const base = { managedRoot: "/tmp/bflow-wheel-pins/tools" };
    expect(() => new ManagedToolInstaller({ ...base, pins: [pinFor({ source: `https://example.com/packages/${WHEEL}` })] })).toThrow(/official PyPI wheel/);
    expect(() => new ManagedToolInstaller({ ...base, pins: [pinFor({ source: "https://files.pythonhosted.org/packages/ab/cd/mempalace-3.11.0.tar.gz" })] })).toThrow(/official PyPI wheel/);
    expect(() => new ManagedToolInstaller({ ...base, pins: [pinFor({ version: "latest" })] })).toThrow(/exact/);
    expect(() => new ManagedToolInstaller({ ...base, pins: [pinFor({ toolId: "gitnexus" })] })).toThrow();
  });

  it("ships a reviewed MemPalace pin in the default catalog for supported platforms", () => {
    for (const [os, arch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"]] as const) {
      const pin = defaultToolCatalog(os, arch).pins.find(candidate => candidate.toolId === "mempalace");
      expect(pin?.recipe.kind, `${os}/${arch}`).toBe("python_wheel");
      expect(pin?.integrity).toBe("43e4c690e339b66e86a3177fe4eea15da3d9541ecbd58e671431c1e13dc1bf0c");
    }
    expect(defaultToolCatalog("win32", "x64").manual.some(item => item.toolId === "mempalace")).toBe(true);
  });
});
