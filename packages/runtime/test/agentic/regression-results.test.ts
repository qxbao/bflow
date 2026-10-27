import { describe, expect, it } from "vitest";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import {
  parseRegressionResult,
  RegressionInfrastructureFailure
} from "../../src/agentic/regression-results.js";

function makeOutcome(overrides: Partial<QualityCommandOutcome> = {}): QualityCommandOutcome {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    executable: process.execPath,
    args: [],
    cwd: "/checkout",
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    combinedOutput: stdout + stderr,
    durationMs: 10,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...overrides
  };
}

describe("parseRegressionResult (node_tap)", () => {
  it("parses mixed pass, TypeError failure with location, skip, and second file pass", () => {
    const tap = [
      "TAP version 13",
      "# Subtest: ok a",
      "ok 1 - ok a",
      "  ---",
      "  duration_ms: 1.2",
      "  type: 'test'",
      "  ...",
      "# Subtest: bad a",
      "not ok 2 - bad a",
      "  ---",
      "  duration_ms: 0.5",
      "  type: 'test'",
      "  location: '/checkout/test/a.test.mjs:14:3'",
      "  failureType: 'testCodeFailure'",
      "  error: 'x is not a function'",
      "  code: 'ERR_TEST_FAILURE'",
      "  name: 'TypeError'",
      "  ...",
      "# Subtest: skip a",
      "ok 3 - skip a # SKIP",
      "  ---",
      "  duration_ms: 0.1",
      "  type: 'test'",
      "  ...",
      "# Subtest: ok b",
      "ok 4 - ok b",
      "  ---",
      "  duration_ms: 0.8",
      "  type: 'test'",
      "  ...",
      "1..4",
      "# tests 4",
      "# suites 0",
      "# pass 2",
      "# fail 1",
      "# cancelled 0",
      "# skipped 1",
      "# todo 0",
      "# duration_ms 12.3",
      ""
    ].join("\n");

    const result = parseRegressionResult(
      makeOutcome({ stdout: tap, exitCode: 1 }),
      "node_tap",
      "/checkout"
    );

    expect(result).toEqual({
      tests: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
      failures: [{ testPath: "test/a.test.mjs", testName: "bad a" }]
    });
  });

  it("joins nested subtest names with ' > ' and does not duplicate subtestsFailed parent container", () => {
    const tap = [
      "TAP version 13",
      "# Subtest: outer suite",
      "    # Subtest: inner suite",
      "        # Subtest: leaf ok",
      "        ok 1 - leaf ok",
      "          ---",
      "          duration_ms: 0.4",
      "          type: 'test'",
      "          ...",
      "        # Subtest: leaf bad",
      "        not ok 2 - leaf bad",
      "          ---",
      "          duration_ms: 0.6",
      "          type: 'test'",
      "          location: '/checkout/test/nested.test.mjs:9:7'",
      "          failureType: 'testCodeFailure'",
      "          error: 'nested failure'",
      "          code: 'ERR_TEST_FAILURE'",
      "          ...",
      "        1..2",
      "    not ok 1 - inner suite",
      "      ---",
      "      duration_ms: 1.2",
      "      type: 'suite'",
      "      location: '/checkout/test/nested.test.mjs:4:3'",
      "      failureType: 'subtestsFailed'",
      "      error: '1 subtest failed'",
      "      code: 'ERR_TEST_FAILURE'",
      "      ...",
      "    1..1",
      "not ok 1 - outer suite",
      "  ---",
      "  duration_ms: 2.0",
      "  type: 'suite'",
      "  location: '/checkout/test/nested.test.mjs:2:1'",
      "  failureType: 'subtestsFailed'",
      "  error: '1 subtest failed'",
      "  code: 'ERR_TEST_FAILURE'",
      "  ...",
      "1..1",
      "# tests 2",
      "# suites 2",
      "# pass 1",
      "# fail 1",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      ""
    ].join("\n");

    const result = parseRegressionResult(
      makeOutcome({ stdout: tap, exitCode: 1 }),
      "node_tap",
      "/checkout"
    );

    expect(result).toEqual({
      tests: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [
        {
          testPath: "test/nested.test.mjs",
          testName: "outer suite > inner suite > leaf bad"
        }
      ]
    });
  });

  it("records file-level failures (such as import errors) with testName '<file>'", () => {
    const tap = [
      "TAP version 13",
      "# Subtest: /checkout/test/broken.test.mjs",
      "not ok 1 - /checkout/test/broken.test.mjs",
      "  ---",
      "  duration_ms: 25.1",
      "  type: 'test'",
      "  location: '/checkout/test/broken.test.mjs:1:1'",
      "  failureType: 'testCodeFailure'",
      "  exitCode: 1",
      "  signal: ~",
      "  error: 'test failed'",
      "  code: 'ERR_TEST_FAILURE'",
      "  ...",
      "1..1",
      "# tests 1",
      "# suites 0",
      "# pass 0",
      "# fail 1",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      ""
    ].join("\n");

    const result = parseRegressionResult(
      makeOutcome({ stdout: tap, exitCode: 1 }),
      "node_tap",
      "/checkout"
    );

    expect(result).toEqual({
      tests: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      failures: [{ testPath: "test/broken.test.mjs", testName: "<file>" }]
    });
  });
});

