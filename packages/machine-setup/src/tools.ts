import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { Sha256DigestSchema } from "@bflow/contracts";
import { z } from "zod";
import { findExecutable } from "./runner.js";
import type { CommandRunner, PlatformProfile } from "./types.js";

export type ToolRequirement =
  | { type: "min"; version: string }
  | { type: "exact"; version: string }
  | { type: "present" };

export interface ToolCatalogEntry {
  readonly toolId: string;
  readonly kind: "runtime" | "provider_cli" | "tool_cli";
  readonly executables: { readonly posix: readonly string[]; readonly win32: readonly string[] };
  readonly versionArgs: readonly string[];
  /** Regex source; capture group 1 is the version. */
  readonly versionPattern: string;
  readonly requirement: ToolRequirement;
  readonly defaultRequired: boolean;
  knownInstallDirs(platform: PlatformProfile): string[];
  readonly manualGuidance: Readonly<Record<"linux" | "darwin" | "win32", string>>;
}

export type ToolObservationStatus =
  | "present"
  | "missing"
  | "version_mismatch"
  | "path_missing"
  | "unparseable_version"
  | "probe_failed";

export interface ToolObservation {
  toolId: string;
  status: ToolObservationStatus;
  resolvedPath: string | null;
  realPath: string | null;
  version: string | null;
  binaryDigest: string | null;
  /** Directory the tool was found in when it is not on PATH, regardless of final status. */
  pathMissingDir: string | null;
  required: boolean;
  diagnostics: string[];
  /** Owner-only action (for example a provider login) that setup cannot perform; reported as deferred, not failed. */
  ownerAction?: string | undefined;
}

export const ToolObservationSchema = z.object({
  toolId: z.string().min(1),
  status: z.enum(["present", "missing", "version_mismatch", "path_missing", "unparseable_version", "probe_failed"]),
  resolvedPath: z.string().nullable(), realPath: z.string().nullable(), version: z.string().nullable(),
  binaryDigest: Sha256DigestSchema.nullable(), pathMissingDir: z.string().nullable(),
  required: z.boolean(), diagnostics: z.array(z.string()), ownerAction: z.string().min(1).optional()
}).strict();

const SEMVER = String.raw`(\d+\.\d+\.\d+)`;

