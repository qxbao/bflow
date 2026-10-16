import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeCommandRunner, findExecutable } from "../src/index.js";

describe("findExecutable regular files only", () => {
  it("does not match a directory named like the tool", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ms-fx-"));
    try {
      const bin = path.join(dir, "bin");
      await mkdir(path.join(bin, "tool"), { recursive: true });
      await chmod(path.join(bin, "tool"), 0o755);
      expect(await findExecutable("tool", [bin], "linux")).toBeNull();
      const other = path.join(dir, "other");
      await mkdir(other);
      await writeFile(path.join(other, "tool"), "#!/bin/sh\n", { mode: 0o755 });
      expect(await findExecutable("tool", [bin, other], "linux")).toBe(path.join(other, "tool"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runner timeout with descendant holding pipes", () => {
  it("resolves within bounded grace after kill", async () => {
    const script =
      "const {spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});" +
      "setTimeout(()=>{},30000)";
    const started = Date.now();
    const r = await new NodeCommandRunner().run([process.execPath, "-e", script], { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(300 + 500 + 400);
  }, 10_000);
});
