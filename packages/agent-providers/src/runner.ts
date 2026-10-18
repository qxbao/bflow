import { type ChildProcess, spawn } from "node:child_process";
import type {
  ProviderCommandInvocation,
  ProviderCommandOutcome,
  ProviderCommandRunner
} from "./types.js";

export function createProviderProcessRunner(defaultOptions?: {
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
}): ProviderCommandRunner {
  const defaultMaxBytes = defaultOptions?.maxOutputBytes ?? 256 * 1024;
  const defaultTimeout = defaultOptions?.defaultTimeoutMs ?? 30_000;

  return {
    async run(invocation: ProviderCommandInvocation): Promise<ProviderCommandOutcome> {
      if (
        !invocation.executable ||
        invocation.executable.trim().length === 0 ||
        invocation.executable.includes("\0")
      ) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "Invalid executable: empty or contains NUL byte",
          started: false,
          failure: "invalid_arguments",
          cause: "Executable is empty or contains NUL byte"
        };
      }

      for (const arg of invocation.args) {
        if (arg.includes("\0")) {
          return {
            exitCode: null,
            stdout: "",
            stderr: "Invalid argument: contains NUL byte",
            started: false,
            failure: "invalid_arguments",
            cause: "Argument contains NUL byte"
          };
        }
      }

      if (invocation.signal?.aborted) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "Operation aborted before start",
          started: false,
          failure: "aborted",
          cause: "Signal was already aborted"
        };
      }

      const timeoutMs = Math.min(
        Math.max(invocation.timeoutMs ?? defaultTimeout, 1),
        2_147_483_647
      );
      const maxOutputBytes = invocation.maxOutputBytes ?? defaultMaxBytes;

      return new Promise<ProviderCommandOutcome>((resolve) => {
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let finished = false;
        let timer: NodeJS.Timeout | null = null;
        let abortHandler: (() => void) | null = null;

        let child: ChildProcess;
        try {
          child = spawn(invocation.executable, [...invocation.args], {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            ...(invocation.cwd !== undefined ? { cwd: invocation.cwd } : {}),
            env: invocation.env ? { ...process.env, ...invocation.env } : process.env
          });
        } catch (err) {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            started: false,
            failure: "spawn",
            cause: err instanceof Error ? err.message : String(err)
          });
          return;
        }

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (abortHandler && invocation.signal) {
            invocation.signal.removeEventListener("abort", abortHandler);
            abortHandler = null;
          }
        };

        const finish = (outcome: ProviderCommandOutcome) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(outcome);
        };

        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore kill error
          }
          finish({
            exitCode: null,
            stdout,
            stderr: stderr + (stderr.length ? "\n" : "") + "Command timed out",
            started: true,
            failure: "timeout",
            cause: `Process exceeded timeout of ${timeoutMs}ms`
          });
        }, timeoutMs);

        if (invocation.signal) {
          abortHandler = () => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore kill error
            }
            finish({
              exitCode: null,
              stdout,
              stderr: stderr + (stderr.length ? "\n" : "") + "Command aborted",
              started: true,
              failure: "aborted",
              cause: "AbortSignal triggered"
            });
          };
          invocation.signal.addEventListener("abort", abortHandler, { once: true });
        }

        child.on("error", (err) => {
          finish({
            exitCode: null,
            stdout,
            stderr: err.message,
            started: false,
            failure: "spawn",
            cause: err.message
          });
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxOutputBytes) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore kill error
            }
            finish({
              exitCode: null,
              stdout,
              stderr: "Output limit exceeded on stdout",
              started: true,
              failure: "output_limit",
              cause: `Process output exceeded limit of ${maxOutputBytes} bytes`
            });
            return;
          }
          stdout += chunk.toString("utf8");
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > maxOutputBytes) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore kill error
            }
            finish({
              exitCode: null,
              stdout,
              stderr,
              started: true,
              failure: "output_limit",
              cause: `Process output exceeded limit of ${maxOutputBytes} bytes`
            });
            return;
          }
          stderr += chunk.toString("utf8");
        });

        child.on("close", (code) => {
          finish({
            exitCode: code,
            stdout,
            stderr,
            started: true
          });
        });
      });
    }
  };
}

export type FakeRunnerScenario =
  | "healthy"
  | "missing_binary"
  | "outdated_version"
  | "auth_expired"
  | "permission_denied"
  | "invalid_flag"
  | "environment_missing"
  | "incompatible_model"
  | "agent_blocked";

