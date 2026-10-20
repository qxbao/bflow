import { existsSync } from "node:fs";
import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as osConstants } from "node:os";
import type { CliContext, CliExecutionResult } from "./types.js";

type Spawn = typeof nodeSpawn;

export function isolationEnginePath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../isolation/bin/ai-isolator");
}

function result(exitCode: number, stdout = "", stderr = ""): CliExecutionResult {
  return { command: "iso", exitCode, ok: exitCode === 0, stdout, stderr };
}

function processDescendants(rootPid: number): number[] {
  const output = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000
  });
  const children = new Map<number, number[]>();
  for (const row of output.split("\n")) {
    const [pidText, parentText] = row.trim().split(/\s+/);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)) {
      const siblings = children.get(parentPid) ?? [];
      siblings.push(pid);
      children.set(parentPid, siblings);
    }
  }
  const ordered: number[] = [];
  const visit = (pid: number) => {
    for (const childPid of children.get(pid) ?? []) visit(childPid);
    ordered.push(pid);
  };
  for (const childPid of children.get(rootPid) ?? []) visit(childPid);
  return ordered;
}

function signalPids(pids: readonly number[], signal: NodeJS.Signals): boolean {
  let sent = false;
  for (const pid of pids) {
    try { process.kill(pid, signal); sent = true; } catch { /* exited during traversal */ }
  }
  return sent;
}

function isProcessAlive(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch { return false; }
}

export async function runIsolator(
  argv: readonly string[],
  context?: CliContext,
  options: { readonly enginePath?: string; readonly spawn?: Spawn } = {}
): Promise<CliExecutionResult> {
  const enginePath = options.enginePath ?? context?.isoEnginePath ?? isolationEnginePath();
  const spawn = options.spawn ?? nodeSpawn;
  const useTerminal = context?.io === undefined;
  const foregroundTty = useTerminal && process.stdin.isTTY === true && process.stdout.isTTY === true;
  let capturedStdout = "";
  let capturedStderr = "";
  const stderr = (chunk: string) => {
    if (!useTerminal) capturedStderr += chunk;
    if (context?.io?.stderrRaw) context.io.stderrRaw(chunk);
    else if (context?.io) context.io.stderr(chunk);
    else process.stderr.write(chunk);
  };
  const stdout = (chunk: string) => {
    if (!useTerminal) capturedStdout += chunk;
    if (context?.io) context.io.stdout(chunk);
    else process.stdout.write(chunk);
  };
  if (!existsSync(enginePath)) {
    const message = `bflow iso: ai-isolator engine is missing at ${enginePath}. Reinstall or restore the @bflow/cli isolation resources.\n`;
    stderr(message);
    return result(127, "", message.trimEnd());
  }

  return await new Promise<CliExecutionResult>((resolveResult) => {
    let child: ChildProcess;
    try {
      child = spawn("bash", [enginePath, ...argv], {
        cwd: context?.cwd ?? process.cwd(),
        env: process.env,
        stdio: useTerminal ? "inherit" : ["inherit", "pipe", "pipe"],
        // Keep interactive providers in the caller's controlling terminal session.
        // Captured/noninteractive runs get a private process group for tree cleanup.
        detached: !useTerminal && process.platform !== "win32"
      });
    } catch (error) {
      const message = `bflow iso: could not start Bash: ${error instanceof Error ? error.message : String(error)}\n`;
      stderr(message);
      resolveResult(result(127, "", message.trimEnd()));
      return;
    }
    let done = false;
    let signalExit: number | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let escalationPids: number[] = [];
    const forward = (signal: NodeJS.Signals) => {
      let delivered = false;
      try {
        if (!useTerminal && child.pid && process.platform !== "win32") {
          process.kill(-child.pid, signal);
          delivered = true;
        } else if (process.platform !== "win32" && child.pid && (!foregroundTty || signal === "SIGTERM")) {
          escalationPids = [...processDescendants(child.pid), child.pid];
          delivered = signalPids(escalationPids, signal);
          if (delivered) {
            escalation = setTimeout(() => {
              signalPids(escalationPids, "SIGKILL");
              escalation = undefined;
            }, 1500);
          }
        } else {
          delivered = child.kill(signal);
        }
      } catch {
        // If process inspection failed, still stop the engine itself.
        try { delivered = child.kill(signal); } catch { /* process may already have exited */ }
      }
      if (delivered) signalExit = signal === "SIGINT" ? 130 : 143;
    };
    // Ctrl+C from a real foreground terminal already reaches its process group.
    const onInt = () => {
      if (foregroundTty) signalExit = 130;
      else forward("SIGINT");
    };
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    if (!useTerminal) {
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout(chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr(chunk));
    }
    child.on("error", (error) => {
      if (done) return;
      done = true;
      if (escalation !== undefined && !escalationPids.some(isProcessAlive)) {
        clearTimeout(escalation);
        escalation = undefined;
      }
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      const message = `bflow iso: could not start Bash: ${error.message}\n`;
      stderr(message);
      resolveResult(result(127, "", message.trimEnd()));
    });
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      if (escalation !== undefined && !escalationPids.some(isProcessAlive)) {
        clearTimeout(escalation);
        escalation = undefined;
      }
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      const status = signalExit ?? (code ?? (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0)));
      resolveResult(result(status, capturedStdout, capturedStderr));
    });
  });
}

export function isIsoInvocation(argv: readonly string[]): boolean {
  return argv[0] === "iso";
}
