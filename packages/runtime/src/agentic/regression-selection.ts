import { testFilePattern, verificationGit, type RunnerProfile } from "./behavioral-runner.js";
import type { ImpactIndex, IndexUnavailableCode } from "./impact-index.js";
import {
  classifyChanges,
  parseNameStatus,
  type ChangedFile,
  type RegressionScope,
  type ScopeTier,
  type Widening
} from "./regression-changes.js";

const SHA40_PATTERN = /^[a-f0-9]{40}$/;
const JS_EXT_PATTERN = /\.[cm]?[jt]sx?$/;
const MAX_CHANGED_FILES = 200;

export interface RegressionSelection {
  scope: ScopeTier;
  base: string;
  head: string;
  testPaths: string[];
  changedFiles: string[];
  changedFilesTruncated: boolean;
  widening: Widening[];
  index:
    | { commit: string }
    | { unavailable: IndexUnavailableCode; detail: string }
    | { notQueried: true };
}

export async function selectRegressionTests(input: {
  worktreePath: string;
  repositoryRoot: string;
  base: string;
  head: string;
  profile: RunnerProfile;
  scope: Exclude<RegressionScope, "mapped_only">;
  index: ImpactIndex;
  git?: (cwd: string, args: string[]) => Promise<string>;
}): Promise<RegressionSelection> {
  if (!SHA40_PATTERN.test(input.base) || !SHA40_PATTERN.test(input.head)) {
    throw new Error("Regression selection requires 40-character hex commit SHAs for base and head");
  }

  const git = input.git ?? verificationGit;

  const lsTreeOut = await git(input.worktreePath, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    input.head
  ]);
  const headFiles = lsTreeOut.split("\0").filter(Boolean);
  const candidateTests = [
    ...new Set(headFiles.filter(p => testFilePattern.test(p) && JS_EXT_PATTERN.test(p)))
  ].sort();
  const candidateTestsSet = new Set(candidateTests);

  const diffOut = await git(input.worktreePath, [
    "diff",
    "--name-status",
    "-M",
    "-z",
    input.base,
    input.head,
    "--"
  ]);
  const changes: ChangedFile[] = parseNameStatus(diffOut);

  const knownPackageRoots = new Set<string>();
  for (const file of headFiles) {
    if (file.endsWith("/package.json")) {
      const dir = file.slice(0, -"/package.json".length);
      if (dir) knownPackageRoots.add(dir);
    }
  }
  for (const change of changes) {
    for (const candidate of [change.path, change.previousPath]) {
      if (candidate && candidate.endsWith("/package.json")) {
        const dir = candidate.slice(0, -"/package.json".length);
        if (dir) knownPackageRoots.add(dir);
      }
    }
  }

  const packageRootOf = (filePath: string): string | undefined => {
    let cursor = filePath;
    while (true) {
      const slash = cursor.lastIndexOf("/");
      if (slash <= 0) return undefined;
      cursor = cursor.slice(0, slash);
      if (knownPackageRoots.has(cursor)) {
        return cursor;
      }
    }
  };

  const allChangedFiles = [...new Set(changes.map(c => c.path))];
  const changedFiles = allChangedFiles.slice(0, MAX_CHANGED_FILES);
  const changedFilesTruncated = allChangedFiles.length > MAX_CHANGED_FILES;

  const classification = classifyChanges(changes, packageRootOf);

  if (input.scope === "full") {
    return {
      scope: "full",
      base: input.base,
      head: input.head,
      testPaths: candidateTests,
      changedFiles,
      changedFilesTruncated,
      widening: classification.widening,
      index: { notQueried: true }
    };
  }

  if (classification.tier === "none") {
    return {
      scope: "none",
      base: input.base,
      head: input.head,
      testPaths: [],
      changedFiles,
      changedFilesTruncated,
      widening: [],
      index: { notQueried: true }
    };
  }

  if (classification.tier === "full") {
    return {
      scope: "full",
      base: input.base,
      head: input.head,
      testPaths: candidateTests,
      changedFiles,
      changedFilesTruncated,
      widening: classification.widening,
      index: { notQueried: true }
    };
  }

  let scope: ScopeTier = classification.tier;
  const packageRoots = new Set<string>(classification.packageRoots);
  const widening: Widening[] = [...classification.widening];
  let index: RegressionSelection["index"] = { notQueried: true };
  const importerFiles: string[] = [];

  if (classification.graphFiles.length > 0) {
    const res = await input.index.importersOf({
      repositoryRoot: input.repositoryRoot,
      base: input.base,
      files: classification.graphFiles
    });
    if (res.status === "ok") {
      index = { commit: res.indexCommit };
      importerFiles.push(...res.files);
    } else {
      index = { unavailable: res.code, detail: res.detail };
      for (const file of classification.graphFiles) {
        const pkg = packageRootOf(file);
        if (pkg !== undefined) {
          packageRoots.add(pkg);
          widening.push({
            path: file,
            tier: "package",
            reason: `index_unavailable:${res.code}`,
            packageRoot: pkg
          });
          if (scope === "graph") {
            scope = "package";
          }
        } else {
          widening.push({
            path: file,
            tier: "full",
            reason: `index_unavailable:${res.code}`
          });
          scope = "full";
        }
      }
    }
  }

  let testPaths: string[];
  if (scope === "full") {
    testPaths = candidateTests;
  } else {
    const selected = new Set<string>();
    for (const pkg of packageRoots) {
      const prefix = `${pkg}/`;
      for (const testPath of candidateTests) {
        if (testPath.startsWith(prefix)) {
          selected.add(testPath);
        }
      }
    }
    for (const file of importerFiles) {
      if (candidateTestsSet.has(file)) {
        selected.add(file);
      }
    }
    for (const file of classification.changedTests) {
      if (candidateTestsSet.has(file)) {
        selected.add(file);
      }
    }
    testPaths = [...selected].sort();
  }

  return {
    scope,
    base: input.base,
    head: input.head,
    testPaths,
    changedFiles,
    changedFilesTruncated,
    widening,
    index
  };
}
