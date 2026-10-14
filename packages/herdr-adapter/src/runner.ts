import { spawn } from "node:child_process";

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

export function validArguments(args: readonly string[]): boolean {
  return Array.isArray(args) && args.every((arg) => typeof arg === "string" && !arg.includes("\0"));
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
        try { child = spawn(binary, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
        catch { resolve({ exitCode: null, stdout: "", stderr: "", failure: "spawn", started: false, cause: "Herdr process could not launch" }); return; }
        let started = false;
        child.once("spawn", () => { started = true; });
        let stdout = "";
        let stderr = "";
        let failure: CommandOutcome["failure"];
        let cause: string | undefined;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (reason: NonNullable<CommandOutcome["failure"]>) => {
          failure ??= reason;
          child.kill("SIGKILL");
        };
        const onAbort = () => stop("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) stop("aborted");
        if (timeoutMs !== undefined) timer = setTimeout(() => stop("timeout"), timeoutMs);
        const append = (which: "stdout" | "stderr", chunk: Buffer) => {
          if (failure === "output_limit") return;
          const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
          if (Buffer.byteLength(next) + Buffer.byteLength(which === "stdout" ? stderr : stdout) > maxOutputBytes) {
            stop("output_limit");
            return;
          }
          if (which === "stdout") stdout = next;
          else stderr = next;
        };
        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.on("error", (error: Error) => {
          failure ??= "spawn";
          cause = error.name === "Error" ? "Herdr process unavailable" : "Herdr process failed";
        });
        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ exitCode, stdout, stderr, started, ...(failure && { failure }), ...(cause && { cause }) });
        });
      });
    }
  };
}
