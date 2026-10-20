import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentProviderId, OperationOptions, OperationResult } from "@bflow/contracts";
import { fail, failWith, ok } from "./errors.js";

const SAFE_PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
const REQUIRED_DIRECTORIES = ["home", "config", "cache", "data", "state", "tmp"] as const;
const MAX_METADATA_BYTES = 4096;
const LB_READINESS_TIMEOUT_MS = 800;

const SCRUBBED_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AGY_CONFIG_DIR",
  "AGY_HOME",
  "AGY_API_KEY",
  "AGY_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTIGRAVITY_API_KEY",
  "ANTIGRAVITY_AUTH_TOKEN",
  "AI_ISOLATOR_CODEX_LB_URL",
  "CODEX_LB_API_KEY"
] as const;

export interface IsolatorProfileFilesystemIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeMs: string;
}

export interface IsolatorProfileIdentity {
  readonly stateRoot: string;
  readonly profileRoot: string;
  readonly provider: AgentProviderId;
  readonly profileName: string;
  readonly filesystem: {
    readonly profileRoot: IsolatorProfileFilesystemIdentity;
    readonly home: IsolatorProfileFilesystemIdentity;
    readonly metadata: IsolatorProfileFilesystemIdentity;
    readonly backendMode?: IsolatorProfileFilesystemIdentity;
    readonly backendUrl?: IsolatorProfileFilesystemIdentity;
  };
  readonly createdAt?: string;
  readonly codexBackendUrl?: string;
  readonly codexBackendMode?: "unset" | "direct" | "linked";
}

export interface ResolvedIsolatorProfile {
  readonly identity: IsolatorProfileIdentity;
  /** Explicit provider subprocess environment. May contain CODEX_LB_API_KEY in memory only. */
  readonly environment: Readonly<Record<string, string>>;
  readonly backendUrl?: string;
}

export interface IsolatorProfileResolverPort {
  resolve(provider: AgentProviderId, profileName: string, operation?: OperationOptions):
    Promise<OperationResult<ResolvedIsolatorProfile>>;
}

export interface IsolatorProfileResolverOptions {
  /** Trusted state root supplied by the host platform; absent uses trusted process selectors. */
  readonly stateRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly fetcher?: (url: string, signal: AbortSignal) => Promise<{ readonly status: number }>;
  readonly readinessTimeoutMs?: number;
}

class ProfileFailure extends Error {
  constructor(readonly code: "validation" | "timeout" | "transport_unavailable", message: string) {
    super(message);
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateOwnerAndMode(
  stat: Awaited<ReturnType<typeof lstat>>,
  privateEntry: boolean
): void {
  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new ProfileFailure("validation", "profile entry is not owned by the current user");
  const mode = typeof stat.mode === "bigint" ? Number(stat.mode) : stat.mode;
  if (privateEntry && process.platform !== "win32" && (mode & 0o077) !== 0)
    throw new ProfileFailure("validation", "profile entry is accessible to other users");
}

function filesystemIdentity(stat: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}): IsolatorProfileFilesystemIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: String(stat.birthtimeMs) };
}

function sameFilesystemIdentity(
  left: IsolatorProfileFilesystemIdentity,
  right: IsolatorProfileFilesystemIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

const NO_FOLLOW_DIRECTORY_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0) |
  (constants.O_DIRECTORY ?? 0);

async function requireDirectory(
  path: string,
  containmentRoot: string,
  privateEntry = true
): Promise<{ readonly canonical: string; readonly identity: IsolatorProfileFilesystemIdentity }> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new ProfileFailure("validation", "profile directory is missing or is not a real directory");
  validateOwnerAndMode(before, privateEntry);
  const handle = await open(path, NO_FOLLOW_DIRECTORY_FLAGS);
  try {
    const opened = await handle.stat();
    const identity = filesystemIdentity(opened);
    if (!opened.isDirectory() || !sameFilesystemIdentity(identity, filesystemIdentity(before)))
      throw new ProfileFailure("validation", "profile directory changed while it was being validated");
    validateOwnerAndMode(opened, privateEntry);
    const canonical = await realpath(path);
    const after = await lstat(path);
    if (!sameFilesystemIdentity(identity, filesystemIdentity(after)) || after.isSymbolicLink())
      throw new ProfileFailure("validation", "profile directory changed while it was being validated");
    if (!isWithin(containmentRoot, canonical))
      throw new ProfileFailure("validation", "profile directory escapes its trusted root");
    return { canonical, identity };
  } finally {
    await handle.close();
  }
}

