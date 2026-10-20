import { describe, expect, it } from "vitest";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { parseRunnerResult } from "../../src/agentic/runner-results.js";

const outcome = (stdout: string, exitCode = 0, extra: Partial<QualityCommandOutcome> = {}): QualityCommandOutcome => ({ executable: "/usr/bin/test", args: [], cwd: "/repo", exitCode, signal: null, stdout, stderr: "", combinedOutput: stdout, durationMs: 1, timedOut: false, aborted: false, outputTruncated: false, ...extra });
// Reduced official reporter shapes, NOT live-toolchain/sandbox acceptance evidence.
// pytest --junitxml, Maven Surefire, PHPUnit --log-junit all share this envelope.
const junit = (leaf = "", attrs = 'tests="1" failures="0" errors="0" skipped="0"') => `<testsuites><testsuite name="tests" ${attrs}><testcase classname="tests.Calculator" name="adds">${leaf}</testcase></testsuite></testsuites>`;
const parse = (xml: string, exit = 0, names = ["tests.Calculator.adds"]) => parseRunnerResult("junit", outcome("build log", exit), names, [xml]);

describe("strict shared JUnit ingress", () => {
  it("records exact class-qualified names and assertion Red", () => {
    expect(parse(junit())).toMatchObject({ tests: 1, passed: 1, targetFailure: false });
    expect(parse(junit('<failure type="AssertionError" message="expected 2">assert 1 == 2</failure>', 'tests="1" failures="1" errors="0"'), 1)).toMatchObject({ failed: 1, targetFailure: true });
  });
  it("validates suite and aggregate counts without double counting nested suites", () => {
    expect(parse(`<testsuites tests="1" failures="0" errors="0"><testsuite tests="1"><testsuite tests="1"><testcase classname="tests.Calculator" name="adds"/></testsuite></testsuite></testsuites>`).tests).toBe(1);
    expect(() => parse(junit().replace('<testsuites>', '<testsuites tests="2">'))).toThrow();
    expect(() => parse(junit().replace('tests="1"', 'tests="2"'))).toThrow();
  });
  it.each([
    '<error type="ImportError">missing module</error>', '<skipped/>',
    '<failure type="RuntimeError">crash</failure>', '<failure>failed</failure>', '<failure type="TypeError">AssertionError: logged message</failure>',
    '<failure type="AssertionError"/><failure type="AssertionError"/>'
  ])("blocks non-assertion/incomplete status %s", leaf => expect(() => parse(junit(leaf), 1)).toThrow());
  it.each([
    '<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    '<!ENTITY x "expanded">', '<?evil test?>', '<testsuite>',
    '<testsuites><testsuite tests="0"/></testsuites>',
    '<testsuite tests="1"><testcase name="adds" name="spoof"/></testsuite>',
    '<testsuite tests="1"><testcase name="&unknown;"/></testsuite>',
    '<testsuite tests="1"><testcase name="&#0;"/></testsuite>',
    '<testsuite tests="1"><testcase name="unescaped &"/></testsuite>'
  ])("rejects unsafe or malformed XML: %s", xml => expect(() => parse(xml)).toThrow());
  it("decodes predefined/numeric entities once and handles CDATA", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><testsuite tests="1"><testcase classname="c" name="a&amp;b&#46;c"><system-out><![CDATA[<debug>&stuff]]></system-out></testcase></testsuite>';
    expect(parse(xml, 0, ["c.a&b.c"]).testNames).toEqual(["c.a&b.c"]);
  });
  it("rejects extra identities, duplicated identities, exit contradictions and runtime markers", () => {
    expect(() => parse(junit(), 0, ["wrong"])).toThrow();
    expect(() => parse(junit(), 1)).toThrow();
    expect(() => parse(junit() + junit())).toThrow();
    expect(() => parseRunnerResult("junit", outcome("", 0, { outputTruncated: true }), ["tests.Calculator.adds"], [junit()])).toThrow();
    expect(() => parseRunnerResult("junit", outcome("", 0, { signal: "SIGTERM" }), ["tests.Calculator.adds"], [junit()])).toThrow();
  });
});

