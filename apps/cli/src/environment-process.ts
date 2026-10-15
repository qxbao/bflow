import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface EnvironmentProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly mode?: "capture" | "background" | "interactive";
  readonly logPath?: string;
}
export interface EnvironmentProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly pid?: number;
}
export interface EnvironmentProcessRunner {
  run(request: EnvironmentProcessRequest): Promise<EnvironmentProcessResult>;
}

/** Every command is argv based. Background servers own their lifetime after spawn. */
export const environmentProcessRunner: EnvironmentProcessRunner = {
  async run(request) {
    const background = request.mode === "background";
    const interactive = request.mode === "interactive";
    const log = background && request.logPath !== undefined
      ? await open(request.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      : undefined;
    try {
      return await new Promise<EnvironmentProcessResult>((resolve, reject) => {
        const child = spawn(request.executable, [...request.args], {
          cwd: request.cwd, env: request.env ?? process.env,
          shell: false, detached: !interactive,
          stdio: background ? ["ignore", log?.fd ?? "ignore", log?.fd ?? "ignore"]
            : interactive ? "inherit" : ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: Error, exitCode: number | null = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve({ exitCode, stdout, stderr, ...(child.pid === undefined ? {} : { pid: child.pid }) });
        };
        const terminate = () => {
          try {
            if (!interactive && child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* Already exited. */ }
        };
        const receive = (chunk: Buffer, target: "stdout" | "stderr") => {
          if (target === "stdout") stdout += chunk.toString("utf8");
          else stderr += chunk.toString("utf8");
          if (stdout.length + stderr.length > 2 * 1024 * 1024) {
            terminate();
            finish(new Error("Process output exceeded 2 MiB"));
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => receive(chunk, "stdout"));
        child.stderr?.on("data", (chunk: Buffer) => receive(chunk, "stderr"));
        child.once("error", (error) => finish(error));
        child.once("close", (code) => finish(undefined, code));
        if (background) child.once("spawn", () => { child.unref(); finish(undefined, 0); });
        else if (!interactive) timer = setTimeout(() => {
          terminate();
          finish(new Error(`Process timed out: ${request.executable}`));
        }, Math.min(request.timeoutMs ?? 5000, 2_147_483_647));
      });
    } finally { await log?.close(); }
  }
};

/** Inherited pane/socket context must never override this repository's session. */
export function namedSessionEnvironment(sessionName: string, base = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HERDR_") && key !== "HERDR_CONFIG_PATH") delete env[key];
  }
  env["HERDR_SESSION"] = sessionName;
  return env;
}
