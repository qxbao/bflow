import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { measureBehavior } from "../../src/agentic/behavioral-runner.js";
import { cleanups, fixture } from "../helpers/behavioral-runner-fixture.js";
import { writeDarwinRtkFixture } from "./rtk-fixture.js";

const observation = vi.hoisted(() => ({ revoked: false, rtkChildren: [] as string[][], revokeAfter: 1 }));
// Observe real child processes; every sandbox command and RTK probe still executes normally.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    const argv = Array.isArray(args[1]) ? args[1] as readonly string[] : [];
    const separator = argv.lastIndexOf("--");
    const executable = separator >= 0 && argv[separator + 1]?.startsWith("/") && argv[separator + 1]?.endsWith("/.bflow-rtk-scratch/rtk")
      ? separator + 1
      : -1;
    if (executable >= 0) {
      observation.rtkChildren.push([...argv.slice(executable + 1)]);
      if (observation.rtkChildren.length === observation.revokeAfter) child.once("close", () => { observation.revoked = true; });
    }
    return child;
  } };
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  observation.revoked = false; observation.rtkChildren = []; observation.revokeAfter = 1;
});

describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("RTK executable authorization", () => {
  it.each([1, 2, 3])("blocks the next actual RTK child when authority changes after probe %s", async revokeAfter => {
    const f = await fixture();
    const executablePath = join(dirname(f.cwd), "rtk-authority-fixture");
    await writeFile(executablePath, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'rtk 1.0.1\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--help" ]; then printf 'Read stdin --filter <FILTER>\\n'; exit 0; fi
if [ "$1" = "pipe" ]; then cat; exit 0; fi
exit 2
`);
    await chmod(executablePath, 0o700);
    await writeDarwinRtkFixture(executablePath, "passthrough");
    observation.revokeAfter = revokeAfter;
    let authorizations = 0;
    const beforeSideEffect = async () => {
      await Promise.resolve();
      authorizations++;
      if (observation.revoked) throw new Error("Profile tool authority revoked");
    };
    await expect(measureBehavior(f.command, f.cwd, f.redRevision, { rtk: {
      executablePath, version: "1.0.1", digest: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
      filter: "auto", required: true, beforeSideEffect
    } })).rejects.toThrow(/RTK/);
    expect(authorizations).toBe(revokeAfter + 1);
    expect(observation.rtkChildren).toEqual([["--version"], ["pipe", "--help"], ["pipe"]].slice(0, revokeAfter));
  });
});