function commonDirs(platform: PlatformProfile): string[] {
  const home = platform.homeDir;
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    ...(platform.os === "darwin" ? [path.join(home, "Library", "pnpm"), "/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    platform.paths.managedBin
  ];
  return [...new Set(dirs)];
}

const providerGuidance = (name: string, url: string): ToolCatalogEntry["manualGuidance"] => ({
  linux: `Install ${name} following the official documentation (${url}), then run its own login flow manually.`,
  darwin: `Install ${name} following the official documentation (${url}), then run its own login flow manually.`,
  win32: `Install ${name} following the official documentation (${url}), then run its own login flow manually.`
});

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    toolId: "node",
    kind: "runtime",
    executables: { posix: ["node"], win32: ["node"] },
    versionArgs: ["--version"],
    versionPattern: String.raw`v?${SEMVER}`,
    requirement: { type: "min", version: "22.13.0" },
    defaultRequired: true,
    knownInstallDirs: commonDirs,
    manualGuidance: {
      linux: "Install Node.js >=22.13.0 from nodejs.org or your distribution package manager.",
      darwin: "Install Node.js >=22.13.0 from nodejs.org or with Homebrew (brew install node).",
      win32: "Install Node.js >=22.13.0 from nodejs.org or with winget."
    }
  },
  {
    toolId: "pnpm",
    kind: "runtime",
    executables: { posix: ["pnpm"], win32: ["pnpm"] },
    versionArgs: ["--version"],
    versionPattern: SEMVER,
    requirement: { type: "exact", version: "12.5.1" },
    defaultRequired: true,
    knownInstallDirs: commonDirs,
    manualGuidance: {
      linux: "Activate pnpm 12.5.1 with corepack (corepack enable; corepack prepare pnpm@12.5.1 --activate) or npm install -g pnpm@12.5.1.",
      darwin: "Activate pnpm 12.5.1 with corepack (corepack enable; corepack prepare pnpm@12.5.1 --activate) or npm install -g pnpm@12.5.1.",
      win32: "Activate pnpm 12.5.1 with corepack (corepack enable; corepack prepare pnpm@12.5.1 --activate) or npm install -g pnpm@12.5.1."
    }
  },
  {
    toolId: "git",
    kind: "runtime",
    executables: { posix: ["git"], win32: ["git"] },
    versionArgs: ["--version"],
    versionPattern: String.raw`git version ${SEMVER}`,
    requirement: { type: "min", version: "2.30.0" },
    defaultRequired: true,
    knownInstallDirs: commonDirs,
    manualGuidance: {
      linux: "Install Git >=2.30.0 with your distribution package manager or from git-scm.com.",
      darwin: "Install Git >=2.30.0 with Homebrew (brew install git) or from git-scm.com.",
      win32: "Install Git >=2.30.0 from git-scm.com or with winget."
    }
  },
  {
    toolId: "herdr",
    kind: "runtime",
    executables: { posix: ["herdr"], win32: ["herdr"] },
    versionArgs: ["--version"],
    versionPattern: String.raw`(?:herdr\s+)?(\S+)`,
    requirement: { type: "present" },
    defaultRequired: true,
    knownInstallDirs: commonDirs,
    manualGuidance: {
      linux: "Install Herdr from its official release page; any release is accepted, the version is recorded as diagnostics only.",
      darwin: "Install Herdr from its official release page; any release is accepted, the version is recorded as diagnostics only.",
      win32: "Install Herdr from its official release page; any release is accepted, the version is recorded as diagnostics only."
    }
  },
  {
    toolId: "claude",
    kind: "provider_cli",
    executables: { posix: ["claude"], win32: ["claude"] },
    versionArgs: ["--version"],
    versionPattern: SEMVER,
    requirement: { type: "present" },
    defaultRequired: false,
    knownInstallDirs: commonDirs,
    manualGuidance: providerGuidance("Claude Code", "https://docs.anthropic.com/en/docs/claude-code")
  },
  {
    toolId: "codex",
    kind: "provider_cli",
    executables: { posix: ["codex"], win32: ["codex"] },
    versionArgs: ["--version"],
    versionPattern: SEMVER,
    requirement: { type: "present" },
    defaultRequired: false,
    knownInstallDirs: commonDirs,
    manualGuidance: providerGuidance("Codex CLI", "https://github.com/openai/codex")
  },
  {
    toolId: "agy",
    kind: "provider_cli",
    executables: { posix: ["agy"], win32: ["agy"] },
    versionArgs: ["--version"],
    versionPattern: SEMVER,
    requirement: { type: "present" },
    defaultRequired: false,
    knownInstallDirs: commonDirs,
    manualGuidance: providerGuidance("Agy", "the provider's official documentation")
  },
  ...["rtk", "gitnexus", "chrome-devtools-mcp", "mempalace"].map((toolId): ToolCatalogEntry => ({
    toolId, kind: "tool_cli", executables: { posix: [toolId], win32: [toolId] },
    versionArgs: ["--version"], versionPattern: SEMVER, requirement: { type: "present" },
    defaultRequired: false, knownInstallDirs: commonDirs,
    manualGuidance: {
      linux: `Install ${toolId} with an approved pinned setup descriptor.`,
      darwin: `Install ${toolId} with an approved pinned setup descriptor.`,
      win32: `Install ${toolId} with an approved pinned setup descriptor.`
    }
  }))
];

