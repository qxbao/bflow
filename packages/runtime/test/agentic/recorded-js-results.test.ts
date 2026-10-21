import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { parseNodeTap } from "../../src/agentic/behavioral-runner.js";
import { parseVitestJson } from "../../src/agentic/vitest-json.js";
/** Captured from installed Node22.23.2 / Vitest2.1.9 on2026-10-20.
 * The unselected test deliberately fails if executed. Paths sanitized only.
 * These are parser captures, not successful production sandbox measurements. */
function outcome(stdout: string, stderr = ""): QualityCommandOutcome {
  return { executable: process.execPath, args: [], cwd: "/fixture", exitCode: 0, signal: null, stdout, stderr, combinedOutput: stdout + stderr, durationMs: 1, timedOut: false, aborted: false, outputTruncated: false };
}
it("accepts captured Node exact-name selection without running an unmapped failing test", async () => {
  const tap = await readFile(new URL("./fixtures/node-22-filtered.tap", import.meta.url), "utf8");
  expect(parseNodeTap(outcome(tap), ["target"], true)).toMatchObject({ tests: 1, passed: 1, failed: 0 });
  expect(() => parseNodeTap(outcome(tap), ["other"], true)).toThrow("identities");
});
it("accepts captured Vitest filtered leaves but never accepts a selected skipped test or weakens owner policy", async () => {
  const json = await readFile(new URL("./fixtures/vitest-2-filtered.json", import.meta.url), "utf8");
  const observed = outcome(json, "BFLOW_VITEST_RUNTIME_ERRORS=0\n");
  expect(parseVitestJson(observed, ["suite target"], true)).toMatchObject({ tests: 1, passed: 1, failed: 0 });
  expect(() => parseVitestJson(observed, ["suite target", "suite unmapped"], true)).toThrow("skipped");
  expect(() => parseVitestJson(observed, ["suite target"])).toThrow("skipped");
});
