import { createHash } from "node:crypto";
import path from "node:path";
import { err, ok, type OperationResult, type SupportedOSPlatform, type TrustScope } from "./types.js";

export interface BflowOSPaths {
  readonly platform: SupportedOSPlatform;
  readonly homeDir: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly serviceUnitDir: string;
  readonly browserProfilesRoot: string;
}

export interface ResolveOSPathsOptions {
  readonly platform?: SupportedOSPlatform | undefined;
  readonly homeDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Resolves standard OS user-level paths for Bflow services, state, logs, and dedicated browser profiles.
 * Never places default directories inside a project repository or personal Chrome directories.
 */
export function resolveBflowOSPaths(options?: ResolveOSPathsOptions): BflowOSPaths {
  const env = options?.env ?? process.env;
  const rawPlatform = options?.platform ?? process.platform;
  const platform: SupportedOSPlatform =
    rawPlatform === "darwin" ? "darwin" : rawPlatform === "win32" ? "win32" : "linux";

  const homeDir = path.resolve(
    options?.homeDir ?? env.HOME ?? env.USERPROFILE ?? (platform === "win32" ? "C:\\Users\\Default" : "/tmp/bflow-user")
  );

  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support", "bflow");
    const logDir = path.join(homeDir, "Library", "Logs", "bflow");
    return {
      platform,
      homeDir,
      configDir: path.join(appSupport, "config"),
      dataDir: path.join(appSupport, "data"),
      stateDir: path.join(appSupport, "state"),
      logDir,
      serviceUnitDir: path.join(homeDir, "Library", "LaunchAgents"),
      browserProfilesRoot: path.join(appSupport, "browser-profiles")
    };
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA
      ? path.resolve(env.LOCALAPPDATA)
      : path.join(homeDir, "AppData", "Local");
    const appData = env.APPDATA
      ? path.resolve(env.APPDATA)
      : path.join(homeDir, "AppData", "Roaming");
    const bflowRoot = path.join(localAppData, "bflow");
    return {
      platform,
      homeDir,
      configDir: path.join(appData, "bflow", "config"),
      dataDir: path.join(bflowRoot, "data"),
      stateDir: path.join(bflowRoot, "state"),
      logDir: path.join(bflowRoot, "logs"),
      serviceUnitDir: path.join(
        appData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup"
      ),
      browserProfilesRoot: path.join(bflowRoot, "browser-profiles")
    };
  }

  // Linux / XDG standard
  const xdgConfigHome = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(homeDir, ".config");
  const xdgDataHome = env.XDG_DATA_HOME
    ? path.resolve(env.XDG_DATA_HOME)
    : path.join(homeDir, ".local", "share");
  const xdgStateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(homeDir, ".local", "state");

  return {
    platform,
    homeDir,
    configDir: path.join(xdgConfigHome, "bflow"),
    dataDir: path.join(xdgDataHome, "bflow"),
    stateDir: path.join(xdgStateHome, "bflow"),
    logDir: path.join(xdgStateHome, "bflow", "logs"),
    serviceUnitDir: path.join(xdgConfigHome, "systemd", "user"),
    browserProfilesRoot: path.join(xdgDataHome, "bflow", "browser-profiles")
  };
}

/**
 * Returns known personal browser profile paths for the current user that Bflow MUST NEVER touch.
 */
