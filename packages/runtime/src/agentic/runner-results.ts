import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { parseNodeTap } from "./node-tap.js";
import { parseVitestJson } from "./vitest-json.js";
import type { ResultFormat } from "./runner-adapter.js";

interface TestResult { name: string; passed: boolean }
export interface ParsedRunnerResult {
  testNames: string[]; testResults: TestResult[]; tests: number; passed: number; failed: number; targetFailure: boolean;
}
function invalid(reason: string): never { throw new Error(`Behavioral result rejected: ${reason}`); }
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid("expected object");
  return input as Record<string, unknown>;
}
function array(input: unknown): unknown[] { if (!Array.isArray(input)) invalid("expected array"); return input; }
function text(input: unknown): string { if (typeof input !== "string" || !input.trim() || input.includes("\0")) invalid("missing text"); return input; }
function number(input: unknown): number { if (!Number.isSafeInteger(input) || Number(input) < 0) invalid("invalid counter"); return Number(input); }
function logText(input: unknown): string { if (typeof input !== "string" || input.includes("\0")) invalid("invalid log text"); return input; }
function json(input: string): unknown { try { return JSON.parse(input); } catch { return invalid("incomplete JSON"); } }
function finish(results: TestResult[], outcome: QualityCommandOutcome, expected: readonly string[], failureExitCodes: readonly number[] = [1]): ParsedRunnerResult {
  const names = results.map(test => test.name), observed = [...names].sort(), mapped = [...expected].sort();
  if (!results.length || new Set(names).size !== names.length || new Set(expected).size !== expected.length || observed.length !== mapped.length || observed.some((name, index) => name !== mapped[index])) invalid("zero, duplicate or mismatched test identities");
  const passed = results.filter(result => result.passed).length, failed = results.length - passed;
  if (failed ? !failureExitCodes.includes(outcome.exitCode!) : outcome.exitCode !== 0) invalid("process exit contradicts test results");
  return { testNames: names, testResults: results, tests: results.length, passed, failed, targetFailure: failed > 0 };
}
// Whitelist assertion exception families. Arbitrary <failure> and arbitrary panic are never Red evidence.
function assertion(input: string): boolean {
  return /(?:^|[\s:.(\\])(?:AssertionError|VitestAssertionError|JestAssertionError|JestExtendError|ChaiError|ExpectError|TestingLibraryElementError|HtmlElementTypeError|AssertionFailedError|AssertFailedException|AssertionException|ComparisonFailure|MultipleFailuresError|ExpectationFailedException|ExpectationNotMetError|AssertError|AssertException|Minitest::Assertion|Xunit\.Sdk\.[A-Za-z]*Exception|Microsoft\.VisualStudio\.TestTools\.UnitTesting\.AssertFailedException)(?:$|[\s:.)\[])/.test(input) || /(?:^|\n)\s*(?:E\s+)?(?:assert\s+|AssertionError:|Failed: DID NOT RAISE\b|XCTAssert\w* failed:|Assertion [^\n]+ failed\.|Assert\.[A-Za-z]+\(\) Failure:)/.test(input);
}

interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }
function xmlCharacter(code: number): boolean { return code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff; }
function unescapeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) invalid("unknown or malformed XML entity");
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_all, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity]!;
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!xmlCharacter(code)) invalid("invalid XML character reference");
    return String.fromCodePoint(code);
  });
}
/** Small bounded XML codec. No DTD, general entities, external resolution, namespace expansion or executable processing instructions. */
function xml(input: string): XmlNode {
  if (input.length > 4_194_304 || [...input].some(char => !xmlCharacter(char.codePointAt(0)!))) invalid("XML size or character limit");
  input = input.replace(/^\uFEFF/, "");
  const document: XmlNode = { name: "#document", attrs: {}, children: [], text: "" }, stack = [document];
  let offset = 0, nodes = 0;
  while (offset < input.length) {
    const current = stack[stack.length - 1]!;
    if (input.startsWith("<!--", offset)) {
      const end = input.indexOf("-->", offset + 4);
      if (end < 0 || input.slice(offset + 4, end).includes("--")) invalid("malformed XML comment");
      offset = end + 3; continue;
    }
    if (input.startsWith("<![CDATA[", offset)) {
      const end = input.indexOf("]]>", offset + 9);
      if (end < 0 || stack.length === 1) invalid("malformed XML CDATA");
      current.text += input.slice(offset + 9, end); offset = end + 3; continue;
    }
    if (input.startsWith("<?xml ", offset) && offset === 0) {
      const declaration = /^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'][A-Za-z][A-Za-z0-9._-]*["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/.exec(input);
      if (!declaration) invalid("malformed XML declaration"); offset = declaration[0].length; continue;
    }
    if (input[offset] !== "<") {
      const next = input.indexOf("<", offset), end = next < 0 ? input.length : next;
      const segment = input.slice(offset, end);
      if (segment.includes("]]>")) invalid("unescaped XML CDATA terminator");
      current.text += unescapeXml(segment); offset = end; continue;
    }
    const closing = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(input.slice(offset));
    if (closing) {
      if (stack.length === 1 || current.name !== closing[1]) invalid("mismatched XML close tag");
      stack.pop(); offset += closing[0].length; continue;
    }
    const opening = /^<([A-Za-z_][\w.:-]*)/.exec(input.slice(offset));
    if (!opening || ++nodes > 100_000 || stack.length > 64) invalid("unsafe XML declaration or tree limit");
    const node: XmlNode = { name: opening[1]!, attrs: Object.create(null) as Record<string, string>, children: [], text: "" };
    offset += opening[0].length;
    while (true) {
      const rest = input.slice(offset), end = /^\s*(\/?>)/.exec(rest);
      if (end) { offset += end[0].length; current.children.push(node); if (end[1] === ">") stack.push(node); break; }
      const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
      if (!attr || Object.hasOwn(node.attrs, attr[1]!)) invalid("malformed or duplicate XML attribute");
      node.attrs[attr[1]!] = unescapeXml(attr[2] ?? attr[3]!); offset += attr[0].length;
    }
  }
  if (stack.length !== 1 || document.children.length !== 1 || document.text.trim()) invalid("incomplete XML document");
  return document.children[0]!;
}
function children(node: XmlNode, name: string): XmlNode[] { return node.children.filter(child => child.name === name); }
function content(node: XmlNode): string { return node.text + node.children.map(content).join("\n"); }
function xmlCounter(node: XmlNode, key: string, required = false): number | undefined {
  const value = node.attrs[key]; if (value === undefined) { if (required) invalid(`missing XML ${key}`); return undefined; }
  if (!/^\d+$/.test(value)) invalid(`invalid XML ${key}`); return number(Number(value));
}
function checkAllowedChildren(node: XmlNode, names: readonly string[]) { if (node.children.some(child => !names.includes(child.name))) invalid(`unknown XML result element in ${node.name}`); }
function junitResults(reports: readonly string[]): TestResult[] {
  if (!reports.length) invalid("missing JUnit reports");
  const walk = (node: XmlNode): TestResult[] => {
    if (node.name !== "testsuite" && node.name !== "testsuites") invalid("invalid JUnit root");
    checkAllowedChildren(node, ["testsuite", "testcase", "properties", "system-out", "system-err"]);
    if (node.text.trim()) invalid("unexpected JUnit suite text");
    const results: TestResult[] = [];
    for (const child of node.children) {
      if (child.name === "testsuite") results.push(...walk(child));
      if (child.name !== "testcase") continue;
      if (node.name !== "testsuite") invalid("testcase outside testsuite");
      checkAllowedChildren(child, ["failure", "error", "skipped", "system-out", "system-err", "properties"]);
      if (child.text.trim()) invalid("unexpected JUnit testcase text");
      const failures = children(child, "failure");
      if (children(child, "error").length || children(child, "skipped").length || failures.length > 1 || child.attrs.status !== undefined && !["run", "passed", "success"].includes(child.attrs.status)) invalid("JUnit skipped or runtime error");
      if (failures.some(failure => !assertion(failure.attrs.type?.trim() || `${failure.attrs.message ?? ""}\n${content(failure)}`))) invalid("JUnit failure is not a recognized assertion");
      const name = text(child.attrs.name), className = child.attrs.classname ?? "";
      results.push({ name: className ? `${className}.${name}` : name, passed: failures.length === 0 });
    }
    const failed = results.filter(result => !result.passed).length;
    for (const [key, value] of [["tests", results.length], ["failures", failed], ["errors", 0], ["skipped", 0], ["disabled", 0]] as const) {
      const declared = xmlCounter(node, key, key === "tests" && node.name === "testsuite");
      if (declared !== undefined && declared !== value) invalid(`JUnit ${key} contradicts leaf results`);
    }
    return results;
  };
  return reports.flatMap(report => walk(xml(report)));
}

