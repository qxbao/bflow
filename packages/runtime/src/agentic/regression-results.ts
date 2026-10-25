import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { QualityCommandOutcome } from "@bflow/quality-gates";

export interface RegressionFailure {
  testPath: string;
  testName: string;
}

export interface RegressionObservation {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: RegressionFailure[];
}

export class RegressionInfrastructureFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegressionInfrastructureFailure";
  }
}

function normalizeTestPath(raw: string, checkout: string): string {
  const trimmed = raw.trim().replace(/:\d+(?::\d+)?$/, "");
  let filePath = trimmed;
  if (filePath.startsWith("file://")) {
    try {
      filePath = fileURLToPath(filePath);
    } catch {
      filePath = filePath.slice("file://".length);
    }
  }
  if (isAbsolute(filePath)) {
    const rel = relative(checkout, filePath).replaceAll("\\", "/");
    if (rel.length > 0 && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)) {
      return rel;
    }
    return filePath.replaceAll("\\", "/");
  }
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function stripTapDirective(name: string): string {
  return name.replace(/\s+#\s*(?:SKIP|TODO)\b.*$/i, "").trim();
}

function extractTapLocation(yamlBlock: string, checkout: string): string | undefined {
  const match = /^\s*location:\s*(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*$/m.exec(yamlBlock);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!raw) return undefined;
  return normalizeTestPath(raw, checkout);
}

const FILE_PATH_LIKE =
  /(^|\/)(test|tests|__tests__|spec|Specs|Tests)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$/;

function parseNodeTapRegression(outcome: QualityCommandOutcome, checkout: string): RegressionObservation {
  const output = outcome.stdout.replace(/\r\n/g, "\n");
  if (!output.startsWith("TAP version 13\n") || /^Bail out!/m.test(output)) {
    throw new RegressionInfrastructureFailure("Regression runner requires complete Node TAP output");
  }
  if (!/^1\.\.\d+\s*$/m.test(output)) {
    throw new RegressionInfrastructureFailure("Incomplete Node TAP plan");
  }
  const count = (label: string) => {
    const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))];
    if (matches.length !== 1) {
      throw new RegressionInfrastructureFailure(`Incomplete TAP counter: ${label}`);
    }
    return Number(matches[0]![1]);
  };
  const tests = count("tests");
  const passed = count("pass");
  const failed = count("fail");
  const cancelled = count("cancelled");
  const skipped = count("skipped") + count("todo");

  if (cancelled > 0) {
    throw new RegressionInfrastructureFailure("Regression TAP run reported cancelled tests");
  }
  if (tests === 0 && outcome.exitCode !== 0) {
    throw new RegressionInfrastructureFailure("Regression TAP run reported zero tests with non-zero exit code");
  }
  if (failed === 0 && outcome.exitCode !== 0) {
    throw new RegressionInfrastructureFailure("Regression TAP run exited non-zero without test failures");
  }

  const lines = output.split("\n");
  const openSubtestName: (string | undefined)[] = [];
  const failuresByLevel: RegressionFailure[][] = [];
  const ensureLevel = (level: number): RegressionFailure[] => {
    while (failuresByLevel.length <= level) {
      failuresByLevel.push([]);
    }
    return failuresByLevel[level]!;
  };
  const hasChildFailuresAbove = (level: number): boolean => {
    for (let l = level + 1; l < failuresByLevel.length; l++) {
      if ((failuresByLevel[l]?.length ?? 0) > 0) return true;
    }
    return false;
  };
  const flushAbove = (targetLevel: number, fallbackLocation?: string) => {
    for (let l = failuresByLevel.length - 1; l > targetLevel; l--) {
      const bucket = failuresByLevel[l];
      if (!bucket || bucket.length === 0) continue;
      const parentName = openSubtestName[l - 1];
      const parentBucket = ensureLevel(l - 1);
      for (const item of bucket) {
        parentBucket.push({
          testPath:
            item.testPath === "<unknown>" && fallbackLocation !== undefined
              ? fallbackLocation
              : item.testPath,
          testName: parentName ? `${parentName} > ${item.testName}` : item.testName
        });
      }
      bucket.length = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const subtestMatch = /^( *)# Subtest: (.+)$/.exec(line);
    if (subtestMatch) {
      const level = Math.floor(subtestMatch[1]!.length / 4);
      flushAbove(level);
      openSubtestName.length = level + 1;
      openSubtestName[level] = stripTapDirective(subtestMatch[2]!);
      continue;
    }

    const resultMatch = /^( *)(not ok|ok) (\d+)(?: - (.*))?$/.exec(line);
    if (!resultMatch) continue;

    const indent = resultMatch[1]!;
    const level = Math.floor(indent.length / 4);
    const status = resultMatch[2]!;
    const cleanName = stripTapDirective(resultMatch[4] ?? "");

    const yamlLines: string[] = [];
    if (lines[i + 1] === `${indent}  ---`) {
      i += 2;
      while (i < lines.length && lines[i] !== `${indent}  ...`) {
        yamlLines.push(lines[i]!);
        i++;
      }
    }
    const yamlBlock = yamlLines.join("\n");
    const locationPath = extractTapLocation(yamlBlock, checkout);
    const isSubtestsFailed = /^\s*failureType:\s*['"]?subtestsFailed['"]?\s*$/m.test(yamlBlock);

    openSubtestName.length = level + 1;
    openSubtestName[level] = cleanName;
    const hadChildren = hasChildFailuresAbove(level);
    flushAbove(level, locationPath);

    if (status === "not ok") {
      if (hadChildren && isSubtestsFailed) {
        continue;
      }
      if (!hadChildren) {
        const normalizedName = normalizeTestPath(cleanName, checkout);
        const isFileFailure =
          level === 0 &&
          (cleanName === "<file>" ||
            /^\s*exitCode:\s*[1-9]\d*\s*$/m.test(yamlBlock) ||
            (locationPath !== undefined && normalizedName === locationPath) ||
            FILE_PATH_LIKE.test(normalizedName));
        ensureLevel(level).push({
          testPath: isFileFailure
            ? locationPath ?? normalizedName
            : locationPath ?? "<unknown>",
          testName: isFileFailure ? "<file>" : cleanName || "<unknown>"
        });
      }
    }
  }

  flushAbove(0);
  const failures = ensureLevel(0);
  return { tests, passed, failed, skipped, failures };
}

function parseVitestJsonRegression(outcome: QualityCommandOutcome, checkout: string): RegressionObservation {
  const runtimeMatch = /^BFLOW_VITEST_RUNTIME_ERRORS=(\d+)\s*$/m.exec(outcome.stderr);
  if (!runtimeMatch) {
    throw new RegressionInfrastructureFailure("Missing Vitest trusted runtime error counter");
  }
  const runtimeErrors = Number(runtimeMatch[1]);

  let decoded: unknown;
  try {
    decoded = JSON.parse(outcome.stdout);
  } catch {
    throw new RegressionInfrastructureFailure("Regression runner requires valid Vitest JSON output");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new RegressionInfrastructureFailure("Malformed Vitest JSON report");
  }
  const report = decoded as Record<string, unknown>;
  const counter = (key: string) => {
    const value = report[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new RegressionInfrastructureFailure(`Invalid Vitest counter: ${key}`);
    }
    return Number(value);
  };

  const tests = counter("numTotalTests");
  const passed = counter("numPassedTests");
  const numFailedTests = counter("numFailedTests");
  const skipped = counter("numPendingTests") + counter("numTodoTests");

  if (!Array.isArray(report.testResults)) {
    throw new RegressionInfrastructureFailure("Missing Vitest testResults array");
  }

  const hasFailedSuite = report.testResults.some(
    item => typeof item === "object" && item !== null && (item as Record<string, unknown>).status === "failed"
  );
  if (tests === 0 && outcome.exitCode !== 0 && !hasFailedSuite && runtimeErrors === 0) {
    throw new RegressionInfrastructureFailure("Vitest reported zero tests with non-zero exit code");
  }

  const failures: RegressionFailure[] = [];
  for (const rawFile of report.testResults) {
    if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
      throw new RegressionInfrastructureFailure("Malformed Vitest file result");
    }
    const file = rawFile as Record<string, unknown>;
    if (typeof file.name !== "string" || !file.name.length || !Array.isArray(file.assertionResults)) {
      throw new RegressionInfrastructureFailure("Malformed Vitest file result fields");
    }
    const testPath = normalizeTestPath(file.name, checkout);
    let fileLeafFailures = 0;
    for (const rawLeaf of file.assertionResults) {
      if (typeof rawLeaf !== "object" || rawLeaf === null || Array.isArray(rawLeaf)) {
        throw new RegressionInfrastructureFailure("Malformed Vitest assertion result");
      }
      const leaf = rawLeaf as Record<string, unknown>;
      if (leaf.status === "failed") {
        const testName =
          typeof leaf.fullName === "string" && leaf.fullName.length
            ? leaf.fullName
            : typeof leaf.title === "string" && leaf.title.length
              ? leaf.title
              : "<unknown>";
        failures.push({ testPath, testName });
        fileLeafFailures++;
      }
    }
    if (file.status === "failed" && fileLeafFailures === 0) {
      failures.push({ testPath, testName: "<file>" });
    }
  }

  if (runtimeErrors > 0) {
    failures.push({ testPath: "<runtime>", testName: "<vitest-runtime-errors>" });
  }

  const failed = Math.max(numFailedTests, failures.length);
  if (failed === 0 && outcome.exitCode !== 0) {
    throw new RegressionInfrastructureFailure("Vitest exited non-zero without test or runtime failures");
  }

  return { tests, passed, failed, skipped, failures };
}

export function parseRegressionResult(
  outcome: QualityCommandOutcome,
  reporter: "vitest_json" | "node_tap",
  checkout: string
): RegressionObservation {
  if (outcome.timedOut) {
    throw new RegressionInfrastructureFailure("regression_budget_exceeded: regression test execution timed out");
  }
  if (
    outcome.spawnError ||
    outcome.aborted ||
    outcome.outputTruncated ||
    outcome.signal ||
    outcome.exitCode === null
  ) {
    throw new RegressionInfrastructureFailure(
      "Regression runner infrastructure failure (spawn, signal, aborted or truncated output)"
    );
  }
  if (reporter === "node_tap") {
    return parseNodeTapRegression(outcome, checkout);
  }
  if (reporter === "vitest_json") {
    return parseVitestJsonRegression(outcome, checkout);
  }
  throw new RegressionInfrastructureFailure(`Unsupported regression reporter: ${String(reporter)}`);
}