function goReport(status: "pass" | "fail", output = ""): string {
  return [ { Action: "start", Package: "example/math" }, { Action: "run", Package: "example/math", Test: "TestAdd" },
    ...(output ? [{ Action: "output", Package: "example/math", Test: "TestAdd", Output: output }] : []),
    { Action: status, Package: "example/math", Test: "TestAdd", Elapsed: 0.001 }, { Action: status, Package: "example/math", Elapsed: 0.002 } ].map(JSON.stringify).join("\n") + "\n";
}
describe("Go JSON", () => {
  it("accepts completed exact identities and assertion diagnostics", () => {
    expect(parseRunnerResult("go_json", outcome(goReport("pass")), ["example/math.TestAdd"]).passed).toBe(1);
    expect(parseRunnerResult("go_json", outcome(goReport("fail", "    add_test.go:7: got 1, want 2\n"), 1), ["example/math.TestAdd"]).targetFailure).toBe(true);
  });
  it("blocks panics, build errors, skips and missing package completion", () => {
    for (const text of [goReport("fail", "panic: bad\n"), goReport("pass").replace('"pass"', '"skip"'), goReport("pass").split("\n").slice(0,-2).join("\n"), '{"Action":"build-fail","Package":"example/math"}\n']) expect(() => parseRunnerResult("go_json", outcome(text, 1), ["example/math.TestAdd"])).toThrow();
  });
});

describe("Rust libtest", () => {
  const report = (failed: boolean, message = "assertion `left == right` failed") => `running 1 test\ntest tests::adds ... ${failed ? "FAILED" : "ok"}\n${failed ? `\nfailures:\n\n---- tests::adds stdout ----\nthread 'tests::adds' panicked at src/lib.rs:8:5:\n${message}\n\nfailures:\n    tests::adds\n` : ""}\ntest result: ${failed ? "FAILED. 0 passed; 1 failed" : "ok. 1 passed; 0 failed"}; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`;
  it("accepts pass and assertion panic, rejects arbitrary panic", () => {
    expect(parseRunnerResult("rust_libtest", outcome(report(false)), ["tests::adds"]).passed).toBe(1);
    expect(parseRunnerResult("rust_libtest", outcome(report(true), 101), ["tests::adds"]).targetFailure).toBe(true);
    expect(() => parseRunnerResult("rust_libtest", outcome(report(true, "called Option::unwrap() on a None value"), 101), ["tests::adds"])).toThrow();
    expect(() => parseRunnerResult("rust_libtest", outcome(report(false).replace('0 ignored', '1 ignored')), ["tests::adds"])).toThrow();
  });
});

const trx = (status = "Passed", message = "") => `<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results><UnitTestResult testId="id" testName="Suite.Adds" outcome="${status}">${message}</UnitTestResult></Results><TestDefinitions><UnitTest id="id" name="Suite.Adds"><TestMethod className="Suite" name="Adds"/></UnitTest></TestDefinitions><ResultSummary outcome="${status === "Passed" ? "Completed" : "Failed"}"><Counters total="1" executed="1" passed="${status === "Passed" ? 1 : 0}" failed="${status === "Failed" ? 1 : 0}" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"/></ResultSummary></TestRun>`;
it("TRX validates definitions, counts and assertion exception type", () => {
  expect(parseRunnerResult("trx", outcome(""), ["Suite.Adds"], [trx()]).passed).toBe(1);
  expect(parseRunnerResult("trx", outcome("", 1), ["Suite.Adds"], [trx("Failed", '<Output><ErrorInfo><Message>Xunit.Sdk.EqualException: expected 2</Message></ErrorInfo></Output>')]).targetFailure).toBe(true);
  expect(() => parseRunnerResult("trx", outcome("", 1), ["Suite.Adds"], [trx("Failed", '<Output><ErrorInfo><Message>System.NullReferenceException: bad</Message></ErrorInfo></Output>')])).toThrow();
  expect(() => parseRunnerResult("trx", outcome(""), ["Suite.Adds"], [trx().replace('executed="1"', 'executed="0"')])).toThrow();
});

