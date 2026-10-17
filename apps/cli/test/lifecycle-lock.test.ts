import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleLockStatus, withLifecycleLock } from "../src/lifecycle-lock.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-lock-recovery-"))); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "sentinel"), "preserve"); return dir;
}
// The lock contract under test is specifically the kernel flock implementation.
describe.skipIf(process.platform !== "linux")("lifecycle kernel lock and legacy migration", () => {
  it("serializes concurrent commands and keeps a stable guard inode after release", async () => {
    const dir = await fixture(); let release!: () => void, ready!: () => void;
    const entered = new Promise<void>(resolve => ready = resolve);
    const first = withLifecycleLock(dir, async () => { ready(); await new Promise<void>(resolve => release = resolve); });
    await entered; const inode = (await stat(join(dir, "lifecycle.guard"))).ino;
    await expect(withLifecycleLock(dir, async () => undefined)).rejects.toThrow("still running");
    expect(await lifecycleLockStatus(dir)).toContain("active"); release(); await first;
    await withLifecycleLock(dir, async () => undefined);
    expect((await stat(join(dir, "lifecycle.guard"))).ino).toBe(inode);
    expect(await lifecycleLockStatus(dir)).toContain("No active");
  });
  it.each(["SIGINT", "SIGKILL"] as const)("releases automatically after actual process death by %s", async signal => {
    const dir = await fixture(), module = fileURLToPath(new URL("../dist/lifecycle-lock.js", import.meta.url));
    const code = `import {withLifecycleLock} from ${JSON.stringify(module)};await withLifecycleLock(${JSON.stringify(dir)},async()=>{await new Promise(()=>{setInterval(()=>{},1000);setTimeout(()=>{global.gc();process.stdout.write('LOCKED\\n');},30);});});`;
    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    await expect(withLifecycleLock(dir, async () => undefined)).rejects.toThrow("still running");
    child.kill(signal); await exited;
    await expect(withLifecycleLock(dir, async () => "resumed")).resolves.toBe("resumed");
    expect(await readFile(join(dir, "sentinel"), "utf8")).toBe("preserve");
  });
  it("requires explicit recovery for an empty old lock and preserves unknown lock contents", async () => {
    const dir = await fixture(), legacy = join(dir, "lifecycle.lock"); await mkdir(legacy);
    await expect(withLifecycleLock(dir, async () => undefined)).rejects.toThrow("bflow recover --yes");
    await withLifecycleLock(dir, async () => undefined, true); await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(legacy); await writeFile(join(legacy, "unknown"), "keep");
    await expect(withLifecycleLock(dir, async () => undefined, true)).rejects.toThrow();
    expect(await readFile(join(legacy, "unknown"), "utf8")).toBe("keep");
    expect(await readFile(join(dir, "sentinel"), "utf8")).toBe("preserve");
  });
  it("rejects a symlink owner receipt without changing its target", async () => {
    const dir = await fixture(), outside = await fixture();
    await symlink(join(outside, "sentinel"), join(dir, "lifecycle-owner.json"));
    await expect(withLifecycleLock(dir, async () => undefined)).rejects.toThrow();
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
  });
});

// State-root symlink rejection happens before lock acquisition and is portable across POSIX hosts.
describe.skipIf(process.platform === "win32")("portable lifecycle lock path validation", () => {
  it("rejects a symlink state directory without changing its target", async () => {
    const dir = await fixture(), outside = await fixture();
    await symlink(outside, join(dir, "state"));
    await expect(withLifecycleLock(join(dir, "state"), async () => undefined)).rejects.toThrow("symlinks");
    await expect(stat(join(outside, "lifecycle.guard"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
  });
});
