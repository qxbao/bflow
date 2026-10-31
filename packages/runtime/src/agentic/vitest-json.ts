import { isAbsolute, relative } from "node:path";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { digest, record, textField } from "./journal.js";
import { BehavioralIdentityMismatch, NodeTapTestCodeFailure } from "./node-tap.js";

/** Complete, identity-matched Vitest run whose test bodies failed without assertion evidence: a bounded test repair, as for TAP. */
export class VitestTestCodeFailure extends NodeTapTestCodeFailure {
  readonly protocol = "vitest_json" as const;
}

function isVitestAssertionFailure(message: string): boolean {
  if (/^(?:AssertionError|VitestAssertionError|JestAssertionError|JestExtendError|ChaiError|ExpectError|AssertionFailedError|TestingLibraryElementError|HtmlElementTypeError)(?:\s*\[ERR_ASSERTION\])?:/.test(message)) {
    return true;
  }
  if (/^Error:\s*expect\(/.test(message)) return true;
  if (/^Error:\s*promise (?:resolved|rejected)\b[\s\S]*?\binstead of (?:rejecting|resolving)\b/.test(message)) return true;
  if (/^Error:/.test(message) && /\n\s*at (?:Proxy\.expectWrapper\b|_Assertion\.__VITEST_(?:REJECTS|RESOLVES)__\b)/.test(message)) return true;
  return false;
}

/** Private codec for the actual Vitest 2.1 JSON reporter, with the trusted runtime companion.
 * Suite totals count files plus describe suites; reconstruct ancestors instead of equating suites with files.
 */
export function parseVitestJson(outcome: QualityCommandOutcome, expectedNames: readonly string[], nameSelection = false) {
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || outcome.exitCode === null) throw new Error("Behavioral runner infrastructure failure (spawn, deadline, signal or truncated output)");
  const runtimeMarkers = [...outcome.stderr.matchAll(/^BFLOW_VITEST_RUNTIME_ERRORS=([^\r\n]+)\r?$/gm)];
  if (runtimeMarkers.length !== 1 || runtimeMarkers[0]![1] !== "0") throw new Error("Vitest runtime errors or missing trusted reporter completion");
  let decoded: unknown;
  try { decoded = JSON.parse(outcome.stdout); } catch { throw new Error("Behavioral runner requires complete Vitest JSON output"); }
  const report = record(decoded);
  const fields = ["numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites", "numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests", "snapshot", "startTime", "success", "testResults"];
  if (Object.keys(report).some(key => !fields.includes(key))) throw new Error("Unsupported Vitest JSON report fields");
  const counter = (key: string) => { const value = report[key]; if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid Vitest counter ${key}`); return Number(value); };
  const tests = counter("numTotalTests"), passed = counter("numPassedTests"), failed = counter("numFailedTests");
  const pendingTests = counter("numPendingTests"), todoTests = counter("numTodoTests"), pendingSuites = counter("numPendingTestSuites");
  if (!tests || (!nameSelection && (pendingTests || todoTests || pendingSuites)) || (!nameSelection && passed + failed !== tests) || typeof report.success !== "boolean" || typeof report.startTime !== "number" || !Number.isFinite(report.startTime) || report.startTime < 0) throw new Error("Zero, skipped, todo or incomplete Vitest tests cannot prove behavior");
  const snapshot = record(report.snapshot);
  if (snapshot.failure !== false || snapshot.didUpdate !== false) throw new Error("Snapshot failures or updates cannot prove an immutable behavioral observation");
  if (!Array.isArray(report.testResults) || !report.testResults.length) throw new Error("Missing Vitest file results");
  const suites = new Map<string, { executed: boolean; failed: boolean }>(), files = new Set<string>();
  const results: { name: string; passed: boolean }[] = [];
  let observedPassed = 0, observedFailed = 0, filteredSkipped = 0, filteredTodo = 0;
  const codeFailures: string[] = [];
  const allowedFileStatuses = nameSelection ? ["passed", "failed", "pending", "skipped"] : ["passed", "failed"];
  const allowedLeafStatuses = nameSelection ? ["passed", "failed", "skipped", "todo"] : ["passed", "failed"];
  for (const input of report.testResults) {
    const file = record(input), name = textField(file.name), path = relative(outcome.cwd, name);
    if (!isAbsolute(name) || path.startsWith("../") || path === ".." || isAbsolute(path) || files.has(name) || file.message !== "" ||
        !allowedFileStatuses.includes(String(file.status)) || !Array.isArray(file.assertionResults) || (!nameSelection && !file.assertionResults.length) ||
        typeof file.startTime !== "number" || !Number.isFinite(file.startTime) || typeof file.endTime !== "number" || !Number.isFinite(file.endTime) || file.endTime < file.startTime) throw new Error("Vitest file infrastructure failure or malformed file result");
    files.add(name); const fileKey = digest([name]); suites.set(fileKey, { executed: false, failed: false });
    let fileFailed = false, fileExecuted = false;
    for (const input of file.assertionResults) {
      const leaf = record(input), fullName = textField(leaf.fullName), title = textField(leaf.title);
      if (!Array.isArray(leaf.ancestorTitles) || leaf.ancestorTitles.some(value => typeof value !== "string" || !value.trim()) ||
          fullName !== [...leaf.ancestorTitles, title].join(" ") || !allowedLeafStatuses.includes(String(leaf.status)) ||
          !Array.isArray(leaf.failureMessages) || leaf.failureMessages.some(value => typeof value !== "string" || !value.trim())) throw new Error("Malformed, skipped or incomplete Vitest leaf result");
      const isFailed = leaf.status === "failed";
      if (isFailed ? !leaf.failureMessages.length : leaf.failureMessages.length !== 0) throw new Error("Vitest failure is infrastructure or unrelated, not an assertion regression");
      // A test body that throws something other than an assertion (for example calling still-absent code) is a test defect,
      // reported only after the whole run is proven complete and identity-matched.
      if (isFailed && leaf.failureMessages.some(message => !isVitestAssertionFailure(message))) codeFailures.push(fullName);
      const ancestorTitles = leaf.ancestorTitles.map(value => textField(value));
      const ancestors = [fileKey, ...ancestorTitles.map((_value, index) => digest([name, ...ancestorTitles.slice(0, index + 1)]))];
      if (leaf.status === "skipped" || leaf.status === "todo") {
        if (expectedNames.includes(fullName)) throw new Error("Selected Vitest test was skipped");
        for (const key of ancestors) if (!suites.has(key)) suites.set(key, { executed: false, failed: false });
        if (leaf.status === "skipped") filteredSkipped++; else filteredTodo++;
        continue;
      }
      for (const key of ancestors) {
        const previous = suites.get(key);
        suites.set(key, { executed: true, failed: (previous?.failed ?? false) || isFailed });
      }
      fileExecuted = true;
      fileFailed ||= isFailed;
      isFailed ? observedFailed++ : observedPassed++;
      results.push({ name: fullName, passed: !isFailed });
    }
    if (fileExecuted) {
      if (file.status !== (fileFailed ? "failed" : "passed")) throw new Error("Vitest suite infrastructure failure contradicts leaf results");
    } else if (fileFailed || !["passed", "pending", "skipped"].includes(String(file.status))) {
      throw new Error("Vitest suite infrastructure failure contradicts leaf results");
    }
  }
  const names = results.map(result => result.name);
  const failedSuites = [...suites.values()].filter(suite => suite.failed).length;
  const executedPassedSuites = [...suites.values()].filter(suite => suite.executed && !suite.failed).length;
  if (new Set(names).size !== names.length || digest([...names].sort()) !== digest([...expectedNames].sort())) throw new BehavioralIdentityMismatch(expectedNames, names);
  const filtered = filteredSkipped + filteredTodo;
  const totalSuites = counter("numTotalTestSuites"), passedSuites = counter("numPassedTestSuites"), reportedFailedSuites = counter("numFailedTestSuites");
  const suiteCountersValid = nameSelection
    ? reportedFailedSuites === failedSuites && totalSuites >= suites.size && passedSuites >= executedPassedSuites && totalSuites === passedSuites + reportedFailedSuites + pendingSuites
    : totalSuites === suites.size && reportedFailedSuites === failedSuites && passedSuites === suites.size - failedSuites && pendingSuites === 0;
  const testCountersValid = nameSelection
    ? tests === results.length + filtered && filteredSkipped === pendingTests && todoTests >= filteredTodo && todoTests <= filtered
    : tests === results.length && pendingTests === 0 && todoTests === 0;
  if (!testCountersValid || passed !== observedPassed || failed !== observedFailed || !suiteCountersValid ||
      report.success !== (failed === 0) || (failed === 0 ? outcome.exitCode !== 0 : outcome.exitCode !== 1)) throw new Error("Vitest counters, leaf results or process exit code contradict one another");
  if (codeFailures.length) throw new VitestTestCodeFailure(outcome, codeFailures);
  return { testNames: names, testResults: results, tests: results.length, passed, failed, targetFailure: failed > 0 };
}
