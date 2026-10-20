import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  stat as nodeStat
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RunnerDetection, RunnerProfile } from "./behavioral-runner.js";

/** Narrow filesystem port so detection can run against fixtures or fakes. Only read operations are used. */
export interface DetectionFs {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<DetectionStat>;
  lstat(path: string): Promise<DetectionStat>;
  readdir(path: string): Promise<DetectionDirent[]>;
  realpath(path: string): Promise<string>;
}
export interface DetectionStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface DetectionDirent extends DetectionStat {
  name: string;
}

const defaultFs: DetectionFs = {
  readFile: path => nodeReadFile(path, "utf8"),
  stat: path => nodeStat(path),
  lstat: path => nodeLstat(path),
  readdir: async path => (await nodeReaddir(path, { withFileTypes: true })),
  realpath: path => nodeRealpath(path)
};

/** Fixed Runtime-owned bounds. Mirrors the rules enforced by `parseBehavioralCommands`. */
export const PROFILE_TIMEOUT_MS = 180_000;
export const PREPARE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4_194_304;
const MAX_DEPENDENCY_ROOTS = 500;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".bflow", ".claude", "dist", "coverage"]);
const PERMITTED_LEVELS = {
  unit: ["unit", "regression"],
  integration: ["integration", "regression"]
} as const;
const SHELL_UNSAFE = /[;&|$`<>(){}*?!~'"\\\r\n\t\0]/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

const REMEDIATION = [
  "Coordinator thêm một task thiết lập vitest (devDependency + cấu hình) trước task chính",
  "Hoặc chủ dự án khai báo .bflow/verification.json (tuỳ chọn, ghi đè)"
];

function unsupported(reason: string, remediation: string[] = REMEDIATION): RunnerDetection {
  return { status: "unsupported", reason, remediation };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function statOrUndefined(fs: DetectionFs, path: string, follow: boolean): Promise<DetectionStat | undefined> {
  try {
    return await (follow ? fs.stat(path) : fs.lstat(path));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readJsonObject(fs: DetectionFs, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function objectField(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSafeRelativePath(path: string): boolean {
  return SAFE_RELATIVE_PATH.test(path);
}

/**
 * Accepts only `tsc`, `tsc -b`, `tsc --build` or `tsc -b <safe relative paths>` without shell syntax.
 * Returns the argv after `tsc`, or undefined when the script is not one of those exact shapes.
 */
export function parseTscBuildArgs(script: string): string[] | undefined {
  if (SHELL_UNSAFE.test(script)) return undefined;
  const tokens = script.trim().split(/ +/);
  if (tokens[0] !== "tsc") return undefined;
  const rest = tokens.slice(1);
  if (rest.length === 0) return [];
  if (rest[0] !== "-b" && rest[0] !== "--build") return undefined;
  if (rest.slice(1).some(path => !isSafeRelativePath(path))) return undefined;
  return rest;
}

/** Node flags a `node [flags] --test` script may carry; anything else is not forwarded and is not detected. */
const NODE_TEST_FLAG = /^(--experimental-strip-types|--disable-warning=[A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Returns the allowlisted node flags that precede `--test` in a script containing `node [flags] --test`, or undefined
 * when the script has no such invocation. Only the first `node` invocation in the script is considered.
 */
export function parseNodeTestFlags(script: string): string[] | undefined {
  const tokens = script.trim().split(/\s+/);
  const start = tokens.indexOf("node");
  if (start === -1) return undefined;
  const flags: string[] = [];
  for (const token of tokens.slice(start + 1)) {
    if (token === "--test") return flags;
    if (!NODE_TEST_FLAG.test(token)) return undefined;
    flags.push(token);
  }
  return undefined;
}

/** A workspace package whose entry points resolve into `dist/` needs a build before tests can import it. */
function pointsIntoDist(value: unknown): boolean {
  if (typeof value === "string") return /(^|\/)dist\//.test(value);
  if (Array.isArray(value)) return value.some(pointsIntoDist);
  if (value !== null && typeof value === "object") return Object.values(value).some(pointsIntoDist);
  return false;
}

function majorVersion(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : undefined;
}

/**
 * Walks the repository without following symlinks and without descending into skipped directories
 * or `node_modules`. Returns repo-relative POSIX paths of every real `node_modules` directory.
 */
async function walkRepository(fs: DetectionFs, root: string): Promise<{ dependencyRoots: string[]; packageJsons: string[]; tooMany: boolean }> {
  const dependencyRoots: string[] = [], packageJsons: string[] = [];
  const pending: string[] = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    const entries = await fs.readdir(relative ? join(root, relative) : root);
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.isSymbolicLink()) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          dependencyRoots.push(path);
          if (dependencyRoots.length > MAX_DEPENDENCY_ROOTS) return { dependencyRoots, packageJsons, tooMany: true };
        } else if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          pending.push(path);
        }
      } else if (entry.isFile() && entry.name === "package.json") {
        packageJsons.push(path);
      }
    }
  }
  return { dependencyRoots: dependencyRoots.sort(), packageJsons: packageJsons.sort(), tooMany: false };
}

async function needsDistBuild(fs: DetectionFs, root: string, packageJsons: string[]): Promise<boolean> {
  for (const path of packageJsons) {
    if (path === "package.json") continue;
    const manifest = await readJsonObject(fs, join(root, path)).catch(() => undefined);
    if (!manifest) continue;
    if (pointsIntoDist(manifest.main) || pointsIntoDist(manifest.types) || pointsIntoDist(manifest.exports)) return true;
  }
  return false;
}

async function detect(repositoryRoot: string, nodeExecutable: string, fs: DetectionFs): Promise<RunnerDetection> {
  const root = await fs.realpath(repositoryRoot);
  const manifestStat = await statOrUndefined(fs, join(root, "package.json"), false);
  if (!manifestStat?.isFile()) return unsupported("Thiếu package.json ở gốc repository / package.json is missing at the repository root");
  const manifest = await readJsonObject(fs, join(root, "package.json"));
  if (!manifest) return unsupported("package.json không phải JSON object hợp lệ / package.json is not a valid JSON object");

  const dependencies = { ...objectField(manifest.dependencies), ...objectField(manifest.devDependencies) };
  const scripts = objectField(manifest.scripts);
  const notes: string[] = [];
  let runner: { kind: "vitest"; version: string; entry: string; args: string[] } | { kind: "node_tap"; args: string[] } | undefined;
  let vitestProblem: string | undefined;

  if ("vitest" in dependencies) {
    const installedManifest = await readJsonObject(fs, join(root, "node_modules/vitest/package.json"));
    const installedStat = await statOrUndefined(fs, join(root, "node_modules/vitest/package.json"), true);
    if (!installedStat?.isFile()) {
      vitestProblem = "vitest được khai báo nhưng chưa cài đặt (not installed); cần cài dependencies trước";
    } else {
      const version = typeof installedManifest?.version === "string" ? installedManifest.version : "";
      if (majorVersion(version) !== 2) {
        return unsupported(`vitest ${version || "không xác định (unknown version)"} chưa được hỗ trợ; chỉ hỗ trợ vitest 2.x / vitest ${version || "unknown"} is unsupported; only vitest 2.x is supported`);
      }
      const entry = "node_modules/vitest/vitest.mjs";
      const entryStat = await statOrUndefined(fs, join(root, entry), true);
      if (!entryStat?.isFile()) return unsupported("vitest 2.x đã cài nhưng thiếu node_modules/vitest/vitest.mjs / vitest 2.x is installed but vitest.mjs is missing");
      runner = {
        kind: "vitest", version, entry,
        args: [entry, "run", "--globals", "--reporter=json", "--no-cache", "--maxWorkers=1", "--minWorkers=1"]
      };
      notes.push(`vitest ${version}`);
    }
  }
  if (!runner) {
    const nodeFlags = typeof scripts.test === "string" ? parseNodeTestFlags(scripts.test) : undefined;
    if (nodeFlags !== undefined) {
      runner = { kind: "node_tap", args: [...nodeFlags, "--test", "--test-reporter=tap"] };
      notes.push("node --test runner");
    } else {
      return unsupported(vitestProblem ?? "Không phát hiện runner kiểm thử được hỗ trợ (vitest 2.x hoặc node --test) / No supported test runner detected (vitest 2.x or node --test)");
    }
  }

  const executable = await fs.realpath(nodeExecutable);
  if (!isAbsolute(executable) || !(await statOrUndefined(fs, executable, true))?.isFile()) {
    return unsupported("Node executable không hợp lệ / Node executable is not a regular file");
  }

  const walk = await walkRepository(fs, root);
  if (walk.tooMany) return unsupported(`Quá nhiều thư mục node_modules (>${MAX_DEPENDENCY_ROOTS}) / Too many node_modules directories (>${MAX_DEPENDENCY_ROOTS})`);
  // node --test needs no dependencies; vitest is loaded from the root node_modules, so it must be a real directory there.
  if (runner.kind === "vitest" && !walk.dependencyRoots.includes("node_modules")) {
    return unsupported("Thiếu thư mục node_modules thật ở gốc repository (dependencies chưa cài đặt hoặc là symlink) / Root node_modules is missing or is a symlink");
  }

  let prepare: { args: string[]; timeoutMs: number } | undefined;
  const build = typeof scripts.build === "string" ? scripts.build.trim() : "";
  if (build) {
    const tscArgs = parseTscBuildArgs(build);
    if (tscArgs === undefined) {
      notes.push("build script không thuộc dạng tsc được hỗ trợ; không chạy bước prepare / build script is not a supported tsc form; prepare skipped");
    } else if (!(await statOrUndefined(fs, join(root, "node_modules/typescript/bin/tsc"), true))?.isFile()) {
      notes.push("typescript chưa được cài; không chạy bước prepare / typescript is not installed; prepare skipped");
    } else {
      prepare = { args: ["node_modules/typescript/bin/tsc", ...tscArgs], timeoutMs: PREPARE_TIMEOUT_MS };
      notes.push(`prepare: ${["tsc", ...tscArgs].join(" ")}`);
    }
  }
  if (!prepare && await needsDistBuild(fs, root, walk.packageJsons)) {
    notes.push("build step not detected; tests importing dist may fail");
  }

  const base = {
    executable,
    args: [...runner.args],
    reporter: runner.kind === "vitest" ? "vitest_json" as const : "node_tap" as const,
    timeoutMs: PROFILE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    dependencySource: root,
    source: "detected" as const,
    ...(prepare ? { prepare } : {})
  };
  const profiles: RunnerProfile[] = [
    { ...base, args: [...base.args], checkoutDependencyRoots: [...walk.dependencyRoots], id: "auto-unit", command: "auto:unit", method: "unit_test", levels: [...PERMITTED_LEVELS.unit] },
    { ...base, args: [...base.args], checkoutDependencyRoots: [...walk.dependencyRoots], id: "auto-integration", command: "auto:integration", method: "integration_test", levels: [...PERMITTED_LEVELS.integration] }
  ];
  return { status: "detected", profiles, notes };
}

/**
 * Trusted, deterministic detection of a repository test runner. Runs no processes and no shell,
 * never invokes package scripts, and fails closed with `unsupported` whenever a rule is not met.
 */
export async function detectTestRunners(
  repositoryRoot: string,
  options: { nodeExecutable?: string; fs?: DetectionFs } = {}
): Promise<RunnerDetection> {
  const fs = options.fs ?? defaultFs;
  try {
    return await detect(repositoryRoot, options.nodeExecutable ?? process.execPath, fs);
  } catch (error) {
    return unsupported(`Phát hiện runner thất bại / Test runner detection failed: ${errorMessage(error)}`);
  }
}
