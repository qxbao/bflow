import { isAbsolute, relative } from "node:path";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { digest, record, textField } from "./journal.js";

/** Private codec for the actual Vitest 2.1 JSON reporter, with the trusted runtime companion.
 * Suite totals count files plus describe suites; reconstruct ancestors instead of equating suites with files.
 */
export function parseVitestJson(outcome: QualityCommandOutcome, expectedNames: readonly string[]) {
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || outcome.exitCode === null) throw new Error("Behavioral runner infrastructure failure (spawn, deadline, signal or truncated output)");
  if (outcome.stderr !== "BFLOW_VITEST_RUNTIME_ERRORS=0\n") throw new Error("Vitest runtime errors or missing trusted reporter completion");
  let decoded: unknown;
  try { decoded = JSON.parse(outcome.stdout); } catch { throw new Error("Behavioral runner requires complete Vitest JSON output"); }
  const report = record(decoded);
  const fields = ["numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites", "numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests", "snapshot", "startTime", "success", "testResults"];
  if (Object.keys(report).some(key => !fields.includes(key))) throw new Error("Unsupported Vitest JSON report fields");
  const counter = (key: string) => { const value = report[key]; if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid Vitest counter ${key}`); return Number(value); };
  const tests = counter("numTotalTests"), passed = counter("numPassedTests"), failed = counter("numFailedTests");
  if (!tests || counter("numPendingTests") || counter("numTodoTests") || counter("numPendingTestSuites") || passed + failed !== tests || typeof report.success !== "boolean" || typeof report.startTime !== "number" || !Number.isFinite(report.startTime) || report.startTime < 0) throw new Error("Zero, skipped, todo or incomplete Vitest tests cannot prove behavior");
  const snapshot = record(report.snapshot);
  if (snapshot.failure !== false || snapshot.didUpdate !== false) throw new Error("Snapshot failures or updates cannot prove an immutable behavioral observation");
  if (!Array.isArray(report.testResults) || !report.testResults.length) throw new Error("Missing Vitest file results");
  const suites = new Map<string, boolean>(), files = new Set<string>();
  const results: { name: string; passed: boolean }[] = [];
  let observedPassed = 0, observedFailed = 0;
  for (const input of report.testResults) {
    const file = record(input), name = textField(file.name), path = relative(outcome.cwd, name);
    if (!isAbsolute(name) || path.startsWith("../") || path === ".." || isAbsolute(path) || files.has(name) || file.message !== "" ||
        !["passed", "failed"].includes(String(file.status)) || !Array.isArray(file.assertionResults) || !file.assertionResults.length ||
        typeof file.startTime !== "number" || !Number.isFinite(file.startTime) || typeof file.endTime !== "number" || !Number.isFinite(file.endTime) || file.endTime < file.startTime) throw new Error("Vitest file infrastructure failure or malformed file result");
    files.add(name); const fileKey = digest([name]); suites.set(fileKey, false);
    let fileFailed = false;
    for (const input of file.assertionResults) {
      const leaf = record(input), fullName = textField(leaf.fullName), title = textField(leaf.title);
      if (!Array.isArray(leaf.ancestorTitles) || leaf.ancestorTitles.some(value => typeof value !== "string" || !value.trim()) ||
          fullName !== [...leaf.ancestorTitles, title].join(" ") || !["passed", "failed"].includes(String(leaf.status)) ||
          !Array.isArray(leaf.failureMessages) || leaf.failureMessages.some(value => typeof value !== "string" || !value.trim())) throw new Error("Malformed, skipped or incomplete Vitest leaf result");
      const isFailed = leaf.status === "failed";
      if (isFailed ? !leaf.failureMessages.length || leaf.failureMessages.some(message => !/^AssertionError(?:\s*\[ERR_ASSERTION\])?:/.test(message)) : leaf.failureMessages.length !== 0) throw new Error("Vitest failure is infrastructure or unrelated, not an assertion regression");
      const ancestorTitles = leaf.ancestorTitles.map(value => textField(value));
      const ancestors = [fileKey, ...ancestorTitles.map((_value, index) => digest([name, ...ancestorTitles.slice(0, index + 1)]))];
      for (const key of ancestors) suites.set(key, suites.get(key) === true || isFailed);
      fileFailed ||= isFailed;
      isFailed ? observedFailed++ : observedPassed++;
      results.push({ name: fullName, passed: !isFailed });
    }
    if (file.status !== (fileFailed ? "failed" : "passed")) throw new Error("Vitest suite infrastructure failure contradicts leaf results");
  }
  const names = results.map(result => result.name), failedSuites = [...suites.values()].filter(Boolean).length;
  if (new Set(names).size !== names.length || digest([...names].sort()) !== digest([...expectedNames].sort())) throw new Error("Observed test names differ from owner-configured identities");
  if (tests !== results.length || passed !== observedPassed || failed !== observedFailed || counter("numTotalTestSuites") !== suites.size ||
      counter("numFailedTestSuites") !== failedSuites || counter("numPassedTestSuites") !== suites.size - failedSuites ||
      report.success !== (failed === 0) || (failed === 0 ? outcome.exitCode !== 0 : outcome.exitCode !== 1)) throw new Error("Vitest counters, leaf results or process exit code contradict one another");
  return { testNames: names, testResults: results, tests, passed, failed, targetFailure: failed > 0 };
}