it("Jest structured result rejects suite/runtime failures and skip/todo", () => {
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, numRuntimeErrorTestSuites: 0, wasInterrupted: false, testResults: [{ status: "passed", message: "", assertionResults: [{ fullName: "adds correctly", title: "correctly", ancestorTitles: ["adds"], status: "passed", failureMessages: [] }] }] };
  expect(parseRunnerResult("jest_json", outcome(JSON.stringify(report)), ["adds correctly"]).passed).toBe(1);
  expect(() => parseRunnerResult("jest_json", outcome(JSON.stringify({ ...report, numRuntimeErrorTestSuites: 1 })), ["adds correctly"])).toThrow();
});
it("Mocha JSON matches all tests with passes/failures and rejects hooks/runtime errors", () => {
  const test = { title: "adds", fullTitle: "Calculator adds", err: {} };
  const report = { stats: { tests: 1, passes: 1, failures: 0, pending: 0 }, tests: [test], passes: [test], failures: [], pending: [] };
  expect(parseRunnerResult("mocha_json", outcome(JSON.stringify(report)), ["Calculator adds"]).passed).toBe(1);
  expect(() => parseRunnerResult("mocha_json", outcome(JSON.stringify({ ...report, failures: [{ ...test, err: { name: "TypeError", message: "crash" } }] }), 1), ["Calculator adds"])).toThrow();
});
it("RSpec JSON validates totals and failed expectation class", () => {
  const report = { examples: [{ full_description: "Calculator adds", status: "passed" }], summary: { example_count: 1, failure_count: 0, pending_count: 0, errors_outside_of_examples_count: 0 } };
  expect(parseRunnerResult("rspec_json", outcome(JSON.stringify(report)), ["Calculator adds"]).passed).toBe(1);
  const red = { examples: [{ full_description: "Calculator adds", status: "failed", exception: { class: "RSpec::Expectations::ExpectationNotMetError", message: "expected 2, got 1" } }], summary: { ...report.summary, failure_count: 1 } };
  expect(parseRunnerResult("rspec_json", outcome(JSON.stringify(red), 1), ["Calculator adds"]).targetFailure).toBe(true);
  expect(() => parseRunnerResult("rspec_json", outcome(JSON.stringify({ ...report, summary: { ...report.summary, errors_outside_of_examples_count: 1 } })), ["Calculator adds"])).toThrow();
});

