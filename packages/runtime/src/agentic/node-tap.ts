import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { QualityCommandOutcome } from "@bflow/quality-gates";

/** Complete, identity-matched TAP whose test bodies failed without valid assertion evidence. */
export class NodeTapTestCodeFailure extends Error {
  constructor(readonly outcome: QualityCommandOutcome, readonly failedTestNames: readonly string[],
    readonly rtk?: import("./behavioral-runner.js").BehavioralMeasurement["rtk"]) {
    const rawDetail = stripVTControlCharacters([outcome?.stderr, outcome?.stdout].filter(Boolean).join("\n")).trim();
    const errorLine = rawDetail.split(/\r?\n/).find(line => /(?:Error|Exception|ReferenceError|TypeError|SyntaxError):/.test(line))?.trim();
    const suffix = errorLine ? ` Underlying runtime error: ${errorLine.slice(0, 300)}.` : "";
    super(`Behavioral test code failed without an assertion regression in ${JSON.stringify(failedTestNames.slice(0, 8)).slice(0, 1000)}.${suffix} ` +
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

export interface ObservedIdentityLeaf {
  readonly ancestors: readonly string[];
  readonly title: string;
  readonly rawName: string;
}

export function normalizeTestIdentity(value: string): string {
  return value.normalize("NFC").trim().replace(/\s*::\s*/g, " > ").replace(/\s+/g, " ");
}

export function stripFilePrefix(name: string): string {
  return name.replace(/^(?:(?:\.{1,2}|[A-Za-z0-9_-]+)\/)*[A-Za-z0-9._-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs)\s*(?:>|::|:)\s*/i, "").trim();
}

function buildLeafIdentityForms(leaf: ObservedIdentityLeaf): {
  fullForms: Set<string>;
  suffixForms: Set<string>;
  hierarchyForm: string | undefined;
} {
  const fullForms = new Set<string>([normalizeTestIdentity([...leaf.ancestors, leaf.title].join(" "))]);
  if (leaf.ancestors.length > 0) {
    fullForms.add(normalizeTestIdentity([...leaf.ancestors, leaf.title].join(" > ")));
  }
  const suffixForms = new Set<string>();
  for (let k = 1; k <= leaf.ancestors.length; k++) {
    const slice = leaf.ancestors.slice(k);
    suffixForms.add(normalizeTestIdentity([...slice, leaf.title].join(" ")));
    if (slice.length > 0) {
      suffixForms.add(normalizeTestIdentity([...slice, leaf.title].join(" > ")));
    }
  }
  const hierarchyForm = leaf.ancestors.length > 0
    ? normalizeTestIdentity([...leaf.ancestors, leaf.title].join(" ").replace(/\s*>\s*/g, " "))
    : undefined;
  return { fullForms, suffixForms, hierarchyForm };
}

export function matchesExpectedIdentity(leaf: ObservedIdentityLeaf, expectedName: string): boolean {
  const norm = normalizeTestIdentity(expectedName);
  const forms = buildLeafIdentityForms(leaf);
  if (forms.fullForms.has(norm) || forms.suffixForms.has(norm)) return true;
  if (norm.includes(">") && forms.hierarchyForm !== undefined) {
    if (forms.hierarchyForm === normalizeTestIdentity(norm.replace(/\s*>\s*/g, " "))) return true;
  }
  const stripped = normalizeTestIdentity(stripFilePrefix(expectedName));
  if (stripped !== norm) {
    if (forms.fullForms.has(stripped) || forms.suffixForms.has(stripped)) return true;
    if (stripped.includes(">") && forms.hierarchyForm !== undefined) {
      if (forms.hierarchyForm === normalizeTestIdentity(stripped.replace(/\s*>\s*/g, " "))) return true;
    }
  }
  return false;
}

/**
 * Enforces a strict, unambiguous 1-to-1 bijection between executed leaf tests and `expectedNames`.
 * Exact full names (`Suite test` or `Suite > test`) match in Pass 1; remaining suffix/leaf titles match
 * in Pass 2 only when unique across all executed leaves and all remaining expected identities.
 * Ancestor-only suite titles never match; duplicate or ambiguous leaf titles fail closed.
 */
export function resolveExpectedIdentities(
  leaves: readonly ObservedIdentityLeaf[],
  expectedNames: readonly string[]
): { matched: true; canonicalNames: string[] } | { matched: false } {
  if (new Set(expectedNames).size !== expectedNames.length || leaves.length !== expectedNames.length) {
    return { matched: false };
  }
  const normExpected = expectedNames.map(normalizeTestIdentity);
  if (new Set(normExpected).size !== normExpected.length) {
    return { matched: false };
  }
  if (leaves.length === 0) {
    return { matched: true, canonicalNames: [] };
  }
  const leafForms = leaves.map(buildLeafIdentityForms);
  const leafToExpected = new Array<number | undefined>(leaves.length);
  const expectedToLeaf = new Array<number | undefined>(expectedNames.length);

  for (let j = 0; j < normExpected.length; j++) {
    const target = normExpected[j]!;
    const stripped = normalizeTestIdentity(stripFilePrefix(target));
    const matches: number[] = [];
    for (let i = 0; i < leafForms.length; i++) {
      if (leafForms[i]!.fullForms.has(target) || (stripped !== target && leafForms[i]!.fullForms.has(stripped))) matches.push(i);
    }
    if (matches.length > 1) return { matched: false };
    if (matches.length === 1) {
      const i = matches[0]!;
      if (leafToExpected[i] !== undefined) return { matched: false };
      leafToExpected[i] = j;
      expectedToLeaf[j] = i;
    }
  }

  const matchesSuffix = (entry: ReturnType<typeof buildLeafIdentityForms>, target: string): boolean => {
    if (entry.suffixForms.has(target)) return true;
    if (target.includes(">") && entry.hierarchyForm !== undefined) {
      if (entry.hierarchyForm === normalizeTestIdentity(target.replace(/\s*>\s*/g, " "))) return true;
    }
    const stripped = normalizeTestIdentity(stripFilePrefix(target));
    if (stripped !== target) {
      if (entry.suffixForms.has(stripped)) return true;
      if (stripped.includes(">") && entry.hierarchyForm !== undefined) {
        if (entry.hierarchyForm === normalizeTestIdentity(stripped.replace(/\s*>\s*/g, " "))) return true;
      }
    }
    return false;
  };

  for (let j = 0; j < normExpected.length; j++) {
    if (expectedToLeaf[j] !== undefined) continue;
    const target = normExpected[j]!;
    const allMatches: number[] = [];
    for (let i = 0; i < leafForms.length; i++) {
      if (matchesSuffix(leafForms[i]!, target)) allMatches.push(i);
    }
    if (allMatches.length !== 1) return { matched: false };
    const i = allMatches[0]!;
    if (leafToExpected[i] !== undefined) return { matched: false };
    for (let j2 = 0; j2 < normExpected.length; j2++) {
      if (j2 !== j && expectedToLeaf[j2] === undefined && matchesSuffix(leafForms[i]!, normExpected[j2]!)) {
        return { matched: false };
      }
    }
    leafToExpected[i] = j;
    expectedToLeaf[j] = i;
  }

  const canonicalNames: string[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const j = leafToExpected[i];
    if (j === undefined) return { matched: false };
    canonicalNames.push(expectedNames[j]!);
  }
  return { matched: true, canonicalNames };
}

/** Recognizes genuine assertion / query expectation failures (including ANSI-colored and V8 stack-frozen Testing Library errors). */
export function isRecognizedAssertionMessage(rawMessage: string): boolean {
  const message = stripVTControlCharacters(rawMessage).trimStart();
  if (/^(?:AssertionError|VitestAssertionError|JestAssertionError|JestExtendError|ChaiError|ExpectError|ExpectationError|MatcherError|AssertionFailedError|TestingLibraryElementError|HtmlElementTypeError)(?:\s*\[ERR_ASSERTION\])?:/.test(message)) {
    return true;
  }
  if (/^(?:Error:\s*)?\[ERR_ASSERTION\]:/.test(message)) return true;
  if (/^(?:Error:\s*)?expect\(/.test(message)) return true;
  if (/^Error:\s*promise (?:resolved|rejected)\b[\s\S]*?\binstead of (?:rejecting|resolving)\b/.test(message)) return true;
  if (/^Error:\s*(?:Unable to find (?:an? (?:accessible )?element|a label|role)\b|Found multiple elements\b|Timed out in waitFor(?:ElementToBeRemoved)?\b)/.test(message)) {
    return true;
  }
  if (/^Error:/.test(message) && /\n\s*at (?:Proxy\.expectWrapper\b|_Assertion\.__VITEST_(?:REJECTS|RESOLVES)__\b|(?:Object\.)?getElementError\b|[^\n]*@vitest\/expect\/|[^\n]*@testing-library\/(?:dom|jest-dom)\/|Test\._assert(?:Status|Body|Header|Function)\b)/.test(message)) {
    return true;
  }
  if (/^(?:Error:\s*)?(?:expected\s+.+\s+(?:got|to\s+|but\s+|received\s+)|expected\b|expect\b|assertion failed\b|assertion error\b)/i.test(message)) return true;
  if (/^Assertion failed:/i.test(message)) return true;
  return false;
}

const escapeRegexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function escapeUnicodeToken(token: string): string {
  const nfc = token.normalize("NFC");
  const nfd = token.normalize("NFD");
  return nfc === nfd ? escapeRegexLiteral(token) : `(?:${escapeRegexLiteral(nfc)}|${escapeRegexLiteral(nfd)})`;
}

function formatNameSegment(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens.map(escapeUnicodeToken).join("\\s+") : escapeUnicodeToken(segment);
}

function formatHierarchyPattern(name: string): string {
  const parts = name.trim().split(/\s*>\s*/).filter(Boolean);
  return parts.length > 0 ? parts.map(formatNameSegment).join("(?:\\s*>\\s*|\\s+)") : escapeUnicodeToken(name);
}

/**
 * Builds bounded, linear-time CLI test-name filters. Preserves exact `^(?:...)$` patterns for plain single-space
 * ASCII identities on Node/Jest/Mocha while enabling `describe`-nested, `>`-separated, and NFC/NFD Unicode matching.
 */
export function buildRunnerNamePattern(
  testNames: readonly string[],
  mode: "vitest" | "node" | "suite_full"
): string {
  if (mode === "vitest") {
    return "(?:^|\\s)(?:" + testNames.map(formatHierarchyPattern).join("|") + ")\\s*$";
  }
  const needsFlexible = testNames.some(
    name =>
      name.normalize("NFC") !== name.normalize("NFD") ||
      name.includes(">") ||
      name.trim() !== name ||
      /\s{2,}|\t/.test(name)
  );
  if (!needsFlexible) {
    return "^(?:" + testNames.map(escapeRegexLiteral).join("|") + ")$";
  }
  if (mode === "node") {
    const alternatives: string[] = [];
    for (const name of testNames) {
      alternatives.push(formatNameSegment(name));
      if (name.includes(">")) {
        alternatives.push(formatHierarchyPattern(name));
        const leaf = name.split(">").at(-1)?.trim();
        if (leaf) alternatives.push(formatNameSegment(leaf));
      }
    }
    return "^\\s*(?:" + [...new Set(alternatives)].join("|") + ")\\s*$";
  }
  return "(?:^|\\s)(?:" + testNames.map(formatHierarchyPattern).join("|") + ")\\s*$";
}

function extractTapYamlField(yaml: string, key: string): string | undefined {
  const single = new RegExp(`^(\\s*)${key}:\\s*(?:'([^']*)'|"([^"]*)")\\s*$`, "m").exec(yaml);
  if (single) return single[2] ?? single[3] ?? "";
  const block = new RegExp(`^(\\s*)${key}:\\s*\\|-?\\n([\\s\\S]*)$`, "m").exec(yaml);
  if (!block) return undefined;
  const baseIndent = block[1]!.length + 2;
  const collected: string[] = [];
  for (const line of block[2]!.split("\n")) {
    if (line.trim().length > 0 && (line.length < baseIndent || line.slice(0, baseIndent).trim().length > 0)) break;
    collected.push(line.slice(Math.min(line.length, baseIndent)));
  }
  return collected.join("\n").trimEnd();
}

function isNodeTapAssertionFailure(yaml: string): boolean {
  if (!/^\s+failureType:\s*'testCodeFailure'\s*$/m.test(yaml)) return false;
  if (/^\s+code:\s*'ERR_ASSERTION'\s*$/m.test(yaml)) return true;
  const errorName = extractTapYamlField(yaml, "name") ?? "Error";
  const errorBody = extractTapYamlField(yaml, "error") ?? "";
  const stackBody = extractTapYamlField(yaml, "stack");
  const synthesized = `${errorName}: ${errorBody}${stackBody ? `\n    at ${stackBody.replace(/\n/g, "\n    at ")}` : ""}`;
  return isRecognizedAssertionMessage(synthesized);
}

function parseTapTitleAndDirective(raw: string): { title: string; directive?: "skip" | "todo" } {
  const directiveMatch = /^(.*?)\s+#\s*(SKIP|TODO)(?:$|\s+.*)$/i.exec(raw);
  const body = directiveMatch ? directiveMatch[1]! : raw;
  const directive = directiveMatch ? (directiveMatch[2]!.toLowerCase() as "skip" | "todo") : undefined;
  const title = body.replace(/\\([#\\])/g, "$1");
  return directive ? { title, directive } : { title };
}

interface TapTreeEntry {
  readonly level: number;
  readonly index: number;
  readonly ok: boolean;
  readonly name: string;
  readonly directive?: "skip" | "todo" | undefined;
  readonly yaml: string;
  readonly isSuite: boolean;
  readonly children: readonly TapTreeEntry[];
}

interface TapLeafEntry extends ObservedIdentityLeaf {
  readonly level: number;
  readonly ok: boolean;
  readonly directive?: "skip" | "todo" | undefined;
  readonly yaml: string;
}

/** Supported measurement protocol: complete Node test-runner TAP (flat or `describe`-nested suites) with assertion diagnostics. */
export function parseNodeTap(outcome: QualityCommandOutcome, expectedNames: readonly string[], nameSelection = false, selectedPaths: readonly string[] = []) {
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || outcome.exitCode === null) throw new Error("Behavioral runner infrastructure failure (spawn, deadline, signal or truncated output)");
  const output = outcome.stdout.replace(/\r\n/g, "\n");
  if (!output.startsWith("TAP version 13\n") || /^Bail out!/m.test(output)) throw new Error("Behavioral runner requires complete Node TAP output");
  const count = (label: string, required = true): number | undefined => {
    const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))];
    if (matches.length > 1 || (required && matches.length !== 1)) throw new Error("Incomplete TAP counters");
    return matches.length === 1 ? Number(matches[0]![1]) : undefined;
  };
  const total = count("tests")!;
  const reportedSuites = count("suites", false);
  const reportedPass = count("pass")!;
  const reportedFail = count("fail")!;
  const cancelled = count("cancelled")!;
  const skipped = count("skipped")!;
  const todo = count("todo")!;

  const lines = output.split("\n");
  const childrenAtLevel: TapTreeEntry[][] = [];
  const blockIndexAtLevel: number[] = [];
  const openBlockAtLevel: boolean[] = [];
  const topPlans: number[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const planMatch = /^((?: {4})*)1\.\.(\d+)\s*$/.exec(line);
    if (planMatch) {
      const level = planMatch[1]!.length / 4;
      const planned = Number(planMatch[2]);
      if (level === 0) {
        topPlans.push(planned);
      } else {
        if (planned !== (blockIndexAtLevel[level] ?? 0)) {
          throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
        }
        blockIndexAtLevel[level] = 0;
        openBlockAtLevel[level] = false;
      }
      continue;
    }

    const resultMatch = /^((?: {4})*)(not ok|ok) (\d+) - (.+)$/.exec(line);
    if (!resultMatch) continue;
    const indent = resultMatch[1]!;
    const level = indent.length / 4;
    const ok = resultMatch[2] === "ok";
    const index = Number(resultMatch[3]);
    const parsedTitle = parseTapTitleAndDirective(resultMatch[4]!);
    const name = parsedTitle.title;
    const directive = parsedTitle.directive;

    let yaml = "";
    if (lines[i + 1] === `${indent}  ---`) {
      let end = i + 2;
      while (end < lines.length && lines[end] !== `${indent}  ...`) end++;
      if (end >= lines.length) throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
      yaml = lines.slice(i + 2, end).join("\n");
      i = end;
    }

    const expectedIndex = (blockIndexAtLevel[level] ?? 0) + 1;
    if (index !== expectedIndex) throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
    blockIndexAtLevel[level] = expectedIndex;
    if (level > 0) openBlockAtLevel[level] = true;

    for (let deeper = level + 2; deeper < childrenAtLevel.length; deeper++) {
      if ((childrenAtLevel[deeper]?.length ?? 0) > 0 || openBlockAtLevel[deeper]) {
        throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
      }
    }
    if (openBlockAtLevel[level + 1]) {
      throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
    }
    const children = childrenAtLevel[level + 1] ?? [];
    if (childrenAtLevel[level + 1]) childrenAtLevel[level + 1] = [];
    const isSuite = /^\s+type:\s*'suite'\s*$/m.test(yaml);
    if (children.length > 0 && !isSuite) {
      throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
    }
    let bucket = childrenAtLevel[level];
    if (!bucket) {
      bucket = [];
      childrenAtLevel[level] = bucket;
    }
    bucket.push({ level, index, ok, name, ...(directive ? { directive } : {}), yaml, isSuite, children });
  }

  for (let level = 1; level < Math.max(childrenAtLevel.length, openBlockAtLevel.length); level++) {
    if ((childrenAtLevel[level]?.length ?? 0) > 0 || openBlockAtLevel[level]) {
      throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
    }
  }
  const topEntries = childrenAtLevel[0] ?? [];
  const finalPlan = topPlans.at(-1);
  if (finalPlan === undefined || finalPlan !== topEntries.length || topPlans.slice(0, -1).some(plan => plan !== 0)) {
    throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
  }

  const allLeaves: TapLeafEntry[] = [];
  let observedSuites = 0;
  let suiteInfrastructureFailure = false;
  const collectLeaves = (entries: readonly TapTreeEntry[], ancestors: readonly string[]) => {
    for (const entry of entries) {
      if (entry.isSuite) {
        observedSuites++;
        if (!entry.ok && (!/^\s+failureType:\s*'subtestsFailed'\s*$/m.test(entry.yaml) || !entry.children.some(child => !child.ok))) {
          suiteInfrastructureFailure = true;
        }
        if (entry.children.length === 0 && !nameSelection) {
          throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
        }
        collectLeaves(entry.children, [...ancestors, entry.name]);
      } else {
        allLeaves.push({
          ancestors,
          title: entry.name,
          rawName: ancestors.length > 0 ? [...ancestors, entry.name].join(" > ") : entry.name,
          level: entry.level,
          ok: entry.ok,
          ...(entry.directive ? { directive: entry.directive } : {}),
          yaml: entry.yaml
        });
      }
    }
  };
  collectLeaves(topEntries, []);
  if (suiteInfrastructureFailure) {
    throw new Error("Behavioral failure is infrastructure or unrelated, not an assertion regression");
  }
  if (reportedSuites !== undefined && reportedSuites !== observedSuites) {
    throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
  }

  const isUnselectedDirectiveLeaf = (leaf: TapLeafEntry, targetDirective: "skip" | "todo"): boolean => {
    if (!leaf.ok || leaf.directive !== targetDirective) return false;
    return !expectedNames.some(expected => matchesExpectedIdentity(leaf, expected));
  };
  const filteredSkipped = nameSelection ? allLeaves.filter(leaf => isUnselectedDirectiveLeaf(leaf, "skip")) : [];
  const filteredTodo = nameSelection ? allLeaves.filter(leaf => isUnselectedDirectiveLeaf(leaf, "todo")) : [];
  // Node 22 reports a selected file without any matching test as a passing top-level test named after the file. Only an
  // exact selected path qualifies; a failing file entry (for example a load error) remains a failure.
  const isSelectedFilePlaceholder = (leaf: TapLeafEntry): boolean => {
    if (leaf.level !== 0 || leaf.ancestors.length > 0 || !leaf.ok || !/^\s+type:\s*'test'\s*$/m.test(leaf.yaml)) return false;
    const normalizedPath = isAbsolute(leaf.title) ? relative(outcome.cwd, leaf.title).replaceAll("\\", "/") : leaf.title;
    return (selectedPaths.includes(leaf.title) || selectedPaths.includes(normalizedPath)) && !expectedNames.includes(leaf.title);
  };
  const unmatchedFiles = nameSelection ? allLeaves.filter(isSelectedFilePlaceholder) : [];
  const results = allLeaves.filter(leaf => !filteredSkipped.includes(leaf) && !filteredTodo.includes(leaf) && !unmatchedFiles.includes(leaf));
  const tests = results.length, passed = reportedPass - unmatchedFiles.length, failed = reportedFail;
  if (!tests || cancelled || skipped !== filteredSkipped.length || todo !== filteredTodo.length || total !== allLeaves.length || passed + failed !== tests) {
    throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
  }
  const resolved = resolveExpectedIdentities(results, expectedNames);
  if (!resolved.matched) {
    throw new BehavioralIdentityMismatch(expectedNames, results.map(result => result.rawName));
  }
  const names = resolved.canonicalNames;
  const indexedResults = results.map((leaf, index) => ({ leaf, name: names[index]! }));
  const failures = indexedResults.filter(item => !item.leaf.ok);
  if (failures.length !== failed || indexedResults.filter(item => item.leaf.ok).length !== passed || (failed === 0 ? outcome.exitCode !== 0 : outcome.exitCode !== 1)) {
    throw new Error("TAP result contradicts process exit code");
  }
  const targetFailure = failed > 0 && failures.every(item => isNodeTapAssertionFailure(item.leaf.yaml));
  if (failed && !targetFailure) {
    if (failures.every(item => /^\s+failureType:\s*'testCodeFailure'\s*$/m.test(item.leaf.yaml))) {
      throw new NodeTapTestCodeFailure(outcome, failures.filter(item => !isNodeTapAssertionFailure(item.leaf.yaml)).map(item => item.name));
    }
    throw new Error("Behavioral failure is infrastructure or unrelated, not an assertion regression");
  }
  return {
    testNames: names,
    testResults: indexedResults.map(item => ({ name: item.name, passed: item.leaf.ok })),
    tests,
    passed,
    failed,
    targetFailure
  };
}