interface ReadProfileFile {
  readonly content: string;
  readonly identity: IsolatorProfileFilesystemIdentity;
}

interface CodexBackendSelection {
  readonly mode: "unset" | "direct" | "linked";
  readonly backendUrl?: string;
  readonly modeFileIdentity?: IsolatorProfileFilesystemIdentity;
  readonly urlFileIdentity?: IsolatorProfileFilesystemIdentity;
}

const NO_FOLLOW_FILE_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

async function readProfileFile(
  path: string,
  containmentRoot: string,
  maxBytes = MAX_METADATA_BYTES
): Promise<ReadProfileFile | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, NO_FOLLOW_FILE_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes)
      throw new ProfileFailure("validation", "profile metadata is not a bounded regular file");
    validateOwnerAndMode(opened, false);
    const identity = filesystemIdentity(opened);
    const canonical = await realpath(path);
    if (!isWithin(containmentRoot, canonical))
      throw new ProfileFailure("validation", "profile metadata escapes its trusted root");

    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes)
      throw new ProfileFailure("validation", "profile metadata exceeds its size limit");
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isFile() ||
        !sameFilesystemIdentity(identity, filesystemIdentity(after)))
      throw new ProfileFailure("validation", "profile metadata changed while it was being validated");
    const content = bytes.subarray(0, offset).toString("utf8");
    if (content.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content))
      throw new ProfileFailure("validation", "profile metadata contains control characters");
    return { content, identity };
  } finally {
    await handle.close();
  }
}

function parseProfileMetadata(content: string, provider: AgentProviderId, profileName: string): string | undefined {
  const fields = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^=\r\n]*)$/.exec(line);
    if (!match || fields.has(match[1]!))
      throw new ProfileFailure("validation", "profile.env is malformed");
    fields.set(match[1]!, match[2]!);
  }
  if (fields.get("AI_ISOLATOR_TOOL") !== provider || fields.get("AI_ISOLATOR_PROFILE") !== profileName)
    throw new ProfileFailure("validation", "profile.env does not match the selected provider and name");
  const createdAt = fields.get("AI_ISOLATOR_CREATED_AT");
  if (createdAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(createdAt))
    throw new ProfileFailure("validation", "profile.env creation metadata is malformed");
  return createdAt;
}

function normalizeBackendRoot(value: string): string {
  if (value.trim() !== value || value.length === 0 || /[\r\n]/.test(value))
    throw new ProfileFailure("validation", "linked Codex backend URL is malformed");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProfileFailure("validation", "linked Codex backend URL is malformed");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash)
    throw new ProfileFailure("validation", "linked Codex backend URL is malformed");
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith("/backend-api/codex")) path = path.slice(0, -"/backend-api/codex".length);
  else if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  return `${parsed.origin}${path}`;
}

function parseSingleLine(content: string, message: string): string {
  const value = content.endsWith("\r\n") ? content.slice(0, -2)
    : content.endsWith("\n") ? content.slice(0, -1)
      : content;
  if (!value || value.includes("\r") || value.includes("\n") || value.trim() !== value)
    throw new ProfileFailure("validation", message);
  return value;
}

async function defaultFetcher(url: string, signal: AbortSignal): Promise<{ readonly status: number }> {
  return fetch(url, { method: "GET", redirect: "error", cache: "no-store", signal });
}

