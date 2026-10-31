import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQualityCommandRunner } from "../src/runner.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("Slice 7 quality command runner hardening", () => {
  it("does not spawn a subprocess when AbortSignal is already aborted at invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-qg-preabort-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const controller = new AbortController();
    controller.abort();

    // If spawn() were invoked at all on a missing binary, spawnError would be populated with ENOENT.
    const result = await createQualityCommandRunner().run({
      executable: join(root, "must-never-be-spawned"),
      args: [],
      cwd: root,
      env: {},
      timeoutMs: 5_000,
      signal: controller.signal
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.aborted).toBe(true);
      expect(result.value.timedOut).toBe(false);
      expect(result.value.exitCode).toBeNull();
      expect(result.value.outputTruncated).toBe(false);
      expect(result.value.spawnError).toBeUndefined();
    }
    expect(existsSync(join(root, "must-never-be-spawned"))).toBe(false);
  });

  it("does not mark outputTruncated when stdout and stderr are each within maxOutputBytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-qg-combined-cap-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const script = join(root, "dual-output.cjs");
    await writeFile(
      script,
      `process.stdout.write("A".repeat(70));\nprocess.stderr.write("B".repeat(70));\n`
    );

    const runner = createQualityCommandRunner();
    const withinPerStream = await runner.run({
      executable: process.execPath,
      args: [script],
      cwd: root,
      env: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100
    });

    expect(withinPerStream.ok).toBe(true);
    if (withinPerStream.ok) {
      expect(withinPerStream.value.exitCode).toBe(0);
      expect(withinPerStream.value.stdout).toBe("A".repeat(70));
      expect(withinPerStream.value.stderr).toBe("B".repeat(70));
      expect(withinPerStream.value.outputTruncated).toBe(false);
      expect(withinPerStream.value.combinedOutput.length).toBe(140);
    }

    const overflowScript = join(root, "overflow-output.cjs");
    await writeFile(
      overflowScript,
      `process.stdout.write("A".repeat(120));\n`
    );
    const exceeded = await runner.run({
      executable: process.execPath,
      args: [overflowScript],
      cwd: root,
      env: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100
    });

    expect(exceeded.ok).toBe(true);
    if (exceeded.ok) {
      expect(exceeded.value.stdout.length).toBe(100);
      expect(exceeded.value.outputTruncated).toBe(true);
    }
  });
});
