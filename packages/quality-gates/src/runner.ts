import type { ContractError, OperationResult } from "@ai-flow/contracts";
import { spawn, type ChildProcess } from "node:child_process";

function createValidationError(message: string): ContractError {
  return {
    code: "validation",
    retryable: false,
    message
  };
}

export interface QualityCommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface QualityCommandOutcome {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly combinedOutput: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputTruncated: boolean;
  readonly spawnError?: string;
}

export interface QualityCommandRunner {
  run(
    invocation: QualityCommandInvocation
  ): Promise<OperationResult<QualityCommandOutcome>>;
}

export function createQualityCommandRunner(): QualityCommandRunner {
  return {
    async run(
      invocation: QualityCommandInvocation
    ): Promise<OperationResult<QualityCommandOutcome>> {
      if (
        !invocation ||
        typeof invocation.executable !== "string" ||
        invocation.executable.trim().length === 0 ||
        invocation.executable.includes("\0")
      ) {
        return {
          ok: false,
          error: createValidationError(
            `Invalid executable: "${invocation?.executable}". Must be a non-empty string without NUL bytes.`
          )
        };
      }

      if (
        typeof invocation.cwd !== "string" ||
        invocation.cwd.trim().length === 0 ||
        invocation.cwd.includes("\0")
      ) {
        return {
          ok: false,
          error: createValidationError(
            `Invalid cwd: "${invocation.cwd}". Must be a non-empty string without NUL bytes.`
          )
        };
      }

      if (!Array.isArray(invocation.args)) {
        return {
          ok: false,
          error: createValidationError("Invalid args: must be an array of strings.")
        };
      }

      for (const arg of invocation.args) {
        if (typeof arg !== "string" || arg.includes("\0")) {
          return {
            ok: false,
            error: createValidationError(
              "Invalid argument: must be a string without NUL bytes."
            )
          };
        }
      }

      if (invocation.maxOutputBytes !== undefined) {
        if (
          typeof invocation.maxOutputBytes !== "number" ||
          !Number.isSafeInteger(invocation.maxOutputBytes) ||
          invocation.maxOutputBytes <= 0
        ) {
          return {
            ok: false,
            error: createValidationError(
              `Invalid maxOutputBytes: ${invocation.maxOutputBytes}. Must be a positive safe integer.`
            )
          };
        }
      }

      if (
        typeof invocation.timeoutMs !== "number" ||
        !Number.isInteger(invocation.timeoutMs) ||
        invocation.timeoutMs < 1 ||
        invocation.timeoutMs > 2_147_483_647
      ) {
        return {
          ok: false,
          error: createValidationError(
            `Invalid timeoutMs: ${invocation.timeoutMs}. Must be an integer between 1 and 2147483647.`
          )
        };
      }

      if (invocation.signal?.aborted) {
        return {
          ok: true,
          value: {
            executable: invocation.executable,
            args: invocation.args,
            cwd: invocation.cwd,
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            combinedOutput: "",
            durationMs: 0,
            timedOut: false,
            aborted: true,
            outputTruncated: false
          }
        };
      }

      const startTime = Date.now();
      const maxBytes = invocation.maxOutputBytes ?? 262_144;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const combinedChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let combinedBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let aborted = false;
      let spawnError: string | undefined = undefined;
      let settled = false;

      function appendToBuffer(
        chunk: Buffer,
        target: Buffer[],
        currentLength: number
      ): number {
        if (settled) return currentLength;
        if (currentLength >= maxBytes) {
          outputTruncated = true;
          return currentLength;
        }
        if (currentLength + chunk.length > maxBytes) {
          const slice = chunk.subarray(0, maxBytes - currentLength);
          target.push(slice);
          outputTruncated = true;
          return maxBytes;
        }
        target.push(chunk);
        return currentLength + chunk.length;
      }

      return new Promise<OperationResult<QualityCommandOutcome>>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(invocation.executable, [...invocation.args], {
            cwd: invocation.cwd,
            env: { ...invocation.env },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resolve({
            ok: true,
            value: {
              executable: invocation.executable,
              args: invocation.args,
              cwd: invocation.cwd,
              exitCode: null,
              signal: null,
              stdout: "",
              stderr: "",
              combinedOutput: "",
              durationMs: Date.now() - startTime,
              timedOut: false,
              aborted: false,
              outputTruncated: false,
              spawnError: message
            }
          });
          return;
        }

        let timeoutTimer: NodeJS.Timeout | undefined = undefined;
        let killTimer: NodeJS.Timeout | undefined = undefined;

        const cleanup = () => {
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
          if (abortListener && invocation.signal) {
            invocation.signal.removeEventListener("abort", abortListener);
          }
        };

        const scheduleKillTimer = () => {
          if (killTimer === undefined) {
            killTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // Process might have already exited
              }
            }, 250);
            killTimer.unref();
          }
        };

        const abortListener = () => {
          aborted = true;
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // Process might have already exited
          }
          scheduleKillTimer();
        };

        if (invocation.signal) {
          invocation.signal.addEventListener("abort", abortListener, {
            once: true
          });
          if (invocation.signal.aborted) {
            abortListener();
          }
        }

        timeoutTimer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // Process might have already exited
          }
          scheduleKillTimer();
        }, invocation.timeoutMs);
        timeoutTimer.unref();

        if (child.stdout) {
          child.stdout.on("data", (chunk: Buffer) => {
            stdoutBytes = appendToBuffer(chunk, stdoutChunks, stdoutBytes);
            combinedBytes = appendToBuffer(chunk, combinedChunks, combinedBytes);
          });
        }

        if (child.stderr) {
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes = appendToBuffer(chunk, stderrChunks, stderrBytes);
            combinedBytes = appendToBuffer(chunk, combinedChunks, combinedBytes);
          });
        }

        const settle = (
          exitCode: number | null,
          signal: NodeJS.Signals | null
        ) => {
          if (settled) return;
          settled = true;
          cleanup();

          const durationMs = Date.now() - startTime;
          const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const stderr = Buffer.concat(stderrChunks).toString("utf-8");
          const combinedOutput = Buffer.concat(combinedChunks).toString("utf-8");

          resolve({
            ok: true,
            value: {
              executable: invocation.executable,
              args: invocation.args,
              cwd: invocation.cwd,
              exitCode: spawnError !== undefined ? null : exitCode,
              signal,
              stdout,
              stderr,
              combinedOutput,
              durationMs,
              timedOut,
              aborted,
              outputTruncated,
              ...(spawnError !== undefined ? { spawnError } : {})
            }
          });
        };

        child.on("error", (err) => {
          spawnError = err.message;
          settle(null, null);
        });

        child.on("close", (code, signal) => {
          settle(code, signal);
        });
      });
    }
  };
}
