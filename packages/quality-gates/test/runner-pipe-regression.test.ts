import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createQualityCommandRunner } from "../src/runner.js";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Runner did not settle while a detached descendant retained its pipes")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

it.skipIf(process.platform === "win32")("settles abort independently of an escaped descendant's inherited output pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pipe-regression-"));
  const pidFile = join(root, "descendant.pid"), parentScript = join(root, "parent.cjs");
  const descendant = `
    process.on('SIGTERM', () => {});
    console.log('descendant ready');
    setInterval(() => {}, 1000);
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  `;
  await writeFile(parentScript, `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
      { detached: true, stdio: ['ignore', 1, 2] }).unref();
  `);
  const controller = new AbortController();
  const running = createQualityCommandRunner().run({ executable: process.execPath, args: [parentScript],
    cwd: root, env: {}, timeoutMs: 10_000, signal: controller.signal });
  let pid: number | undefined;
  try {
    // Wait for actual initialization before aborting, independent of subprocess startup speed.
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const value = Number(await readFile(pidFile, "utf8"));
        if (Number.isInteger(value) && value > 0) { pid = value; break; }
      } catch { /* The real descendant has not initialized yet. */ }
      await delay(10);
    }
    expect(pid, "descendant started").toBeDefined();
    controller.abort();
    const result = await within(running, 2000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.aborted).toBe(true);
      expect(result.value.timedOut).toBe(false);
      expect(result.value.stdout).toContain("descendant ready");
    }
    // The detached process escapes the runner's group: completion must not depend on its exit.
    expect(() => process.kill(pid!, 0)).not.toThrow();
  } finally {
    controller.abort();
    try {
      pid ??= Number(await readFile(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch { /* Already stopped or never started. */ }
    try { await within(running, 2000); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