export function getPersonalChromeProfilePaths(
  homeDir: string,
  env?: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const resolvedHome = path.resolve(homeDir);
  const localAppData = env?.LOCALAPPDATA
    ? path.resolve(env.LOCALAPPDATA)
    : path.join(resolvedHome, "AppData", "Local");
  const xdgConfig = env?.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(resolvedHome, ".config");

  return [
    path.join(xdgConfig, "google-chrome"),
    path.join(xdgConfig, "google-chrome-beta"),
    path.join(xdgConfig, "google-chrome-unstable"),
    path.join(xdgConfig, "chromium"),
    path.join(xdgConfig, "BraveSoftware", "Brave-Browser"),
    path.join(xdgConfig, "microsoft-edge"),
    path.join(resolvedHome, "snap", "chromium", "common", "chromium"),
    path.join(resolvedHome, "Library", "Application Support", "Google", "Chrome"),
    path.join(resolvedHome, "Library", "Application Support", "Google", "Chrome Canary"),
    path.join(resolvedHome, "Library", "Application Support", "Chromium"),
    path.join(resolvedHome, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    path.join(localAppData, "Google", "Chrome", "User Data"),
    path.join(localAppData, "Chromium", "User Data"),
    path.join(localAppData, "Microsoft", "Edge", "User Data"),
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data")
  ].map((p) => path.resolve(p));
}

function isSameOrSubpath(parentDir: string, candidatePath: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedParent === resolvedCandidate) return true;
  const rel = path.relative(resolvedParent, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface ValidateBrowserProfilePathOptions {
  readonly targetProfileDir: string;
  readonly homeDir: string;
  readonly repositoryRoots?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Enforces that a browser profile directory:
 * 1. Is an absolute path.
 * 2. Is NEVER inside any Git repository / workspace root.
 * 3. NEVER overlaps with or resides inside a personal Chrome/Chromium profile directory.
 */
export function validateBrowserProfileDirectory(
  options: ValidateBrowserProfilePathOptions
): OperationResult<string> {
  if (!path.isAbsolute(options.targetProfileDir)) {
    return err({
      code: "validation",
      retryable: false,
      message: `Browser profile directory must be an absolute path: ${options.targetProfileDir}`,
      details: { diagnosticCode: "non_absolute_profile_path" }
    });
  }

  const resolvedTarget = path.resolve(options.targetProfileDir);

  for (const repoRoot of options.repositoryRoots ?? []) {
    const resolvedRepo = path.resolve(repoRoot);
    if (isSameOrSubpath(resolvedRepo, resolvedTarget) || isSameOrSubpath(resolvedTarget, resolvedRepo)) {
      return err({
        code: "validation",
        retryable: false,
        message: `Browser profile directory '${resolvedTarget}' must not be placed inside repository '${resolvedRepo}'`,
        details: {
          diagnosticCode: "repository_profile_forbidden",
          profileDir: resolvedTarget,
          repositoryRoot: resolvedRepo
        }
      });
    }
  }

  const personalPaths = getPersonalChromeProfilePaths(options.homeDir, options.env);
  for (const personalPath of personalPaths) {
    if (isSameOrSubpath(personalPath, resolvedTarget) || isSameOrSubpath(resolvedTarget, personalPath)) {
      return err({
        code: "validation",
        retryable: false,
        message: `Browser profile directory '${resolvedTarget}' conflicts with personal browser profile '${personalPath}'`,
        details: {
          diagnosticCode: "personal_profile_forbidden",
          profileDir: resolvedTarget,
          personalProfilePath: personalPath
        }
      });
    }
  }

  return ok(resolvedTarget);
}

/**
 * Computes a deterministic, filesystem-safe directory path for a dedicated Chrome profile
 * scoped to a specific TrustScope (and optional taskId/partitionId).
 */
export function resolveDedicatedProfileDir(
  browserProfilesRoot: string,
  scope: TrustScope,
  partitionSuffix?: string
): string {
  const canonicalRoot = path.resolve(browserProfilesRoot);
  const scopeDescriptor =
    scope.kind === "machine"
      ? `machine:${scope.machineId}`
      : scope.kind === "repository"
        ? `repo:${scope.machineId}:${scope.repositoryId}:${scope.workspaceRoot}`
        : `session:${scope.machineId}:${scope.repositoryId}:${scope.workspaceRoot}:${scope.sessionId}`;
  const fullKey = partitionSuffix ? `${scopeDescriptor}:${partitionSuffix}` : scopeDescriptor;
  const hash = createHash("sha256").update(fullKey, "utf8").digest("hex").slice(0, 24);
  const prefix =
    scope.kind === "machine"
      ? `machine-${scope.machineId}`
      : scope.kind === "repository"
        ? `repo-${scope.repositoryId}`
        : `session-${scope.repositoryId}-${scope.sessionId}`;
  const safePrefix = prefix.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  return path.join(canonicalRoot, `${safePrefix}-${hash}`, "user-data");
}

/**
 * Validates that a remote debugging host is strictly loopback-bound.
 */
export function validateLoopbackDebuggingHost(host: string): OperationResult<"127.0.0.1" | "localhost" | "[::1]"> {
  const normalized = host.trim().toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "localhost" || normalized === "[::1]" || normalized === "::1") {
    return ok(normalized === "::1" ? "[::1]" : (normalized as "127.0.0.1" | "localhost" | "[::1]"));
  }
  return err({
    code: "validation",
    retryable: false,
    message: `Chrome remote debugging endpoint must only bind to loopback (got '${host}')`,
    details: {
      diagnosticCode: "non_loopback_forbidden",
      host
    }
  });
}