function goResults(input: string): TestResult[] {
  const packages = new Map<string, { status?: string; tests: Map<string, { started: boolean; status?: string; output: string }> }>();
  for (const line of input.split(/\r?\n/).filter(line => line.trim())) {
    const event = object(json(line)), action = text(event.Action), pkgName = text(event.Package);
    if (!["start", "run", "pause", "cont", "output", "pass", "fail", "skip"].includes(action)) invalid("Go build/runtime error or unknown event");
    let pkg = packages.get(pkgName); if (!pkg) { pkg = { tests: new Map() }; packages.set(pkgName, pkg); }
    if (pkg.status !== undefined) invalid("Go event after package completion");
    if (event.Test === undefined) {
      if (!["start", "output", "pass", "fail", "skip"].includes(action)) invalid("Go package event lacks test identity");
      if (action === "skip") invalid("Go skipped package");
      if (action === "pass" || action === "fail") { if (pkg.status) invalid("duplicate Go completion"); pkg.status = action; }
      if (action === "output" && /(?:^|\n)(?:panic:|fatal error:|FAIL\s+.*\[build failed\]|\s*build failed)/.test(logText(event.Output))) invalid("Go runtime/build error");
      continue;
    }
    const name = text(event.Test);
    let test = pkg.tests.get(name); if (!test) { test = { started: false, output: "" }; pkg.tests.set(name, test); }
    if (action === "run") { if (test.started) invalid("duplicate Go test run"); test.started = true; }
    if (action === "output") test.output += logText(event.Output);
    if (["pass", "fail", "skip"].includes(action)) { if (test.status) invalid("duplicate Go test completion"); test.status = action; }
  }
  const results: TestResult[] = [];
  for (const [pkgName, pkg] of packages) {
    if (!pkg.status || !pkg.tests.size) invalid("incomplete or zero Go package tests");
    let failed = false;
    for (const [name, test] of pkg.tests) {
      if (!test.started || !["pass", "fail"].includes(test.status ?? "") || /(?:panic:|fatal error:|runtime error:|\[build failed\])/.test(test.output)) invalid("Go incomplete, skipped or runtime failure");
      if (test.status === "fail") {
        failed = true;
        // testing.T has no typed assertion record. Admit source-located comparison diagnostics only.
        const leaf = ![...pkg.tests.keys()].some(other => other.startsWith(`${name}/`));
        if (leaf && (!/\.go:\d+:/.test(test.output) || !/\b(?:assert(?:ion)?|expected|want|got|mismatch)\b/i.test(test.output))) invalid("Go failure lacks assertion diagnostics");
      }
      // Parent subtest completion is an aggregate, not a separately selected leaf.
      if (![...pkg.tests.keys()].some(other => other.startsWith(`${name}/`))) results.push({ name: `${pkgName}.${name}`, passed: test.status === "pass" });
    }
    if (pkg.status !== (failed ? "fail" : "pass")) invalid("Go package result contradicts tests");
  }
  return results;
}
function rustResults(input: string): TestResult[] {
  if (/error(?:\[E\d+\])?:|process didn't exit successfully|signal:|fatal runtime error:|test panicked after/.test(input)) invalid("Rust infrastructure failure");
  const results: TestResult[] = [], summaries = [...input.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in .+$/gm)];
  const starts = [...input.matchAll(/^running (\d+) tests?$/gm)];
  if (!summaries.length || summaries.length !== starts.length) invalid("incomplete Rust harness output");
  let offset = 0;
  for (let index = 0; index < summaries.length; index++) {
    const summary = summaries[index]!, block = input.slice(offset, summary.index), start = starts[index]!;
    if (start.index! < offset || start.index! > summary.index!) invalid("Rust harness order mismatch");
    const tests = [...block.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)(?:\s.*)?$/gm)];
    const passed = Number(summary[2]), failed = Number(summary[3]);
    if (Number(summary[4]) || Number(summary[5]) || tests.length !== passed + failed || Number(start[1]) !== tests.length || tests.filter(test => test[2] === "ok").length !== passed || tests.filter(test => test[2] === "FAILED").length !== failed || summary[1] !== (failed ? "FAILED" : "ok")) invalid("Rust counters/skips contradict tests");
    for (const test of tests) {
      if (test[2] === "FAILED") {
        const escaped = test[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const diagnostic = new RegExp(`^---- ${escaped} stdout ----\\n([\\s\\S]*?)(?=^---- |^failures:|^test result:|(?![\\s\\S]))`, "m").exec(block);
        if (!diagnostic || !/assertion (?:`[^`]+` |[^\n]*?)failed|assertion failed:/.test(diagnostic[1]!)) invalid("Rust panic is not an assertion");
      }
      results.push({ name: test[1]!, passed: test[2] === "ok" });
    }
    offset = summary.index! + summary[0].length;
  }
  return results;
}

function trxResults(reports: readonly string[]): TestResult[] {
  if (!reports.length) invalid("missing TRX reports");
  return reports.flatMap(report => {
    const root = xml(report);
    if (root.name !== "TestRun") invalid("invalid TRX root");
    const resultGroups = children(root, "Results"), summaries = children(root, "ResultSummary"), definitionGroups = children(root, "TestDefinitions");
    if (resultGroups.length !== 1 || summaries.length !== 1 || definitionGroups.length !== 1) invalid("missing TRX result definitions/summary");
    const definitions = new Map<string, XmlNode>();
    for (const definition of definitionGroups[0]!.children) {
      if (definition.name !== "UnitTest" || definitions.has(text(definition.attrs.id)) || children(definition, "TestMethod").length !== 1) invalid("malformed TRX definition");
      definitions.set(text(definition.attrs.id), definition);
    }
    const seen = new Set<string>(), results: TestResult[] = [];
    for (const result of resultGroups[0]!.children) {
      if (result.name !== "UnitTestResult" || !["Passed", "Failed"].includes(result.attrs.outcome ?? "") || seen.has(text(result.attrs.testId)) || !definitions.has(result.attrs.testId!)) invalid("TRX missing, duplicate or nonconclusive test result");
      seen.add(result.attrs.testId!);
      const failed = result.attrs.outcome === "Failed";
      if (failed && !assertion(content(result))) invalid("TRX failure is not an assertion");
      if (!failed && children(result, "Output").some(output => children(output, "ErrorInfo").length)) invalid("TRX passed test contains error");
      const method = children(definitions.get(result.attrs.testId!)!, "TestMethod")[0]!;
      const className = text(method.attrs.className).split(",")[0]!.trim();
      results.push({ name: `${className}.${text(method.attrs.name)}`, passed: !failed });
    }
    if (definitions.size !== seen.size) invalid("TRX definitions lack results");
    const summary = summaries[0]!, counts = children(summary, "Counters");
    if (counts.length !== 1 || children(summary, "RunInfos").some(info => info.children.length) || children(summary, "Output").some(output => children(output, "ErrorInfo").length)) invalid("TRX run-level error");
    const counter = counts[0]!, failed = results.filter(result => !result.passed).length;
    if (!["Completed", "Passed", "Failed"].includes(summary.attrs.outcome ?? "") || (summary.attrs.outcome === "Failed") !== (failed > 0)) invalid("TRX summary status contradiction");
    const expected: Record<string, number> = { total: results.length, executed: results.length, passed: results.length - failed, failed };
    for (const [key, value] of Object.entries(expected)) if (xmlCounter(counter, key, true) !== value) invalid(`TRX ${key} contradiction`);
    for (const key of Object.keys(counter.attrs)) if (!(key in expected) && xmlCounter(counter, key) !== 0) invalid(`TRX nonconclusive ${key}`);
    return results;
  });
}
function jestResults(input: string, selected: readonly string[]): TestResult[] {
  const report = object(json(input)), results: TestResult[] = [];
  const tests = number(report.numTotalTests), passed = number(report.numPassedTests), failed = number(report.numFailedTests);
  const pendingSuitesCount = number(report.numPendingTestSuites);
  if (number(report.numTodoTests) || number(report.numRuntimeErrorTestSuites) || report.wasInterrupted !== false || report.success !== (failed === 0)) invalid("Jest skipped, interrupted or runtime errors");
  const suites = array(report.testResults); let failedSuites = 0, pendingSuites = 0, filtered = 0;
  for (const item of suites) {
    const suite = object(item), leaves = array(suite.assertionResults); let suiteFailed = false, suiteExecuted = false;
    if (!leaves.length || !["passed", "failed", "pending"].includes(String(suite.status)) || suite.testExecError !== undefined) invalid("Jest suite infrastructure error");
    for (const leaf of leaves) {
      const test = object(leaf), failed = test.status === "failed", messages = array(test.failureMessages);
      if (!["passed", "failed", "pending"].includes(String(test.status)) || messages.some(value => typeof value !== "string") || (failed ? !messages.length || messages.some(message => !assertion(String(message)) && !/^Error: expect\(/.test(String(message))) : messages.length > 0)) invalid("Jest skipped or non-assertion failure");
      const ancestors = array(test.ancestorTitles).map(text), title = text(test.title), fullName = text(test.fullName);
      if ([...ancestors, title].join(" ") !== fullName) invalid("Jest fullName contradicts titles");
      if (test.status === "pending") { if (selected.includes(fullName)) invalid("Selected Jest test skipped"); filtered++; continue; }
      suiteExecuted = true;
      results.push({ name: fullName, passed: !failed }); suiteFailed ||= failed;
    }
    if (suiteExecuted) {
      if (suite.status !== (suiteFailed ? "failed" : "passed") || !suiteFailed && suite.message !== "") invalid("Jest suite status contradiction");
      if (suiteFailed) failedSuites++;
    } else {
      if (!["pending", "passed"].includes(String(suite.status)) || suite.message !== "") invalid("Jest suite status contradiction");
      if (suite.status === "pending") pendingSuites++;
    }
  }
  if (pendingSuitesCount !== pendingSuites || tests !== results.length + filtered || number(report.numPendingTests) !== filtered || passed !== results.filter(test => test.passed).length || failed !== results.length - passed || number(report.numTotalTestSuites) !== suites.length || number(report.numPassedTestSuites) !== suites.length - failedSuites - pendingSuites || number(report.numFailedTestSuites) !== failedSuites) invalid("Jest counters contradict results");
  return results;
}
function mochaResults(input: string): TestResult[] {
  const report = object(json(input)), stats = object(report.stats), tests = array(report.tests), passes = array(report.passes), failures = array(report.failures);
  if (number(stats.pending) || array(report.pending).length || number(stats.tests) !== tests.length || number(stats.passes) !== passes.length || number(stats.failures) !== failures.length || passes.length + failures.length !== tests.length) invalid("Mocha skipped or counter contradiction");
  const results: TestResult[] = [], observed = new Map<string, boolean>();
  for (const [items, passed] of [[passes, true], [failures, false]] as const) for (const raw of items) {
    const item = object(raw), name = text(item.fullTitle), error = object(item.err);
    if (observed.has(name) || (passed ? Object.keys(error).length > 0 : !assertion(`${error.name ?? ""}\n${error.message ?? ""}\n${error.stack ?? ""}`))) invalid("Mocha duplicate, hook or runtime failure");
    observed.set(name, passed);
  }
  for (const raw of tests) {
    const item = object(raw), name = text(item.fullTitle), passed = observed.get(name), error = object(item.err);
    if (passed === undefined || (passed ? Object.keys(error).length > 0 : !assertion(`${error.name ?? ""}\n${error.message ?? ""}\n${error.stack ?? ""}`))) invalid("Mocha tests contradict failures/passes");
    results.push({ name, passed });
  }
  return results;
}
function rspecResults(input: string): TestResult[] {
  const report = object(json(input)), summary = object(report.summary), results: TestResult[] = [];
  if (number(summary.pending_count) || summary.errors_outside_of_examples_count !== undefined && number(summary.errors_outside_of_examples_count) || report.messages !== undefined && array(report.messages).length) invalid("RSpec pending or outside-example error");
  for (const raw of array(report.examples)) {
    const test = object(raw), failed = test.status === "failed";
    if (!["passed", "failed"].includes(String(test.status))) invalid("RSpec skipped/incomplete example");
    if (failed) {
      const exception = object(test.exception);
      if (!assertion(text(exception.class))) invalid("RSpec runtime failure");
    } else if (test.exception != null) invalid("RSpec passed example contains exception");
    results.push({ name: text(test.full_description), passed: !failed });
  }
  if (number(summary.example_count) !== results.length || number(summary.failure_count) !== results.filter(test => !test.passed).length) invalid("RSpec counters contradict results");
  return results;
}

/** Parses only complete structured per-test evidence; process success alone is never accepted. */
export function parseRunnerResult(format: ResultFormat, outcome: QualityCommandOutcome, expectedNames: readonly string[], reports?: readonly string[], failureExitCodes?: readonly number[], selectedPaths: readonly string[] = []): ParsedRunnerResult {
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || outcome.exitCode === null) invalid("runner infrastructure failure (spawn, deadline, signal or truncated output)");
  if (reports !== undefined && (!reports.length || reports.length > 1024 || reports.reduce((total, report) => total + Buffer.byteLength(report), 0) > 4_194_304)) invalid("missing or oversized structured reports");
  if (Buffer.byteLength(outcome.stdout) > 4_194_304) invalid("oversized runner output");
  let results: TestResult[];
  const output = outcome.stdout.replace(/\r\n/g, "\n");
  switch (format) {
    case "node_tap": return parseNodeTap(outcome, expectedNames, true, selectedPaths);
    case "vitest_json": return parseVitestJson(outcome, expectedNames, true);
    case "junit": results = junitResults(reports ?? [output]); break;
    case "trx": results = trxResults(reports ?? [output]); break;
    case "go_json": results = goResults(output); break;
    case "rust_libtest": results = rustResults(output); break;
    case "jest_json": results = jestResults(reports?.length === 1 ? reports[0]! : output, expectedNames); break;
    case "mocha_json": results = mochaResults(output); break;
    case "rspec_json": results = rspecResults(reports?.length === 1 ? reports[0]! : output); break;
    default: return invalid("unsupported result format");
  }
  return finish(results, outcome, expectedNames, failureExitCodes ?? (format === "rust_libtest" ? [101] : [1]));
}