export interface FakeRunnerConfig {
  readonly scenario?: FakeRunnerScenario;
  readonly providerScenarios?: Readonly<Partial<Record<string, FakeRunnerScenario>>>;
  readonly customHandler?: (
    invocation: ProviderCommandInvocation
  ) => ProviderCommandOutcome | undefined;
}

export function createFakeProviderRunner(config?: FakeRunnerConfig): ProviderCommandRunner {
  const globalScenario = config?.scenario ?? "healthy";

  return {
    async run(invocation: ProviderCommandInvocation): Promise<ProviderCommandOutcome> {
      if (
        !invocation.executable ||
        invocation.executable.trim().length === 0 ||
        invocation.executable.includes("\0")
      ) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "Invalid executable: empty or contains NUL byte",
          started: false,
          failure: "invalid_arguments",
          cause: "Executable is empty or contains NUL byte"
        };
      }

      for (const arg of invocation.args) {
        if (arg.includes("\0")) {
          return {
            exitCode: null,
            stdout: "",
            stderr: "Invalid argument: contains NUL byte",
            started: false,
            failure: "invalid_arguments",
            cause: "Argument contains NUL byte"
          };
        }
      }

      if (invocation.signal?.aborted) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "Operation aborted before start",
          started: false,
          failure: "aborted",
          cause: "Signal was already aborted"
        };
      }

      if (config?.customHandler) {
        const handled = config.customHandler(invocation);
        if (handled !== undefined) {
          return handled;
        }
      }

      const execBase = invocation.executable.split("/").pop() ?? invocation.executable;
      const argsStr = invocation.args.join(" ");
      let providerName = invocation.env?.["BFLOW_PROVIDER"] ?? "";
      if (!providerName) {
        if (execBase.includes("codex")) {
          providerName = "codex";
        } else if (execBase.includes("agy")) {
          providerName = "agy";
        } else if (execBase.includes("claude")) {
          providerName = "claude";
        } else if (
          argsStr.includes("login status") ||
          argsStr.includes("--no-daemon") ||
          argsStr.includes("--ask-for-approval") ||
          invocation.args[0] === "exec"
        ) {
          providerName = "codex";
        } else if (
          invocation.args[0] === "models" ||
          argsStr.includes("--mode") ||
          argsStr.includes("--output-format")
        ) {
          providerName = "agy";
        } else {
          providerName = "claude";
        }
      }

      const scenario = config?.providerScenarios?.[providerName] ?? globalScenario;

      if (scenario === "missing_binary") {
        return {
          exitCode: null,
          stdout: "",
          stderr: `spawn ${invocation.executable} ENOENT`,
          started: false,
          failure: "spawn",
          cause: `spawn ${invocation.executable} ENOENT`
        };
      }

      // Version check
      if (invocation.args.includes("--version")) {
        if (scenario === "outdated_version") {
          if (providerName === "claude") {
            return { exitCode: 0, stdout: "Claude Code 1.0.2\n", stderr: "", started: true };
          }
          if (providerName === "codex") {
            return { exitCode: 0, stdout: "codex-cli 0.10.0\n", stderr: "", started: true };
          }
          return { exitCode: 0, stdout: "agy 0.5.0\n", stderr: "", started: true };
        }

        if (providerName === "claude") {
          return { exitCode: 0, stdout: "2.1.301 (Claude Code)\n", stderr: "", started: true };
        }
        if (providerName === "codex") {
          return { exitCode: 0, stdout: "codex-cli 0.162.0\n", stderr: "", started: true };
        }
        return { exitCode: 0, stdout: "1.4.0\n", stderr: "", started: true };
      }

      // Global MCP enumeration (read-only; codex mcp list --json)
      if (providerName === "codex" && argsStr === "mcp list --json") {
        return { exitCode: 0, stdout: "[]\n", stderr: "", started: true };
      }

      // Help check (capability discovery)
      if (invocation.args.includes("--help") || invocation.args.includes("-h")) {
        if (scenario === "invalid_flag") {
          return {
            exitCode: 0,
            stdout: `${providerName} minimal help (missing required flags)\n--version\n--help\n`,
            stderr: "",
            started: true
          };
        }

        if (providerName === "claude") {
          return {
            exitCode: 0,
            stdout:
              "Usage: claude [options] [command] [prompt]\n" +
              "  --version\n" +
              "  --help\n" +
              "  --restricted\n" +
              "  --strict-mcp-config\n" +
              "  --setting-sources\n" +
              "  --disable-slash-commands\n" +
              "  --permission-mode\n" +
              "  --tools\n" +
              "  --allowedTools\n" +
              "  --disallowedTools\n" +
              "  --add-dir\n" +
              "  --settings\n" +
              "  --mcp-config\n" +
              "  --append-system-prompt\n" +
              "  --append-system-prompt-file\n" +
              "  --model\n" +
              "  --effort\n" +
              "  --print\n" +
              "  --dangerously-skip-permissions\n" +
              "Commands:\n" +
              "  auth                                  Manage authentication\n" +
              "  mcp                                   Configure and manage MCP servers\n",
            stderr: "",
            started: true
          };
        }

        if (providerName === "codex") {
          return {
            exitCode: 0,
            stdout:
              "Usage: codex [OPTIONS] [PROMPT]\n" +
              "  --version\n" +
              "  --help\n" +
              "  -c, --config\n" +
              "  --no-daemon\n" +
              "  -s, --sandbox\n" +
              "  -a, --ask-for-approval\n" +
              "  --add-dir\n" +
              "  --enable\n" +
              "  --disable\n" +
              "  --strict-config\n" +
              "  --dangerously-bypass-hook-trust\n" +
              "  --dangerously-bypass-approvals-and-sandbox\n" +
              "  -m, --model\n" +
              "Commands:\n" +
              "  exec              Run Codex non-interactively\n" +
              "  login             Manage login\n" +
              "  mcp               Manage external MCP servers for Codex\n" +
              "  doctor            Diagnose local Codex installation\n",
            stderr: "",
            started: true
          };
        }

        return {
          exitCode: 0,
          stdout:
            "Usage of agy:\n" +
            "  --version\n" +
            "  --help\n" +
            "  --sandbox\n" +
            "  --mode\n" +
            "  --add-dir\n" +
            "  --disable-slash-commands\n" +
            "  --dangerously-skip-permissions\n" +
            "  --print\n" +
            "  --output-format\n" +
            "  --model\n" +
            "Available subcommands:\n" +
            "  models          List available models\n" +
            "  mcp             Manage MCP servers\n",
          stderr: "",
          started: true
        };
      }

      // Authentication status command
      const isAuthStatus =
        (providerName === "claude" && argsStr.includes("auth status")) ||
        (providerName === "codex" && argsStr.includes("login status")) ||
        (providerName === "agy" && argsStr.includes("models"));

      if (isAuthStatus) {
        if (scenario === "auth_expired") {
          if (providerName === "claude") {
            return {
              exitCode: 1,
              stdout: JSON.stringify({
                authenticated: false,
                status: "expired",
                error: "OAuth token expired for user@example.com Bearer sk-secret-12345"
              }),
              stderr: "OAuth token expired for user@example.com Bearer sk-secret-12345",
              started: true
            };
          }
          if (providerName === "codex") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "Login expired: Please re-authenticate at https://example.com for user@example.com Bearer sk-token-999",
              started: true
            };
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Authentication required or token expired for user@example.com Bearer sk-token-888",
            started: true
          };
        }

        if (providerName === "claude") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              authenticated: true,
              status: "active",
              email: "dev@example.com"
            }),
            stderr: "",
            started: true
          };
        }
        if (providerName === "codex") {
          return {
            exitCode: 0,
            stdout: "Logged in as dev@example.com\n",
            stderr: "",
            started: true
          };
        }
        return {
          exitCode: 0,
          stdout: "antigravity-2.0\ngemini-1.5-pro\ngemini-1.5-flash\n",
          stderr: "",
          started: true
        };
      }

      // Execution Probe / Command handling
      if (scenario === "permission_denied") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Permission denied: target directory or operation not authorized by permission policy",
          started: true
        };
      }

      if (scenario === "invalid_flag") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "error: unknown option '--invalid-flag-test'",
          started: true
        };
      }

      if (scenario === "environment_missing") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Error: Cannot access state directory or cwd: No such file or directory",
          started: true
        };
      }

      if (scenario === "incompatible_model") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Error: Model is incompatible or not authorized for your organization or tier",
          started: true
        };
      }

      if (scenario === "agent_blocked") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Agent blocked waiting for interactive confirmation / trust approval dialog",
          started: true
        };
      }

      if (scenario === "auth_expired") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Authentication failed: OAuth token expired for user@example.com Bearer sk-secret-12345",
          started: true
        };
      }

      // Default healthy probe response
      return {
        exitCode: 0,
        stdout: "pong\n",
        stderr: "",
        started: true
      };
    }
  };
}
