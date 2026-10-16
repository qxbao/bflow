#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./commands.js";
import { formatCommandError } from "./formatters.js";
import { parseCliArgs } from "./parser.js";
import { composeCliRuntime } from "./runtime.js";
import {
  CLI_EXIT_CODES,
  type CliCommandName,
  type CliContext,
  type CliExecutionResult,
  type CliIo
} from "./types.js";

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
  const io: CliIo = context?.io ?? {
    stdout: (msg) => process.stdout.write(msg + "\n"),
    stderr: (msg) => process.stderr.write(msg + "\n")
  };

  if (context?.runtime === undefined) {
    const parseRes = parseCliArgs(args);
    const environmentStatus = parseRes.ok && parseRes.value.command === "status" &&
      parseRes.value.runId === undefined && parseRes.value.statusFilter === undefined && parseRes.value.workflowId === undefined &&
      parseRes.value.limit === undefined && parseRes.value.cursor === undefined;
    if (parseRes.ok && BUSINESS_COMMANDS.has(parseRes.value.command) && !environmentStatus) {
      const configPath =
        parseRes.value.command === "run" ? parseRes.value.configPath : undefined;

      const composedRes = await composeCliRuntime({
        ...(context?.cwd !== undefined ? { cwd: context.cwd } : {}),
        ...(configPath !== undefined ? { configPath } : {}),
        ...(context?.clock !== undefined ? { clock: context.clock } : {}),
        ...(context?.operationOptions !== undefined
          ? { operationOptions: context.operationOptions }
          : {})
      });

      if (!composedRes.ok) {
        const stderr = formatCommandError(
          composedRes.error,
          parseRes.value.command,
          parseRes.value.json
        );
        io.stderr(stderr);
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

      try {
        const result = await runCli(args, {
          ...context,
          io,
          runtime: composedRes.value.runtime
        });
        process.exitCode = result.exitCode;
        return result;
      } finally {
        await composedRes.value.close();
      }
    }
  }

  const result = await runCli(args, {
    ...context,
    io
  });

  process.exitCode = result.exitCode;
  return result;
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
      void main().catch((err) => {
        process.stderr.write(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exitCode = 1;
      });
    }
  } catch {
    // Ignore resolution errors in test environments
  }
}
