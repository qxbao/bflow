import { testFilePattern } from "./behavioral-runner.js";

export type RegressionScope = "affected" | "full" | "mapped_only";

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  previousPath?: string;
}

export type ScopeTier = "none" | "graph" | "package" | "full";

export interface Widening {
  path: string;
  tier: "package" | "full";
  reason: string;
  packageRoot?: string;
}

export interface ChangeClassification {
  tier: ScopeTier;
  graphFiles: string[];
  packageRoots: string[];
  changedTests: string[];
  widening: Widening[];
}

const TIER_RANK: Record<ScopeTier, number> = {
  none: 0,
  graph: 1,
  package: 2,
  full: 3
};

const EXACT_ROOT_CONFIGS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  ".node-version",
  ".nvmrc",
  "pnpm-workspace.yaml",
  "turbo.json"
]);

const DOC_PATTERN = /\.(md|txt|rst)$/i;
const CODE_PATTERN = /\.[cm]?[jt]sx?$/;
const NESTED_CONFIG_PATTERN = /\/(?:vitest\.(?:config|workspace)|jest\.config|[^/]+\.config)\.[cm]?[jt]s$/;

function raiseTier(current: ScopeTier, next: ScopeTier): ScopeTier {
  return TIER_RANK[next] > TIER_RANK[current] ? next : current;
}

function isRootConfig(path: string): boolean {
  if (path.includes("/")) return false;
  return (
    EXACT_ROOT_CONFIGS.has(path) ||
    /^tsconfig[^/]*\.json$/.test(path) ||
    /^vitest\.(?:config|workspace)\.[^/]+$/.test(path) ||
    /^.+\.config\.(?:[cm]?[jt]s|json)$/.test(path)
  );
}

export function classifyChanges(
  changes: readonly ChangedFile[],
  packageRootOf: (path: string) => string | undefined
): ChangeClassification {
  let tier: ScopeTier = "none";
  const graphFiles = new Set<string>();
  const packageRoots = new Set<string>();
  const changedTests = new Set<string>();
  const widening: Widening[] = [];

  for (const change of changes) {
    const { path } = change;

    if (isRootConfig(path)) {
      tier = raiseTier(tier, "full");
      widening.push({ path, tier: "full", reason: `root_config:${path}` });
      continue;
    }

    if (DOC_PATTERN.test(path)) {
      continue;
    }

    if (path.endsWith("/package.json")) {
      const pkg = packageRootOf(path);
      if (pkg !== undefined) {
        packageRoots.add(pkg);
        widening.push({ path, tier: "package", reason: "package_manifest", packageRoot: pkg });
        tier = raiseTier(tier, "package");
      } else {
        widening.push({ path, tier: "full", reason: "package_manifest" });
        tier = raiseTier(tier, "full");
      }
      continue;
    }

    // Runner/build configuration has no importers, but changes how every test of its package runs.
    if (NESTED_CONFIG_PATTERN.test(path)) {
      const pkg = packageRootOf(path);
      if (pkg !== undefined) {
        packageRoots.add(pkg);
        widening.push({ path, tier: "package", reason: "package_config", packageRoot: pkg });
        tier = raiseTier(tier, "package");
      } else {
        widening.push({ path, tier: "full", reason: "package_config" });
        tier = raiseTier(tier, "full");
      }
      continue;
    }

    if (CODE_PATTERN.test(path)) {
      tier = raiseTier(tier, "graph");
      const basePath = change.status === "R" && change.previousPath ? change.previousPath : path;
      graphFiles.add(basePath);
      if (change.status !== "D" && testFilePattern.test(path)) {
        changedTests.add(path);
      }
      continue;
    }

    const pkg = packageRootOf(path);
    if (pkg !== undefined) {
      packageRoots.add(pkg);
      widening.push({ path, tier: "package", reason: "non_code_change", packageRoot: pkg });
      tier = raiseTier(tier, "package");
    } else {
      widening.push({ path, tier: "full", reason: "non_code_change" });
      tier = raiseTier(tier, "full");
    }
  }

  return {
    tier,
    graphFiles: [...graphFiles],
    packageRoots: [...packageRoots],
    changedTests: [...changedTests],
    widening
  };
}

export function parseNameStatus(output: string): ChangedFile[] {
  if (!output) return [];
  const tokens = output.split("\0");
  const results: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const rawStatus = tokens[i++];
    if (!rawStatus) continue;
    const code = rawStatus[0] as ChangedFile["status"] | undefined;
    if (code !== "A" && code !== "M" && code !== "D" && code !== "R" && code !== "C" && code !== "T") {
      throw new Error(`Unsupported git diff status: ${rawStatus}`);
    }
    if (code === "R" || code === "C") {
      const previousPath = tokens[i++];
      const path = tokens[i++];
      if (!previousPath || !path) {
        throw new Error(`Malformed git diff rename/copy entry for status ${rawStatus}`);
      }
      results.push({ path, status: code, previousPath });
    } else {
      const path = tokens[i++];
      if (!path) {
        throw new Error(`Malformed git diff entry for status ${rawStatus}`);
      }
      results.push({ path, status: code });
    }
  }
  return results;
}
