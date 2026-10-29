import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { digest } from "./journal.js";

/** Complete, identity-matched TAP whose test bodies failed without valid assertion evidence. */
export class NodeTapTestCodeFailure extends Error {
  constructor(readonly outcome: QualityCommandOutcome, readonly failedTestNames: readonly string[],
    readonly rtk?: import("./behavioral-runner.js").BehavioralMeasurement["rtk"]) {
    super(`Behavioral test code failed without an assertion regression in ${JSON.stringify(failedTestNames.slice(0, 8)).slice(0, 1000)}. ` +
      "Repair the existing mapped tests to assert missing target behavior before calling absent code; preserve their names. Do not implement before valid Red evidence.");
  }
}

/** Identity mismatch carries the owner-configured and observed names for bounded diagnostics. */
export class BehavioralIdentityMismatch extends Error {
  constructor(readonly expectedNames: readonly string[], readonly observedNames: readonly string[]) {
    super("Observed test names differ from owner-configured identities");
  }
}

/**
 * An identity mismatch the Developer must repair by naming the mapped tests exactly as the accepted strategy does. It reuses
 * the bounded test-code repair route: an escalation left the run stranded while the Developer waited for its phase result.
 */
export class BehavioralIdentityRepair extends NodeTapTestCodeFailure {
  constructor(outcome: QualityCommandOutcome, readonly expectedNames: readonly string[], readonly observedNames: readonly string[],
    readonly protocol: "node_tap" | "vitest_json", readonly diagnostics: unknown,
    rtk?: import("./behavioral-runner.js").BehavioralMeasurement["rtk"]) {
    super(outcome, observedNames, rtk);
    const list = (names: readonly string[]) => JSON.stringify(names.slice(0, 20)).slice(0, 1000);
    this.message = `Observed test names differ from the accepted test identities: expected exactly ${list(expectedNames)}, observed ${list(observedNames)}. ` +
      "Rename the mapped tests so each full name (suite titles and test title joined by a space) equals an expected name; do not change the accepted mapping. " +
      "Do not implement before valid Red evidence.";
  }
}

/** Supported measurement protocol: complete, flat Node test-runner TAP with assertion diagnostics. */
export function parseNodeTap(outcome: QualityCommandOutcome, expectedNames: readonly string[], nameSelection = false, selectedPaths: readonly string[] = []) {
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || outcome.exitCode === null) throw new Error("Behavioral runner infrastructure failure (spawn, deadline, signal or truncated output)");
  const output = outcome.stdout.replace(/\r\n/g, "\n");
  if (!output.startsWith("TAP version 13\n") || /^Bail out!/m.test(output)) throw new Error("Behavioral runner requires complete Node TAP output");
  const allResults = [...output.matchAll(/^(not ok|ok) (\d+) - (.+)\n([\s\S]*?)(?=^(?:not ok|ok) \d+ - |^1\.\.\d+\s*$)/gm)];
  const count = (label: string) => { const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))]; if (matches.length !== 1) throw new Error("Incomplete TAP counters"); return Number(matches[0]![1]); };
  const filtered = nameSelection ? allResults.filter(result => result[1] === "ok" && result[3]!.endsWith(" # SKIP test name does not match pattern") && !expectedNames.includes(result[3]!.replace(/ # SKIP test name does not match pattern$/, ""))) : [];
  // Node 22 reports a selected file without any matching test as a passing top-level test named after the file. Only an
  // exact selected path qualifies; a failing file entry (for example a load error) remains a failure.
  const unmatchedFiles = nameSelection ? allResults.filter(result => result[1] === "ok" && selectedPaths.includes(result[3]!) &&
    !expectedNames.includes(result[3]!) && /^\s+type: 'test'$/m.test(result[4]!)) : [];
  const results = allResults.filter(result => !filtered.includes(result) && !unmatchedFiles.includes(result));
  const total = count("tests"), tests = results.length, passed = count("pass") - unmatchedFiles.length, failed = count("fail");
  if (!tests || count("cancelled") || count("skipped") !== filtered.length || count("todo") || total !== allResults.length || passed + failed !== tests || !new RegExp(`^1\\.\\.${total}$`, "m").test(output) || allResults.some((result, index) => Number(result[2]) !== index + 1)) throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
  const names = results.map(result => result[3]!);
  if (digest([...names].sort()) !== digest([...expectedNames].sort())) throw new BehavioralIdentityMismatch(expectedNames, names);
  const failures = results.filter(result => result[1] === "not ok");
  if (failures.length !== failed || results.filter(result => result[1] === "ok").length !== passed || (failed === 0 ? outcome.exitCode !== 0 : outcome.exitCode !== 1)) throw new Error("TAP result contradicts process exit code");
  const targetFailure = failed > 0 && failures.every(result => /^\s+failureType: 'testCodeFailure'$/m.test(result[4]!) && /^\s+code: 'ERR_ASSERTION'$/m.test(result[4]!));
  if (failed && !targetFailure) {
    if (failures.every(result => /^\s+failureType: 'testCodeFailure'$/m.test(result[4]!)))
      throw new NodeTapTestCodeFailure(outcome, failures.filter(result => !/^\s+code: 'ERR_ASSERTION'$/m.test(result[4]!)).map(result => result[3]!));
    throw new Error("Behavioral failure is infrastructure or unrelated, not an assertion regression");
  }
  return { testNames: names, testResults: results.map(result => ({ name: result[3]!, passed: result[1] === "ok" })), tests, passed, failed, targetFailure };
}
