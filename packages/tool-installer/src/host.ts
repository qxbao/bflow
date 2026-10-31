import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: string;
}

export interface ToolRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
  input?: string;
}

export interface ToolHost {
  run(executable: string, args: readonly string[], options?: ToolRunOptions): Promise<ProcessResult>;
  download(source: string, target: string, signal?: AbortSignal): Promise<void>;
}

export const systemToolHost: ToolHost = {
  run(executable, args, options) {
    return new Promise((done, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error("Command cancelled before start"));
        return;
      }
      if (
        options?.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)
      ) {
        reject(new Error("Invalid command timeout"));
        return;
      }
      const child = spawn(executable, [...args], {
        cwd: options?.cwd,
        shell: false,
        env: { ...process.env, ...options?.environment },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "",
        stderr = "",
        bytes = 0;
      let failure: Error | undefined;
      const stop = (message: string) => {
        failure ??= new Error(message);
        child.kill("SIGKILL");
      };
      const timer =
        options?.timeoutMs === undefined ? undefined : setTimeout(() => stop("Command timed out"), options.timeoutMs);
      const abort = () => stop("Command cancelled");
      options?.signal?.addEventListener("abort", abort, { once: true });
      const collect = (chunk: Buffer, output: "stdout" | "stderr") => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          stop("Command output exceeded 2 MB");
          return;
        }
        if (output === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
      child.stdin.on("error", () => {
        /* process may close stdin before consuming the probe */
      });
      child.stdin.end(options?.input);
      child.on("error", (error) => {
        failure = error;
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        if (failure) {
          reject(failure);
          return;
        }
        done({
          exitCode: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1),
          stdout,
          stderr,
          ...(signal ? { signal } : {})
        });
      });
    });
  },
  async download(source, target, signal) {
    let current = source;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(current, { ...(signal ? { signal } : {}), redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Download redirect limit exceeded");
        const next = new URL(location, current);
        if (next.protocol !== "https:" || next.username || next.password || next.hash)
          throw new Error("Unsafe download redirect");
        current = next.toString();
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 250_000_000 ? new Error("Download exceeds 250 MB") : null, chunk);
        }
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        limit,
        createWriteStream(target, { flags: "wx", mode: 0o600 })
      );
      return;
    }
  }
};