describe("parseRegressionResult (vitest_json)", () => {
  function makeVitestReport(overrides: Record<string, unknown> = {}) {
    return {
      numTotalTestSuites: 1,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      numTotalTests: 3,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 0,
      snapshot: { failure: false, didUpdate: false },
      startTime: 1700000000000,
      success: false,
      testResults: [
        {
          name: "/checkout/test/math.test.ts",
          status: "failed",
           startTime: 1700000000001,
          endTime: 1700000000010,
          message: "",
          assertionResults: [
            {
              ancestorTitles: ["math"],
              title: "adds numbers",
              fullName: "math adds numbers",
              status: "passed",
              failureMessages: []
            },
            {
              ancestorTitles: ["math"],
              title: "throws TypeError in regression",
              fullName: "math throws TypeError in regression",
              status: "failed",
              failureMessages: ["TypeError: Cannot read properties of undefined (reading 'foo')"]
            },
            {
              ancestorTitles: ["math"],
              title: "pending case",
              fullName: "math pending case",
              status: "skipped",
              failureMessages: []
            }
          ]
        }
      ],
      ...overrides
    };
  }

  it("counts TypeError failures and accepts pending/todo tests", () => {
    const report = makeVitestReport({
      numTotalTests: 4,
      numPendingTests: 1,
      numTodoTests: 1
    });
    const outcome = makeOutcome({
      stdout: JSON.stringify(report),
      stderr: "BFLOW_VITEST_RUNTIME_ERRORS=0\n",
      exitCode: 1
    });

    const result = parseRegressionResult(outcome, "vitest_json", "/checkout");
    expect(result).toEqual({
      tests: 4,
      passed: 1,
      failed: 1,
      skipped: 2,
      failures: [
        {
          testPath: "test/math.test.ts",
          testName: "math throws TypeError in regression"
        }
      ]
    });
  });

  it("adds <vitest-runtime-errors> failure when BFLOW_VITEST_RUNTIME_ERRORS > 0", () => {
    const report = makeVitestReport();
    const outcome = makeOutcome({
      stdout: JSON.stringify(report),
      stderr: "BFLOW_VITEST_RUNTIME_ERRORS=2\n",
      exitCode: 1
    });

    const result = parseRegressionResult(outcome, "vitest_json", "/checkout");
    expect(result.failures).toEqual([
      {
        testPath: "test/math.test.ts",
        testName: "math throws TypeError in regression"
      },
      {
        testPath: "<runtime>",
        testName: "<vitest-runtime-errors>"
      }
    ]);
    expect(result.failed).toBe(2);
  });

  it("records <file> when a Vitest suite fails with zero failed leaf assertions", () => {
    const report = makeVitestReport({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [
        {
          name: "/checkout/test/import-error.test.ts",
          status: "failed",
          startTime: 1700000000001,
          endTime: 1700000000010,
          message: "Failed to resolve import './missing.js'",
          assertionResults: []
        }
      ]
    });
    const outcome = makeOutcome({
      stdout: JSON.stringify(report),
      stderr: "BFLOW_VITEST_RUNTIME_ERRORS=0\n",
      exitCode: 1
    });

    const result = parseRegressionResult(outcome, "vitest_json", "/checkout");
    expect(result.failures).toEqual([
      { testPath: "test/import-error.test.ts", testName: "<file>" }
    ]);
    expect(result.failed).toBe(1);
  });
});

describe("parseRegressionResult infrastructure errors", () => {
  it("throws RegressionInfrastructureFailure starting with regression_budget_exceeded on timedOut", () => {
    expect(() =>
      parseRegressionResult(makeOutcome({ timedOut: true }), "node_tap", "/checkout")
    ).toThrowError(RegressionInfrastructureFailure);
    expect(() =>
      parseRegressionResult(makeOutcome({ timedOut: true }), "node_tap", "/checkout")
    ).toThrow(/^regression_budget_exceeded/);
  });

  it.each([
    ["signal", { signal: "SIGKILL" as const }],
    ["outputTruncated", { outputTruncated: true }],
    ["spawnError", { spawnError: "ENOENT" }],
    ["aborted", { aborted: true }]
  ])("throws RegressionInfrastructureFailure on %s", (_label, patch) => {
    expect(() =>
      parseRegressionResult(makeOutcome(patch), "node_tap", "/checkout")
    ).toThrowError(RegressionInfrastructureFailure);
  });

  it("throws RegressionInfrastructureFailure on malformed JSON or missing runtime reporter stderr", () => {
    expect(() =>
      parseRegressionResult(
        makeOutcome({ stdout: "{broken", stderr: "BFLOW_VITEST_RUNTIME_ERRORS=0\n", exitCode: 1 }),
        "vitest_json",
        "/checkout"
      )
    ).toThrowError(RegressionInfrastructureFailure);

    expect(() =>
      parseRegressionResult(
        makeOutcome({ stdout: "{}", stderr: "", exitCode: 0 }),
        "vitest_json",
        "/checkout"
      )
    ).toThrowError(RegressionInfrastructureFailure);
  });

  it("throws RegressionInfrastructureFailure when tests === 0 and exitCode !== 0", () => {
    const emptyTap = [
      "TAP version 13",
      "1..0",
      "# tests 0",
      "# suites 0",
      "# pass 0",
      "# fail 0",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      ""
    ].join("\n");
    expect(() =>
      parseRegressionResult(makeOutcome({ stdout: emptyTap, exitCode: 1 }), "node_tap", "/checkout")
    ).toThrowError(RegressionInfrastructureFailure);

    const emptyVitest = JSON.stringify({
      numTotalTestSuites: 0,
      numPassedTestSuites: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      snapshot: { failure: false, didUpdate: false },
      startTime: 1700000000000,
      success: false,
      testResults: []
    });
    expect(() =>
      parseRegressionResult(
        makeOutcome({
          stdout: emptyVitest,
          stderr: "BFLOW_VITEST_RUNTIME_ERRORS=0\n",
          exitCode: 1
        }),
        "vitest_json",
        "/checkout"
      )
    ).toThrowError(RegressionInfrastructureFailure);
  });
});
