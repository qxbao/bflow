import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createQualityCommandRunner } from "../src/runner.js";

describe.skipIf(process.platform === "win32")("quality runner descendant cancellation", () => {
  async function fixture(detached: boolean, exitParent = false) {
    const root = await mkdtemp(join(tmpdir(), "quality-descendants-"));
    const pidFile = join(root, "grandchild.pid");
    const childScript = join(root, "parent.cjs");
    const descendantCode = `
      process.on('SIGTERM', () => {});
      console.log('descendant ready');
      setInterval(() => {}, 1000);
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    `;
    await writeFile(childScript, `
      const descendant = require('node:child_process').spawn(process.execPath,
        ['-e', ${JSON.stringify(descendantCode)}],
        { detached: ${detached}, stdio: ['ignore', 1, 2] });
      ${exitParent ? "descendant.unref();" : "setInterval(() => {}, 1000);"}
    `);
    let pid: number | undefined;
    return {
      root,
      childScript,
      async waitForDescendant() {
        for (let index = 0; index < 200; index++) {
          try {
            pid = Number(await readFile(pidFile, "utf8"));
            if (Number.isInteger(pid) && pid > 0) return pid;
          } catch { /* Wait until the real child has initialized. */ }
          await delay(10);
        }
        throw new Error("Descendant failed to start");
      },
      async cleanup() {
        // Detached descendants deliberately remain outside the runner's group.
        try {
          pid ??= Number(await readFile(pidFile, "utf8"));
          if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
        } catch { /* Already terminated or never started. */ }
        await rm(root, { recursive: true, force: true });
      }
    };
  }

  async function isAlive(pid: number) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        // An orphan may remain a zombie until the host's init reaps it.
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  for (const mode of ["timeout", "abort"] as const) {
    it(`bounds ${mode} and kills a non-detached grandchild ignoring SIGTERM`, async () => {
      const f = await fixture(false);
      const controller = new AbortController();
      try {
        const run = createQualityCommandRunner().run({
          executable: process.execPath,
          args: [f.childScript],
          cwd: f.root,
          env: {},
          timeoutMs: mode === "timeout" ? 700 : 10_000,
          signal: controller.signal
        });
        const pid = await f.waitForDescendant();
        const start = Date.now();
        if (mode === "abort") controller.abort();
        const result = await run;
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.timedOut).toBe(mode === "timeout");
        expect(result.value.aborted).toBe(mode === "abort");
        expect(result.value.stdout).toContain("descendant ready");
        expect(Date.now() - start).toBeLessThan(2000);
        for (let index = 0; index < 50 && await isAlive(pid); index++) await delay(10);
        expect(await isAlive(pid)).toBe(false);
      } finally {
        controller.abort();
        await f.cleanup();
      }
    });
  }

  it("returns within the escalation budget when a detached descendant retains pipes", async () => {
    const f = await fixture(true, true);
    try {
      const run = createQualityCommandRunner().run({
        executable: process.execPath,
        args: [f.childScript],
        cwd: f.root,
        env: {},
        timeoutMs: 700
      });
      await f.waitForDescendant();
      const result = await run;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timedOut).toBe(true);
      expect(result.value.exitCode).toBe(0);
      expect(result.value.signal).toBeNull();
      expect(result.value.durationMs).toBeLessThan(2000);
      expect(result.value.stdout).toContain("descendant ready");
    } finally {
      await f.cleanup();
    }
  });
});
