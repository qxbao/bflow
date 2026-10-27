import { describe, expect, it } from "vitest";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { parseNodeTap } from "../../src/agentic/node-tap.js";
import { parseRunnerResult } from "../../src/agentic/runner-results.js";

const outcome = (stdout: string, exitCode = 0): QualityCommandOutcome => ({ executable: "/usr/local/bin/node", args: [], cwd: "/repo",
  exitCode, signal: null, stdout, stderr: "", combinedOutput: stdout, durationMs: 1, timedOut: false, aborted: false, outputTruncated: false });

// Recorded from Node v22.19.0: `node --test --test-reporter=tap --test-name-pattern=^(?:alpha one)$ test/a.test.mjs test/b.test.mjs`.
// A selected file without a matching test is reported as a passing top-level test named after the file, not as a SKIP.
// Live run bf-b5679f4f2e725cadfef1 blocked workflow verification on this: the unit command also selected the integration test file.
const unmatchedFile = `TAP version 13
# Subtest: alpha one
ok 1 - alpha one
  ---
  duration_ms: 0.335125
  type: 'test'
  ...
1..0
# Subtest: test/b.test.mjs
ok 2 - test/b.test.mjs
  ---
  duration_ms: 38.440584
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 45.80575
`;

describe("Node TAP name selection across several selected files", () => {
  it("ignores the passing placeholder Node reports for a selected file without a matching test", () => {
    const parsed = parseNodeTap(outcome(unmatchedFile), ["alpha one"], true, ["test/a.test.mjs", "test/b.test.mjs"]);
    expect(parsed).toMatchObject({ testNames: ["alpha one"], tests: 1, passed: 1, failed: 0 });
    expect(parseRunnerResult("node_tap", outcome(unmatchedFile), ["alpha one"], undefined, undefined, ["test/a.test.mjs", "test/b.test.mjs"]).testNames)
      .toEqual(["alpha one"]);
  });

  it("still refuses a file entry that is not one of the selected files", () => {
    expect(() => parseNodeTap(outcome(unmatchedFile), ["alpha one"], true, ["test/a.test.mjs"]))
      .toThrow("Observed test names differ from owner-configured identities");
    expect(() => parseNodeTap(outcome(unmatchedFile), ["alpha one"], false, ["test/a.test.mjs", "test/b.test.mjs"]))
      .toThrow("Observed test names differ from owner-configured identities");
  });

  it("keeps a failing selected file as a failure instead of hiding it", () => {
    const failing = unmatchedFile.replace("ok 2 - test/b.test.mjs", "not ok 2 - test/b.test.mjs").replace("# pass 2", "# pass 1").replace("# fail 0", "# fail 1");
    expect(() => parseNodeTap(outcome(failing, 1), ["alpha one"], true, ["test/a.test.mjs", "test/b.test.mjs"])).toThrow();
  });
});