function makeAbortSignal(options: OperationOptions | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export class IsolatorProfileResolver {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly fetcher: NonNullable<IsolatorProfileResolverOptions["fetcher"]>;
  private readonly readinessTimeoutMs: number;

  constructor(private readonly options: IsolatorProfileResolverOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? LB_READINESS_TIMEOUT_MS;
  }

  async resolve(
    provider: AgentProviderId,
    profileName: string,
    operation?: OperationOptions
  ): Promise<OperationResult<ResolvedIsolatorProfile>> {
    try {
      if (!SAFE_PROFILE_NAME.test(profileName))
        throw new ProfileFailure("validation", "profile name is not valid for ai-isolator");
      const realHome = this.realHome();
      const rootPath = this.options.stateRoot ?? this.environment.AI_ISOLATOR_HOME ?? join(realHome, ".local", "share", "ai-isolator");
      if (!isAbsolute(rootPath))
        throw new ProfileFailure("validation", "trusted ai-isolator state root must be absolute");

      const stateRoot = await realpath(rootPath);
      await requireDirectory(stateRoot, stateRoot, false);

      const profilesDirectoryEntry = await requireDirectory(join(stateRoot, "profiles"), stateRoot, false);
      const profilesDirectory = profilesDirectoryEntry.canonical;
      const profileRootPath = join(profilesDirectory, `${provider}--${profileName}`);
      const profileRootEntry = await requireDirectory(profileRootPath, profilesDirectory);
      const profileRoot = profileRootEntry.canonical;
      if (profileRoot !== profileRootPath)
        throw new ProfileFailure("validation", "profile root is not canonical");

      const directories = new Map<string, { readonly canonical: string; readonly identity: IsolatorProfileFilesystemIdentity }>();
      for (const name of REQUIRED_DIRECTORIES)
        directories.set(name, await requireDirectory(join(profileRoot, name), profileRoot));
      const homeEntry = directories.get("home")!;
      const home = homeEntry.canonical;

      const metadata = await readProfileFile(join(profileRoot, "profile.env"), profileRoot);
      if (metadata === undefined) throw new ProfileFailure("validation", "profile.env is missing");
      const createdAt = parseProfileMetadata(metadata.content, provider, profileName);

      const providerConfigName = provider === "codex" ? ".codex" : provider === "claude" ? ".claude" : ".gemini";
      const providerConfigRootPath = join(home, providerConfigName);
      let providerConfigRoot: string | undefined;
      try {
        providerConfigRoot = (await requireDirectory(providerConfigRootPath, home, false)).canonical;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (provider === "agy") {
        if (providerConfigRoot === undefined)
          throw new ProfileFailure("validation", "Agy profile native config directory is missing");
        await requireDirectory(join(providerConfigRoot, "antigravity-cli"), home, false);
      }

      const backend = provider === "codex" ? await this.resolveCodexBackend(profileRoot, operation) : undefined;
      const backendUrl = backend?.backendUrl;
      const identity: IsolatorProfileIdentity = {
        stateRoot,
        profileRoot,
        provider,
        profileName,
        filesystem: {
          profileRoot: profileRootEntry.identity,
          home: homeEntry.identity,
          metadata: metadata.identity,
          ...(backend?.modeFileIdentity !== undefined ? { backendMode: backend.modeFileIdentity } : {}),
          ...(backend?.urlFileIdentity !== undefined ? { backendUrl: backend.urlFileIdentity } : {})
        },
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(backendUrl !== undefined ? { codexBackendUrl: backendUrl } : {}),
        ...(backend !== undefined ? { codexBackendMode: backend.mode } : {})
      };
      return ok({
        identity,
        environment: this.profileEnvironment(provider, profileName, stateRoot, realHome, home, backendUrl),
        ...(backendUrl !== undefined ? { backendUrl } : {})
      });
    } catch (error) {
      if (operation?.signal?.aborted) return fail("cancelled", "profile validation was cancelled");
      if (error instanceof ProfileFailure) {
        switch (error.code) {
          case "timeout":
            return failWith({ code: "timeout", retryable: true, retrySafety: "observation_only",
              message: error.message, details: { status: "blocked" } });
          case "transport_unavailable":
            return fail("transport_unavailable", error.message, { status: "blocked" });
          case "validation":
            return fail("validation", error.message, { status: "blocked" });
        }
      }
      return fail("validation", "selected ai-isolator profile is missing or invalid", { status: "blocked" });
    }
  }

  private realHome(): string {
    const home = this.environment.AI_ISOLATOR_REAL_HOME ?? this.options.homeDirectory ??
      this.environment.HOME ?? homedir();
    if (!isAbsolute(home)) throw new ProfileFailure("validation", "trusted real HOME must be absolute");
    return resolve(home);
  }

  private async resolveCodexBackend(profileRoot: string, operation?: OperationOptions): Promise<CodexBackendSelection> {
    const modePath = join(profileRoot, "codex-lb.mode");
    const modeFile = await readProfileFile(modePath, profileRoot, 1024);
    if (modeFile === undefined) return { mode: "unset" };
    const mode = parseSingleLine(modeFile.content, "Codex backend mode metadata is malformed");
    if (mode === "direct") return { mode, modeFileIdentity: modeFile.identity };
    if (mode !== "linked")
      throw new ProfileFailure("validation", "Codex backend mode metadata is malformed");

    const urlFile = await readProfileFile(join(profileRoot, "codex-lb.url"), profileRoot, 2048);
    if (urlFile === undefined) throw new ProfileFailure("validation", "linked Codex backend URL is missing");
    const root = normalizeBackendRoot(parseSingleLine(urlFile.content, "linked Codex backend URL is malformed"));
    const deadline = operation?.deadline === undefined ? undefined : Date.parse(operation.deadline);
    if (deadline !== undefined && !Number.isFinite(deadline))
      throw new ProfileFailure("validation", "linked Codex backend readiness deadline is invalid");
    const remaining = deadline === undefined ? this.readinessTimeoutMs : deadline - Date.now();
    const timeoutMs = Math.min(this.readinessTimeoutMs, operation?.timeoutMs ?? this.readinessTimeoutMs, remaining);
    if (timeoutMs <= 0) throw new ProfileFailure("timeout", "linked Codex backend readiness deadline expired");
    let response: { readonly status: number };
    const signal = makeAbortSignal(operation, timeoutMs);
    try {
      response = await this.fetcher(`${root}/health/ready`, signal);
    } catch {
      if (operation?.signal?.aborted) throw new ProfileFailure("validation", "linked Codex backend readiness was cancelled");
      if (signal.aborted) throw new ProfileFailure("timeout", "linked Codex backend readiness timed out");
      throw new ProfileFailure("transport_unavailable", "linked Codex backend is not ready");
    }
    if (response.status !== 200)
      throw new ProfileFailure("transport_unavailable", "linked Codex backend is not ready");
    return {
      mode: "linked",
      backendUrl: `${root}/backend-api/codex`,
      modeFileIdentity: modeFile.identity,
      urlFileIdentity: urlFile.identity
    };
  }

  private profileEnvironment(
    provider: AgentProviderId,
    profileName: string,
    stateRoot: string,
    realHome: string,
    home: string,
    backendUrl: string | undefined
  ): Readonly<Record<string, string>> {
    const profileRoot = join(stateRoot, "profiles", `${provider}--${profileName}`);
    const environment: Record<string, string> = {
      ...Object.fromEntries(SCRUBBED_ENVIRONMENT_KEYS.map(key => [key, ""])),
      HOME: home,
      XDG_CONFIG_HOME: join(profileRoot, "config"),
      XDG_CACHE_HOME: join(profileRoot, "cache"),
      XDG_DATA_HOME: join(profileRoot, "data"),
      XDG_STATE_HOME: join(profileRoot, "state"),
      TMPDIR: join(profileRoot, "tmp"),
      AI_ISOLATOR: "1",
      AI_ISOLATOR_HOME: stateRoot,
      AI_ISOLATOR_REAL_HOME: realHome,
      AI_ISOLATOR_TOOL: provider,
      AI_ISOLATOR_PROFILE: profileName
    };
    if (this.environment.PATH !== undefined) environment["PATH"] = this.environment.PATH;
    if (provider === "codex") environment["CODEX_HOME"] = join(home, ".codex");
    if (provider === "claude") delete environment["CLAUDE_CONFIG_DIR"];
    if (provider === "codex" && backendUrl !== undefined) {
      const key = this.environment.CODEX_LB_API_KEY;
      if (key !== undefined) environment["CODEX_LB_API_KEY"] = key;
    }
    return environment;
  }
}
