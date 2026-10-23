import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { parseNodeTap } from "../../src/agentic/behavioral-runner.js";
import { parseVitestJson } from "../../src/agentic/vitest-json.js";
import { NodeTapTestCodeFailure } from "../../src/agentic/node-tap.js";
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

it("classifies only complete matched test-body errors as test repairs, never malformed output or infrastructure", () => {
  const tap = "TAP version 13\nnot ok 1 - target\n  ---\n  failureType: 'testCodeFailure'\n  error: 'math.multiply is not a function'\n  name: 'TypeError'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
  const failed = { ...outcome(tap), exitCode: 1 };
  expect(() => parseNodeTap(failed, ["target"])).toThrow(NodeTapTestCodeFailure);
  expect(() => parseNodeTap({ ...failed, timedOut: true }, ["target"])).toThrow("infrastructure failure");
  expect(() => parseNodeTap(failed, ["another target"])).toThrow("identities");
  expect(() => parseNodeTap({ ...failed, stdout: tap.replace("# tests 1", "# tests 2") }, ["target"])).toThrow("incomplete");
  expect(() => parseNodeTap({ ...failed, stdout: tap.replace("testCodeFailure", "hookFailed") }, ["target"])).toThrow("infrastructure or unrelated");
});
