import { readFile } from "node:fs/promises";
import { shellQuoteArgv } from "./director-skill.js";

export type DirectorLaunchProvider = "claude" | "codex" | "agy";
export const DIRECTOR_LAUNCH_PROVIDERS: readonly DirectorLaunchProvider[] = ["claude", "codex", "agy"];

/** Environment variable read by `detectProvider` in `bflow director start`; scoped to the launched CLI, never a repo role. */
export const DIRECTOR_PROVIDER_HINT_ENV = "BFLOW_DIRECTOR_PROVIDER";

/**
 * Invocation-scoped Director permissions: it must be able to start and contact the local host.
 * Keep Codex off the shared daemon so daemon updates cannot drain this Director's turns.
 * These flags do not change specialist launch policy or Runtime human approval gates.
 */
export const DIRECTOR_START_ARGS: Readonly<Record<DirectorLaunchProvider, readonly string[]>> = {
  claude: ["--dangerously-skip-permissions", "/bflow-start"],
  codex: ["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "$bflow-start"],
  agy: ["-i", "/bflow-start"]
};

const LINUX_TERMINALS = ["gnome-terminal", "konsole", "xfce4-terminal", "kitty", "alacritty", "wezterm", "foot", "xterm"] as const;
export type DirectorTerminalKind = (typeof LINUX_TERMINALS)[number] | "macos_terminal" | "windows_terminal";

export type DirectorTerminalSelection =
  | { readonly available: true; readonly kind: DirectorTerminalKind; readonly executable: string }
  | { readonly available: false; readonly reason: string };

export interface DirectorTerminalProbe {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isWsl: () => Promise<boolean>;
  /** Absolute path of an executable on PATH, or null. */
  readonly find: (name: string) => Promise<string | null>;
}

const isSsh = (env: Readonly<Record<string, string | undefined>>): boolean =>
  Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

/** WSL detection from the environment or the kernel banner; any read failure means "not WSL". */
export async function defaultIsWsl(env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(await readFile("/proc/version", "utf8")); } catch { return false; }
}

/** Selects a terminal opener by executable availability only. Nothing here is a live claim. */
export async function selectDirectorTerminal(probe: DirectorTerminalProbe): Promise<DirectorTerminalSelection> {
  if (isSsh(probe.env)) return { available: false, reason: "Phiên SSH không có màn hình cục bộ để mở cửa sổ terminal." };
  if (probe.platform === "darwin") {
    const osascript = await probe.find("osascript");
    return osascript ? { available: true, kind: "macos_terminal", executable: osascript }
      : { available: false, reason: "Không tìm thấy osascript để mở Terminal trên macOS." };
  }
  if (probe.platform !== "linux") return { available: false, reason: `Chưa hỗ trợ mở terminal trên nền tảng ${probe.platform}.` };
  if (await probe.isWsl()) {
    const [wt, wsl] = await Promise.all([probe.find("wt.exe"), probe.find("wsl.exe")]);
    if (wt && wsl) return { available: true, kind: "windows_terminal", executable: wt };
  }
  if (!probe.env.DISPLAY && !probe.env.WAYLAND_DISPLAY) return { available: false, reason: "Không có màn hình đồ họa (DISPLAY/WAYLAND_DISPLAY trống)." };
  for (const name of LINUX_TERMINALS) {
    const found = await probe.find(name);
    if (found) return { available: true, kind: name, executable: found };
  }
  return { available: false, reason: "Không tìm thấy trình giả lập terminal được hỗ trợ trên PATH." };
}

const DROP_PREFIXES = ["HERDR_", "ORCA_", "AI_ISOLATOR_", "ANTIGRAVITY_", "AGY_"];
const DROP_KEYS = new Set([
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR",
  "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODEX_CI"
]);
/** Machine-scope Bflow settings a user may legitimately set; every other BFLOW_* value is pane/role/credential context. */
const KEEP_BFLOW = new Set(["BFLOW_HOME", "BFLOW_DEBUG", "BFLOW_SOURCE", "BFLOW_GITNEXUS", "BFLOW_HERDR_BIN"]);

/**
 * Environment for the launched terminal: inherited user config stays, while Herdr pane/socket,
 * Orca, isolator and nested provider session markers plus Bflow role/credential values are dropped.
 */
export function sanitizeDirectorLaunchEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  provider: DirectorLaunchProvider
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (DROP_KEYS.has(key) || DROP_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    if (key.startsWith("BFLOW_") && !KEEP_BFLOW.has(key)) continue;
    env[key] = value;
  }
  env[DIRECTOR_PROVIDER_HINT_ENV] = provider;
  return env;
}

/** POSIX command line: `cd <cwd> && BFLOW_DIRECTOR_PROVIDER=<p> <argv...>`, every word single-quoted. */
export function directorCommandLine(cwd: string, provider: DirectorLaunchProvider, argv: readonly string[]): string {
  return `cd ${shellQuoteArgv([cwd])} && ${DIRECTOR_PROVIDER_HINT_ENV}=${provider} ${shellQuoteArgv(argv)}`;
}

export type DirectorTerminalInvocation =
  | { readonly ok: true; readonly kind: DirectorTerminalKind; readonly executable: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Terminal argv that runs `envExecutable HINT=<p> <provider argv>` in `cwd` without a shell. The
 * `env` wrapper carries the hint even when a terminal server does not forward the client environment.
 */
export function directorTerminalInvocation(input: {
  readonly selection: Extract<DirectorTerminalSelection, { available: true }>;
  readonly cwd: string;
  readonly provider: DirectorLaunchProvider;
  readonly argv: readonly string[];
  readonly envExecutable: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DirectorTerminalInvocation {
  const { selection, cwd } = input;
  const inner = [input.envExecutable, `${DIRECTOR_PROVIDER_HINT_ENV}=${input.provider}`, ...input.argv];
  const done = (args: readonly string[]): DirectorTerminalInvocation => ({ ok: true, kind: selection.kind, executable: selection.executable, args });
  switch (selection.kind) {
    case "gnome-terminal": return done([`--working-directory=${cwd}`, "--", ...inner]);
    case "konsole": return done(["--workdir", cwd, "-e", ...inner]);
    case "xfce4-terminal": return done(["--working-directory", cwd, "-x", ...inner]);
    case "kitty": return done(["--directory", cwd, ...inner]);
    case "alacritty": return done(["--working-directory", cwd, "-e", ...inner]);
    case "wezterm": return done(["start", "--cwd", cwd, "--", ...inner]);
    case "foot": return done([`--working-directory=${cwd}`, ...inner]);
    case "xterm": return done(["-e", ...inner]);
    case "macos_terminal":
      // The command line is an osascript argv item, never interpolated into AppleScript source.
      return done(["-e", "on run argv", "-e", "tell application \"Terminal\"", "-e", "activate", "-e", "do script (item 1 of argv)",
        "-e", "end tell", "-e", "end run", directorCommandLine(cwd, input.provider, input.argv)]);
    case "windows_terminal": {
      // Windows Terminal splits its command line on ';' even inside one argument.
      if ([cwd, ...inner].some(part => part.includes(";"))) return { ok: false, reason: "Đường dẫn có ký tự ';' nên không thể mở an toàn qua Windows Terminal." };
      const distro = input.env.WSL_DISTRO_NAME;
      const distroArgs = distro && /^[A-Za-z0-9._-]{1,64}$/.test(distro) ? ["-d", distro] : [];
      return done(["new-tab", "wsl.exe", ...distroArgs, "--cd", cwd, "--exec", ...inner]);
    }
  }
}
