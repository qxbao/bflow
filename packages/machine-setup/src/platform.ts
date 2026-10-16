import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { HostEnvironment, PlatformProfile, SupportStatus } from "./types.js";

export function defaultHostEnvironment(): HostEnvironment {
  const posix = process.platform !== "win32";
  return {
    platform: process.platform,
    arch: process.arch,
    env: { ...process.env },
    homeDir: os.homedir(),
    hostname: os.hostname(),
    uid: posix && typeof process.getuid === "function" ? process.getuid() : null,
    gid: posix && typeof process.getgid === "function" ? process.getgid() : null
  };
}

function absoluteOr(value: string | undefined, fallback: string, host: HostEnvironment): string {
  const p = host.platform === "win32" ? path.win32 : path.posix;
  return value !== undefined && value !== "" && p.isAbsolute(value) ? value : fallback;
}

export function resolveXdgPaths(host: HostEnvironment): PlatformProfile["paths"] {
  const p = host.platform === "win32" ? path.win32 : path.posix;
  const config = p.join(absoluteOr(host.env.XDG_CONFIG_HOME, p.join(host.homeDir, ".config"), host), "bflow");
  const data = p.join(absoluteOr(host.env.XDG_DATA_HOME, p.join(host.homeDir, ".local", "share"), host), "bflow");
  const state = p.join(absoluteOr(host.env.XDG_STATE_HOME, p.join(host.homeDir, ".local", "state"), host), "bflow");
  return { config, data, state, managedBin: p.join(data, "bin") };
}

function detectShell(host: HostEnvironment): { shell: PlatformProfile["shell"]; shellPath: string | null } {
  if (host.platform === "win32") {
    const comSpec = host.env.ComSpec;
    if (host.env.PSModulePath) return { shell: "pwsh", shellPath: null };
    if (comSpec) return { shell: "cmd", shellPath: comSpec };
    return { shell: "unknown", shellPath: null };
  }
  const shellPath = host.env.SHELL;
  if (!shellPath) return { shell: "unknown", shellPath: null };
  const base = shellPath.split("/").pop() ?? "";
  switch (base) {
    case "bash":
    case "zsh":
    case "fish":
    case "sh":
      return { shell: base, shellPath };
    case "dash":
      return { shell: "sh", shellPath };
    default:
      return { shell: "unknown", shellPath };
  }
}

export function splitPath(host: HostEnvironment): string[] {
  const raw = host.platform === "win32" ? (host.env.Path ?? host.env.PATH ?? "") : (host.env.PATH ?? "");
  const sep = host.platform === "win32" ? ";" : ":";
  return raw.split(sep).filter((e) => e !== "");
}

/**
 * Pure apart from a PATH lookup for sudo (informational). The caller supplies
 * `elevationAvailable` detection via the optional probe; default is false.
 */
export function detectPlatform(
  host: HostEnvironment,
  options: { elevationAvailable?: boolean } = {}
): PlatformProfile {
  const os_: PlatformProfile["os"] =
    host.platform === "linux" || host.platform === "darwin" || host.platform === "win32" ? host.platform : "other";
  const supportStatus: SupportStatus =
    os_ === "linux" || os_ === "darwin" ? "supported" : os_ === "win32" ? "designed_unverified" : "unsupported";
  const { shell, shellPath } = detectShell(host);
  const machineId =
    "m-" +
    createHash("sha256")
      .update(`${host.hostname}\0${host.uid ?? ""}\0${host.homeDir}`, "utf8")
      .digest("hex")
      .slice(0, 24);
  return {
    os: os_,
    arch: host.arch,
    supportStatus,
    shell,
    shellPath,
    uid: host.uid,
    gid: host.gid,
    isRoot: host.uid === 0,
    elevationAvailable: options.elevationAvailable ?? false,
    homeDir: host.homeDir,
    hostname: host.hostname,
    machineId,
    paths: resolveXdgPaths(host),
    pathEntries: splitPath(host)
  };
}

/** Detect profile and probe PATH for sudo (informational only; never executed). */
export async function detectPlatformWithProbe(host: HostEnvironment): Promise<PlatformProfile> {
  const { findExecutable } = await import("./runner.js");
  const entries = splitPath(host);
  const sudo = await findExecutable("sudo", entries, host.platform);
  return detectPlatform(host, { elevationAvailable: sudo !== null });
}
