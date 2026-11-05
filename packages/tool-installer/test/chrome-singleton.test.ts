import { lstat, lutimes, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { planChromeSession } from "../src/integrations.js";
import type { ToolHost } from "../src/installer.js";

const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill(); await exited;
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-chrome-lock-"))); roots.push(root);
  const host: ToolHost = { async download() {}, async run() { return { exitCode: 0, stdout: "Google Chrome 150", stderr: "" }; } };
  const input = { managedRoot: root, repositoryId: "machine", taskId: "setup-browser-probe",
    browserExecutable: "chrome", serverExecutable: "chrome-devtools-mcp", host };
  const { profileDir } = await planChromeSession(input);
  return { root, input, profileDir, lock: join(profileDir, "SingletonLock") };
}

it.skipIf(process.platform !== "linux")("recovers a singleton from before boot even when its PID has been reused", async () => {
  const f = await fixture();
  await symlink(`${hostname()}-${process.pid}`, f.lock);
  await lutimes(f.lock, new Date("2000-01-01"), new Date("2000-01-01"));
  await symlink(join(f.root, "missing-socket"), join(f.profileDir, "SingletonSocket"));
  await symlink("old-cookie", join(f.profileDir, "SingletonCookie"));
  expect((await planChromeSession(f.input)).status).toBe("ready");
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    await expect(lstat(join(f.profileDir, name))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a fresh singleton owned by a live process", async () => {
  const f = await fixture(), target = `${hostname()}-${process.pid}`;
  await symlink(target, f.lock);
  expect((await planChromeSession(f.input)).status).toBe("profile_locked");
  expect(await readlink(f.lock)).toBe(target);
});

it.skipIf(process.platform !== "linux")("keeps an old singleton when its browser socket is still present", async () => {
  const f = await fixture(), socketPath = join(f.root, "browser.sock");
  const server = createServer(); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await symlink(socketPath, join(f.profileDir, "SingletonSocket"));
  await symlink(`${hostname()}-${process.pid}`, f.lock);
  await lutimes(f.lock, new Date("2000-01-01"), new Date("2000-01-01"));
  expect((await planChromeSession(f.input)).status).toBe("profile_locked");
  expect(await readlink(f.lock)).toBe(`${hostname()}-${process.pid}`);
});

it.skipIf(process.platform !== "linux")("keeps an old singleton when its live owner still references the profile", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", f.profileDir], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const target = `${hostname()}-${child.pid}`;
  await symlink(target, f.lock);
  await lutimes(f.lock, new Date("2000-01-01"), new Date("2000-01-01"));
  expect((await planChromeSession(f.input)).status).toBe("profile_locked");
  expect(await readlink(f.lock)).toBe(target);
});

it("keeps locks belonging to another host even if they predate boot", async () => {
  const f = await fixture(), target = `other-host-${process.pid}`;
  await symlink(target, f.lock);
  await lutimes(f.lock, new Date("2000-01-01"), new Date("2000-01-01"));
  expect((await planChromeSession(f.input)).status).toBe("profile_locked");
  expect(await readlink(f.lock)).toBe(target);
});
