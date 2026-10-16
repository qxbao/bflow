import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, CommandRunner } from "./types.js";

export const DENIED_COMMANDS: readonly string[] = ["sudo", "doas", "su", "runas", "pkexec"];
const MAX_BUFFER = 1024 * 1024;
const TIMEOUT_GRACE_MS = 300;

function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // fall through to killing the direct child
    }
  }
  child.kill("SIGKILL");
}

function baseName(arg: string): string {
  const b = arg.split(/[\\/]/).pop() ?? arg;
  return b.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

export class NodeCommandRunner implements CommandRunner {
  run(
    argv: readonly string[],
    options: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {}
  ): Promise<CommandResult> {
    if (argv.length === 0 || argv[0] === undefined || argv[0] === "") {
      return Promise.reject(new TypeError("argv must be non-empty"));
    }
    if (argv.some((a) => typeof a !== "string" || a.includes("\0"))) {
      return Promise.reject(new TypeError("argv must not contain NUL bytes"));
    }
    if (DENIED_COMMANDS.includes(baseName(argv[0]))) {
      return Promise.reject(new TypeError(`elevation command is not permitted: ${argv[0]}`));
    }
    const [file, ...args] = argv as [string, ...string[]];
    return new Promise<CommandResult>((resolve) => {
      let timedOut = false;
      let settled = false;
      let outBuf = "";
      let errBuf = "";
      let spawnError = "";
      let graceTimer: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, stdout: outBuf, stderr: errBuf === "" ? spawnError : errBuf, timedOut });
      };
      const child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ? { ...process.env, ...options.env } : process.env
      });
      const onAbort = (): void => killTree(child);
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (outBuf.length < MAX_BUFFER) outBuf += c;
      });
      child.stderr.on("data", (c: string) => {
        if (errBuf.length < MAX_BUFFER) errBuf += c;
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        spawnError = `${e.code ?? "ERROR"}: ${e.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
          // A descendant may keep the stdio pipes open; do not wait for them indefinitely.
          graceTimer = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(null);
          }, TIMEOUT_GRACE_MS);
        }, options.timeoutMs);
      }
    });
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(
  name: string,
  pathEntries: readonly string[],
  platform: NodeJS.Platform,
  pathExt?: string
): Promise<string | null> {
  if (name === "" || name.includes("\0") || /[\\/]/.test(name)) return null;
  const exts =
    platform === "win32"
      ? ["", ...(pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")]
      : [""];
  for (const dir of pathEntries) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