/** Strict major.minor.patch parser (no prerelease/build, no leading zeros requirement relaxed). */
export function parseSemver(value: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function lookupNames(entry: ToolCatalogEntry, os: PlatformProfile["os"]): readonly string[] {
  return os === "win32" ? entry.executables.win32 : entry.executables.posix;
}

async function probeOne(
  entry: ToolCatalogEntry,
  platform: PlatformProfile,
  runner: CommandRunner,
  required: boolean,
  knownDirs: (platform: PlatformProfile) => string[]
): Promise<ToolObservation> {
  const obs: ToolObservation = {
    toolId: entry.toolId,
    status: "missing",
    resolvedPath: null,
    realPath: null,
    version: null,
    binaryDigest: null,
    pathMissingDir: null,
    required,
    diagnostics: []
  };
  const nodePlatform: NodeJS.Platform = platform.os === "other" ? "linux" : platform.os;
  let found: string | null = null;
  let onPath = false;
  for (const name of lookupNames(entry, platform.os)) {
    found = await findExecutable(name, platform.pathEntries, nodePlatform);
    if (found) {
      onPath = true;
      break;
    }
  }
  if (!found) {
    for (const name of lookupNames(entry, platform.os)) {
      found = await findExecutable(name, knownDirs(platform), nodePlatform);
      if (found) break;
    }
  }
  if (!found) {
    obs.diagnostics.push(`${entry.toolId} not found on PATH or known install directories`);
    return obs;
  }
  obs.resolvedPath = found;
  if (!onPath) obs.pathMissingDir = path.dirname(found);
  try {
    obs.realPath = await realpath(found);
    obs.binaryDigest = await sha256File(obs.realPath);
  } catch (e) {
    obs.status = "probe_failed";
    obs.diagnostics.push(`cannot read binary: ${(e as Error).message}`);
    return obs;
  }
  if (!onPath) {
    obs.status = "path_missing";
    obs.diagnostics.push(`${entry.toolId} found in ${path.dirname(found)} which is not on PATH`);
  }
  let result;
  try {
    result = await runner.run([found, ...entry.versionArgs], { timeoutMs: 10_000 });
  } catch (e) {
    obs.status = "probe_failed";
    obs.diagnostics.push(`version probe failed: ${(e as Error).message}`);
    return obs;
  }
  if (result.timedOut) {
    obs.status = "probe_failed";
    obs.diagnostics.push("version probe timed out after 10s");
    return obs;
  }
  if (result.exitCode !== 0) {
    obs.status = "probe_failed";
    obs.diagnostics.push(`version probe exited with ${String(result.exitCode)}`);
    return obs;
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const m = new RegExp(entry.versionPattern).exec(output);
  const extracted = m?.[1] ?? null;
  const req = entry.requirement;
  if (req.type === "present") {
    if (output === "") {
      obs.status = "probe_failed";
      obs.diagnostics.push("version probe produced no output");
      return obs;
    }
    obs.version = extracted ?? (output.split(/\r?\n/)[0] as string).trim();
    if (obs.status !== "path_missing") obs.status = "present";
    return obs;
  }
  if (extracted === null || parseSemver(extracted) === null) {
    obs.status = "unparseable_version";
    obs.diagnostics.push(`cannot parse version from output of ${entry.toolId}`);
    return obs;
  }
  obs.version = extracted;
  const cmp = compareSemver(extracted, req.version) as number;
  const ok = req.type === "min" ? cmp >= 0 : cmp === 0;
  if (!ok) {
    obs.status = "version_mismatch";
    obs.diagnostics.push(
      `${entry.toolId} ${extracted} does not satisfy ${req.type === "min" ? ">=" : "="}${req.version}`
    );
    return obs;
  }
  if (obs.status !== "path_missing") obs.status = "present";
  return obs;
}

export async function probeTools(
  platform: PlatformProfile,
  runner: CommandRunner,
  options: {
    required: ReadonlySet<string>;
    /** Test seam: replaces the catalog's knownInstallDirs lookup. */
    knownInstallDirs?: (platform: PlatformProfile) => string[];
  }
): Promise<ToolObservation[]> {
  const out: ToolObservation[] = [];
  for (const entry of TOOL_CATALOG) {
    const dirs = (p: PlatformProfile): string[] => {
      const join = p.os === "win32" ? path.win32.join : path.posix.join;
      const managed = join(p.paths.data, "tools", entry.toolId);
      return [managed, join(managed, "bin"), join(managed, "node_modules", ".bin"),
        ...(options.knownInstallDirs ? options.knownInstallDirs(p) : entry.knownInstallDirs(p))];
    };
    out.push(await probeOne(entry, platform, runner, options.required.has(entry.toolId), dirs));
  }
  // Pins without a supported CLI probe must stay visible and unhealthy, never silently disappear.
  for (const toolId of options.required) {
    if (out.some((o) => o.toolId === toolId)) continue;
    out.push({ toolId, status: "missing", resolvedPath: null, realPath: null, version: null,
      binaryDigest: null, pathMissingDir: null, required: true,
      diagnostics: [`No supported CLI probe for ${toolId}; verify its native integration separately`] });
  }
  return out;
}