it.each([
  'java.lang.AssertionError', 'org.opentest4j.AssertionFailedError', 'org.junit.ComparisonFailure',
  'PHPUnit\\Framework\\ExpectationFailedException', 'NUnit.Framework.AssertionException',
  'RSpec::Expectations::ExpectationNotMetError', 'Minitest::Assertion'
])("JUnit accepts known assertion exception %s", type => {
  expect(parse(junit(`<failure type="${type}"/>`, 'tests="1" failures="1"'), 1).targetFailure).toBe(true);
});
it.each([
  { spawnError: "ENOENT" }, { timedOut: true }, { aborted: true }, { outputTruncated: true }, { signal: "SIGKILL" as const }, { exitCode: null }
])("rejects infrastructure before parsing any successful report: %j", extra => {
  expect(() => parseRunnerResult("junit", outcome("", 0, extra), ["tests.Calculator.adds"], [junit()])).toThrow(/infrastructure/);
});
it("blocks duplicated names across independent JUnit report files", () => {
  expect(() => parseRunnerResult("junit", outcome(""), ["tests.Calculator.adds"], [junit(), junit()])).toThrow(/duplicate/);
});
it("TRX uses definition class/method instead of display names", () => {
  expect(parseRunnerResult("trx", outcome(""), ["Suite.Adds"], [trx().replace('testName="Suite.Adds"', 'testName="adds prettily"').replace('className="Suite"', 'className="Suite, Tests.Assembly"')]).testNames).toEqual(["Suite.Adds"]);
});
it("Go subtest parent is an aggregate and names retain package ownership", () => {
  const events = [
    { Action: "run", Package: "example/math", Test: "TestAdd" },
    { Action: "run", Package: "example/math", Test: "TestAdd/positive" },
    { Action: "pass", Package: "example/math", Test: "TestAdd/positive" },
    { Action: "pass", Package: "example/math", Test: "TestAdd" },
    { Action: "pass", Package: "example/math" }
  ].map(JSON.stringify).join("\n");
  expect(parseRunnerResult("go_json", outcome(events), ["example/math.TestAdd/positive"]).tests).toBe(1);
  expect(() => parseRunnerResult("go_json", outcome(events), ["TestAdd/positive"])).toThrow();
});
it("Jest assertion Red differs from runtime TypeError", () => {
  const report = (message: string) => ({ success: false, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numPassedTestSuites: 0, numFailedTestSuites: 1, numPendingTestSuites: 0, numRuntimeErrorTestSuites: 0, wasInterrupted: false, testResults: [{ status: "failed", message, assertionResults: [{ fullName: "adds correctly", title: "correctly", ancestorTitles: ["adds"], status: "failed", failureMessages: [message] }] }] });
  expect(parseRunnerResult("jest_json", outcome(JSON.stringify(report('Error: expect(received).toBe(expected)\nExpected: 2\nReceived: 1')), 1), ["adds correctly"]).targetFailure).toBe(true);
  expect(() => parseRunnerResult("jest_json", outcome(JSON.stringify(report('TypeError: cannot read properties of null')), 1), ["adds correctly"])).toThrow();
});
it("Mocha assertion Red requires matching leaf records and totals", () => {
  const test = { title: "adds", fullTitle: "Calculator adds", err: { name: "AssertionError", message: "expected 1 to equal 2" } };
  const report = { stats: { tests: 1, passes: 0, failures: 1, pending: 0 }, tests: [test], passes: [], failures: [test], pending: [] };
  expect(parseRunnerResult("mocha_json", outcome(JSON.stringify(report), 1), ["Calculator adds"]).targetFailure).toBe(true);
  expect(() => parseRunnerResult("mocha_json", outcome(JSON.stringify(report)), ["Calculator adds"])).toThrow();
  expect(() => parseRunnerResult("mocha_json", outcome(JSON.stringify({ ...report, tests: [{ ...test, fullTitle: "different" }] }), 1), ["Calculator adds"])).toThrow();
});
it("RSpec blocks runtime exceptions independently from failure count", () => {
  const report = { examples: [{ full_description: "Calculator adds", status: "failed", exception: { class: "NoMethodError", message: "missing method" } }], summary: { example_count: 1, failure_count: 1, pending_count: 0 } };
  expect(() => parseRunnerResult("rspec_json", outcome(JSON.stringify(report), 1), ["Calculator adds"])).toThrow(/runtime/);
});
it("rejects XML namespace tricks, mixed content, deep nesting and oversized input", () => {
  for (const report of [ '<x:testsuite tests="1"><x:testcase name="adds"/></x:testsuite>', '<testsuite tests="1"><testcase name="adds"/></testsuite>junk', '<testsuite tests="1">'.repeat(70) + '</testsuite>'.repeat(70), ' '.repeat(4_194_305) ]) expect(() => parse(report)).toThrow();
});

it("CTest assertion JUnit requires its explicit Runtime-selected failure exit code", () => {
  const xml = junit('<failure type="AssertionError"/>', 'tests="1" failures="1"');
  expect(() => parseRunnerResult("junit", outcome("", 8), ["tests.Calculator.adds"], [xml])).toThrow();
  expect(parseRunnerResult("junit", outcome("", 8), ["tests.Calculator.adds"], [xml], [8]).targetFailure).toBe(true);
});
it("Go accepts blank output records but rejects events after completion", () => {
  const report = goReport("fail", "\n    add_test.go:7: got 1, want 2\n");
  expect(parseRunnerResult("go_json", outcome(report, 1), ["example/math.TestAdd"]).targetFailure).toBe(true);
  expect(() => parseRunnerResult("go_json", outcome(goReport("pass") + JSON.stringify({Action:"output",Package:"example/math",Output:"late"})), ["example/math.TestAdd"])).toThrow();
});
