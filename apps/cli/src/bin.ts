#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePresentation, runCli } from "./commands.js";
import { isHighLevelInvocation } from "./high-level/index.js";
import { formatCommandError } from "./formatters.js";
import { parseCliArgs } from "./parser.js";
import { toContractError } from "./presentation.js";
import { composeCliRuntime } from "./runtime.js";
import {
  CLI_EXIT_CODES,
  type CliCommandName,
  type CliContext,
  type CliExecutionResult,
  type CliIo
} from "./types.js";

const VALID_COMMANDS: ReadonlySet<CliCommandName> = new Set([
  "up",
  "down",
  "attach",
  "recover",
  "doctor",
  "init",
  "setup",
  "run",
  "status",
  "approve",
  "resume",
  "cancel",
  "help",
  "version"
]);

const BUSINESS_COMMANDS: ReadonlySet<CliCommandName> = new Set([
  "run",
  "status",
  "approve",
  "resume",
  "cancel"
]);

export async function main(
  argv?: readonly string[] | undefined,
  context?: CliContext | undefined
): Promise<CliExecutionResult> {
  const args = argv ?? process.argv.slice(2);
  const isDefaultIo = context?.io === undefined;
  const realIo: CliIo = context?.io ?? {
    stdout: (msg) => process.stdout.write(msg + "\n"),
    stderr: (msg) => process.stderr.write(msg + "\n")
  };

  const isJson = args.some((a) => a === "--json" || a === "-j") || Boolean(context?.presentation?.json);
  const cmdCandidate = args.find((a) => !a.startsWith("-"));
  const command = (cmdCandidate && VALID_COMMANDS.has(cmdCandidate as CliCommandName)
    ? cmdCandidate
    : undefined) as CliCommandName | undefined;

  const presentation = resolvePresentation(context, isJson, isDefaultIo);

  let bufferedStdout: string | undefined;
  let bufferedStderr: string | undefined;

  const io: CliIo = {
    stdout: (msg) => {
      bufferedStdout = msg;
    },
    stderr: (msg) => {
      bufferedStderr = msg;
    },
    progress: msg => {
      if (realIo.progress) realIo.progress(msg);
      else realIo.stderr(msg);
    },
    stderrRaw: realIo.stderrRaw?.bind(realIo) ?? (isDefaultIo ? chunk => { process.stderr.write(chunk); } : undefined)
  };

  const runtimeContext: CliContext = {
    ...context,
    io,
    presentation
  };

  try {
    if (context?.runtime === undefined && !isHighLevelInvocation(args)) {
      const parseRes = parseCliArgs(args);
      const environmentStatus = parseRes.ok && parseRes.value.command === "status" &&
        parseRes.value.runId === undefined && parseRes.value.statusFilter === undefined && parseRes.value.workflowId === undefined &&
        parseRes.value.limit === undefined && parseRes.value.cursor === undefined;
      if (parseRes.ok && BUSINESS_COMMANDS.has(parseRes.value.command) && !environmentStatus) {
        const configPath =
          parseRes.value.command === "run" ? parseRes.value.configPath : undefined;

        let composedRes;
        try {
          composedRes = await composeCliRuntime({
            ...(context?.cwd !== undefined ? { cwd: context.cwd } : {}),
            ...(configPath !== undefined ? { configPath } : {}),
            ...(context?.clock !== undefined ? { clock: context.clock } : {}),
            ...(context?.operationOptions !== undefined
              ? { operationOptions: context.operationOptions }
              : {})
          });
        } catch (composeErr) {
          const contractError = toContractError(composeErr);
          const stderr = formatCommandError(
            contractError,
            parseRes.value.command,
            isJson,
            presentation
          );
          realIo.stderr(stderr);
          const result: CliExecutionResult = {
            exitCode: CLI_EXIT_CODES.RUNTIME_ERROR,
            ok: false,
            command: parseRes.value.command,
            stdout: "",
            stderr,
            error: contractError
          };
          process.exitCode = result.exitCode;
          return result;
        }

        if (!composedRes.ok) {
          const stderr = formatCommandError(
            composedRes.error,
            parseRes.value.command,
            isJson,
            presentation
          );
          realIo.stderr(stderr);
          const result: CliExecutionResult = {
            exitCode: CLI_EXIT_CODES.RUNTIME_ERROR,
            ok: false,
            command: parseRes.value.command,
            stdout: "",
            stderr,
            error: composedRes.error
          };
          process.exitCode = result.exitCode;
          return result;
        }

        let result: CliExecutionResult | undefined;
        let closeErr: unknown;
        try {
          result = await runCli(args, {
            ...runtimeContext,
            runtime: composedRes.value.runtime
          });
        } finally {
          try {
            await composedRes.value.close();
          } catch (err) {
            closeErr = err;
          }
        }

        if (result !== undefined && result.ok) {
          if (closeErr !== undefined) {
            const contractError = toContractError(closeErr);
            const stderr = formatCommandError(
              contractError,
              parseRes.value.command,
              isJson,
              presentation
            );
            realIo.stderr(stderr);
            const cleanupResult: CliExecutionResult = {
              exitCode: CLI_EXIT_CODES.RUNTIME_ERROR,
              ok: false,
              command: parseRes.value.command,
              stdout: "",
              stderr,
              error: contractError
            };
            process.exitCode = cleanupResult.exitCode;
            return cleanupResult;
          }
          if (bufferedStdout !== undefined) {
            realIo.stdout(bufferedStdout);
          }
          process.exitCode = result.exitCode;
          return result;
        }

        if (result !== undefined && !result.ok) {
          if (bufferedStderr !== undefined) {
            realIo.stderr(bufferedStderr);
          }
          process.exitCode = result.exitCode;
          return result;
        }
      }
    }

    const result = await runCli(args, runtimeContext);
    if (bufferedStdout !== undefined) {
      realIo.stdout(bufferedStdout);
    }
    if (bufferedStderr !== undefined) {
      realIo.stderr(bufferedStderr);
    }
    process.exitCode = result.exitCode;
    return result;
  } catch (err) {
    const contractError = toContractError(err);
    const stderr = formatCommandError(contractError, command, isJson, presentation);
    realIo.stderr(stderr);
    const result: CliExecutionResult = {
      exitCode: CLI_EXIT_CODES.RUNTIME_ERROR,
      ok: false,
      ...(command !== undefined ? { command } : {}),
      stdout: "",
      stderr,
      error: contractError
    };
    process.exitCode = result.exitCode;
    return result;
  }
}

