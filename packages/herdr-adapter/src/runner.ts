import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { scheduleSafeTimeout } from "./operation-budget.js";

export interface CommandInvocation {
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: "spawn" | "timeout" | "aborted" | "output_limit" | "invalid_arguments" | "runner";
  /** false proves the command never launched; omission is conservatively uncertain. */
  readonly started?: boolean;
  readonly cause?: string;
}

export interface HerdrCommandRunner {
  run(invocation: CommandInvocation): Promise<CommandOutcome>;
}

const PRE_EXEC_INVALID_ARG_CODES = new Set(["E2BIG", "ENAMETOOLONG", "EINVAL"]);
const PIPE_DRAIN_GRACE_MS = 50;

export function validArguments(args: readonly string[]): boolean {
  return Array.isArray(args) && args.every((arg) => typeof arg === "string" && !arg.includes("\0"));
}

function classifyPreExecError(error: unknown): { failure: "invalid_arguments" | "spawn"; cause: string } {
  const code = typeof (error as NodeJS.ErrnoException)?.code === "string"
    ? (error as NodeJS.ErrnoException).code!
    : undefined;
  if (code && PRE_EXEC_INVALID_ARG_CODES.has(code)) {
    return {
      failure: "invalid_arguments",
      cause: `Herdr CLI arguments rejected before execution (${code})`
    };
  }
  const name = error instanceof Error ? error.name : "";
  return {
    failure: "spawn",
    cause: name === "Error" ? "Herdr process unavailable" : "Herdr process failed"
  };
}

export function createProcessRunner(binary = "herdr"): HerdrCommandRunner {
  return {
    run({ args, signal, timeoutMs, maxOutputBytes = 1024 * 1024 }) {
      return new Promise<CommandOutcome>((resolve) => {
        if (typeof binary !== "string" || !binary || binary.includes("\0") || !validArguments(args)) {
          resolve({ exitCode: null, stdout: "", stderr: "", failure: "invalid_arguments", started: false });
          return;
        }
        if (signal?.aborted) {
          resolve({ exitCode: null, stdout: "", stderr: "", failure: "aborted", started: false });
          return;
        }
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          resolve({ exitCode: null, stdout: "", stderr: "", failure: "timeout", started: false });
          return;
        }
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(binary, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
        } catch (spawnErr) {
          const classified = classifyPreExecError(spawnErr);
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            failure: classified.failure,
            started: false,
            cause: classified.failure === "invalid_arguments" ? classified.cause : "Herdr process could not launch"
          });
          return;
        }

        let started = false;
        child.once("spawn", () => {
          started = true;
        });

        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let stdout = "";
        let stderr = "";
        let totalOutputBytes = 0;
        let failure: CommandOutcome["failure"];
        let cause: string | undefined;
        let settled = false;
        let observedExitCode: number | null = null;
        let cancelTimeout: (() => void) | undefined;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          cancelTimeout?.();
          if (drainTimer !== undefined) {
            clearTimeout(drainTimer);
            drainTimer = undefined;
          }
          signal?.removeEventListener("abort", onAbort);
          if (failure !== "output_limit") {
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({
            exitCode,
            stdout,
            stderr,
            started,
            ...(failure && { failure }),
            ...(cause && { cause })
          });
        };

        const armDrainFallback = () => {
          if (settled || drainTimer !== undefined) return;
          drainTimer = setTimeout(() => {
            drainTimer = undefined;
            finish(observedExitCode);
          }, PIPE_DRAIN_GRACE_MS);
          drainTimer.unref?.();
        };

        const stop = (reason: NonNullable<CommandOutcome["failure"]>) => {
          failure ??= reason;
          try {
            child.kill("SIGKILL");
          } catch {
            // child may have already exited
          }
          armDrainFallback();
        };

        const onAbort = () => stop("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) stop("aborted");
        if (timeoutMs !== undefined && !settled) {
          cancelTimeout = scheduleSafeTimeout(() => stop("timeout"), timeoutMs);
        }

        const append = (which: "stdout" | "stderr", chunk: Buffer) => {
          if (settled || failure === "output_limit") return;
          totalOutputBytes += chunk.byteLength;
          if (totalOutputBytes > maxOutputBytes) {
            stop("output_limit");
            return;
          }
          if (which === "stdout") stdout += stdoutDecoder.write(chunk);
          else stderr += stderrDecoder.write(chunk);
        };

        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.on("error", (error: Error) => {
          if (!started) {
            const classified = classifyPreExecError(error);
            failure ??= classified.failure;
            cause = classified.cause;
          } else {
            failure ??= "spawn";
            cause = error.name === "Error" ? "Herdr process unavailable" : "Herdr process failed";
          }
          armDrainFallback();
        });
        child.once("exit", (exitCode) => {
          observedExitCode = exitCode;
          // If a background grandchild inherited stdout/stderr pipes, "close" may never fire; bound the drain wait.
          armDrainFallback();
        });
        child.on("close", (exitCode) => {
          finish(exitCode ?? observedExitCode);
        });
      });
    }
  };
}
