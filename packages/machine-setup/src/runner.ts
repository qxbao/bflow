import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, CommandRunner } from "./types.js";

export const DENIED_COMMANDS: readonly string[] = ["sudo", "doas", "su", "runas", "pkexec"];
const MAX_BUFFER = 1024 * 1024;

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
      const child = execFile(
        file,
        args,
        {
          shell: false,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          encoding: "utf8",
          env: options.env ? { ...process.env, ...options.env } : process.env,
          ...(options.signal ? { signal: options.signal } : {})
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          const e = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
          let exitCode: number | null = 0;
          let err = String(stderr ?? "");
          if (e) {
            exitCode = typeof e.code === "number" ? e.code : null;
            if (typeof e.code === "string" && err === "") err = `${e.code}: ${e.message}`;
          }
          resolve({ exitCode, stdout: String(stdout ?? ""), stderr: err, timedOut });
        }
      );
      const timer: NodeJS.Timeout | undefined =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeoutMs);
    });
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
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