if (process.argv[1] !== undefined) {
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    let isEntry = false;
    try {
      isEntry = realpathSync(process.argv[1]) === realpathSync(scriptPath);
    } catch {
      isEntry = process.argv[1] === scriptPath || resolve(process.argv[1]) === resolve(scriptPath);
    }
    if (isEntry) {
      const controller = new AbortController();
      const parsed = parseCliArgs(process.argv.slice(2));
      const lifecycle = parsed.ok && ["up", "down", "recover"].includes(parsed.value.command);
      let interruptedExitCode = 130;
      const interrupt = () => controller.abort();
      const terminate = () => { interruptedExitCode = 143; controller.abort(); };
      if (lifecycle) { process.once("SIGINT", interrupt); process.once("SIGTERM", terminate); }
      void main(undefined, lifecycle ? { operationOptions: { signal: controller.signal } } : undefined)
        .catch((err) => {
          const isJson = process.argv.slice(2).some((a) => a === "--json" || a === "-j");
          const contractError = toContractError(err);
          const stderr = formatCommandError(contractError, undefined, isJson);
          process.stderr.write(stderr + "\n");
          process.exitCode = 1;
        })
        .finally(() => {
          if (lifecycle) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
          if (controller.signal.aborted) process.exitCode = interruptedExitCode;
        });
    }
  } catch {
    // Ignore resolution errors in test environments
  }
}
